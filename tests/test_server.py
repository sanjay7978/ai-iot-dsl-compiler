"""Unit tests for server.py: the phone-remote access rules and the build-and-run helper."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


def handler(address, path):
    """A request handler without a socket, for testing the access rules."""
    h = server.Handler.__new__(server.Handler)
    h.client_address = (address, 50000)
    h.path = path
    return h


class RemoteAccessTest(unittest.TestCase):
    key = server.REMOTE.key

    def test_laptop_can_use_everything(self):
        self.assertTrue(handler("127.0.0.1", "/api/compile").allowed())
        self.assertTrue(handler("::1", "/index.html").allowed())

    def test_phone_needs_the_key(self):
        self.assertFalse(handler("192.168.1.20", "/remote.html").allowed())
        self.assertFalse(handler("192.168.1.20", "/remote.html?k=wrong").allowed())
        self.assertTrue(handler("192.168.1.20", f"/remote.html?k={self.key}").allowed())

    def test_phone_cannot_reach_the_compiler_or_ai(self):
        for path in ("/api/compile", "/api/run", "/api/nl2dsl", "/api/fix", "/index.html", "/api/remote/events"):
            self.assertFalse(handler("192.168.1.20", f"{path}?k={self.key}").allowed(), path)

    def test_phone_can_send_sensor_values(self):
        self.assertTrue(handler("10.0.0.7", f"/api/remote/state?k={self.key}").allowed())
        self.assertTrue(handler("10.0.0.7", f"/api/remote/config?k={self.key}").allowed())


class BuildAndRunTest(unittest.TestCase):
    source = "SENSOR t : NUMBER\nDEVICE fan\nIF t > 30 THEN turn_on(fan) ELSE turn_off(fan)\n"

    def run_target(self, target, t):
        result = server.build_and_run(self.source, {"t": t}, target)
        self.assertTrue(result["ok"], result.get("error"))
        return result["output"]

    def test_targets_agree(self):
        for t in ("31", "12.5"):
            c = self.run_target("c", t)
            self.assertEqual(c, self.run_target("python", t))
            if server.shutil.which("node"):
                self.assertEqual(c, self.run_target("js", t))
        self.assertIn("fan          ON", self.run_target("c", "31"))

    def test_bad_inputs_are_ignored(self):
        out = server.build_and_run(self.source, {"t; rm -rf /": "1", "t": "$(x)"}, "python")
        self.assertTrue(out["ok"])
        self.assertIn("warning: no value for sensor 't'", out["stderr"])

    def test_arduino_is_not_runnable(self):
        self.assertFalse(server.build_and_run(self.source, {}, "arduino")["ok"])

    def test_language_json(self):
        data = json.loads(server.language())
        self.assertEqual(data["grammar"]["conflicts"], [])
        self.assertIn("START", [s["id"] for s in data["dfa"]["states"]])


if __name__ == "__main__":
    unittest.main()
