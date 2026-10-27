// main.js — wires the page together. All compiling is done by the C++ compiler
// on the server (POST /api/compile); the page shows and animates the results.

import { $, bus, postJson, getJson, debounce, escapeHtml, fmtNum, toast } from "./util.js";
import { state } from "./state.js";
import { initEditor, getSource, setSource, render as renderEditor, applyFix, replaceRange } from "./editor.js";
import { initPanes, renderPanes, resetPanes, renderAst, renderIr, setIrView, linkSpans } from "./panes.js";
import { initLanguage, renderLanguage } from "./grammar.js";
import { initCode, renderCode } from "./codepane.js";
import { executeIr, sensorSpecs } from "./vm.js";
import { renderTwin, updateTwin, unitFor } from "./twin.js";
import { buildDay, renderChart, STEPS } from "./timeline.js";
import { initXray, openXray } from "./xray.js";
import { initAi } from "./ai.js";
import { initTour, startTour } from "./tour.js";
import { shareProgram, programFromUrl } from "./share.js";
import { printReport } from "./report.js";
import { initPalette, setCommands } from "./palette.js";
import { initRemote, openRemote } from "./remote-host.js";

// ---- theme ---------------------------------------------------------------------------

function currentTheme() {
  return document.documentElement.dataset.theme ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("iotc-theme", next); } catch (e) { /* storage unavailable */ }
}

// ---- tabs -----------------------------------------------------------------------------

const tabs = () => Array.from(document.querySelectorAll(".tab"));

function positionIndicator() {
  const active = tabs().find((t) => t.dataset.tab === state.activeTab);
  if (!active) return;
  $("tabIndicator").style.left = active.offsetLeft + 6 + "px";
  $("tabIndicator").style.width = active.offsetWidth - 12 + "px";
}

function showTab(name) {
  state.activeTab = name;
  tabs().forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
    if (on) {
      const bar = t.parentElement, left = t.offsetLeft, right = left + t.offsetWidth;
      if (left < bar.scrollLeft) bar.scrollLeft = left - 8;
      else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth + 8;
    }
  });
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + name));
  positionIndicator();
  // Graphs measure their container, so draw them when they become visible.
  if (name === "ast" && state.astView === "graph") renderAst();
  if (name === "ir" && state.irView === "cfg") renderIr();
}

// ---- compile ---------------------------------------------------------------------------

function setStatus(kind, text) {
  $("status").className = "status" + (kind ? " " + kind : "");
  $("statusText").textContent = text;
}

let compileSeq = 0;
async function compile({ quiet = false } = {}) {
  const source = getSource();
  const seq = ++compileSeq;
  $("compileBtn").classList.add("busy");
  if (!quiet) setStatus("", "Compiling…");
  try {
    const data = await postJson("/api/compile", { source });
    if (seq !== compileSeq) return;   // a newer compile is on its way
    state.result = data;
    state.compiledSource = source;
    state.hover = null;
    state.link = null;
    state.explanations = {};
    showResult(data, quiet);
    renderEditor();
    bus.emit("compiled", data);
  } catch (e) {
    setStatus("fail", e instanceof TypeError ? "Cannot reach the compiler server. Start it with: make run" : e.message);
  } finally {
    if (seq === compileSeq) $("compileBtn").classList.remove("busy");
  }
}

const liveCompile = debounce(() => state.live && compile({ quiet: true }), 350);

function showResult(r, quiet) {
  const errs = r.stats.errors, warns = r.stats.warnings;
  if (errs === 0) setStatus("ok", warns ? `Compiled with ${warns} warning${warns === 1 ? "" : "s"}` : "Compiled successfully");
  else setStatus("fail", `Found ${errs} error${errs === 1 ? "" : "s"}`);

  const status = Object.fromEntries(r.phases.map((p) => [p.id, p.status]));
  document.querySelectorAll(".step").forEach((s) => {
    s.dataset.status = status[s.dataset.step] || "";
    const p = r.phases.find((x) => x.id === s.dataset.step);
    s.title = p ? `${p.name}: ${{ ok: "passed", error: "errors found", skipped: "not run" }[p.status]}` : "";
  });

  renderPanes(r);
  renderCode();
  setupHome(r);

  $("statTokens").textContent = r.stats.tokens;
  $("statRules").textContent = r.stats.rules;
  $("statErrors").textContent = r.stats.errors;
  $("statWarnings").textContent = r.stats.warnings;
  $("statIr").textContent = r.ir.length ? `${r.stats.irBefore} → ${r.stats.irAfter}` : "–";
  $("statTime").textContent = r.stats.timeMs.toFixed(3) + " ms";

  if (!quiet) {
    if (r.stats.errors) showTab("problems");
    else if (state.activeTab === "problems" && !r.errors.length) showTab("tokens");
  }
}

// ---- examples and source ---------------------------------------------------------------

function loadSource(text, name = "") {
  state.exampleName = name;
  setSource(text);
  compile();
}

function loadExample(name) {
  const ex = state.examples.find((e) => e.name === name);
  if (!ex) return;
  $("examples").value = ex.name;
  history.replaceState(null, "", location.pathname);
  loadSource(ex.source, ex.name.replace(/^\d+_/, "").replace(/_/g, " "));
}

async function loadExamples() {
  try {
    state.examples = await getJson("/api/examples");
    for (const ex of state.examples) {
      const opt = document.createElement("option");
      opt.value = ex.name;
      opt.textContent = ex.name.replace(/^\d+_/, "").replace(/_/g, " ");
      $("examples").appendChild(opt);
    }
  } catch (e) {
    setStatus("fail", "Cannot reach the compiler server. Start it with: make run");
    return;
  }
  const shared = await programFromUrl();
  if (shared) {
    loadSource(shared, "shared program");
    toast("Loaded the program from the link");
  } else if (state.examples.length && !getSource()) {
    loadExample(state.examples[0].name);
  }
}

// ---- smart home: controls, twin and the 24-hour day --------------------------------------

let day = null, chart = null, dayTimer = null, dayIndex = 0, daySpeed = 1, homeKey = "";

function deviceNames() {
  return state.result ? state.result.symbols.filter((s) => s.kind === "device").map((s) => s.name) : [];
}

function setupHome(r) {
  const key = r.cCode ? r.symbols.map((s) => s.kind + s.name + s.type).join("|") + "|" + r.optimizedIr.length + r.cCode.length : "";
  const ok = !!r.cCode;
  $("homeEmpty").hidden = ok;
  $("homeBody").hidden = !ok;
  if (!ok) { pauseDay(); renderTwin(null); homeKey = ""; return; }
  const changed = key !== homeKey;
  homeKey = key;
  for (const s of sensorSpecs(r)) {
    if (s.type === "NUMBER" && typeof state.simInputs[s.name] !== "number") state.simInputs[s.name] = s.first;
    if (s.type === "STATE" && !s.options.includes(state.simInputs[s.name])) state.simInputs[s.name] = s.options[s.options.length > 1 ? 1 : 0];
  }
  if (changed) {
    renderTwin(r, { onSensorClick: focusSensorControl });
    renderSensorControls(r);
    pauseDay();
    day = null;
    $("dayChart").innerHTML = '<p class="muted day-hint">Press <b>Play a day</b> to simulate 24 hours: sensors follow daily curves, devices change the room (heaters warm it, pumps water the soil) and the rules run every 5 minutes.</p>';
    $("dayClock").textContent = "Live";
  }
  simulate();
}

function renderSensorControls(r) {
  const list = $("sensorList");
  list.innerHTML = "";
  for (const s of sensorSpecs(r)) {
    const row = document.createElement("div");
    row.className = "sensor";
    row.dataset.sensor = s.name;
    const label = `<div class="sensor-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}<span class="sensor-type">${s.type}</span></div>`;
    if (s.type === "NUMBER") {
      const v = state.simInputs[s.name];
      row.innerHTML = label +
        `<input type="range" min="${s.min}" max="${Math.max(s.max, v)}" step="${s.step}" value="${v}" aria-label="${escapeHtml(s.name)}">` +
        `<input type="number" step="${s.step}" value="${v}" aria-label="${escapeHtml(s.name)} value">`;
      const [range, num] = row.querySelectorAll("input");
      const set = (val) => !Number.isNaN(val) && bus.emit("set-sensor", { name: s.name, value: val });
      range.addEventListener("input", () => set(parseFloat(range.value)));
      num.addEventListener("input", () => set(parseFloat(num.value)));
    } else {
      row.innerHTML = label + '<div class="segmented" role="group">' +
        s.options.map((o) => `<button type="button" class="seg${o === state.simInputs[s.name] ? " active" : ""}" data-v="${o}">${o}</button>`).join("") + "</div>";
      row.querySelectorAll(".seg").forEach((b) => b.addEventListener("click", () => bus.emit("set-sensor", { name: s.name, value: b.dataset.v })));
    }
    list.appendChild(row);
  }
  if (!list.children.length) list.innerHTML = '<p class="muted">No sensors declared.</p>';
}

function syncControls() {
  document.querySelectorAll("#sensorList .sensor").forEach((row) => {
    const v = state.simInputs[row.dataset.sensor];
    const inputs = row.querySelectorAll("input");
    if (inputs.length) {
      if (document.activeElement !== inputs[0]) inputs[0].value = v;
      if (document.activeElement !== inputs[1]) inputs[1].value = typeof v === "number" ? +v.toFixed(2) : v;
    }
    row.querySelectorAll(".seg").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  });
}

function focusSensorControl(name) {
  const row = document.querySelector(`#sensorList .sensor[data-sensor="${CSS.escape(name)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  row.classList.remove("flash");
  void row.offsetWidth;
  row.classList.add("flash");
  const input = row.querySelector("input, button");
  if (input) input.focus({ preventScroll: true });
}

function showRun(run) {
  const r = state.result;
  $("ruleList").innerHTML = r.optimizedIr
    .filter((ins) => ins.op === "rule")
    .map((ins) => {
      const acts = run.actions[ins.rule];
      const fight = run.conflicts.find((c) => c.rules.includes(ins.rule));
      return `<li class="${acts ? "fired" : ""}${fight ? " fight" : ""}"><span class="rule-name">Rule ${ins.rule}<small>line ${ins.line}</small></span>` +
        `<span class="rule-acts">${acts ? escapeHtml(acts.join(", ")) : "no action"}${fight ? " · conflicts on " + escapeHtml(fight.device) : ""}</span></li>`;
    })
    .join("");
}

function simulate() {
  if (!state.result || !state.result.cCode) return;
  const run = executeIr(state.result.optimizedIr, state.simInputs, deviceNames());
  updateTwin(state.simInputs, run);
  showRun(run);
  syncControls();
}

function setSensor({ name, value, from }) {
  state.simInputs[name] = value;
  if (dayTimer) pauseDay();
  $("dayClock").textContent = "Live";
  simulate();
  bus.emit("inputs-changed");
  if (from === "phone") toast(`Phone: ${name} = ${typeof value === "number" ? fmtNum(value) + unitFor(name) : value}`);
}

function ensureDay() {
  if (!day) {
    day = buildDay(state.result, Math.floor(Math.random() * 1e6));
    $("dayChart").innerHTML = "";
    chart = renderChart($("dayChart"), day, { onScrub: (k) => { pauseDay(); showFrame(k); } });
  }
}

function showFrame(k) {
  dayIndex = k;
  const f = day.frames[k];
  Object.assign(state.simInputs, f.inputs);
  updateTwin(f.inputs, f.run, { minute: f.minute });
  showRun(f.run);
  syncControls();
  chart.setHead(k);
  const h = Math.floor(f.minute / 60), m = f.minute % 60;
  $("dayClock").textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function playDay() {
  if (!state.result || !state.result.cCode) return;
  ensureDay();
  if (dayTimer) return pauseDay();
  if (dayIndex >= STEPS - 1) dayIndex = 0;
  $("playDay").textContent = "Pause";
  dayTimer = setInterval(() => {
    if (dayIndex >= STEPS - 1) { pauseDay(); return; }
    showFrame(dayIndex + 1);
  }, 110 / daySpeed);
}

function pauseDay() {
  clearInterval(dayTimer);
  dayTimer = null;
  $("playDay").textContent = "Play a day";
}

// ---- X-ray ---------------------------------------------------------------------------------

async function startXray() {
  const source = getSource();
  try {
    const [data] = await Promise.all([
      postJson("/api/compile", { source, trace: true }),
      state.language ? Promise.resolve() : getJson("/api/language").then((l) => (state.language = l)),
    ]);
    state.traceResult = data;
    state.traceSource = source;
    openXray(data, () => {
      $("smartHome").scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(playDay, 600);
    });
  } catch (e) {
    toast("Could not start the X-ray: " + e.message, "bad");
  }
}

// ---- wiring ------------------------------------------------------------------------------

function initHome() {
  $("playDay").addEventListener("click", playDay);
  $("newDay").addEventListener("click", () => { pauseDay(); day = null; dayIndex = 0; ensureDay(); showFrame(0); });
  $("daySpeed").addEventListener("change", (e) => {
    daySpeed = +e.target.value;
    if (dayTimer) { pauseDay(); playDay(); }
  });
  $("liveMode").addEventListener("click", () => { pauseDay(); $("dayClock").textContent = "Live"; simulate(); });
  bus.on("set-sensor", setSensor);
  bus.on("play-day", () => { $("smartHome").scrollIntoView({ behavior: "smooth", block: "start" }); if (!dayTimer) setTimeout(playDay, 500); });
}

function initButtons() {
  $("themeToggle").addEventListener("click", toggleTheme);
  $("compileBtn").addEventListener("click", () => compile());
  $("clearBtn").addEventListener("click", () => {
    setSource("");
    $("examples").selectedIndex = 0;
    state.result = null;
    state.compiledSource = null;
    resetPanes();
    setStatus("", "Ready");
  });
  $("examples").addEventListener("change", () => $("examples").value && loadExample($("examples").value));
  $("liveToggle").addEventListener("change", (e) => { state.live = e.target.checked; if (state.live) compile({ quiet: true }); });
  $("xrayBtn").addEventListener("click", startXray);
  $("presentBtn").addEventListener("click", startTour);
  $("shareBtn").addEventListener("click", () => shareProgram(getSource()));
  $("reportBtn").addEventListener("click", printReport);
  document.querySelectorAll(".step").forEach((s) =>
    s.addEventListener("click", () => {
      if (s.dataset.ir) setIrView(s.dataset.ir);
      showTab(s.dataset.tab);
      $("workspace").scrollIntoView({ behavior: "smooth", block: "nearest" });
    })
  );
  tabs().forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  window.addEventListener("resize", debounce(() => { positionIndicator(); if (day) { chart = renderChart($("dayChart"), day, { onScrub: (k) => { pauseDay(); showFrame(k); } }); chart.setHead(dayIndex); } }, 200));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target !== $("aiInput")) { e.preventDefault(); compile(); }
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
    $("shortcut").textContent = "⌘ ↵";
    $("paletteKey").textContent = "⌘K";
  }
}

function initBus() {
  bus.on("source-changed", () => {
    state.exampleName = state.exampleName || "my program";
    if (state.result) setStatus("stale", "Edited since last compile");
    liveCompile();
  });
  bus.on("apply-fix", (fix) => { applyFix(fix); toast("Applied: " + fix.title); });
  bus.on("replace-source", (text) => {
    const src = getSource();
    replaceRange(0, src.length, text);
    compile();
  });
  bus.on("load-example", loadExample);
  bus.on("show-tab", showTab);
  bus.on("ir-view", (v) => { setIrView(v); showTab("ir"); });
  bus.on("open-xray", startXray);
  bus.on("compiled", () => linkSpans(null));
}

function initCommands() {
  const cmds = [
    { title: "Watch it compile (X-ray)", group: "Show", run: startXray },
    { title: "Start presentation mode", group: "Show", run: startTour },
    { title: "Play a 24-hour day", group: "Smart home", run: () => bus.emit("play-day") },
    { title: "Phone remote (QR code)", group: "Smart home", run: openRemote },
    { title: "Share a link to this program", group: "File", run: () => shareProgram(getSource()) },
    { title: "Print / save the compilation report as PDF", group: "File", run: printReport },
    { title: "Compile now", group: "Compiler", run: () => compile() },
    { title: "Toggle live compile", group: "Compiler", run: () => { $("liveToggle").click(); } },
    { title: "Toggle light / dark theme", group: "View", run: toggleTheme },
    { title: "Toggle projector mode (larger text)", group: "View", run: () => document.documentElement.classList.toggle("projector") },
  ];
  [["tokens", "Tokens"], ["ast", "Syntax tree"], ["language", "Language: DFA, FIRST/FOLLOW, LL(1)"], ["symbols", "Symbols"],
   ["ir", "Intermediate code"], ["code", "Generated code"], ["problems", "Problems"]]
    .forEach(([id, name]) => cmds.push({ title: "Open " + name, group: "Tab", run: () => showTab(id) }));
  [["machine", "Optimizer time machine"], ["cfg", "Control-flow graph"]]
    .forEach(([id, name]) => cmds.push({ title: "Open " + name, group: "Tab", run: () => bus.emit("ir-view", id) }));
  state.examples.forEach((ex) => cmds.push({ title: "Load example: " + ex.name.replace(/^\d+_/, "").replace(/_/g, " "), group: "Example", run: () => loadExample(ex.name) }));
  setCommands(cmds);
}

async function init() {
  initEditor();
  initPanes();
  initLanguage();
  initCode();
  initXray();
  initAi();
  initTour();
  initPalette();
  initRemote();
  initHome();
  initButtons();
  initBus();
  showTab("tokens");
  document.querySelector(".tabs").scrollLeft = 0;
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionIndicator);
  getJson("/api/language").then((l) => { state.language = l; renderLanguage(); }).catch(() => {});
  await loadExamples();
  initCommands();
  window.addEventListener("hashchange", async () => {
    const shared = await programFromUrl();
    if (shared && shared !== getSource()) loadSource(shared, "shared program");
  });
}

init();
