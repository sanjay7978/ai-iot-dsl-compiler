// iot_runtime.js: simulated sensors and devices for iotc-generated JavaScript programs.
//
// Usage: node program.js temperature=32 door=OPEN motion=ON
// Every device starts OFF; evaluateRules() runs once; the final device states
// are printed. The output format matches the C runtime (runtime/iot_runtime.c).
"use strict";

const STATE_UNKNOWN = "UNKNOWN", STATE_ON = "ON", STATE_OFF = "OFF";
const STATE_OPEN = "OPEN", STATE_CLOSED = "CLOSED", STATE_TRUE = "TRUE", STATE_FALSE = "FALSE";
const STATES = new Set([STATE_ON, STATE_OFF, STATE_OPEN, STATE_CLOSED, STATE_TRUE, STATE_FALSE]);

const args = new Map();
let names = [];
let on = [];
let level = [];

// Formats a number like C's printf("%g").
function formatG(x) {
  if (x === 0) return "0";
  if (!isFinite(x)) return String(x).toLowerCase().replace("infinity", "inf");
  const exp = Math.floor(Math.log10(Math.abs(x)));
  if (exp < -4 || exp >= 6) {
    let [m, e] = x.toExponential(5).split("e");
    m = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    const n = Math.abs(+e);
    return `${m}e${+e < 0 ? "-" : "+"}${n < 10 ? "0" + n : n}`;
  }
  let s = x.toPrecision(6);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

function readNumber(sensor) {
  const v = args.get(sensor);
  if (v === undefined) {
    process.stderr.write(`warning: no value for sensor '${sensor}', using 0\n`);
    return 0;
  }
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
}

function readState(sensor) {
  const v = args.get(sensor);
  if (v === undefined) {
    process.stderr.write(`warning: no value for sensor '${sensor}', using UNKNOWN\n`);
    return STATE_UNKNOWN;
  }
  if (STATES.has(v.toUpperCase())) return v.toUpperCase();
  process.stderr.write(`warning: unknown state '${v}' for sensor '${sensor}'\n`);
  return STATE_UNKNOWN;
}

const valid = (d) => d >= 0 && d < names.length;

function turnOn(d) {
  if (!valid(d)) return;
  on[d] = true;
  if (level[d] === 0) level[d] = 100;
  console.log(`  turn_on(${names[d]})`);
}

function turnOff(d) {
  if (!valid(d)) return;
  on[d] = false;
  level[d] = 0;
  console.log(`  turn_off(${names[d]})`);
}

function toggle(d) {
  if (!valid(d)) return;
  on[d] = !on[d];
  level[d] = on[d] ? 100 : 0;
  console.log(`  toggle(${names[d]})`);
}

function setLevel(d, value) {
  if (!valid(d)) return;
  level[d] = value;
  on[d] = value > 0;
  console.log(`  set_level(${names[d]}, ${formatG(value)})`);
}

function run(evaluateRules, deviceNames, argv = process.argv.slice(2)) {
  for (const a of argv) {
    const i = a.indexOf("=");
    if (i > 0 && !args.has(a.slice(0, i))) args.set(a.slice(0, i), a.slice(i + 1));
  }
  names = [...deviceNames];
  on = names.map(() => false);
  level = names.map(() => 0);

  console.log("Actions:");
  evaluateRules();
  console.log("Device states:");
  names.forEach((name, d) => {
    if (on[d] && level[d] !== 100) console.log(`  ${name.padEnd(12)} ON (level ${formatG(level[d])})`);
    else console.log(`  ${name.padEnd(12)} ${on[d] ? "ON" : "OFF"}`);
  });
}

module.exports = {
  STATE_UNKNOWN, STATE_ON, STATE_OFF, STATE_OPEN, STATE_CLOSED, STATE_TRUE, STATE_FALSE,
  read_number: readNumber, read_state: readState,
  turn_on: turnOn, turn_off: turnOff, toggle, set_level: setLevel,
  run, formatG,
};
