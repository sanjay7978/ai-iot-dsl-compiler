// twin.js — the smart-home digital twin: an animated floor plan whose devices are
// driven by the compiled program (the optimized IR, executed by vm.js).

import { $, svgEl, escapeHtml, fmtNum } from "./util.js";

// ---- where things go -----------------------------------------------------------------

const ROOMS = {
  living:  { label: "Living room", x: 20, y: 20, w: 420, h: 280 },
  kitchen: { label: "Kitchen", x: 440, y: 20, w: 300, h: 280 },
  bedroom: { label: "Bedroom", x: 20, y: 300, w: 280, h: 240 },
  utility: { label: "Hall & utility", x: 300, y: 300, w: 440, h: 240 },
  garden:  { label: "Garden", x: 760, y: 20, w: 180, h: 520, outside: true },
};
const DEVICE_SLOTS = {
  living: [[110, 140], [240, 140], [360, 210], [110, 240], [240, 240]],
  kitchen: [[520, 130], [650, 130], [520, 235], [650, 235]],
  bedroom: [[90, 410], [210, 410], [90, 495], [210, 495]],
  utility: [[380, 395], [500, 395], [620, 395], [380, 485], [620, 485]],
  garden: [[850, 150], [850, 265], [850, 380], [850, 480]],
};
const SENSOR_SLOTS = {
  living: [[352, 36]], kitchen: [[652, 36]], bedroom: [[212, 316]], utility: [[652, 316]], garden: [[850, 36]],
};

const has = (name, re) => re.test(name.toLowerCase());

function deviceKind(n) {
  if (has(n, /fan/)) return "fan";
  if (has(n, /heat|warm|blanket/)) return "heater";
  if (has(n, /cool|^ac$|_ac$|^ac_|air_?con|aircon|chill/)) return "cooler";
  if (has(n, /pump|sprinkl|irrig|valve|water|mist/)) return "pump";
  if (has(n, /alarm|siren|buzz|bell|alert/)) return "alarm";
  if (has(n, /vent|exhaust|hood|purif/)) return "vent";
  if (has(n, /lock|latch/)) return "lock";
  if (has(n, /light|lamp|bulb|led/)) return "light";
  return "generic";
}
function deviceRoom(n) {
  if (has(n, /garden|pump|sprinkl|irrig|valve|water|grow|lawn|pool|mist/)) return "garden";
  if (has(n, /bed|blanket|curtain|blind/)) return "bedroom";
  if (has(n, /heat/)) return "bedroom";
  if (has(n, /vent|exhaust|hood|oven|stove|fridge|kettle|cook|purif/)) return "kitchen";
  if (has(n, /alarm|siren|buzz|lock|door|garage|gate|security|camera|bell/)) return "utility";
  if (has(n, /fan|light|lamp|^ac$|_ac|cool|air|tv|speaker|music/)) return "living";
  return "utility";
}
function sensorKind(n) {
  if (has(n, /temp|outside|outdoor|heat|thermo/)) return "temperature";
  if (has(n, /humid/)) return "humidity";
  if (has(n, /motion|pir|presence|occup|movement/)) return "motion";
  if (has(n, /soil|moist/)) return "soil";
  if (has(n, /rain|wet/)) return "rain";
  if (has(n, /light|lux|bright|sun|lumin/)) return "light";
  if (has(n, /door|gate|garage/)) return "door";
  if (has(n, /window/)) return "window";
  if (has(n, /smoke|gas|co2|air_q|pollut/)) return "smoke";
  return "generic";
}
function sensorRoom(n) {
  if (has(n, /outside|outdoor|rain|soil|moist|sun|weather|wind(?!ow)/)) return "garden";
  if (has(n, /light|lux|bright/)) return "garden";
  if (has(n, /door|gate|garage/)) return "utility";
  if (has(n, /humid|smoke|gas|kitchen/)) return "kitchen";
  if (has(n, /bed/)) return "bedroom";
  return "living";
}
export function unitFor(name) {
  const k = sensorKind(name);
  if (k === "temperature") return " °C";
  if (k === "humidity" || k === "soil") return " %";
  if (k === "light") return " lx";
  return "";
}

// ---- drawing ---------------------------------------------------------------------------

function deviceIcon(kind, g) {
  switch (kind) {
    case "fan": {
      const b = svgEl("g", { class: "fan-blades" }, g);
      for (let i = 0; i < 3; i++)
        svgEl("path", { d: "M0,-3 C8,-22 22,-18 15,-6 C11,0 4,0 0,-3 Z", transform: `rotate(${i * 120})` }, b);
      svgEl("circle", { r: 4, class: "hub" }, g);
      break;
    }
    case "light":
      svgEl("circle", { r: 30, class: "glow" }, g);
      svgEl("path", { d: "M-8,4 C-14,-2 -11,-15 0,-15 C11,-15 14,-2 8,4 L6,9 L-6,9 Z", class: "bulb" }, g);
      svgEl("path", { d: "M-5,12 L5,12 M-4,15 L4,15", class: "line" }, g);
      break;
    case "heater": {
      svgEl("rect", { x: -17, y: -6, width: 34, height: 18, rx: 3, class: "body" }, g);
      for (let i = -12; i <= 12; i += 6) svgEl("path", { d: `M${i},-3 L${i},9`, class: "line" }, g);
      const w = svgEl("g", { class: "waves" }, g);
      for (const x of [-9, 0, 9]) svgEl("path", { d: `M${x},-10 c-4,-4 4,-6 0,-10 c-4,-4 4,-6 0,-10`, class: "wave" }, w);
      break;
    }
    case "cooler": {
      svgEl("rect", { x: -18, y: -8, width: 36, height: 16, rx: 3, class: "body" }, g);
      svgEl("path", { d: "M-13,3 L13,3", class: "line" }, g);
      const f = svgEl("g", { class: "frost" }, g);
      for (const x of [-10, 0, 10]) svgEl("path", { d: `M${x},12 l0,8 M${x - 3},14 l6,4 M${x + 3},14 l-6,4`, class: "flake" }, f);
      break;
    }
    case "pump": {
      svgEl("path", { d: "M-16,-10 L6,-10 L6,-2", class: "pipe" }, g);
      svgEl("circle", { cx: -12, cy: -10, r: 6, class: "body" }, g);
      const d = svgEl("g", { class: "drops" }, g);
      for (const [x, delay] of [[2, 0], [6, 0.3], [10, 0.6]]) svgEl("circle", { cx: x, cy: 2, r: 2.2, style: `animation-delay:${delay}s`, class: "drop" }, d);
      break;
    }
    case "alarm":
      svgEl("circle", { r: 14, class: "ring r1" }, g);
      svgEl("circle", { r: 14, class: "ring r2" }, g);
      svgEl("path", { d: "M-9,6 C-9,-2 -8,-11 0,-11 C8,-11 9,-2 9,6 L12,9 L-12,9 Z", class: "body" }, g);
      svgEl("circle", { cy: 12, r: 2.5, class: "body" }, g);
      break;
    case "vent": {
      svgEl("circle", { r: 14, class: "body" }, g);
      for (let y = -8; y <= 8; y += 4) svgEl("path", { d: `M-10,${y} L10,${y}`, class: "line" }, g);
      const a = svgEl("g", { class: "air" }, g);
      for (const y of [-6, 0, 6]) svgEl("path", { d: `M16,${y} q5,-3 10,0 t10,0`, class: "airline" }, a);
      break;
    }
    case "lock":
      svgEl("path", { d: "M-7,-2 L-7,-9 C-7,-17 7,-17 7,-9 L7,-2", class: "shackle" }, g);
      svgEl("rect", { x: -11, y: -3, width: 22, height: 16, rx: 3, class: "body" }, g);
      break;
    default:
      svgEl("rect", { x: -12, y: -10, width: 24, height: 20, rx: 4, class: "body" }, g);
      svgEl("circle", { cx: 0, cy: 0, r: 3.5, class: "led" }, g);
  }
}

function sensorIcon(kind, g) {
  switch (kind) {
    case "temperature":
      svgEl("rect", { x: -3, y: -11, width: 6, height: 16, rx: 3, class: "s-line" }, g);
      svgEl("circle", { cy: 7, r: 4.5, class: "s-fill" }, g);
      svgEl("rect", { x: -1.4, y: -6, width: 2.8, height: 12, class: "s-fill level" }, g);
      break;
    case "humidity":
      svgEl("path", { d: "M0,-11 C5,-4 8,0 8,4 A8,8 0 0 1 -8,4 C-8,0 -5,-4 0,-11 Z", class: "s-line" }, g);
      break;
    case "motion":
      svgEl("circle", { r: 3, class: "s-fill" }, g);
      svgEl("path", { d: "M-7,-7 A10,10 0 0 0 -7,7 M7,-7 A10,10 0 0 1 7,7", class: "s-line pulse" }, g);
      break;
    case "light":
      svgEl("circle", { r: 5, class: "s-fill" }, g);
      for (let i = 0; i < 8; i++) svgEl("path", { d: "M0,-8 L0,-11", transform: `rotate(${i * 45})`, class: "s-line" }, g);
      break;
    case "soil":
      svgEl("path", { d: "M-9,8 L9,8 M0,8 L0,-2 M0,-2 C-6,-2 -8,-8 -8,-10 C-3,-10 0,-6 0,-2 M0,0 C5,0 8,-5 8,-8 C3,-8 0,-4 0,0", class: "s-line" }, g);
      break;
    case "rain":
      svgEl("path", { d: "M-9,1 A5,5 0 0 1 -6,-8 A7,7 0 0 1 7,-6 A4,4 0 0 1 9,1 Z", class: "s-line" }, g);
      svgEl("path", { d: "M-4,5 l-2,5 M2,5 l-2,5 M7,5 l-2,5", class: "s-line rain-drops" }, g);
      break;
    case "door":
    case "window":
      svgEl("rect", { x: -7, y: -10, width: 14, height: 20, rx: 1.5, class: "s-line" }, g);
      svgEl("circle", { cx: 3, cy: 1, r: 1.3, class: "s-fill" }, g);
      break;
    case "smoke":
      svgEl("path", { d: "M-6,8 C-10,2 -2,0 -6,-6 M2,8 C-2,2 6,0 2,-6 M8,8 C4,3 10,0 8,-4", class: "s-line" }, g);
      break;
    default:
      svgEl("circle", { r: 6, class: "s-line" }, g);
      svgEl("circle", { r: 2, class: "s-fill" }, g);
  }
}

// ---- the twin ---------------------------------------------------------------------------

let view = null;   // {svg, devices: {name: {g, label, ...}}, sensors: {...}, door, window}

export function renderTwin(result, { onSensorClick } = {}) {
  const host = $("twin");
  host.innerHTML = "";
  if (!result || !result.cCode) {
    view = null;
    host.innerHTML = '<div class="empty"><span>The smart home comes alive once the program compiles without errors.</span></div>';
    return;
  }
  const svg = svgEl("svg", { viewBox: "0 0 960 560", class: "twin-svg", role: "img", "aria-label": "Smart home floor plan" }, host);
  const defs = svgEl("defs", {}, svg);
  const grad = svgEl("radialGradient", { id: "twin-glow" }, defs);
  svgEl("stop", { offset: "0%", "stop-color": "var(--glow)", "stop-opacity": 0.9 }, grad);
  svgEl("stop", { offset: "100%", "stop-color": "var(--glow)", "stop-opacity": 0 }, grad);

  // Rooms
  const rooms = svgEl("g", { class: "rooms" }, svg);
  for (const [id, r] of Object.entries(ROOMS)) {
    svgEl("rect", { x: r.x, y: r.y, width: r.w, height: r.h, class: "room" + (r.outside ? " outside" : ""), "data-room": id }, rooms);
    const t = svgEl("text", { x: r.x + 12, y: r.y + r.h - 12, class: "room-label" }, rooms);
    t.textContent = r.label;
  }
  // Front door (bottom wall of the hall) and window (top wall of the living room)
  const door = svgEl("g", { class: "door" }, svg);
  svgEl("path", { d: "M500,540 L560,540", class: "wall-gap" }, door);
  svgEl("path", { d: "M500,540 A60,60 0 0 0 560,480", class: "swing" }, door);
  svgEl("path", { d: "M500,540 L560,540", class: "leaf" }, door);
  const win = svgEl("g", { class: "window" }, svg);
  svgEl("path", { d: "M160,20 L260,20", class: "wall-gap" }, win);
  svgEl("path", { d: "M160,20 L210,20", class: "pane left" }, win);
  svgEl("path", { d: "M260,20 L210,20", class: "pane right" }, win);
  const night = svgEl("rect", { x: 0, y: 0, width: 960, height: 560, class: "night" }, svg);
  const clock = svgEl("text", { x: 930, y: 548, class: "twin-clock", "text-anchor": "end" }, svg);

  // Devices
  const symbols = result.symbols;
  const used = {};
  const devices = {};
  for (const s of symbols.filter((x) => x.kind === "device")) {
    const room = deviceRoom(s.name);
    const slots = DEVICE_SLOTS[room];
    const i = (used[room] = (used[room] || 0) + 1) - 1;
    const [x, y] = slots[i % slots.length];
    const dy = Math.floor(i / slots.length) * 22;
    const kind = deviceKind(s.name);
    const g = svgEl("g", { class: `dev k-${kind}`, transform: `translate(${x},${y + dy})` }, svg);
    svgEl("circle", { r: 30, class: "plate" }, g);
    svgEl("circle", { r: 30, class: "level-arc", pathLength: 100 }, g);
    const icon = svgEl("g", { class: "icon" }, g);
    deviceIcon(kind, icon);
    const name = svgEl("text", { y: 46, class: "dev-name", "text-anchor": "middle" }, g);
    name.textContent = s.name;
    const st = svgEl("text", { y: 60, class: "dev-state", "text-anchor": "middle" }, g);
    st.textContent = "OFF";
    const bubble = svgEl("g", { class: "bubble" }, g);
    svgEl("rect", { x: -36, y: -58, width: 72, height: 20, rx: 10 }, bubble);
    const bt = svgEl("text", { y: -44, "text-anchor": "middle" }, bubble);
    devices[s.name] = { g, st, bubble, bt, kind, prev: null };
  }

  // Sensors
  const sUsed = {};
  const sensors = {};
  for (const s of symbols.filter((x) => x.kind === "sensor")) {
    const room = sensorRoom(s.name);
    const [x, y0] = SENSOR_SLOTS[room][0];
    const i = (sUsed[room] = (sUsed[room] || 0) + 1) - 1;
    const y = y0 + i * 40;
    const kind = sensorKind(s.name);
    const g = svgEl("g", { class: `sensor-badge k-${kind}`, transform: `translate(${x - 70},${y})`, tabindex: 0, role: "button", "aria-label": "Change " + s.name }, svg);
    svgEl("rect", { width: 150, height: 32, rx: 16 }, g);
    const icon = svgEl("g", { transform: "translate(17,16)", class: "s-icon" }, g);
    sensorIcon(kind, icon);
    const nm = svgEl("text", { x: 34, y: 13, class: "s-name" }, g);
    nm.textContent = s.name.length > 14 ? s.name.slice(0, 13) + "…" : s.name;
    const val = svgEl("text", { x: 34, y: 26, class: "s-value" }, g);
    g.addEventListener("click", () => onSensorClick && onSensorClick(s.name, g));
    g.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && onSensorClick && onSensorClick(s.name, g));
    sensors[s.name] = { g, val, kind, type: s.type };
  }
  view = { svg, devices, sensors, door, win, night, clock };
}

// Shows the sensor values and the result of running the rules on them.
export function updateTwin(inputs, run, { minute = null, flash = true } = {}) {
  if (!view) return;
  for (const [name, s] of Object.entries(view.sensors)) {
    const v = inputs[name];
    s.val.textContent = s.type === "NUMBER" ? fmtNum(+v) + unitFor(name) : String(v ?? "–");
    const active = ["ON", "OPEN", "TRUE"].includes(String(v));
    s.g.classList.toggle("active", s.type === "STATE" && active);
    if (s.kind === "temperature") {
      const level = Math.max(0, Math.min(1, (+v + 5) / 45));
      const bar = s.g.querySelector(".level");
      if (bar) { bar.setAttribute("height", 12 * level); bar.setAttribute("y", 6 - 12 * level); }
    }
    if (s.kind === "door") view.door.classList.toggle("open", active);
    if (s.kind === "window") view.win.classList.toggle("open", active);
  }

  const conflicted = new Map(run.conflicts.map((c) => [c.device, c.rules]));
  for (const [name, d] of Object.entries(view.devices)) {
    const dev = run.devices[name] || { on: false, level: 0 };
    const level = dev.on ? dev.level : 0;
    d.g.classList.toggle("on", dev.on);
    d.g.style.setProperty("--level", Math.max(0.15, Math.min(1, level / 100)));
    d.g.querySelector(".level-arc").style.strokeDasharray = dev.on && dev.level !== 100 ? `${Math.min(100, level)} 100` : "0 100";
    d.st.textContent = dev.on ? (dev.level !== 100 ? `ON · ${fmtNum(dev.level)}` : "ON") : "OFF";
    d.g.classList.toggle("conflict", conflicted.has(name));

    const sig = dev.on + ":" + dev.level;
    const writes = run.writes[name] || [];
    if (conflicted.has(name)) {
      d.bt.textContent = "rules " + conflicted.get(name).join(" & ") + " fight";
      d.bubble.classList.add("show", "bad");
    } else if (flash && d.prev !== null && d.prev !== sig && writes.length) {
      d.bt.textContent = "Rule " + writes[writes.length - 1].rule;
      d.bubble.classList.remove("bad");
      d.bubble.classList.add("show");
      clearTimeout(d.timer);
      d.timer = setTimeout(() => d.bubble.classList.remove("show"), 1400);
    } else if (!conflicted.has(name)) {
      d.bubble.classList.remove("bad");
    }
    d.prev = sig;
  }

  if (minute === null) {
    view.night.style.opacity = 0;
    view.clock.textContent = "";
  } else {
    const h = minute / 60;
    const dark = h < 6 || h > 20 ? 1 : h < 7.5 ? (7.5 - h) / 1.5 : h > 18.5 ? (h - 18.5) / 1.5 : 0;
    view.night.style.opacity = (dark * 0.32).toFixed(3);
    view.clock.textContent = `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor(minute % 60)).padStart(2, "0")}`;
  }
}

export function sensorAnchor(name) {
  return view && view.sensors[name] ? view.sensors[name].g : null;
}

export { escapeHtml };
