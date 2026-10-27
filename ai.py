"""AI assistance for the IoT DSL compiler (natural language -> DSL, error explanations).

The AI never replaces the compiler: everything it writes is checked by
./iotc, and if the compiler reports errors the AI gets one chance to repair
its answer using those error messages.

Free providers, chosen automatically in this order (override with AI_PROVIDER):
  groq    - needs GROQ_API_KEY      (free tier, https://console.groq.com)
  gemini  - needs GEMINI_API_KEY    (free tier, https://aistudio.google.com)
  ollama  - local model, no key     (https://ollama.com, e.g. `ollama pull qwen3`)
  offline - built-in rule-based converter, always available
Settings are read from environment variables or a local .env file.
Only the Python standard library is used.
"""

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
COMPILER = ROOT / "iotc"


# --------------------------------------------------------------------------- config

def load_env(path=ROOT / ".env"):
    """Loads KEY=VALUE lines from .env without overriding real environment variables."""
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()


class AIError(Exception):
    pass


def _post_json(url, payload, headers=None, timeout=90):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        raise AIError(f"HTTP {e.code}: {body}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise AIError(str(e)) from e


# ------------------------------------------------------------------------ providers

class Groq:
    name = "Groq"

    def __init__(self):
        self.key = os.environ["GROQ_API_KEY"]
        self.model = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")

    def chat(self, system, user):
        data = _post_json(
            "https://api.groq.com/openai/v1/chat/completions",
            {"model": self.model, "temperature": 0,
             "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]},
            headers={"Authorization": f"Bearer {self.key}"},
        )
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as e:
            raise AIError("unexpected Groq response") from e


class Gemini:
    name = "Gemini"

    def __init__(self):
        self.key = os.environ["GEMINI_API_KEY"]
        self.model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

    def chat(self, system, user):
        data = _post_json(
            f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent",
            {"systemInstruction": {"parts": [{"text": system}]},
             "contents": [{"role": "user", "parts": [{"text": user}]}],
             "generationConfig": {"temperature": 0}},
            headers={"x-goog-api-key": self.key},
        )
        try:
            return "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])
        except (KeyError, IndexError) as e:
            raise AIError("unexpected Gemini response") from e


class Ollama:
    name = "Ollama"

    def __init__(self, model):
        self.host = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
        self.model = model

    @staticmethod
    def installed_models():
        host = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
        try:
            with urllib.request.urlopen(host + "/api/tags", timeout=1.5) as resp:
                return [m["name"] for m in json.loads(resp.read()).get("models", [])]
        except (urllib.error.URLError, OSError, ValueError, KeyError):
            return []

    def chat(self, system, user):
        payload = {"model": self.model, "stream": False, "think": False,
                   "options": {"temperature": 0},
                   "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        try:
            data = _post_json(self.host + "/api/chat", payload, timeout=180)
        except AIError as e:
            if "think" not in str(e):
                raise
            payload.pop("think")          # older Ollama versions don't know "think"
            data = _post_json(self.host + "/api/chat", payload, timeout=180)
        if "error" in data:
            raise AIError(data["error"])
        return data.get("message", {}).get("content", "")


_cache = {"time": 0.0, "provider": None}


def get_provider():
    """Returns the provider to use, or None for offline mode. Cached for 30 s."""
    if time.time() - _cache["time"] < 30:
        return _cache["provider"]

    wanted = os.environ.get("AI_PROVIDER", "auto").lower()
    provider = None
    if wanted in ("auto", "groq") and os.environ.get("GROQ_API_KEY"):
        provider = Groq()
    elif wanted in ("auto", "gemini") and os.environ.get("GEMINI_API_KEY"):
        provider = Gemini()
    elif wanted in ("auto", "ollama"):
        models = Ollama.installed_models()
        if models:   # Ollama is running and has at least one model
            provider = Ollama(os.environ.get("OLLAMA_MODEL") or models[0])

    _cache.update(time=time.time(), provider=provider)
    return provider


def status():
    p = get_provider()
    if p is None:
        return {"mode": "offline", "provider": "Offline rules", "model": None}
    return {"mode": "llm", "provider": p.name, "model": p.model}


# --------------------------------------------------------------------- compiler check

def compile_check(source):
    """Runs the real compiler on `source` and returns its JSON result."""
    result = subprocess.run([str(COMPILER), "--json"], input=source.encode("utf-8"),
                            capture_output=True, timeout=10)
    try:
        return json.loads(result.stdout)
    except ValueError:
        return {"success": False, "errors": [{"line": 0, "col": 0, "message": "compiler did not run",
                                              "severity": "error", "phase": "internal"}]}


def _errors(result):
    return [e for e in result.get("errors", []) if e.get("severity") == "error"]


# ---------------------------------------------------------------------- NL -> DSL

LANGUAGE_REFERENCE = """IoT DSL reference:
- Declarations:  SENSOR <name> : NUMBER    SENSOR <name> : STATE    DEVICE <name>, <name>
- Rule:          IF <condition> THEN <action> [<action> ...] { ELSE IF <condition> THEN <action> ... } [ELSE <action> ...]
- Condition:     <value> <op> <value>, where op is > < >= <= == != ; combine with AND, OR, NOT and ( ).
- Arithmetic:    NUMBER values may use + - * / and parentheses, e.g. temperature - outside > 5.
- NUMBER sensors are compared with numbers (decimals allowed).
- STATE sensors are compared only with == or != against ON, OFF, OPEN, CLOSED, TRUE, FALSE.
- Actions:       turn_on(device)  turn_off(device)  toggle(device)  set_level(device, number expression 0-100)
- Names use lowercase letters, digits and underscores (e.g. soil_moisture). Keywords are UPPERCASE.
- Every sensor and device that a rule uses must be declared."""

NL2DSL_SYSTEM = f"""You convert IoT automation requirements written in English into the IoT DSL below.
Reply with DSL code only: no explanations, no markdown, no code fences.

{LANGUAGE_REFERENCE}

Example
English: If the temperature is above 30 degrees and the door is open, turn on the fan.
DSL:
SENSOR temperature : NUMBER
SENSOR door : STATE
DEVICE fan

IF temperature > 30 AND door == OPEN
THEN turn_on(fan)

Example
English: When motion is detected or humidity drops below 40, switch on the light and set the AC to 22. Otherwise switch the light off.
DSL:
SENSOR motion : STATE
SENSOR humidity : NUMBER
DEVICE light, ac

IF motion == ON OR humidity < 40
THEN turn_on(light)
     set_level(ac, 22)
ELSE turn_off(light)

Example
English: If the window is open turn the heater off, else if it is colder than 18 heat at 10 times the difference to 22, otherwise turn the heater off.
DSL:
SENSOR window : STATE
SENSOR temperature : NUMBER
DEVICE heater

IF window == OPEN
THEN turn_off(heater)
ELSE IF temperature < 18
THEN set_level(heater, (22 - temperature) * 10)
ELSE turn_off(heater)"""

DECL_RE = re.compile(r"^\s*(SENSOR\s+\w+\s*:\s*(?:NUMBER|STATE)|DEVICE\s+\w+(?:\s*,\s*\w+)*)\s*$", re.M)


def existing_declarations(source):
    return [m.group(1).strip() for m in DECL_RE.finditer(source or "")]


def clean_output(text):
    """Strips thinking blocks, code fences and chatter from a model reply."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S | re.I)
    fence = re.search(r"```[a-zA-Z]*\n(.*?)```", text, flags=re.S)
    if fence:
        text = fence.group(1)
    lines = [ln.rstrip() for ln in text.strip().splitlines()]
    while lines and not re.match(r"^\s*(SENSOR|DEVICE|IF|#)\b", lines[0]):
        lines.pop(0)                        # drop "Here is the DSL:" and similar
    if lines and lines[0].strip().upper() == "DSL:":
        lines.pop(0)
    return "\n".join(lines).strip() + "\n" if lines else ""


def nl_to_dsl(text, context=""):
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "Please describe a rule in English first."}

    provider = get_provider()
    note = None
    if provider is not None:
        decls = existing_declarations(context)
        user = ""
        if decls:
            user += ("Names already declared in the user's program (reuse these names when they mean "
                     "the same thing):\n" + "\n".join(decls) + "\n\n")
        user += f"English: {text}\nDSL:"
        try:
            dsl = clean_output(provider.chat(NL2DSL_SYSTEM, user))
            result = compile_check(dsl)
            attempts = 1
            if _errors(result):            # one repair attempt using the compiler's messages
                msgs = "\n".join(f"- line {e['line']}: {e['message']}" for e in _errors(result))
                repair = (f"{user}\n{dsl}\nThe compiler reported these errors:\n{msgs}\n"
                          "Reply with the corrected complete DSL only.")
                dsl = clean_output(provider.chat(NL2DSL_SYSTEM, repair))
                result = compile_check(dsl)
                attempts = 2
            return {"ok": True, "dsl": dsl, "provider": provider.name, "model": provider.model,
                    "attempts": attempts, "valid": not _errors(result),
                    "errors": [e["message"] for e in _errors(result)]}
        except (AIError, subprocess.TimeoutExpired) as e:
            note = f"{provider.name} was unavailable ({str(e)[:120]}), so the offline converter was used."

    dsl, error = offline_nl_to_dsl(text)
    if dsl is None:
        return {"ok": False, "error": error, "provider": "Offline rules", "note": note}
    result = compile_check(dsl)
    return {"ok": True, "dsl": dsl, "provider": "Offline rules", "model": None, "attempts": 1,
            "valid": not _errors(result), "errors": [e["message"] for e in _errors(result)], "note": note}


# --------------------------------------------------------------- offline converter

_NUMBER = r"(-?\d+(?:\.\d+)?)"
_NUM_OPS = [   # longest phrases first
    (r"greater than or equal to|more than or equal to|at least|not below|>=", ">="),
    (r"less than or equal to|at most|not above|<=", "<="),
    (r"not equal to|is not|isn't|!=", "!="),
    (r"above|over|greater than|more than|higher than|exceeds|exceeding|rises above|goes above|>", ">"),
    (r"below|under|less than|lower than|drops below|falls below|goes below|<", "<"),
    (r"equal to|equals|exactly|is|==|=", "=="),
]
_STATES = {"open": "OPEN", "opened": "OPEN", "closed": "CLOSED", "shut": "CLOSED", "on": "ON",
           "off": "OFF", "true": "TRUE", "false": "FALSE", "detected": "ON", "active": "ON",
           "inactive": "OFF", "present": "ON"}
_ACTIONS = [
    (r"(?:turn|switch|power)\s+on\s+(.+)", "turn_on"),
    (r"(?:turn|switch|power)\s+off\s+(.+)", "turn_off"),
    (r"(?:turn|switch|power)\s+(.+?)\s+on", "turn_on"),
    (r"(?:turn|switch|power)\s+(.+?)\s+off", "turn_off"),
    (r"(?:start|activate|enable|run)\s+(.+)", "turn_on"),
    (r"(?:stop|deactivate|disable)\s+(.+)", "turn_off"),
    (r"toggle\s+(.+)", "toggle"),
]


def _name(words):
    words = re.sub(r"\b(the|a|an|my|of|sensor|reading|value|degrees?|celsius|percent|%)\b", " ", words)
    words = re.sub(r"[^a-z0-9_ ]", " ", words)
    name = "_".join(words.split())
    return name if re.match(r"^[a-z_][a-z0-9_]*$", name) else None


def _condition(clause):
    clause = clause.strip()
    m = re.match(r"^(.+?)\s+is\s+(not\s+)?(" + "|".join(_STATES) + r")$", clause)
    if m:
        name = _name(m.group(1))
        if name:
            return name, "STATE", "!=" if m.group(2) else "==", _STATES[m.group(3)]
    for phrase, op in _NUM_OPS:
        m = re.match(r"^(.+?)\s+(?:is\s+|gets\s+|goes\s+)?(?:" + phrase + r")\s+" + _NUMBER + r"\b",
                     clause)
        if m:
            name = _name(m.group(1))
            if name:
                return name, "NUMBER", op, m.group(2)
    return None


def _action(text):
    text = text.strip()
    m = re.match(r"^set\s+(.+?)\s+(?:level\s+)?to\s+" + _NUMBER, text)
    if m and _name(m.group(1)):
        return f"set_level({_name(m.group(1))}, {m.group(2)})", _name(m.group(1))
    for pattern, func in _ACTIONS:
        m = re.match("^" + pattern + "$", text)
        if m and _name(m.group(1)):
            return f"{func}({_name(m.group(1))})", _name(m.group(1))
    return None


def _actions(text):
    out = []
    for part in re.split(r"\s*(?:,|;|\band\b|\bthen\b)\s*", text):
        if not part.strip():
            continue
        a = _action(part)
        if a is None:
            return None, part.strip()
        out.append(a)
    return out, None


def offline_nl_to_dsl(text):
    """Rule-based English -> DSL for simple sentences. Returns (dsl, None) or (None, error)."""
    hint = ("The offline converter understands sentences like: \"If temperature is above 30 and the door "
            "is open, turn on the fan, otherwise turn off the fan.\"")
    s = text.lower().strip().rstrip(".!")
    s = re.sub(r"\bplease\b", "", s)
    s = re.sub(r"\s+", " ", s)

    parts = re.split(r"\s*[,;.]?\s*\b(?:otherwise|else)\b\s*,?\s*", s, maxsplit=1)
    main, other = parts[0], parts[1] if len(parts) > 1 else ""

    m = (re.match(r"^(?:if|when|whenever)\s+(.+?)\s*(?:,\s*(?:then\s+)?|\s+then\s+)(.+)$", main)
         or re.match(r"^(?:if|when|whenever)\s+(.+?)\s+((?:turn|switch|power|set|toggle|start|stop|activate|"
                     r"deactivate|enable|disable|run)\b.+)$", main))
    if m:
        cond_text, action_text = m.group(1), m.group(2)
    else:
        m = re.match(r"^(.+?)\s+(?:if|when|whenever)\s+(.+)$", main)
        if not m:
            return None, "I couldn't find an if/when condition. " + hint
        action_text, cond_text = m.group(1), m.group(2)

    pieces = re.split(r"\s+(and|or)\s+", cond_text)
    conds, joins = [], []
    for i, piece in enumerate(pieces):
        if i % 2:
            joins.append(piece.upper())
            continue
        c = _condition(piece)
        if c is None:
            return None, f"I couldn't understand the condition \"{piece.strip()}\". " + hint
        conds.append(c)

    then_actions, bad = _actions(action_text)
    if then_actions is None:
        return None, f"I couldn't understand the action \"{bad}\". " + hint
    else_actions = []
    if other:
        else_actions, bad = _actions(other)
        if else_actions is None:
            return None, f"I couldn't understand the action \"{bad}\". " + hint

    sensors, devices = {}, []
    for name, typ, _, _ in conds:
        sensors.setdefault(name, typ)
    for _, dev in then_actions + else_actions:
        if dev not in devices:
            devices.append(dev)

    lines = [f"SENSOR {n} : {t}" for n, t in sensors.items()]
    lines.append("DEVICE " + ", ".join(devices))
    cond = conds[0][0] + f" {conds[0][2]} {conds[0][3]}"
    for join, (n, _, op, v) in zip(joins, conds[1:]):
        cond += f" {join} {n} {op} {v}"
    lines += ["", f"IF {cond}", "THEN " + then_actions[0][0]]
    lines += ["     " + a for a, _ in then_actions[1:]]
    if else_actions:
        lines.append("ELSE " + else_actions[0][0])
        lines += ["     " + a for a, _ in else_actions[1:]]
    return "\n".join(lines) + "\n", None


# --------------------------------------------------------------------- explanations

EXPLAIN_SYSTEM = f"""You are a friendly compiler tutor for a small IoT rule language.
A student's program produced a compiler message. Explain it for a beginner in 2-3 short sentences
(what is wrong and why the compiler rejects it). Then write one line starting with "Fix:" that shows
the corrected line of code. Plain text only, no markdown, no headings.

{LANGUAGE_REFERENCE}"""

_TEMPLATES = [
    (r"'(\w+)' is not a registered device",
     "The rule tries to control '{0}', but no device with that name was declared. The compiler keeps a "
     "symbol table of every SENSOR and DEVICE, and actions may only use names found there.",
     "Add a declaration such as: DEVICE {0}"),
    (r"'(\w+)' is not a declared sensor",
     "The condition reads '{0}', but there is no SENSOR declaration with that name, so the compiler "
     "doesn't know its type.",
     "Add a declaration such as: SENSOR {0} : NUMBER   (or STATE for ON/OFF/OPEN/CLOSED values)"),
    (r"type mismatch",
     "Both sides of a comparison must have the same type. NUMBER sensors are compared with numbers, and "
     "STATE sensors with ON, OFF, OPEN, CLOSED, TRUE or FALSE.",
     "Compare the sensor with a value of its own type, e.g. temperature > 30 or door == OPEN"),
    (r"cannot be used on STATE values",
     "States such as OPEN or ON have no order, so 'greater than' or 'less than' makes no sense for them. "
     "Only == and != are allowed.",
     "Use == or !=, e.g. door == OPEN"),
    (r"is a device, not a sensor",
     "Conditions can only test sensors (inputs). Devices are outputs that rules switch on and off.",
     "Test a sensor in the IF part and control the device in the THEN part"),
    (r"is a sensor, not a device",
     "Actions control devices (outputs). A sensor is an input and cannot be turned on or off.",
     "Pass a declared DEVICE to the action, e.g. turn_on(fan)"),
    (r"unknown action '(\w+)'",
     "'{0}' is not one of the built-in actions, so the compiler cannot generate code for it.",
     "Use turn_on(device), turn_off(device), toggle(device) or set_level(device, number)"),
    (r"expects (\d+) argument",
     "The action was called with the wrong number of arguments.",
     "set_level needs a device and a number, e.g. set_level(ac, 22); the others take one device"),
    (r"already declared",
     "Each name may be declared only once, otherwise the compiler cannot tell which declaration you mean.",
     "Remove the second declaration or rename one of them"),
    (r"keywords are uppercase",
     "Keywords in this language are case-sensitive and written in uppercase, so 'if' is read as an "
     "ordinary name.",
     "Write IF, THEN, ELSE, AND, OR and NOT in capitals"),
    (r"expected 'THEN'",
     "After the condition, a rule must continue with the keyword THEN before its actions. The parser "
     "found something else instead.",
     "IF <condition> THEN <action>"),
    (r"expected '\)'|',' or '\)'",
     "A bracket was opened but never closed, so the parser reached something unexpected.",
     "Add the missing ')' at the end of the condition or action"),
    (r"expected an action",
     "THEN (or ELSE) must be followed by at least one action call.",
     "THEN turn_on(fan)"),
    (r"expected a condition|expected a comparison operator",
     "A condition must have the form <sensor> <operator> <value>.",
     "IF temperature > 30 THEN ..."),
    (r"unexpected '='",
     "A single '=' means assignment, which this language doesn't have. Equality is written with two "
     "equals signs.",
     "Write == instead of ="),
    (r"unexpected character '(.+?)'",
     "The lexer met the character '{0}', which is not part of the language, so it cannot form a token "
     "from it.",
     "Remove the character or replace it with a valid operator"),
    (r"malformed number|invalid numeric literal",
     "Numbers may contain only digits and one decimal point followed by digits.",
     "Write numbers like 30 or 22.5"),
    (r"declared but never used",
     "This is only a warning: the name is declared but no rule uses it. The program still compiles.",
     "Use it in a rule or remove the declaration"),
    (r"can never be true",
     "The compiler rewrote the condition as OR-of-AND groups and found that no sensor values can satisfy any "
     "group, e.g. a temperature cannot be above 30 and below 20 at the same time. The actions can never run.",
     "Check the numbers and operators, or join the comparisons with OR instead of AND"),
    (r"is always true",
     "The negation of this condition can never be satisfied, so the condition holds for every sensor value and "
     "does not really test anything.",
     "Make the comparison stricter, or remove the condition"),
    (r"this ELSE IF can never run",
     "An ELSE IF only runs when every earlier condition is false. Whenever this condition is true, an earlier "
     "one is already true, so control never reaches it.",
     "Put the more specific test first, e.g. check temperature > 40 before temperature > 30"),
    (r"ELSE part can never run",
     "The conditions before ELSE together cover every possible sensor value, so the ELSE branch is unreachable.",
     "Remove the ELSE part or change one of the conditions"),
    (r"possible conflict|conflict: rule",
     "Two rules control the same device in different ways, and the compiler found sensor values for which both "
     "conditions are true. Rules run in order, so the later rule silently overrides the earlier one.",
     "Make the conditions exclusive (e.g. add AND NOT ...) or merge them into one rule with ELSE IF"),
    (r"only the last action has effect",
     "The same branch changes one device twice, so the first action is immediately overwritten.",
     "Keep only the action you want"),
    (r"arithmetic '.' needs numbers",
     "+, -, * and / only work on numbers. STATE values such as OPEN or ON cannot be added or multiplied.",
     "Use arithmetic only with NUMBER sensors and numbers"),
    (r"condition must be true or false",
     "A condition has to be a comparison or a combination of comparisons. A plain number or sensor is not "
     "true or false by itself.",
     "Compare it with something, e.g. temperature > 30"),
    (r"division by zero",
     "Dividing by zero has no defined result, so the generated program would produce an invalid value.",
     "Divide by a non-zero number"),
    (r"compares two constants",
     "This is only a warning: the condition doesn't depend on any sensor, so it is always true or always "
     "false. The optimizer will remove the branch that can never run.",
     "Compare a sensor with a value instead"),
]


def offline_explain(message):
    for pattern, text, fix in _TEMPLATES:
        m = re.search(pattern, message)
        if m:
            groups = m.groups() or ("",)
            return text.format(*groups) + "\nFix: " + fix.format(*groups)
    return ("The compiler found a problem at this position. Check the spelling of names and keywords, and "
            "that the rule has the form IF <condition> THEN <action>.")


def explain(source, error):
    message = str(error.get("message", ""))
    provider = get_provider()
    if provider is not None:
        numbered = "\n".join(f"{i:>3} | {line}" for i, line in enumerate((source or "").splitlines(), 1))
        user = (f"Program:\n{numbered}\n\nCompiler {error.get('severity', 'error')} "
                f"({error.get('phase', '')} phase) at line {error.get('line')}, column {error.get('col')}: "
                f"{message}")
        try:
            reply = re.sub(r"<think>.*?</think>", "", provider.chat(EXPLAIN_SYSTEM, user), flags=re.S).strip()
            reply = re.sub(r"\*\*|`", "", reply)
            if reply:
                return {"ok": True, "text": reply, "provider": provider.name}
        except AIError:
            pass
    return {"ok": True, "text": offline_explain(message), "provider": "Offline rules"}


# ------------------------------------------------------------ program explanation

EXPLAIN_PROGRAM_SYSTEM = f"""You explain IoT automation programs to non-programmers.
You get the program and a literal English translation produced by the compiler.
Rewrite it as a short, friendly description of how the home behaves (3-6 sentences).
Keep every condition and number exactly right. Plain text, no markdown, no headings.

{LANGUAGE_REFERENCE}"""


def explain_program(source, english):
    """A natural description of the whole program; falls back to the compiler's English."""
    literal = "\n".join(str(s) for s in english)
    provider = get_provider()
    if provider is not None and literal:
        try:
            reply = provider.chat(EXPLAIN_PROGRAM_SYSTEM,
                                  f"Program:\n{source}\n\nCompiler's literal translation:\n{literal}")
            reply = re.sub(r"<think>.*?</think>", "", reply, flags=re.S).strip()
            reply = re.sub(r"\*\*|`|^#+\s*", "", reply, flags=re.M)
            if reply:
                return {"ok": True, "text": reply, "provider": provider.name}
        except AIError:
            pass
    return {"ok": True, "text": literal, "provider": "Compiler (English back-translation)"}


# ------------------------------------------------------------------- AI quick fix

FIX_SYSTEM = f"""You repair programs written in the IoT DSL below.
You get a program and one compiler error. Return the COMPLETE corrected program, changing as
little as possible (only what is needed to fix this error). Reply with DSL code only: no
explanations, no markdown, no code fences.

{LANGUAGE_REFERENCE}"""


def fix_program(source, error):
    """Asks the AI for a corrected program and only returns it if it really fixes the error."""
    provider = get_provider()
    if provider is None:
        return {"ok": False, "error": "No AI model is available. Use the compiler's quick fix if one is shown."}
    numbered = "\n".join(f"{i:>3} | {line}" for i, line in enumerate((source or "").splitlines(), 1))
    user = (f"Program:\n{numbered}\n\nCompiler {error.get('severity', 'error')} at line {error.get('line')}, "
            f"column {error.get('col')}: {error.get('message', '')}\n\nCorrected program:")
    try:
        fixed = clean_output(provider.chat(FIX_SYSTEM, user))
    except AIError as e:
        return {"ok": False, "error": f"{provider.name} is unavailable: {str(e)[:120]}"}
    if not fixed.strip():
        return {"ok": False, "error": "The AI did not return a program."}

    before = len(_errors(compile_check(source)))
    result = compile_check(fixed)
    after = len(_errors(result))
    still = [e for e in result.get("errors", [])
             if e.get("message") == error.get("message") and e.get("line") == error.get("line")]
    if still or after > before:
        return {"ok": False, "error": "The AI's suggestion did not fix this error, so it is not offered."}
    return {"ok": True, "source": fixed, "provider": provider.name, "model": provider.model,
            "errorsBefore": before, "errorsAfter": after}
