"""English-to-DSL benchmark for the Review III paper.

For each English rule we have a hand-written reference DSL program. Four
pipelines are compared:
  A  offline rule-based converter only
  B  LLM, raw answer (no checking)
  C  LLM + compile check with one compiler-guided repair
  D  full Kelvin gate: compile check + meaning check, repair, offline fallback
An answer is "correct" when its compiled program sets every reference device to
the same state as the reference program on a set of test inputs built around
the constants in the reference (c-1, c, c+1 for numbers; every value for states).
"""
import itertools, json, re, subprocess, sys, time, tempfile, os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import ai  # noqa: E402

IOTC = str(ROOT / "iotc")
RUNTIME = ROOT / "runtime" / "iot_runtime.py"

BENCH = [
    ("If the temperature is above 30 and the door is open, turn on the fan",
     "SENSOR temperature : NUMBER\nSENSOR door : STATE\nDEVICE fan\nIF temperature > 30 AND door == OPEN THEN turn_on(fan)"),
    ("if the temperature is above 30 and the door is open, turn on the fan",
     "SENSOR temperature : NUMBER\nSENSOR door : STATE\nDEVICE fan\nIF temperature > 30 AND door == OPEN THEN turn_on(fan)"),
    ("When humidity is below 40 turn on the humidifier, otherwise turn it off",
     "SENSOR humidity : NUMBER\nDEVICE humidifier\nIF humidity < 40 THEN turn_on(humidifier) ELSE turn_off(humidifier)"),
    ("If the soil moisture is below 35, turn on the pump",
     "SENSOR soil_moisture : NUMBER\nDEVICE pump\nIF soil_moisture < 35 THEN turn_on(pump)"),
    ("If motion is detected, turn on the light",
     "SENSOR motion : STATE\nDEVICE light\nIF motion == ON THEN turn_on(light)"),
    ("If the window is open, turn off the heater",
     "SENSOR window : STATE\nDEVICE heater\nIF window == OPEN THEN turn_off(heater)"),
    ("If the temperature is below 18, turn on the heater, otherwise turn off the heater",
     "SENSOR temperature : NUMBER\nDEVICE heater\nIF temperature < 18 THEN turn_on(heater) ELSE turn_off(heater)"),
    ("If the light level is below 20 and motion is on, turn on the porch light",
     "SENSOR light_level : NUMBER\nSENSOR motion : STATE\nDEVICE porch_light\nIF light_level < 20 AND motion == ON THEN turn_on(porch_light)"),
    ("If the gas level is above 300 or the smoke is above 70, turn on the alarm",
     "SENSOR gas_level : NUMBER\nSENSOR smoke : NUMBER\nDEVICE alarm\nIF gas_level > 300 OR smoke > 70 THEN turn_on(alarm)"),
    ("Set the fan to level 50 when the temperature is above 26",
     "SENSOR temperature : NUMBER\nDEVICE fan\nIF temperature > 26 THEN set_level(fan, 50)"),
    ("If the co2 is above 1000, turn on the vent, otherwise turn off the vent",
     "SENSOR co2 : NUMBER\nDEVICE vent\nIF co2 > 1000 THEN turn_on(vent) ELSE turn_off(vent)"),
    ("If it is raining, turn off the sprinkler",
     "SENSOR rain : STATE\nDEVICE sprinkler\nIF rain == TRUE THEN turn_off(sprinkler)"),
    ("If the door is closed and the alarm switch is on, turn on the lock",
     "SENSOR door : STATE\nSENSOR alarm_switch : STATE\nDEVICE lock\nIF door == CLOSED AND alarm_switch == ON THEN turn_on(lock)"),
    ("If the temperature is above 35 or the humidity is above 80, turn on the ac",
     "SENSOR temperature : NUMBER\nSENSOR humidity : NUMBER\nDEVICE ac\nIF temperature > 35 OR humidity > 80 THEN turn_on(ac)"),
    ("If the water level is below 10, turn off the pump",
     "SENSOR water_level : NUMBER\nDEVICE pump\nIF water_level < 10 THEN turn_off(pump)"),
    ("When the light level is above 600, turn off the lamp, otherwise turn on the lamp",
     "SENSOR light_level : NUMBER\nDEVICE lamp\nIF light_level > 600 THEN turn_off(lamp) ELSE turn_on(lamp)"),
    ("If the temperature is above 28 and the window is closed, turn on the fan and turn off the heater",
     "SENSOR temperature : NUMBER\nSENSOR window : STATE\nDEVICE fan, heater\nIF temperature > 28 AND window == CLOSED THEN turn_on(fan) turn_off(heater)"),
    ("If the soil moisture is below 30 and it is not raining, turn on the pump",
     "SENSOR soil_moisture : NUMBER\nSENSOR rain : STATE\nDEVICE pump\nIF soil_moisture < 30 AND rain == FALSE THEN turn_on(pump)"),
    ("If motion is off, turn off the light",
     "SENSOR motion : STATE\nDEVICE light\nIF motion == OFF THEN turn_off(light)"),
    ("If the pressure is above 120, turn on the valve",
     "SENSOR pressure : NUMBER\nDEVICE valve\nIF pressure > 120 THEN turn_on(valve)"),
    ("Turn on the buzzer if the noise is above 85",
     "SENSOR noise : NUMBER\nDEVICE buzzer\nIF noise > 85 THEN turn_on(buzzer)"),
    ("If the battery is below 15, turn off the display",
     "SENSOR battery : NUMBER\nDEVICE display\nIF battery < 15 THEN turn_off(display)"),
    ("If the temperature is above 40, turn on the cooler and the alarm",
     "SENSOR temperature : NUMBER\nDEVICE cooler, alarm\nIF temperature > 40 THEN turn_on(cooler) turn_on(alarm)"),
    ("If the garage door is open and the light level is below 10, turn on the garage light",
     "SENSOR garage_door : STATE\nSENSOR light_level : NUMBER\nDEVICE garage_light\nIF garage_door == OPEN AND light_level < 10 THEN turn_on(garage_light)"),
    ("If the occupancy is 0, turn off the ac",
     "SENSOR occupancy : NUMBER\nDEVICE ac\nIF occupancy == 0 THEN turn_off(ac)"),
    ("If the humidity is above 70, turn on the dehumidifier, otherwise turn it off",
     "SENSOR humidity : NUMBER\nDEVICE dehumidifier\nIF humidity > 70 THEN turn_on(dehumidifier) ELSE turn_off(dehumidifier)"),
    ("If the temperature is at least 25, turn on the fan",
     "SENSOR temperature : NUMBER\nDEVICE fan\nIF temperature >= 25 THEN turn_on(fan)"),
    ("If the temperature is at most 15, turn on the heater",
     "SENSOR temperature : NUMBER\nDEVICE heater\nIF temperature <= 15 THEN turn_on(heater)"),
    ("If the front door is open or motion is on, turn on the camera",
     "SENSOR front_door : STATE\nSENSOR motion : STATE\nDEVICE camera\nIF front_door == OPEN OR motion == ON THEN turn_on(camera)"),
    ("If the temperature is above 30 and the humidity is below 40, set the humidifier to level 60",
     "SENSOR temperature : NUMBER\nSENSOR humidity : NUMBER\nDEVICE humidifier\nIF temperature > 30 AND humidity < 40 THEN set_level(humidifier, 60)"),
]


def compile_json(src):
    out = subprocess.run([IOTC, "--json"], input=src, capture_output=True, text=True, timeout=10).stdout
    return json.loads(out)


def to_python(src, path):
    r = subprocess.run([IOTC, "--target", "python", "-o", path], input=src, capture_output=True, text=True, timeout=10)
    return r.returncode == 0


def device_states(py, inputs):
    args = [f"{k}={v}" for k, v in inputs.items()]
    out = subprocess.run([sys.executable, py, *args], capture_output=True, text=True, timeout=10, cwd=os.path.dirname(py)).stdout
    states = {}
    if "Device states:" in out:
        for line in out.split("Device states:")[1].strip().splitlines():
            parts = line.split()
            if len(parts) >= 2:
                states[parts[0]] = " ".join(parts[1:])
    return states


def test_inputs(ref_result):
    sensors = [s for s in ref_result["symbols"] if s["kind"] == "sensor"]
    nums = {t["lexeme"] for t in ref_result["tokens"] if t["category"] == "number"}
    domain = {}
    for s in sensors:
        if s["type"] == "NUMBER":
            vals = set()
            for n in nums:
                v = float(n)
                vals.update([v - 1, v, v + 1])
            domain[s["name"]] = sorted(vals) or [0.0]
        else:
            # the natural pair of values for this sensor, from the literals the reference uses
            lits = {t["lexeme"] for t in ref_result["tokens"] if t["category"] == "state"}
            pairs = [("ON", "OFF"), ("OPEN", "CLOSED"), ("TRUE", "FALSE")]
            used = [p for p in pairs if lits & set(p)] or pairs
            domain[s["name"]] = sorted({v for p in used for v in p})
    names = list(domain)
    combos = list(itertools.product(*[domain[n] for n in names]))
    if len(combos) > 60:
        step = len(combos) / 60
        combos = [combos[int(i * step)] for i in range(60)]
    return [dict(zip(names, c)) for c in combos]


def correct(candidate, ref_src, tmp):
    if not candidate:
        return False
    r = compile_json(candidate)
    if r["stats"]["errors"]:
        return False
    ref = compile_json(ref_src)
    rp, cp = os.path.join(tmp, "ref.py"), os.path.join(tmp, "cand.py")
    if not (to_python(ref_src, rp) and to_python(candidate, cp)):
        return False
    ref_devices = [s["name"] for s in ref["symbols"] if s["kind"] == "device"]
    for inp in test_inputs(ref):
        a, b = device_states(rp, inp), device_states(cp, inp)
        if any(a.get(d) != b.get(d) for d in ref_devices):
            return False
    return True


def main():
    provider = ai.get_provider()
    print("provider:", provider.name if provider else None, getattr(provider, "model", None), flush=True)
    tmp = tempfile.mkdtemp()
    for f in ("iot_runtime.py",):
        Path(tmp, f).write_text(RUNTIME.read_text())
    rows = []
    for i, (text, ref) in enumerate(BENCH, 1):
        row = {"id": i, "text": text}
        # A: offline
        t = time.perf_counter(); off, _ = ai.offline_nl_to_dsl(text); row["A_ms"] = (time.perf_counter() - t) * 1000
        row["A_ok"] = correct(off, ref, tmp); row["A_compiles"] = bool(off) and not compile_json(off)["stats"]["errors"]
        # B: raw LLM
        user = f"English: {text}\nDSL:"
        t = time.perf_counter(); raw = ai.clean_output(provider.chat(ai.NL2DSL_SYSTEM, user)); tb = time.perf_counter() - t
        rb = compile_json(raw)
        row["B_s"] = tb; row["B_compiles"] = not rb["stats"]["errors"]; row["B_ok"] = correct(raw, ref, tmp)
        row["B_meaning_issues"] = [] if rb["stats"]["errors"] else ai.meaning_problems(text, rb)
        # C: compile check + one repair
        c_dsl, tc = raw, tb
        errs = [e for e in rb["errors"] if e["severity"] == "error"]
        if errs:
            msgs = "\n".join(f"- line {e['line']}: {e['message']}" for e in errs)
            t = time.perf_counter()
            c_dsl = ai.clean_output(provider.chat(ai.NL2DSL_SYSTEM, f"{user}\n{raw}\nThe compiler reported these errors:\n{msgs}\nReply with the corrected complete DSL only."))
            tc += time.perf_counter() - t
        row["C_s"] = tc; row["C_compiles"] = not compile_json(c_dsl)["stats"]["errors"]; row["C_ok"] = correct(c_dsl, ref, tmp)
        row["C_repaired"] = bool(errs)
        # D: full gate (same logic as ai.nl_to_dsl, reusing the first answer)
        d_dsl, td, source = raw, tb, "llm"
        issues = [f"line {e['line']}: {e['message']}" for e in errs] or ai.meaning_problems(text, rb)
        if issues:
            msgs = "\n".join(f"- {m}" for m in issues)
            t = time.perf_counter()
            d_dsl = ai.clean_output(provider.chat(ai.NL2DSL_SYSTEM, f"{user}\n{raw}\nThe compiler found these problems:\n{msgs}\nTranslate the whole English sentence, keeping every condition and number. Reply with the corrected complete DSL only."))
            td += time.perf_counter() - t
        rd = compile_json(d_dsl)
        lost = [] if rd["stats"]["errors"] else ai.meaning_problems(text, rd)
        if rd["stats"]["errors"] or lost:
            if off and not compile_json(off)["stats"]["errors"] and not ai.meaning_problems(text, compile_json(off)):
                d_dsl, source = off, "offline"
        row["D_s"] = td; row["D_compiles"] = not compile_json(d_dsl)["stats"]["errors"]; row["D_ok"] = correct(d_dsl, ref, tmp)
        row["D_triggered"] = bool(issues); row["D_source"] = source
        row["dsl"] = {"A": off, "B": raw, "C": c_dsl, "D": d_dsl}
        rows.append(row)
        print(i, {k: v for k, v in row.items() if k.endswith("ok") or k in ("D_triggered", "D_source", "C_repaired")}, f"B {tb:.1f}s", flush=True)
    Path(__file__).with_name("nl_benchmark_results.json").write_text(json.dumps(rows, indent=1))
    n = len(rows)
    for k in "ABCD":
        ok = sum(r[f"{k}_ok"] for r in rows); comp = sum(r[f"{k}_compiles"] for r in rows)
        print(f"{k}: correct {ok}/{n} ({100*ok/n:.0f}%), compiles {comp}/{n}")


if __name__ == "__main__":
    main()
