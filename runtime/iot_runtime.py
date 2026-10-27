"""iot_runtime.py: simulated sensors and devices for iotc-generated Python programs.

Usage: python3 program.py temperature=32 door=OPEN motion=ON
Every device starts OFF; evaluate_rules() runs once; the final device states
are printed. The output format matches the C runtime (runtime/iot_runtime.c).
"""

import sys

STATE_UNKNOWN, STATE_ON, STATE_OFF = "UNKNOWN", "ON", "OFF"
STATE_OPEN, STATE_CLOSED, STATE_TRUE, STATE_FALSE = "OPEN", "CLOSED", "TRUE", "FALSE"
_STATES = {STATE_ON, STATE_OFF, STATE_OPEN, STATE_CLOSED, STATE_TRUE, STATE_FALSE}

_args = {}
_names = []
_on = []
_level = []


def _lookup(name):
    return _args.get(name)


def read_number(sensor):
    value = _lookup(sensor)
    if value is None:
        print(f"warning: no value for sensor '{sensor}', using 0", file=sys.stderr)
        return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


def read_state(sensor):
    value = _lookup(sensor)
    if value is None:
        print(f"warning: no value for sensor '{sensor}', using UNKNOWN", file=sys.stderr)
        return STATE_UNKNOWN
    if value.upper() in _STATES:
        return value.upper()
    print(f"warning: unknown state '{value}' for sensor '{sensor}'", file=sys.stderr)
    return STATE_UNKNOWN


def _valid(d):
    return 0 <= d < len(_names)


def turn_on(d):
    if not _valid(d):
        return
    _on[d] = True
    if _level[d] == 0:
        _level[d] = 100
    print(f"  turn_on({_names[d]})")


def turn_off(d):
    if not _valid(d):
        return
    _on[d] = False
    _level[d] = 0
    print(f"  turn_off({_names[d]})")


def toggle(d):
    if not _valid(d):
        return
    _on[d] = not _on[d]
    _level[d] = 100 if _on[d] else 0
    print(f"  toggle({_names[d]})")


def set_level(d, level):
    if not _valid(d):
        return
    _level[d] = level
    _on[d] = level > 0
    print(f"  set_level({_names[d]}, {level:g})")


def run(evaluate_rules, device_names, argv=None):
    argv = sys.argv[1:] if argv is None else argv
    for arg in argv:
        if "=" in arg:
            name, value = arg.split("=", 1)
            _args.setdefault(name, value)
    _names[:] = list(device_names)
    _on[:] = [False] * len(_names)
    _level[:] = [0] * len(_names)

    print("Actions:")
    evaluate_rules()
    print("Device states:")
    for d, name in enumerate(_names):
        if _on[d] and _level[d] != 100:
            print(f"  {name:<12} ON (level {_level[d]:g})")
        else:
            print(f"  {name:<12} {'ON' if _on[d] else 'OFF'}")
