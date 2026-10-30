"""Local web server for the IoT DSL compiler.

This file is only glue: it serves the web page in web/, passes source text to
the C++ compiler (./iotc --json), builds and runs the generated code, forwards
AI requests to ai.py and relays the phone remote. All compilation happens in C++.

Run:  make run       (this computer only:   http://127.0.0.1:8000)
      make remote    (also lets a phone on the same Wi-Fi act as the sensor panel)
"""

import json
import os
import queue
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import ai

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
EXAMPLES_DIR = ROOT / "examples"
RUNTIME_DIR = ROOT / "runtime"
COMPILER = ROOT / "iotc"
PORT = int(os.environ.get("PORT", "8000"))
LAN = "--lan" in sys.argv or os.environ.get("LAN") == "1"
HOST = "0.0.0.0" if LAN else "127.0.0.1"
MAX_BODY_BYTES = 100_000
SAFE_ARG = re.compile(r"[A-Za-z0-9_.\-]+")
SAFE_NAME = re.compile(r"[A-Za-z_]\w*")


def run_compiler(source, *args):
    return subprocess.run([str(COMPILER), *args], input=source.encode("utf-8"),
                          capture_output=True, timeout=10)


_language_cache = {}


def language():
    """The scanner DFA and grammar analysis (static, computed once by iotc)."""
    if "data" not in _language_cache:
        out = subprocess.run([str(COMPILER), "--language"], capture_output=True, timeout=10)
        _language_cache["data"] = out.stdout
    return _language_cache["data"]


# --------------------------------------------------------------------- build & run

def build_and_run(source, inputs, target="c"):
    """Compiles the DSL for `target`, then builds/runs it with the sensor values."""
    commands = {"c": "C", "python": "Python", "js": "JavaScript"}
    if target not in commands:
        return {"ok": False, "error": "This target cannot be run here."}

    gen = run_compiler(source, "--target", target)
    if gen.returncode != 0 or not gen.stdout:
        return {"ok": False, "error": "The program has errors, so no code was generated."}

    args = []
    for name, value in (inputs or {}).items():
        name, value = str(name), str(value)
        if SAFE_NAME.fullmatch(name) and SAFE_ARG.fullmatch(value):
            args.append(f"{name}={value}")

    with tempfile.TemporaryDirectory(prefix="iotc-") as tmp:
        tmp = Path(tmp)
        if target == "c":
            cc = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
            if not cc:
                return {"ok": False, "error": "No C compiler found (install Xcode command line tools or gcc)."}
            (tmp / "program.c").write_bytes(gen.stdout)
            build = subprocess.run([cc, "-std=c99", "-Wall", "-I", str(RUNTIME_DIR), str(tmp / "program.c"),
                                    str(RUNTIME_DIR / "iot_runtime.c"), "-o", str(tmp / "program")],
                                   capture_output=True, timeout=30)
            if build.returncode != 0:
                return {"ok": False, "error": "C compilation failed:\n" + build.stderr.decode(errors="replace")}
            cmd = [str(tmp / "program"), *args]
            shown = ["iotc program.iot -o program.c",
                     "cc -std=c99 -Wall -Iruntime program.c runtime/iot_runtime.c -o program",
                     "./program " + " ".join(args)]
        elif target == "python":
            (tmp / "program.py").write_bytes(gen.stdout)
            shutil.copy(RUNTIME_DIR / "iot_runtime.py", tmp)
            cmd = [sys.executable, str(tmp / "program.py"), *args]
            shown = ["iotc program.iot --target python -o program.py", "python3 program.py " + " ".join(args)]
        else:
            node = shutil.which("node")
            if not node:
                return {"ok": False, "error": "Node.js is not installed, so JavaScript cannot be run here."}
            (tmp / "program.js").write_bytes(gen.stdout)
            shutil.copy(RUNTIME_DIR / "iot_runtime.js", tmp)
            cmd = [node, str(tmp / "program.js"), *args]
            shown = ["iotc program.iot --target js -o program.js", "node program.js " + " ".join(args)]
        run = subprocess.run(cmd, capture_output=True, timeout=10)

    return {"ok": True, "output": run.stdout.decode(errors="replace"),
            "stderr": run.stderr.decode(errors="replace"), "commands": shown}


# --------------------------------------------------------------------- phone remote

def lan_ip():
    """The address other devices on this Wi-Fi can reach (no packets are sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class Remote:
    """Relays sensor changes from phones to the laptop page (Server-Sent Events)."""

    def __init__(self):
        self.key = secrets.token_urlsafe(9)
        self.config = {"sensors": [], "program": "", "version": 0}
        self.lock = threading.Lock()
        self.listeners = []

    def publish(self, event):
        with self.lock:
            for q in list(self.listeners):
                q.put(event)

    def subscribe(self):
        q = queue.Queue()
        with self.lock:
            self.listeners.append(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.listeners:
                self.listeners.remove(q)


REMOTE = Remote()
REMOTE_PUBLIC = {"/remote.html", "/api/remote/config", "/api/remote/state"}

# Website pages are served at clean addresses (/studio); the old .html addresses redirect there.
PAGES = {"/studio": "/studio.html", "/docs": "/docs.html", "/examples": "/examples.html", "/about": "/about.html"}
OLD_PAGES = {html: clean for clean, html in PAGES.items()}
OLD_PAGES["/index.html"] = "/"


# --------------------------------------------------------------------- HTTP handler

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet during the demo

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # -- helpers
    def send_json(self, status, payload):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BODY_BYTES:
            raise ValueError("request is too large")
        data = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(data, dict):
            raise ValueError("invalid request")
        return data

    def is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def allowed(self):
        """Other devices may only use the remote page, with the session key."""
        if self.is_local():
            return True
        url = urlparse(self.path)
        key = parse_qs(url.query).get("k", [""])[0]
        return url.path in REMOTE_PUBLIC and secrets.compare_digest(key, REMOTE.key)

    # -- routes
    def do_GET(self):
        if not self.allowed():
            return self.send_json(403, {"error": "forbidden"})
        path = urlparse(self.path).path
        if path == "/api/examples":
            examples = [{"name": p.stem, "source": p.read_text(encoding="utf-8")}
                        for p in sorted(EXAMPLES_DIR.glob("*.iot"))]
            return self.send_json(200, examples)
        if path == "/api/ai-status":
            return self.send_json(200, ai.status())
        if path == "/api/language":
            return self.send_json(200, language())
        if path == "/api/remote/info":
            return self.send_json(200, {"enabled": LAN, "key": REMOTE.key,
                                        "url": f"http://{lan_ip()}:{PORT}/remote.html?k={REMOTE.key}"})
        if path == "/api/remote/config":
            return self.send_json(200, REMOTE.config)
        if path == "/api/remote/events":
            return self.stream_events()
        if path in OLD_PAGES:
            query = urlparse(self.path).query
            self.send_response(301)
            self.send_header("Location", OLD_PAGES[path] + ("?" + query if query else ""))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        if path != "/" and path.endswith("/") and path.rstrip("/") in PAGES:
            # /studio/ would break the page's relative links, so send it to /studio
            self.send_response(301)
            self.send_header("Location", path.rstrip("/"))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        if path in PAGES:
            self.path = PAGES[path] + ("?" + urlparse(self.path).query if urlparse(self.path).query else "")
        return super().do_GET()

    def do_POST(self):
        if not self.allowed():
            return self.send_json(403, {"error": "forbidden"})
        path = urlparse(self.path).path
        routes = {
            "/api/compile": lambda d: self.compile(d),
            "/api/run": lambda d: build_and_run(str(d.get("source", "")), d.get("inputs"),
                                                str(d.get("target", "c"))),
            "/api/nl2dsl": lambda d: ai.nl_to_dsl(str(d.get("text", "")), str(d.get("context", ""))),
            "/api/explain": lambda d: ai.explain(str(d.get("source", "")), d.get("error") or {}),
            "/api/explain-program": lambda d: ai.explain_program(str(d.get("source", "")), d.get("english") or []),
            "/api/fix": lambda d: ai.fix_program(str(d.get("source", "")), d.get("error") or {}),
            "/api/remote/config": self.remote_config,
            "/api/remote/state": self.remote_state,
        }
        handler = routes.get(path)
        if handler is None:
            return self.send_json(404, {"error": "not found"})
        if not COMPILER.exists():
            return self.send_json(500, {"error": "compiler not built - run 'make' first"})
        try:
            result = handler(self.read_json())
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})
        except subprocess.TimeoutExpired:
            return self.send_json(500, {"error": "timed out"})
        return self.send_json(200, result)

    def compile(self, data):
        args = ["--json", "--trace"] if data.get("trace") else ["--json"]
        result = run_compiler(str(data.get("source", "")), *args)
        if not result.stdout.strip():
            return {"error": result.stderr.decode(errors="replace").strip() or "compiler produced no output"}
        return result.stdout

    def remote_config(self, data):
        """The laptop page publishes the current program's sensors (local only)."""
        if not self.is_local():
            raise ValueError("only the laptop can change the configuration")
        sensors = data.get("sensors")
        if not isinstance(sensors, list):
            raise ValueError("invalid configuration")
        REMOTE.config = {"sensors": sensors[:30], "program": str(data.get("program", ""))[:80],
                         "version": REMOTE.config["version"] + 1}
        return {"ok": True}

    def remote_state(self, data):
        """A phone changed a sensor: forward it to the laptop page."""
        name, value = str(data.get("name", "")), str(data.get("value", ""))
        if not SAFE_NAME.fullmatch(name) or not SAFE_ARG.fullmatch(value):
            raise ValueError("invalid sensor value")
        REMOTE.publish({"type": "sensor", "name": name, "value": value})
        return {"ok": True}

    def stream_events(self):
        """Server-Sent Events: pushes phone changes to the laptop page."""
        if not self.is_local():
            return self.send_json(403, {"error": "forbidden"})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = REMOTE.subscribe()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    event = q.get(timeout=15)
                    self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            REMOTE.unsubscribe(q)


class Server(ThreadingHTTPServer):
    daemon_threads = True


def port_taken(port):
    """True if something already answers on this port on the laptop. macOS lets a
    second server bind 0.0.0.0 next to one on 127.0.0.1, and the browser then
    talks to the old one, so check before starting."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


if __name__ == "__main__":
    try:
        if port_taken(PORT):
            raise OSError("port in use")
        server = Server((HOST, PORT), Handler)
    except OSError:
        raise SystemExit(
            f"Port {PORT} is already in use (is the server already running in another terminal?).\n"
            f"Stop it with Ctrl+C there, or use another port:  PORT=8080 python3 server.py"
        )
    s = ai.status()
    print(f"IoT DSL compiler running at http://127.0.0.1:{PORT}  (Ctrl+C to stop)")
    if LAN:
        print(f"Phone remote enabled: open the Remote button in the page, or http://{lan_ip()}:{PORT}/remote.html?k={REMOTE.key}")
    print(f"AI assistant: {s['provider']}" + (f" ({s['model']})" if s["model"] else ""))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
