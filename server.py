"""Local web server for the IoT DSL compiler demo.

This file is only glue: it serves the web page in web/ and passes the source
text to the C++ compiler (./iotc --json). All compilation happens in C++.

Run:  make run      (or: python3 server.py)
Open: http://127.0.0.1:8000
"""

import json
import os
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
EXAMPLES_DIR = ROOT / "examples"
COMPILER = ROOT / "iotc"
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8000"))
MAX_SOURCE_BYTES = 100_000


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet during the demo

    def send_json(self, status, payload):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/examples":
            examples = [
                {"name": p.stem, "source": p.read_text(encoding="utf-8")}
                for p in sorted(EXAMPLES_DIR.glob("*.iot"))
            ]
            return self.send_json(200, examples)
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/compile":
            return self.send_json(404, {"error": "not found"})

        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_SOURCE_BYTES:
            return self.send_json(413, {"error": "program is too large"})
        try:
            source = json.loads(self.rfile.read(length) or b"{}").get("source", "")
        except (ValueError, AttributeError):
            return self.send_json(400, {"error": "invalid request"})

        if not COMPILER.exists():
            return self.send_json(500, {"error": "compiler not built - run 'make' first"})
        try:
            result = subprocess.run(
                [str(COMPILER), "--json"],
                input=source.encode("utf-8"),
                capture_output=True,
                timeout=5,
            )
        except subprocess.TimeoutExpired:
            return self.send_json(500, {"error": "compiler timed out"})

        if not result.stdout.strip():
            msg = result.stderr.decode(errors="replace").strip() or "compiler produced no output"
            return self.send_json(500, {"error": msg})
        return self.send_json(200, result.stdout)


if __name__ == "__main__":
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        raise SystemExit(
            f"Port {PORT} is already in use (is the server already running in another terminal?).\n"
            f"Stop it with Ctrl+C there, or use another port:  PORT=8080 python3 server.py"
        )
    print(f"IoT DSL compiler running at http://{HOST}:{PORT}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
