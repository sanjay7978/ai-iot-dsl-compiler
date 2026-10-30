"""Collects real project numbers for the website, so nothing on it is invented.

Writes web/data/project.json:
  - test counts (from the last `make test` run, see tests/run_tests.sh)
  - size of the hand-written compiler, phases, targets, grammar facts
  - per-example compile results (tokens, IR before/after, warnings, errors)
  - the hero presets compiled by the real compiler (used when the server is offline)

Run:  python3 tools/project_stats.py      (make test runs it automatically)
"""
import json
import subprocess
import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IOTC = ROOT / "iotc"
OUT = ROOT / "web" / "data" / "project.json"

# English sentence + the DSL it means. The DSL is compiled by the real compiler below.
PRESETS = [
    {
        "id": "cooling",
        "label": "Cooling",
        "english": "If the temperature is above 30 and the door is open, turn on the fan, otherwise turn it off",
        "dsl": "SENSOR temperature : NUMBER\nSENSOR door : STATE\nDEVICE fan\n\n"
               "IF temperature > 30 AND door == OPEN\nTHEN turn_on(fan)\nELSE turn_off(fan)\n",
    },
    {
        "id": "irrigation",
        "label": "Irrigation",
        "english": "When soil moisture drops below 35 and it is not raining, run the pump at 80 percent, otherwise stop it",
        "dsl": "SENSOR soil_moisture : NUMBER\nSENSOR rain : STATE\nDEVICE pump\n\n"
               "IF soil_moisture < 35 AND rain == FALSE\nTHEN set_level(pump, 80)\nELSE turn_off(pump)\n",
    },
    {
        "id": "security",
        "label": "Night security",
        "english": "If there is motion and the light level is below 20, turn on the porch light and the alarm",
        "dsl": "SENSOR motion : STATE\nSENSOR light_level : NUMBER\nDEVICE porch_light, alarm\n\n"
               "IF motion == ON AND light_level < 20\nTHEN turn_on(porch_light)\n     turn_on(alarm)\n"
               "ELSE turn_off(porch_light)\n",
    },
]


def compile_source(source):
    out = subprocess.run([str(IOTC), "--json"], input=source, capture_output=True, text=True, timeout=20)
    return json.loads(out.stdout)


def source_size():
    files = sorted((ROOT / "src").glob("*.cpp")) + sorted((ROOT / "src").glob("*.h"))
    lines = sum(len(p.read_text(encoding="utf-8").splitlines()) for p in files)
    return {"files": len(files), "lines": lines}


def web_size():
    files = [p for p in (ROOT / "web").rglob("*") if p.is_file() and p.suffix in {".js", ".css", ".html"}]
    return {"files": len(files), "lines": sum(len(p.read_text(encoding="utf-8").splitlines()) for p in files)}


def python_test_count():
    suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"))
    return suite.countTestCases()


def shell_checks():
    summary = ROOT / "build" / "test-summary.json"
    if summary.exists():
        return json.loads(summary.read_text())
    return None


def main():
    if not IOTC.exists():
        sys.exit("build the compiler first: make")
    language = json.loads(subprocess.run([str(IOTC), "--language"], capture_output=True, text=True,
                                         stdin=subprocess.DEVNULL).stdout)
    grammar = language["grammar"]

    examples = []
    for path in sorted((ROOT / "examples").glob("*.iot")):
        r = compile_source(path.read_text(encoding="utf-8"))
        examples.append({
            "name": path.stem,
            "tokens": r["stats"]["tokens"],
            "rules": r["stats"]["rules"],
            "errors": r["stats"]["errors"],
            "warnings": r["stats"]["warnings"],
            "irBefore": r["stats"]["irBefore"],
            "irAfter": r["stats"]["irAfter"],
            "passes": [{"name": p["name"], "count": p["count"]} for p in r["optimization"].get("passes", [])],
            "phases": {p["id"]: p["status"] for p in r["phases"]},
        })

    presets = []
    for p in PRESETS:
        r = compile_source(p["dsl"])
        if r["stats"]["errors"]:
            sys.exit(f"preset {p['id']} does not compile: {r['errors']}")
        presets.append({**p, "result": r})

    shell = shell_checks()
    py_tests = python_test_count()
    data = {
        "generated": date.today().isoformat(),
        "phases": 7,
        "targets": [t["name"] for t in presets[0]["result"]["targets"]],
        "compiler": source_size(),
        "web": web_size(),
        "grammar": {
            "productions": len(grammar["productions"]),
            "nonterminals": len(grammar["nonterminals"]),
            "terminals": len(grammar["terminals"]),
            "conflicts": len(grammar["conflicts"]),
        },
        "dfaStates": len(language["dfa"]["states"]),
        "tests": {
            "shellPassed": shell["passed"] if shell else None,
            "shellFailed": shell["failed"] if shell else None,
            "python": py_tests,
            "total": (shell["passed"] + py_tests) if shell else None,
        },
        "examples": examples,
        "presets": presets,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {data['tests']['total']} tests, "
          f"{data['compiler']['lines']} compiler lines, {len(examples)} examples")


if __name__ == "__main__":
    main()
