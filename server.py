"""Local web server for the IoT DSL compiler.

This file is only glue: it serves the web page in web/, passes source text to
the C++ compiler (./iotc --json), builds and runs the generated C code, and
forwards AI requests to ai.py. All compilation happens in C++.

Run:  make run      (or: python3 server.py)
Open: http://127.0.0.1:8000
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import ai

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
EXAMPLES_DIR = ROOT / "examples"
RUNTIME_DIR = ROOT / "runtime"
COMPILER = ROOT / "iotc"
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY_BYTES = 100_000


def run_compiler(source, *args):
    return subprocess.run([str(COMPILER), *args], input=source.encode("utf-8"),
                          capture_output=True, timeout=10)


def build_and_run(source, inputs):
    """Compiles the DSL to C, builds it with the runtime and runs it with the sensor values."""
    cc = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
    if not cc:
        return {"ok": False, "error": "No C compiler found (install Xcode command line tools or gcc)."}

    gen = run_compiler(source, "--c")
    if gen.returncode != 0 or not gen.stdout:
        return {"ok": False, "error": "The program has errors, so no C code was generated."}

    args = []
    for name, value in (inputs or {}).items():
        name, value = str(name), str(value)
        if re.fullmatch(r"[A-Za-z_]\w*", name) and re.fullmatch(r"[A-Za-z0-9_.\-]+", value):
            args.append(f"{name}={value}")

    with tempfile.TemporaryDirectory(prefix="iotc-") as tmp:
        c_file = Path(tmp) / "program.c"
        exe = Path(tmp) / "program"
        c_file.write_bytes(gen.stdout)
        build = subprocess.run([cc, "-std=c99", "-Wall", "-I", str(RUNTIME_DIR), str(c_file),
                                str(RUNTIME_DIR / "iot_runtime.c"), "-o", str(exe)],
                               capture_output=True, timeout=30)
        if build.returncode != 0:
            return {"ok": False, "error": "C compilation failed:\n" + build.stderr.decode(errors="replace")}
        run = subprocess.run([str(exe), *args], capture_output=True, timeout=5)

    return {
        "ok": True,
        "output": run.stdout.decode(errors="replace"),
        "stderr": run.stderr.decode(errors="replace"),
        "commands": [
            "iotc program.iot -o program.c",
            "cc -std=c99 -Wall -Iruntime program.c runtime/iot_runtime.c -o program",
            "./program " + " ".join(args),
        ],
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet during the demo

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

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

    def do_GET(self):
        if self.path == "/api/examples":
            examples = [{"name": p.stem, "source": p.read_text(encoding="utf-8")}
                        for p in sorted(EXAMPLES_DIR.glob("*.iot"))]
            return self.send_json(200, examples)
        if self.path == "/api/ai-status":
            return self.send_json(200, ai.status())
        return super().do_GET()

    def do_POST(self):
        routes = {
            "/api/compile": self.compile,
            "/api/run": lambda d: build_and_run(str(d.get("source", "")), d.get("inputs")),
            "/api/nl2dsl": lambda d: ai.nl_to_dsl(str(d.get("text", "")), str(d.get("context", ""))),
            "/api/explain": lambda d: ai.explain(str(d.get("source", "")), d.get("error") or {}),
        }
        handler = routes.get(self.path)
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
        result = run_compiler(str(data.get("source", "")), "--json")
        if not result.stdout.strip():
            return {"error": result.stderr.decode(errors="replace").strip() or "compiler produced no output"}
        return result.stdout


if __name__ == "__main__":
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        raise SystemExit(
            f"Port {PORT} is already in use (is the server already running in another terminal?).\n"
            f"Stop it with Ctrl+C there, or use another port:  PORT=8080 python3 server.py"
        )
    s = ai.status()
    print(f"IoT DSL compiler running at http://{HOST}:{PORT}  (Ctrl+C to stop)")
    print(f"AI assistant: {s['provider']}" + (f" ({s['model']})" if s["model"] else ""))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
