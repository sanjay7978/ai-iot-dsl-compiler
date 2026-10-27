// timeline.js — a simulated 24-hour day. Sensor values follow daily curves and
// simple physics (heaters warm the room, pumps water the soil...), the compiled
// rules run every 5 minutes, and a logic-analyzer chart shows the result.

import { $, svgEl, fmtNum } from "./util.js";
import { executeIr, sensorSpecs, comparedValues } from "./vm.js";
import { unitFor } from "./twin.js";

export const STEP = 5;                 // minutes per simulation step
export const STEPS = (24 * 60) / STEP; // 288 steps

const has = (n, re) => re.test(n.toLowerCase());

function rng(seed) {   // mulberry32
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Which way a device pushes a sensor: +1 warms/raises, -1 cools/lowers.
function effectOf(device, sensor) {
  const s = sensor.toLowerCase();
  if (/temp|thermo/.test(s) && !/outside|outdoor/.test(s)) {
    if (has(device, /heat|warm/)) return 1.4;
    if (has(device, /cool|^ac$|_ac|aircon|chill/)) return -1.6;
    if (has(device, /fan|vent/)) return -0.25;
  }
  if (/humid/.test(s) && has(device, /dehumid|vent|exhaust|fan|ac$/)) return -1.5;
  if (/humid/.test(s) && has(device, /humidif|mist/)) return 1.5;
  if (/soil|moist/.test(s) && has(device, /pump|sprinkl|irrig|valve|water/)) return 3.2;
  if (/light|lux|bright/.test(s) && !/outside/.test(s) && has(device, /light|lamp/)) return 0;
  return 0;
}

// Builds the day: sensor curves + state schedules, simulated with feedback.
export function buildDay(result, seed = 7) {
  const rand = rng(seed);
  const specs = sensorSpecs(result);
  const devices = result.symbols.filter((s) => s.kind === "device").map((s) => s.name);
  const hourOf = (k) => (k * STEP) / 60;

  const daylight = (h) => Math.max(0, Math.sin((Math.PI * (h - 6)) / 14));
  const wave = (h) => Math.sin((2 * Math.PI * (h - 9)) / 24);   // -1 at 3:00, +1 at 15:00

  // Each number sensor's daily curve crosses the thresholds the program tests,
  // so the rules actually fire during the day.
  const curve = {};
  for (const s of specs.filter((x) => x.type === "NUMBER")) {
    const lits = comparedValues(result.ir, s.name, "number").map(Number);
    const lo0 = lits.length ? Math.min(...lits) : null, hi0 = lits.length ? Math.max(...lits) : null;
    const around = (defLo, defHi, pad) => {
      if (lo0 === null) return [defLo, defHi];
      return [lo0 - pad(lo0), hi0 + pad(hi0)];
    };
    let range;
    if (has(s.name, /outside|outdoor/)) range = around(5, 23, (v) => Math.max(4, Math.abs(v) * 0.2));
    else if (has(s.name, /temp|thermo/)) range = around(15, 27, (v) => Math.max(5, Math.abs(v) * 0.2));
    else if (has(s.name, /humid/)) range = around(40, 75, (v) => Math.max(8, Math.abs(v) * 0.2));
    else if (has(s.name, /light|lux|bright|sun/)) range = [0, lo0 === null ? 950 : Math.max(hi0 * 2.2, 50)];
    else range = around(s.min, s.max, (v) => Math.max(2, Math.abs(v) * 0.25));
    curve[s.name] = { lo: range[0], hi: range[1], soilStart: lo0 === null ? 48 : hi0 + 12 };
  }
  const along = (name, w) => { const c = curve[name]; return (c.lo + c.hi) / 2 + ((c.hi - c.lo) / 2) * w; };
  const outsideSensor = specs.find((x) => x.type === "NUMBER" && has(x.name, /outside|outdoor/));
  const outside = (h) => (outsideSensor ? along(outsideSensor.name, wave(h)) : 14 + 9 * wave(h));

  // State schedules: lists of [startMinute, endMinute] when the sensor is "active".
  const schedules = {};
  for (const s of specs.filter((x) => x.type === "STATE")) {
    const blocks = [];
    if (has(s.name, /door|gate|garage/)) {
      blocks.push([455, 470], [1075, 1095], [1290, 1300]);
      for (let i = 0; i < 2; i++) { const t = 600 + Math.floor(rand() * 420); blocks.push([t, t + 10]); }
    } else if (has(s.name, /window/)) {
      const t = 540 + Math.floor(rand() * 120);
      blocks.push([t, t + 300 + Math.floor(rand() * 90)]);
    } else if (has(s.name, /motion|pir|presence|occup/)) {
      for (let i = 0; i < 12; i++) { const t = 390 + Math.floor(rand() * 990); blocks.push([t, t + 15 + Math.floor(rand() * 20)]); }
    } else if (has(s.name, /rain|wet/)) {
      if (rand() < 0.8) { const t = 780 + Math.floor(rand() * 180); blocks.push([t, t + 90]); }
    } else {
      for (let t = 120 + Math.floor(rand() * 120); t < 1440; t += 240 + Math.floor(rand() * 120)) blocks.push([t, t + 90]);
    }
    const active = ["OPEN", "ON", "TRUE"].find((v) => s.options.includes(v)) || s.options[0];
    const idle = s.options.find((v) => v !== active) || active;
    schedules[s.name] = { blocks, active, idle };
  }

  // Number sensors start from their daily curve.
  const value = {};
  for (const s of specs.filter((x) => x.type === "NUMBER")) {
    if (has(s.name, /soil|moist/)) value[s.name] = curve[s.name].soilStart;
    else if (has(s.name, /light|lux|bright|sun/)) value[s.name] = 0;
    else value[s.name] = along(s.name, wave(0));
  }

  const frames = [];
  let prevDevices = null;
  for (let k = 0; k < STEPS; k++) {
    const h = hourOf(k), minute = k * STEP;
    const inputs = {};
    for (const s of specs) {
      if (s.type === "STATE") {
        const sc = schedules[s.name];
        inputs[s.name] = sc.blocks.some(([a, b]) => minute >= a && minute < b) ? sc.active : sc.idle;
      } else {
        inputs[s.name] = +value[s.name].toFixed(2);
      }
    }
    const run = executeIr(result.optimizedIr, inputs, devices);
    frames.push({ minute, inputs, run });

    // Physics for the next step.
    for (const s of specs.filter((x) => x.type === "NUMBER")) {
      let v = value[s.name];
      const noise = (rand() - 0.5) * 0.3;
      const next = h + STEP / 60;
      if (has(s.name, /outside|outdoor/)) v = along(s.name, wave(next)) + noise;
      else if (has(s.name, /temp|thermo/)) v += 0.12 * (along(s.name, wave(next)) - v) + noise;
      else if (has(s.name, /humid/)) v += 0.1 * (along(s.name, -wave(next)) - v) + noise * 3;
      else if (has(s.name, /soil|moist/)) v -= 0.25 + 0.35 * daylight(h) + (rand() - 0.5) * 0.1;
      else if (has(s.name, /light|lux|bright|sun/)) v = curve[s.name].hi * daylight(next) * (0.85 + rand() * 0.15);
      else v = along(s.name, Math.sin((2 * Math.PI * next) / 8)) + noise;
      for (const d of devices) {
        const dev = run.devices[d];
        if (dev && dev.on) v += effectOf(d, s.name) * Math.min(1, dev.level / 100);
      }
      if (has(s.name, /rain/) === false && has(s.name, /soil|moist/)) {
        const rain = specs.find((x) => x.type === "STATE" && has(x.name, /rain/));
        if (rain && ["TRUE", "ON"].includes(inputs[rain.name])) v += 1.2;
      }
      value[s.name] = Math.max(s.min, Math.min(s.max, v));
    }
    prevDevices = run.devices;
  }
  return { frames, specs, devices, seed, prevDevices };
}

// ---- the chart -------------------------------------------------------------------------

export function renderChart(container, day, { onScrub } = {}) {
  container.innerHTML = "";
  const width = Math.max(container.clientWidth, 520);
  const LEFT = 118, RIGHT = 12, TOP = 22;
  const lanes = [];
  day.specs.forEach((s) => lanes.push({ kind: s.type === "NUMBER" ? "number" : "state", spec: s, h: s.type === "NUMBER" ? 40 : 16 }));
  day.devices.forEach((d) => lanes.push({ kind: "device", name: d, h: 16 }));
  const height = TOP + lanes.reduce((s, l) => s + l.h + 8, 0) + 8;
  const svg = svgEl("svg", { width, height, class: "chart-svg", role: "img", "aria-label": "24-hour simulation chart" }, container);
  const x = (k) => LEFT + ((width - LEFT - RIGHT) * k) / STEPS;

  // Hour grid
  for (let hr = 0; hr <= 24; hr += 3) {
    const xx = x((hr * 60) / STEP);
    svgEl("line", { x1: xx, x2: xx, y1: TOP - 6, y2: height - 4, class: "grid" }, svg);
    const t = svgEl("text", { x: xx, y: 12, class: "tick", "text-anchor": "middle" }, svg);
    t.textContent = String(hr).padStart(2, "0") + ":00";
  }

  let y = TOP;
  for (const lane of lanes) {
    const label = svgEl("text", { x: 8, y: y + lane.h / 2 + 4, class: "lane-label" + (lane.kind === "device" ? " device" : "") }, svg);
    label.textContent = lane.kind === "device" ? lane.name : lane.spec.name;
    if (lane.kind === "number") {
      const vals = day.frames.map((f) => f.inputs[lane.spec.name]);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const span = hi - lo || 1;
      const yy = (v) => y + lane.h - 2 - ((v - lo) / span) * (lane.h - 4);
      svgEl("rect", { x: LEFT, y, width: width - LEFT - RIGHT, height: lane.h, class: "lane-bg" }, svg);
      const d = vals.map((v, k) => (k ? "L" : "M") + x(k).toFixed(1) + "," + yy(v).toFixed(1)).join(" ");
      svgEl("path", { d, class: "series" }, svg);
      const range = svgEl("text", { x: LEFT - 6, y: y + lane.h - 2, class: "lane-range", "text-anchor": "end" }, svg);
      range.textContent = `${fmtNum(lo)}–${fmtNum(hi)}${unitFor(lane.spec.name)}`;
    } else if (lane.kind === "state") {
      svgEl("rect", { x: LEFT, y, width: width - LEFT - RIGHT, height: lane.h, class: "lane-bg" }, svg);
      const active = ["OPEN", "ON", "TRUE"];
      let start = -1;
      day.frames.forEach((f, k) => {
        const on = active.includes(f.inputs[lane.spec.name]);
        if (on && start < 0) start = k;
        if ((!on || k === STEPS - 1) && start >= 0) {
          svgEl("rect", { x: x(start), y: y + 2, width: Math.max(1.5, x(on ? k + 1 : k) - x(start)), height: lane.h - 4, rx: 2, class: "band state" }, svg);
          start = -1;
        }
      });
    } else {
      svgEl("rect", { x: LEFT, y, width: width - LEFT - RIGHT, height: lane.h, class: "lane-bg" }, svg);
      day.frames.forEach((f, k) => {
        const dev = f.run.devices[lane.name];
        if (dev && dev.on)
          svgEl("rect", { x: x(k), y: y + 2, width: x(k + 1) - x(k) + 0.4, height: lane.h - 4, class: "band device", style: `opacity:${0.35 + 0.65 * Math.min(1, dev.level / 100)}` }, svg);
        if (f.run.conflicts.some((c) => c.device === lane.name))
          svgEl("rect", { x: x(k), y: y - 3, width: Math.max(2, x(k + 1) - x(k)), height: 3, class: "conflict-mark" }, svg);
      });
    }
    y += lane.h + 8;
  }

  const head = svgEl("line", { x1: LEFT, x2: LEFT, y1: TOP - 8, y2: height - 4, class: "playhead" }, svg);
  const scrub = (e) => {
    const r = svg.getBoundingClientRect();
    const k = Math.round(((e.clientX - r.left - LEFT) / (width - LEFT - RIGHT)) * STEPS);
    if (onScrub) onScrub(Math.max(0, Math.min(STEPS - 1, k)));
  };
  let dragging = false;
  svg.addEventListener("pointerdown", (e) => { dragging = true; svg.setPointerCapture(e.pointerId); scrub(e); });
  svg.addEventListener("pointermove", (e) => dragging && scrub(e));
  svg.addEventListener("pointerup", () => (dragging = false));
  return {
    setHead(k) {
      const xx = x(k);
      head.setAttribute("x1", xx);
      head.setAttribute("x2", xx);
    },
  };
}

export { $ };
