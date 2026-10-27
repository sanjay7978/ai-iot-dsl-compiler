// vm.js — a tiny virtual machine that executes the compiler's three-address code.
// The simulator, the digital twin and the 24-hour player all run the
// optimized IR produced by the C++ compiler through this interpreter.

export function executeIr(code, inputs, deviceNames) {
  const labels = {};
  code.forEach((ins, i) => ins.op === "label" && (labels[ins.label] = i));
  const temps = {};
  const devices = Object.fromEntries(deviceNames.map((d) => [d, { on: false, level: 0 }]));
  const actions = {};   // rule number -> list of executed calls (text)
  const writes = {};    // device -> [{rule, effect}]

  const val = (v) => {
    switch (v.kind) {
      case "temp": return temps[v.text];
      case "sensor": return inputs[v.text];
      case "number": return parseFloat(v.text);
      case "bool": return v.text === "true";
      default: return v.text;   // state literal or device name
    }
  };
  const binop = (op, a, b) => {
    switch (op) {
      case ">": return a > b;
      case "<": return a < b;
      case ">=": return a >= b;
      case "<=": return a <= b;
      case "==": return a === b;
      case "!=": return a !== b;
      case "AND": return a && b;
      case "OR": return a || b;
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return a / b;
    }
    return false;
  };

  for (let pc = 0, guard = 0; pc < code.length && guard < 100000; guard++) {
    const ins = code[pc++];
    switch (ins.op) {
      case "binary": temps[ins.dest] = binop(ins.oper, val(ins.a), val(ins.b)); break;
      case "not": temps[ins.dest] = !val(ins.a); break;
      case "neg": temps[ins.dest] = -val(ins.a); break;
      case "copy": temps[ins.dest] = val(ins.a); break;
      case "if_false": if (!val(ins.a)) pc = labels[ins.label]; break;
      case "goto": pc = labels[ins.label]; break;
      case "call": {
        const args = ins.args.map(val);
        const name = args[0];
        const d = devices[name];
        let effect = ins.callee;
        if (d) {
          if (ins.callee === "turn_on") { d.on = true; if (!d.level) d.level = 100; }
          else if (ins.callee === "turn_off") { d.on = false; d.level = 0; }
          else if (ins.callee === "toggle") { d.on = !d.on; d.level = d.on ? 100 : 0; }
          else if (ins.callee === "set_level") { d.level = args[1]; d.on = args[1] > 0; effect += ":" + (+args[1]).toFixed(2); }
          (writes[name] = writes[name] || []).push({ rule: ins.rule, effect });
        }
        const shown = args.map((v) => (typeof v === "number" ? +v.toFixed(3) : v)).join(", ");
        (actions[ins.rule] = actions[ins.rule] || []).push(`${ins.callee}(${shown})`);
        break;
      }
    }
  }

  // A conflict: two different rules set the same device differently in one evaluation.
  const conflicts = [];
  for (const [device, list] of Object.entries(writes)) {
    const rules = new Set(list.map((w) => w.rule));
    const effects = new Set(list.map((w) => w.effect));
    if (rules.size > 1 && (effects.size > 1 || list.some((w) => w.effect === "toggle")))
      conflicts.push({ device, rules: [...rules] });
  }
  return { devices, actions, writes, conflicts };
}

// Values a sensor is compared with in the IR (to build sensible controls).
export function comparedValues(ir, name, kind) {
  const vals = [];
  for (const ins of ir) {
    if (ins.op !== "binary") continue;
    if (ins.a.kind === "sensor" && ins.a.text === name && ins.b.kind === kind) vals.push(ins.b.text);
    if (ins.b.kind === "sensor" && ins.b.text === name && ins.a.kind === kind) vals.push(ins.a.text);
  }
  return vals;
}

const COUNTERPART = { ON: "OFF", OFF: "ON", OPEN: "CLOSED", CLOSED: "OPEN", TRUE: "FALSE", FALSE: "TRUE" };

export function stateOptions(ir, name) {
  const opts = [...new Set(comparedValues(ir, name, "state"))];
  if (opts.length === 1) opts.push(COUNTERPART[opts[0]]);
  return opts.length ? opts : ["ON", "OFF"];
}

export function numberRange(ir, name) {
  const texts = comparedValues(ir, name, "number");
  const nums = texts.map(Number);
  const hi = Math.max(100, ...nums.map((n) => Math.ceil((n * 1.5) / 10) * 10));
  const lo = Math.min(0, ...nums);
  const step = texts.some((t) => t.includes(".")) ? 0.5 : 1;
  return { lo, hi, step, first: nums.length ? nums[0] : Math.round(hi / 4) };
}

// The sensor panel description shared by the twin, the phone remote and the day player.
export function sensorSpecs(result) {
  return result.symbols
    .filter((s) => s.kind === "sensor")
    .map((s) => {
      if (s.type === "NUMBER") {
        const r = numberRange(result.ir, s.name);
        return { name: s.name, type: "NUMBER", min: r.lo, max: r.hi, step: r.step, first: r.first };
      }
      return { name: s.name, type: "STATE", options: stateOptions(result.ir, s.name) };
    });
}
