// landing.js — the home page. Everything shown here comes from the real compiler:
// the hero demo calls /api/compile (or /api/nl2dsl for typed sentences), the story
// figures use /api/language and compiled examples, and the numbers come from
// data/project.json written by tools/project_stats.py.

import { initSite, projectStats, countUp, initReveal } from "./site.js";
import { escapeHtml, postJson, getJson, sleep } from "./util.js";
import { highlightDsl, highlightCode, irHtml } from "./highlight.js";
import { renderTree, renderDfa } from "./graph.js";
import { executeIr, sensorSpecs } from "./vm.js";
import { qrSvg } from "./qr.js";

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

initSite();

let stats = null;
const examplesCache = {};

async function compileSource(source) {
  const t0 = performance.now();
  const result = await postJson("/api/compile", { source });
  return { result, roundTrip: performance.now() - t0 };
}

async function compileExample(name) {
  if (examplesCache[name]) return examplesCache[name];
  const list = examplesCache.__list || (examplesCache.__list = await getJson("/api/examples"));
  const ex = list.find((e) => e.name === name);
  if (!ex) throw new Error("example not found");
  examplesCache[name] = { source: ex.source, result: (await compileSource(ex.source)).result };
  return examplesCache[name];
}

// ---------------------------------------------------------------- hero demo

const STAGES = ["Tokens", "Syntax tree", "Symbols & checks", "Three-address code", "Optimizer", "Generated code"];
const demo = { preset: null, result: null, source: "", stage: 0, auto: null, inputs: {}, target: "c", seq: 0 };

function countNodes(n) { return 1 + (n.children || []).reduce((a, c) => a + countNodes(c), 0); }
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function setStatus(kind, text) {
  $("demoStatus").className = "demo-status " + kind;
  $("demoStatus").querySelector("span").textContent = text;
}

function railItems() { return Array.from(document.querySelectorAll("#rail li")); }

function metrics(r) {
  const status = Object.fromEntries(r.phases.map((p) => [p.id, p.status]));
  const c = r.targets && r.targets.find((t) => t.id === "c");
  const syms = r.symbols.length;
  const errs = r.errors.filter((e) => e.severity !== "warning");
  return [
    { st: status.lexer, text: plural(r.stats.tokens, "token") },
    { st: status.parser === "ok" && status.ast === "ok" ? "ok" : status.parser === "ok" ? status.ast : status.parser, text: r.ast ? plural(countNodes(r.ast), "node") : "–" },
    { st: status.semantic, text: errs.length ? plural(errs.length, "error") : r.stats.warnings ? plural(r.stats.warnings, "warning") : `${plural(syms, "symbol")} ✓` },
    { st: status.ir, text: r.ir.length ? plural(r.stats.irBefore, "instr") : "–" },
    { st: status.optimizer, text: r.ir.length ? `${r.stats.irBefore} → ${r.stats.irAfter}` : "–" },
    { st: status.codegen, text: c ? `${c.code.trimEnd().split("\n").length} lines of C` : "–" },
  ];
}

async function lightRail(r) {
  const items = railItems();
  const m = metrics(r);
  items.forEach((li) => { li.classList.remove("done", "fail", "lit", "flash"); li.querySelector(".rail-metric").textContent = "…"; });
  $("rail").classList.remove("running");
  void $("rail").offsetWidth;
  $("rail").classList.add("running");
  for (let i = 0; i < items.length; i++) {
    const li = items[i];
    li.querySelector(".rail-metric").textContent = m[i].st === "skipped" ? "not reached" : m[i].text;
    li.classList.add(m[i].st === "ok" ? "done" : m[i].st === "error" ? "fail" : "", "flash");
    if (!reduceMotion) await sleep(110);
  }
}

function selectStage(i, { user = false } = {}) {
  demo.stage = i;
  if (user) stopAuto();
  railItems().forEach((li, k) => li.classList.toggle("lit", k === i));
  renderArtifact();
}

function startAuto() {
  stopAuto();
  if (reduceMotion) return;
  demo.auto = setInterval(() => selectStage((demo.stage + 1) % STAGES.length), 3200);
}
function stopAuto() { clearInterval(demo.auto); demo.auto = null; }

function treeHtml(n, counter) {
  const i = n.label.indexOf(": ");
  const key = n.kind === "logic" ? "" : i >= 0 ? n.label.slice(0, i) : n.label;
  const val = n.kind === "logic" ? n.label : i >= 0 ? n.label.slice(i + 2) : "";
  const vcls = n.kind === "number" ? "num" : n.kind === "state" ? "st" : n.kind === "logic" || n.kind === "compare" ? "op" : "";
  const kids = (n.children || []).map((c) => treeHtml(c, counter)).join("");
  return `<li style="--i:${counter.i++}"><span><span class="k">${escapeHtml(key)}</span>${key && val ? " " : ""}<span class="v ${vcls}">${escapeHtml(val)}</span></span>${kids ? `<ul>${kids}</ul>` : ""}</li>`;
}

function renderArtifact() {
  const r = demo.result;
  const art = $("demoArt");
  $("artTitle").textContent = STAGES[demo.stage];
  $("artHint").textContent = "";
  art.style.animation = "none"; void art.offsetWidth; art.style.animation = "";
  if (!r) { art.innerHTML = ""; return; }
  const status = Object.fromEntries(r.phases.map((p) => [p.id, p.status]));
  const notReached = (why) => `<p class="verdict">${why}</p>` + problemsHtml(r);

  switch (demo.stage) {
    case 0: {
      $("artHint").textContent = `${r.tokens.length} tokens`;
      art.innerHTML = '<div class="tok-strip">' + r.tokens.slice(0, 60).map((t, i) =>
        `<span class="tok ${t.category}" style="--i:${i}"><small>${escapeHtml(t.type)}</small><b>${escapeHtml(t.lexeme)}</b></span>`).join("") + "</div>";
      break;
    }
    case 1: {
      if (!r.ast) { art.innerHTML = notReached("The parser stopped at a syntax error, so no tree was built."); break; }
      $("artHint").textContent = `${countNodes(r.ast)} nodes`;
      const rules = r.ast.children.filter((c) => c.kind === "rule");
      const root = rules.length ? { ...r.ast, children: rules } : r.ast;
      art.innerHTML = `<div class="mini-tree"><ul>${treeHtml(root, { i: 0 })}</ul></div>`;
      break;
    }
    case 2: {
      if (status.semantic === "skipped") { art.innerHTML = notReached("Semantic analysis runs once the program parses."); break; }
      const warns = r.errors.filter((e) => e.phase === "semantic");
      art.innerHTML = '<table class="mini-table"><thead><tr><th>Name</th><th>Kind</th><th>Type</th><th>Uses</th></tr></thead><tbody>' +
        r.symbols.map((s) => `<tr><td>${escapeHtml(s.name)}</td><td>${s.kind}</td><td>${s.type || "–"}</td><td>${s.uses}</td></tr>`).join("") + "</tbody></table>" +
        (warns.length
          ? warns.slice(0, 3).map((w) => `<p class="verdict ${w.severity === "warning" ? "warn" : ""}"><b>${w.severity}</b> line ${w.line}: ${escapeHtml(w.message)}</p>`).join("")
          : '<p class="verdict ok"><b>✓ Types check.</b> Rule analysis found no impossible conditions and no conflicting rules.</p>');
      break;
    }
    case 3: {
      if (!r.ir.length) { art.innerHTML = notReached("Intermediate code is generated once the program passes semantic analysis."); break; }
      $("artHint").textContent = "before optimization";
      art.innerHTML = '<ol class="tac">' + r.ir.map((ins, i) =>
        `<li style="--i:${i}" class="${["label", "rule"].includes(ins.op) ? "" : "indent"}"><span>${irHtml(ins)}</span></li>`).join("") + "</ol>";
      break;
    }
    case 4: {
      if (!r.ir.length) { art.innerHTML = notReached("The optimizer runs on intermediate code."); break; }
      const passes = r.optimization.passes || [];
      const max = Math.max(1, ...passes.map((p) => p.count));
      const saved = r.stats.irBefore - r.stats.irAfter;
      art.innerHTML = `<div class="opt-sum">${r.stats.irBefore} → ${r.stats.irAfter}<small>${saved ? `instructions, ${Math.round((saved / r.stats.irBefore) * 100)}% smaller` : "already minimal: nothing to remove"}</small></div>` +
        '<div class="passes">' + passes.map((p) =>
          `<div class="pass"><span>${escapeHtml(p.name)}</span><span>${p.count}×</span><i><b style="--w:${(p.count / max) * 100}%"></b></i></div>`).join("") + "</div>" +
        (passes.length ? "" : '<p class="verdict ok">The program was already optimal; every pass ran and found nothing to change.</p>');
      break;
    }
    case 5: {
      if (!r.targets || !r.targets.length) { art.innerHTML = notReached("Code is generated once the program compiles without errors."); break; }
      const t = r.targets.find((x) => x.id === demo.target) || r.targets[0];
      $("artHint").textContent = t.fileName;
      art.innerHTML = '<div class="gen-tabs">' + r.targets.map((x) =>
        `<button type="button" data-target="${x.id}" class="${x.id === t.id ? "active" : ""}">${escapeHtml(x.name)}</button>`).join("") +
        `</div><pre class="gen-code">${highlightCode(t.code, t.id)}</pre>`;
      art.querySelectorAll(".gen-tabs button").forEach((b) => b.addEventListener("click", () => { stopAuto(); demo.target = b.dataset.target; renderArtifact(); }));
      break;
    }
  }
}

function problemsHtml(r) {
  return r.errors.slice(0, 4).map((e) => `<p class="verdict ${e.severity === "warning" ? "warn" : ""}"><b>${e.phase} ${e.severity}</b> line ${e.line}:${e.col}: ${escapeHtml(e.message)}</p>`).join("");
}

async function typeSource(src, seq) {
  const pre = $("demoSrc");
  if (reduceMotion) { pre.innerHTML = highlightDsl(src); return; }
  const step = Math.max(2, Math.round(src.length / 45));
  for (let n = 0; n <= src.length; n += step) {
    if (seq !== demo.seq) return;
    pre.innerHTML = highlightDsl(src.slice(0, n)) + '<span class="typing-caret"></span>';
    await sleep(14);
  }
  pre.innerHTML = highlightDsl(src);
}

// ---- room

function deviceIcon(name) {
  const n = name.toLowerCase();
  if (/fan|vent/.test(n)) return '<svg viewBox="0 0 34 34"><circle cx="17" cy="17" r="14"/><g class="spin"><path d="M17 15c2-7 8-7 8-3s-5 4-8 3Z"/><path d="M17 15c2-7 8-7 8-3s-5 4-8 3Z" transform="rotate(120 17 17)"/><path d="M17 15c2-7 8-7 8-3s-5 4-8 3Z" transform="rotate(240 17 17)"/></g><circle cx="17" cy="17" r="1.6"/></svg>';
  if (/light|lamp|bulb/.test(n)) return '<svg viewBox="0 0 34 34"><circle cx="17" cy="14" r="8" class="glowc"/><path d="M13.5 22.5h7M14.5 26h5M14 21c0-2-3-3.5-3-7a6 6 0 0 1 12 0c0 3.5-3 5-3 7"/></svg>';
  if (/pump|sprink|water|irrig|valve/.test(n)) return '<svg viewBox="0 0 34 34"><path d="M17 5s-8 9-8 14a8 8 0 0 0 16 0c0-5-8-14-8-14Z"/><path class="drop" d="M17 27v3"/></svg>';
  if (/alarm|siren|buzz|bell/.test(n)) return '<svg viewBox="0 0 34 34"><circle class="ringo" cx="17" cy="16" r="12"/><path d="M11 22V15a6 6 0 0 1 12 0v7M9 22h16M15 25.5a2 2 0 0 0 4 0"/></svg>';
  if (/heat/.test(n)) return '<svg viewBox="0 0 34 34"><rect x="7" y="16" width="20" height="10" rx="2"/><path d="M12 12c-1.5-2 1.5-3 0-5M17 12c-1.5-2 1.5-3 0-5M22 12c-1.5-2 1.5-3 0-5"/></svg>';
  if (/cool|^ac$|air/.test(n)) return '<svg viewBox="0 0 34 34"><path d="M17 5v24M7 11l20 12M27 11 7 23"/></svg>';
  if (/lock|door/.test(n)) return '<svg viewBox="0 0 34 34"><rect x="9" y="15" width="16" height="12" rx="2"/><path d="M12 15v-4a5 5 0 0 1 10 0v4"/></svg>';
  return '<svg viewBox="0 0 34 34"><rect x="8" y="8" width="18" height="18" rx="3"/><circle cx="17" cy="17" r="3"/></svg>';
}

function setupRoom(r) {
  const devs = r.symbols.filter((s) => s.kind === "device").map((s) => s.name);
  const specs = r.optimizedIr && r.optimizedIr.length ? sensorSpecs(r) : [];
  $("roomDevices").innerHTML = devs.map((d) =>
    `<div class="device-tile" data-dev="${escapeHtml(d)}">${deviceIcon(d)}<span class="dn">${escapeHtml(d)}</span><span class="ds">OFF</span><span class="lvl"><b></b></span></div>`).join("") ||
    '<p class="muted" style="font-size:13px">No devices declared.</p>';

  demo.inputs = {};
  for (const s of specs) {
    if (s.type === "NUMBER") demo.inputs[s.name] = Math.min(s.max, +(s.first + Math.max(s.step, Math.round((s.max - s.min) * 0.08))).toFixed(1));
    else demo.inputs[s.name] = s.options[0];
  }
  $("roomSensors").innerHTML = specs.map((s) => s.type === "NUMBER"
    ? `<div class="rs"><label for="rs-${s.name}">${escapeHtml(s.name)}</label><output id="ro-${s.name}">${demo.inputs[s.name]}</output>` +
      `<input id="rs-${s.name}" type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${demo.inputs[s.name]}" data-s="${s.name}"></div>`
    : `<div class="rs"><label>${escapeHtml(s.name)}</label><span></span><div class="segmented" role="group" aria-label="${escapeHtml(s.name)}">` +
      s.options.map((o) => `<button type="button" class="seg${o === demo.inputs[s.name] ? " active" : ""}" data-s="${s.name}" data-v="${o}">${o}</button>`).join("") + "</div></div>").join("");

  $("roomSensors").querySelectorAll("input[type=range]").forEach((el) => el.addEventListener("input", () => {
    demo.inputs[el.dataset.s] = parseFloat(el.value);
    $("ro-" + el.dataset.s).textContent = el.value;
    runRoom();
  }));
  $("roomSensors").querySelectorAll(".seg").forEach((b) => b.addEventListener("click", () => {
    demo.inputs[b.dataset.s] = b.dataset.v;
    b.parentElement.querySelectorAll(".seg").forEach((x) => x.classList.toggle("active", x === b));
    runRoom();
  }));
  runRoom();
}

function runRoom() {
  const r = demo.result;
  if (!r || !r.optimizedIr || !r.optimizedIr.length) return;
  const devs = r.symbols.filter((s) => s.kind === "device").map((s) => s.name);
  const run = executeIr(r.optimizedIr, demo.inputs, devs);
  document.querySelectorAll("#roomDevices .device-tile").forEach((tile) => {
    const d = run.devices[tile.dataset.dev];
    if (!d) return;
    tile.classList.toggle("on", d.on);
    const lv = d.on ? (d.level > 0 ? d.level : 100) : 0;
    tile.style.setProperty("--lv", Math.max(0.3, lv / 100));
    tile.querySelector(".ds").textContent = d.on ? (d.level > 0 && d.level < 100 ? `ON · ${d.level}%` : "ON") : "OFF";
    tile.querySelector(".lvl b").style.width = lv + "%";
  });
}

// ---- running a program through the demo

async function showProgram(source, result, { roundTrip = null, recorded = false } = {}) {
  const seq = ++demo.seq;
  demo.source = source;
  demo.result = result;
  const errs = result.stats.errors;
  if (recorded) setStatus("ok", "Offline: showing a result recorded from the real compiler");
  else setStatus(errs ? "bad" : "ok", errs
    ? `${plural(errs, "error")} found by iotc`
    : `Compiled by iotc in ${result.stats.timeMs.toFixed(2)} ms` + (roundTrip ? ` · ${Math.round(roundTrip)} ms round trip` : ""));
  $("srcHint").textContent = `${source.trimEnd().split("\n").length} lines`;
  const typing = typeSource(source, seq);
  await lightRail(result);
  await typing;
  if (seq !== demo.seq) return;
  setupRoom(result);
  const firstBad = result.phases.findIndex((p) => p.status === "error");
  selectStage(firstBad >= 0 ? [0, 1, 1, 2, 3, 4, 5][firstBad] : 0);
  if (!errs) startAuto();
}

async function runPreset(p) {
  stopAuto();
  demo.preset = p;
  document.querySelectorAll(".preset").forEach((b) => b.classList.toggle("active", b.dataset.id === p.id));
  $("demoInput").value = p.english;
  setStatus("busy", "Compiling…");
  try {
    const { result, roundTrip } = await compileSource(p.dsl);
    await showProgram(p.dsl, result, { roundTrip });
  } catch (e) {
    await showProgram(p.dsl, p.result, { recorded: true });
  }
}

async function runSentence(text) {
  const preset = stats && stats.presets.find((p) => p.english === text);
  if (preset) return runPreset(preset);
  stopAuto();
  document.querySelectorAll(".preset").forEach((b) => b.classList.remove("active"));
  $("demoRun").classList.add("busy");
  setStatus("busy", "Converting English to the DSL…");
  try {
    const d = await postJson("/api/nl2dsl", { text });
    if (!d.ok) { setStatus("bad", d.error || "Could not convert this sentence"); return; }
    setStatus("busy", `Converted by ${d.provider}${d.model ? " · " + d.model : ""}. Compiling…`);
    const { result, roundTrip } = await compileSource(d.dsl);
    await showProgram(d.dsl, result, { roundTrip });
    const by = `${d.provider}${d.model ? " · " + d.model : ""}`;
    setStatus(result.stats.errors ? "bad" : "ok", (result.stats.errors ? "The AI's answer has errors" : `Converted by ${by}, verified by iotc`) + ` · ${result.stats.timeMs.toFixed(2)} ms`);
  } catch (e) {
    setStatus("bad", "The compiler server is not running. Start it with: make run");
  } finally {
    $("demoRun").classList.remove("busy");
  }
}

function initDemo() {
  const presets = stats ? stats.presets : [];
  $("demoPresets").innerHTML = presets.map((p) => `<button type="button" class="preset" data-id="${p.id}">${escapeHtml(p.label)}</button>`).join("");
  $("demoPresets").querySelectorAll(".preset").forEach((b) => b.addEventListener("click", () => runPreset(presets.find((p) => p.id === b.dataset.id))));
  $("demoInput").placeholder = "Describe a rule, e.g. If the humidity is above 70, turn on the vent";
  $("demoForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("demoInput").value.trim();
    if (text) runSentence(text);
  });
  railItems().forEach((li, i) => li.querySelector("button").addEventListener("click", () => selectStage(i, { user: true })));
  $("demoArt").addEventListener("pointerdown", stopAuto);
  if (presets.length) runPreset(presets[0]);
  else setStatus("bad", "Project data missing: run make test or make stats");
}

// ---------------------------------------------------------------- numbers

function fillStats() {
  if (!stats) return;
  const values = { tests: stats.tests.total, lines: stats.compiler.lines, productions: stats.grammar.productions, targets: stats.targets.length, phases: stats.phases };
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    document.querySelectorAll("[data-stat]").forEach((el) => {
      const v = values[el.dataset.stat];
      if (typeof v === "number") countUp(el, v);
    });
  }, { threshold: 0.4 });
  io.observe($("proof"));
  const note = document.querySelector('[data-stat-note="conflicts"]');
  note.textContent = stats.grammar.conflicts === 0 ? "LL(1) · 0 conflicts" : `${stats.grammar.conflicts} LL(1) conflicts`;
  if (stats.tests.total == null) document.querySelector('[data-stat="tests"]').textContent = stats.tests.python;
}

async function aiStatus() {
  try {
    const s = await getJson("/api/ai-status");
    const name = s.mode === "llm" ? `${s.provider}${s.model ? " · " + s.model : ""}` : "Offline rules";
    $("aiTag").textContent = s.mode === "llm" ? s.provider : "Offline";
    $("aiLive").innerHTML = `<i class="led"></i>Active right now: ${escapeHtml(name)}`;
  } catch (e) {
    $("aiTag").textContent = "AI";
    $("aiLive").innerHTML = '<i class="led"></i>Start the server to see which model is active';
  }
}

// ---------------------------------------------------------------- story figures

const unavailable = (el) => (el.innerHTML = '<div class="fig-empty">Start the compiler server (<span class="mono">make run</span>) to load this figure.</div>');

async function storyFigures() {
  const sym = (s) => `<span class="${/^[a-z_]+$/.test(s) && !["id", "num"].includes(s) ? "g-nt" : "g-t"}">${escapeHtml(s)}</span>`;
  try {
    const lang = await getJson("/api/language");
    renderDfa($("figDfa"), lang.dfa);
    $("figDfaNote").textContent = `${lang.dfa.states.length} states, from the hand-written lexer`;
    const g = lang.grammar;
    const shown = ["rule", "else_part", "expr", "expr_tail", "and_expr", "not_expr", "rel_expr", "action"].filter((nt) => g.nonterminals.includes(nt));
    const list = shown.length >= 4 ? shown : g.nonterminals.slice(0, 8);
    $("figGrammar").innerHTML = '<div class="gram">' + list.map((nt) => {
      const alts = g.productions.filter((p) => p.lhs === nt).map((p) => (p.rhs.length ? p.rhs.map(sym).join(" ") : '<span class="g-eps">ε</span>'));
      return `<div class="g-row"><span>${sym(nt)}</span><span class="g-arrow">→</span><span>${alts.join(' <span class="g-bar">|</span> ')}</span></div>`;
    }).join("") + "</div>" +
      '<div class="first-sets">' + list.slice(0, 6).map((nt) => `<div><b>FIRST(${escapeHtml(nt)})</b><br><span>{ ${g.first[nt].map(escapeHtml).join(", ")} }</span></div>`).join("") + "</div>" +
      `<p class="verdict ${g.conflicts.length ? "warn" : "ok"}"><b>${g.conflicts.length ? "✗" : "✓"} ${g.conflicts.length ? g.conflicts.length + " conflicts" : "LL(1)"}.</b> ${g.productions.length} productions, ${g.nonterminals.length} nonterminals, ${g.terminals.length} terminals; every cell of the parse table has at most one production.</p>`;
    $("figLlNote").textContent = `${list.length} of ${g.nonterminals.length} nonterminals shown`;
  } catch (e) { unavailable($("figDfa")); unavailable($("figGrammar")); }

  const preset = demo.result || (stats && stats.presets[0] && stats.presets[0].result);
  if (preset && preset.ast) {
    // Only the rule: the declarations make the tree wide without saying much.
    const rules = preset.ast.children.filter((c) => c.kind === "rule");
    renderTree($("figTree"), rules.length ? { ...preset.ast, children: rules } : preset.ast);
  }
  else unavailable($("figTree"));

  try {
    const { result } = await compileExample("08_rule_analysis");
    const warns = result.errors.filter((e) => e.phase === "semantic");
    $("figSemaNote").textContent = "example 08_rule_analysis";
    $("figSema").innerHTML = '<table class="mini-table"><thead><tr><th>Name</th><th>Kind</th><th>Type</th><th>Declared</th><th>Uses</th></tr></thead><tbody>' +
      result.symbols.map((s) => `<tr><td>${escapeHtml(s.name)}</td><td>${s.kind}</td><td>${s.type || "–"}</td><td>line ${s.line}</td><td>${s.uses}</td></tr>`).join("") + "</tbody></table>" +
      warns.slice(0, 4).map((w) => `<p class="verdict warn"><b>warning</b> line ${w.line}: ${escapeHtml(w.message)}</p>`).join("");
    const conflict = warns.find((w) => /^conflict/.test(w.message));
    if (conflict) $("conflictArt").innerHTML = `<b>warning</b>line ${conflict.line}: ${escapeHtml(conflict.message)}`;
  } catch (e) { unavailable($("figSema")); }

  try {
    const { result } = await compileExample("07_optimization");
    $("figIrNote").textContent = `example 07_optimization · ${result.ir.length} instructions before optimization`;
    $("figIr").innerHTML = '<ol class="tac">' + result.ir.map((ins, i) =>
      `<li style="--i:${i}" class="${["label", "rule"].includes(ins.op) ? "" : "indent"}"><span>${irHtml(ins)}</span></li>`).join("") + "</ol>";
    const full = await postJson("/api/compile", { source: examplesCache["07_optimization"].source, trace: true });
    drawOptChart($("figOpt"), full.optTrace || []);
    $("figOptNote").textContent = `example 07 · ${result.stats.irBefore} → ${result.stats.irAfter} instructions`;
  } catch (e) { unavailable($("figIr")); unavailable($("figOpt")); }

  const gen = demo.result || (stats && stats.presets[0].result);
  if (gen && gen.targets) {
    let cur = "c";
    const draw = () => {
      const t = gen.targets.find((x) => x.id === cur);
      $("figGen").innerHTML = '<div class="gen-tabs">' + gen.targets.map((x) => `<button type="button" data-t="${x.id}" class="${x.id === cur ? "active" : ""}">${escapeHtml(x.name)} <span class="muted">${escapeHtml(x.fileName)}</span></button>`).join("") +
        `</div><pre class="gen-code">${highlightCode(t.code, t.id)}</pre>`;
      $("figGen").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { cur = b.dataset.t; draw(); }));
    };
    draw();
  }
}

// Bar chart: instruction count after each optimizer pass (snapshots from the real optimizer trace).
function drawOptChart(el, trace) {
  if (!trace.length) { unavailable(el); return; }
  const W = 640, H = 260, pad = { l: 34, r: 12, t: 16, b: 54 };
  const max = Math.max(...trace.map((s) => s.count));
  const bw = (W - pad.l - pad.r) / trace.length;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="opt-chart" role="img" aria-label="Instruction count after each optimizer pass">`;
  for (let g = 0; g <= max; g += Math.max(1, Math.ceil(max / 4))) {
    svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(g)}" y2="${y(g)}" class="oc-grid"/><text x="${pad.l - 8}" y="${y(g) + 4}" class="oc-tick" text-anchor="end">${g}</text>`;
  }
  trace.forEach((s, i) => {
    const prev = i ? trace[i - 1].count : s.count;
    const x = pad.l + i * bw + bw * 0.18, w = bw * 0.64;
    const changed = s.count < prev;
    svg += `<g class="oc-bar${changed ? " changed" : ""}${i === 0 ? " first" : ""}" style="--d:${i * 60}ms"><title>${escapeHtml(s.pass)} (round ${s.round}): ${s.count} instructions</title>` +
      `<rect x="${x}" y="${y(s.count)}" width="${w}" height="${H - pad.b - y(s.count)}" rx="3"/>` +
      `<text x="${x + w / 2}" y="${y(s.count) - 6}" text-anchor="middle" class="oc-val">${s.count}</text>` +
      `<text x="${x + w / 2}" y="${H - pad.b + 16}" text-anchor="end" transform="rotate(-35 ${x + w / 2} ${H - pad.b + 16})" class="oc-tick">${escapeHtml(abbrev(s.pass))}</text></g>`;
  });
  svg += "</svg>";
  el.innerHTML = svg + '<div class="chart-legend"><span><i style="background:var(--accent)"></i>pass removed instructions</span><span><i style="background:var(--line-strong)"></i>no change</span></div>';
}
const abbrev = (p) => ({ "Constant folding": "fold", "Algebraic simplification": "algebra", "Common sub-expression elimination": "CSE", "Copy propagation": "copy prop",
  "Constant branch elimination": "branch", "Unreachable code elimination": "unreachable", "Jump optimization": "jumps", "Dead code elimination": "DCE", Original: "original" }[p] || p.split(" ")[0].toLowerCase());

function initStory() {
  const items = Array.from(document.querySelectorAll("#storyNav li"));
  const figs = Array.from(document.querySelectorAll(".story-figs .fig"));
  const activate = (i) => {
    items.forEach((li) => li.classList.toggle("active", +li.dataset.i === i));
    figs.forEach((f) => f.classList.toggle("active", +f.dataset.i === i));
  };
  activate(0);
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => e.isIntersecting && activate(+e.target.dataset.i));
  }, { rootMargin: "-45% 0px -50% 0px" });
  figs.forEach((f) => io.observe(f));
  items.forEach((li) => li.addEventListener("click", () => figs[+li.dataset.i].scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" })));

  // Draw the figures when the section first comes near (graphs measure their container).
  let drawn = false;
  const near = new IntersectionObserver((entries) => {
    if (drawn || !entries.some((e) => e.isIntersecting)) return;
    drawn = true;
    near.disconnect();
    storyFigures();
  }, { rootMargin: "400px 0px" });
  near.observe($("how"));
}

// ---------------------------------------------------------------- measured charts

function measured() {
  if (!stats) return;
  const valid = stats.examples.filter((e) => e.errors === 0 && e.irBefore > 0);
  const max = Math.max(...valid.map((e) => e.irBefore)) * 1.16;   // leave room for the labels
  const name = (n) => n.replace(/^\d+_/, "").replace(/_/g, " ");
  $("chartIr").innerHTML = '<div class="bars">' + valid.map((e) =>
    `<div class="bar-row"><span title="${e.name}">${name(e.name)}</span><div class="bar-pair">` +
    `<div class="bar before" style="--w:${(e.irBefore / max) * 100}%"><b data-w="${(e.irBefore / max) * 100}"></b><em>${e.irBefore}</em></div>` +
    `<div class="bar after" style="--w:${(e.irAfter / max) * 100}%"><b data-w="${(e.irAfter / max) * 100}"></b><em>${e.irAfter}${e.irAfter < e.irBefore ? ` (−${Math.round((1 - e.irAfter / e.irBefore) * 100)}%)` : ""}</em></div></div></div>`).join("") +
    '</div><div class="chart-legend"><span><i style="background:var(--line-strong)"></i>before</span><span><i style="background:var(--accent)"></i>after optimization</span></div>';

  const cols = ["lexer", "parser", "ast", "semantic", "ir", "optimizer", "codegen"];
  const heads = ["LEX", "PARSE", "AST", "SEM", "IR", "OPT", "GEN"];
  const mark = { ok: "✓", error: "✗", skipped: "–" };
  $("chartPhases").innerHTML = '<table class="phase-grid"><thead><tr><th></th>' + heads.map((h) => `<th>${h}</th>`).join("") + "</tr></thead><tbody>" +
    stats.examples.map((e) => `<tr><th scope="row">${name(e.name)}</th>` + cols.map((c) => `<td class="${e.phases[c]}" title="${c}: ${e.phases[c]}">${mark[e.phases[c]] || ""}</td>`).join("") + "</tr>").join("") +
    "</tbody></table>" + '<div class="chart-legend"><span>✓ passed</span><span>✗ errors found</span><span>– not reached</span></div>';

  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    document.querySelectorAll("#chartIr .bar b").forEach((b) => (b.style.width = b.dataset.w + "%"));
  }, { threshold: 0.3 });
  io.observe($("chartIr"));
}

// ---------------------------------------------------------------- start

(async function start() {
  try { $("qrArt").innerHTML = qrSvg(location.origin + "/remote.html", { quiet: 1, className: "" }); } catch (e) { /* decorative */ }
  aiStatus();
  stats = await projectStats();
  fillStats();
  initDemo();
  initStory();
  measured();
  initReveal();
})();
