// xray.js — "Compiler X-ray": plays the whole compilation step by step, using the
// real traces recorded by the C++ compiler (scanner DFA steps, parser calls,
// symbol table, IR, optimizer snapshots and generated code).

import { $, bus, escapeHtml, lineStarts, toOffset, posLE } from "./util.js";
import { state } from "./state.js";
import { renderDfa, renderTree } from "./graph.js";
import { irHtml, highlightCode, highlightDsl } from "./highlight.js";
import { snapshotHtml } from "./panes.js";

const PHASES = [
  { id: "scan", name: "Lexical analysis", ms: 45,
    caption: "The scanner reads one character at a time and follows its DFA. When no transition fits, it accepts the longest token it has seen (maximal munch) and starts again from <b>start</b>." },
  { id: "parse", name: "Syntax analysis", ms: 70,
    caption: "The recursive-descent parser calls one function per grammar rule. One token of lookahead decides which rule to use (LL(1)), and the syntax tree grows as rules complete." },
  { id: "sema", name: "Semantic analysis", ms: 520,
    caption: "Declarations fill the symbol table; every use is checked for kind and type. Then the conditions are reasoned about: impossible or always-true conditions and conflicting rules." },
  { id: "ir", name: "Intermediate code", ms: 260,
    caption: "Each expression becomes three-address code: one operator per instruction, temporaries t1, t2 … and IF_FALSE / GOTO with labels for the branches." },
  { id: "opt", name: "Optimization", ms: 1500,
    caption: "Optimization passes run on the control-flow graph until nothing changes. Struck-out lines were removed; highlighted lines were added or rewritten." },
  { id: "gen", name: "Code generation", ms: 110,
    caption: "The code generator turns the IF_FALSE / GOTO patterns back into if / else and writes C. The same IR also becomes Arduino, Python and JavaScript." },
  { id: "done", name: "Compiled", ms: 2000, caption: "" },
];

let r = null;          // compile result with traces
let frames = [];       // [{phase, step}]
let pos = 0;
let timer = null;
let speed = 1;
let built = "";        // phase whose stage DOM is built
let dfaView = null, treeView = null, tokOffsets = [], starts = [];
let onFinish = null;

function sample(list, max, keep) {
  if (list.length <= max) return list.map((_, i) => i);
  const idx = [];
  const every = list.length / max;
  for (let i = 0; i < list.length; i++) if (keep(list[i]) || Math.floor(i / every) !== Math.floor((i - 1) / every)) idx.push(i);
  return idx;
}

function buildFrames() {
  frames = [];
  // Scanner: skip whitespace steps; keep at most ~320 steps.
  const lex = r.lexTrace.map((s, i) => ({ s, i })).filter(({ s }) => !(s[1] === "START" && s[2] === "START"));
  const lexIdx = sample(lex, 320, () => false);
  lexIdx.forEach((k) => frames.push({ phase: 0, step: lex[k].i }));
  frames.push({ phase: 0, step: r.lexTrace.length });   // all tokens accepted
  const parseIdx = sample(r.parseTrace, 420, (e) => e[0] === "error");
  parseIdx.forEach((k) => frames.push({ phase: 1, step: k }));
  frames.push({ phase: 1, step: r.parseTrace.length });
  const semaSteps = r.symbols.length + r.errors.filter((e) => e.phase === "semantic").length;
  for (let k = 0; k <= Math.max(1, semaSteps); k++) frames.push({ phase: 2, step: k });
  if (r.ir.length) {
    for (let k = 0; k <= r.ir.length; k++) frames.push({ phase: 3, step: k });
    for (let k = 0; k < r.optTrace.length; k++) frames.push({ phase: 4, step: k });
    const c = r.targets[0];
    for (let k = 0; k <= c.lines.length; k++) {
      // boilerplate lines (no source mapping) go by in bursts of four
      if (k < c.lines.length && c.lines[k][0] < 0 && k % 4) continue;
      frames.push({ phase: 5, step: k });
    }
  }
  frames.push({ phase: 6, step: 0 });
}

// ---- the source pane (left side of every phase) ------------------------------------------

function sourceHtml(curStart, curEnd, doneUntil) {
  const src = state.traceSource;
  const a = Math.max(0, Math.min(curStart, src.length)), b = Math.max(a, Math.min(curEnd, src.length));
  const d = Math.max(0, Math.min(doneUntil, a));
  return `<span class="xr-done">${highlightDsl(src.slice(0, d))}</span>` +
    `<span>${highlightDsl(src.slice(d, a))}</span>` +
    `<span class="xr-cur">${escapeHtml(src.slice(a, b)) || " "}</span>` +
    `<span class="xr-pending">${escapeHtml(src.slice(b))}</span>`;
}

function showSource(a, b, done) {
  const pre = $("xrSource");
  pre.innerHTML = sourceHtml(a, b, done);
  const cur = pre.querySelector(".xr-cur");
  if (cur) {
    const top = cur.offsetTop - pre.clientHeight / 2;
    if (Math.abs(pre.scrollTop - top) > pre.clientHeight / 3) pre.scrollTop = Math.max(0, top);
  }
}

const spanOffsets = (s) => [toOffset(starts, s[0], s[1]), toOffset(starts, s[2], s[3])];

// ---- phase stages ----------------------------------------------------------------------

function buildStage(phase) {
  built = phase;
  const stage = $("xrStage");
  stage.className = "xr-stage p-" + PHASES[phase].id;
  const right = {
    0: `<div class="xr-card xr-dfa"><h3>Scanner DFA <small id="xrState"></small></h3><div id="xrDfa"></div></div>
        <div class="xr-card xr-tokens"><h3>Tokens <small id="xrTokCount"></small></h3><div id="xrTokStrip" class="xr-strip"></div></div>`,
    1: `<div class="xr-card xr-stack"><h3>Call stack <small>recursive descent</small></h3><ol id="xrStack"></ol><p id="xrLook" class="xr-look"></p></div>
        <div class="xr-card xr-tree"><h3>Syntax tree</h3><div id="xrTree"></div></div>`,
    2: `<div class="xr-card"><h3>Symbol table</h3><table class="data-table xr-symtab"><thead><tr><th>Name</th><th>Kind</th><th>Type</th><th>Declared</th></tr></thead><tbody id="xrSyms"></tbody></table></div>
        <div class="xr-card"><h3>Checks</h3><ul id="xrChecks" class="xr-checks"></ul></div>`,
    3: `<div class="xr-card xr-wide"><h3>Three-address code <small id="xrIrCount"></small></h3><ol id="xrIr" class="ir-list"></ol></div>`,
    4: `<div class="xr-card xr-wide"><div class="xr-pass"><span id="xrPass"></span><b id="xrCount"></b></div><ol id="xrOpt" class="ir-list"></ol></div>`,
    5: `<div class="xr-card xr-wide"><h3>program.c <small>generated from the optimized IR</small></h3><ol id="xrGen" class="ir-list code-list"></ol></div>`,
    6: `<div class="xr-done-card" id="xrSummary"></div>`,
  }[phase];
  stage.innerHTML = (phase < 6 ? `<div class="xr-card xr-src"><h3>Source</h3><pre id="xrSource" class="xr-source"></pre></div>` : "") + right;
  if (phase === 0) dfaView = renderDfa($("xrDfa"), state.language.dfa);
  if (phase === 1 && r.ast) treeView = renderTree($("xrTree"), r.ast);
}

function renderScan(step) {
  const t = r.lexTrace;
  const s = t[Math.min(step, t.length - 1)];
  const done = step >= t.length;
  const offset = done ? state.traceSource.length : s[0];
  showSource(offset, offset + 1, offset);
  dfaView.highlight(done ? null : s[1], done ? "START" : s[2]);
  $("xrState").textContent = done ? "all input read" : `${s[1].toLowerCase()} → ${s[2].toLowerCase()}`;
  const accepted = r.tokens.filter((_, i) => tokOffsets[i][1] <= offset);
  $("xrTokCount").textContent = `${accepted.length} / ${r.tokens.length}`;
  $("xrTokStrip").innerHTML = accepted.slice(-18)
    .map((tk, i, arr) => `<span class="pill ${tk.category}${i === arr.length - 1 ? " fresh" : ""}">${tk.type}<em>${escapeHtml(tk.lexeme)}</em></span>`)
    .join("");
}

function renderParse(step) {
  const ev = r.parseTrace;
  const stack = [];
  let last = null;
  for (let i = 0; i < Math.min(step + 1, ev.length); i++) {
    const [kind, name] = ev[i];
    if (kind === "enter") stack.push({ name, err: false });
    else if (kind === "exit") stack.pop();
    else if (kind === "error" && stack.length) stack[stack.length - 1].err = true;
    last = ev[i];
  }
  const tokIndex = last ? Math.min(last[2], r.tokens.length - 1) : 0;
  const tok = r.tokens[tokIndex];
  const done = step >= ev.length;
  if (tok && !done) {
    const [a, b] = tokOffsets[tokIndex];
    showSource(a, b, a);
  } else showSource(state.traceSource.length, state.traceSource.length, state.traceSource.length);

  const fn = state.language.grammar.functions;
  $("xrStack").innerHTML = stack.length
    ? stack.map((f, i) => `<li class="${i === stack.length - 1 ? "top" : ""}${f.err ? " err" : ""}" style="--d:${i}"><code>${escapeHtml((fn[f.name] || f.name).split(" / ")[0])}</code><small>${escapeHtml(f.name)}</small></li>`).join("")
    : '<li class="top"><code>done</code><small>the whole program matched the grammar</small></li>';
  $("xrLook").innerHTML = done ? "" : last && last[0] === "error"
    ? `<b class="bad">Syntax error</b> expected ${escapeHtml(last[1])}`
    : tok ? `Lookahead: <span class="pill ${tok.category}">${tok.type}</span> <code>${escapeHtml(tok.lexeme || "end")}</code>` : "";

  if (treeView) {
    const end = done || !tok ? [1e9, 1e9] : [tok.line, tok.col];
    treeView.nodes.forEach((n) => {
      const e = n.data.end;
      const visible = n.depth === 0 || (e && e[0] && posLE(e[0], e[1], end[0], end[1]));
      n.el.classList.toggle("xr-hidden", !visible);
      if (n.edge) n.edge.classList.toggle("xr-hidden", !visible);
    });
  }
}

function renderSema(step) {
  const sema = r.phases.find((p) => p.id === "semantic");
  showSource(0, 0, 0);
  if (sema.status === "skipped") {
    $("xrSyms").innerHTML = "";
    $("xrChecks").innerHTML = `<li class="err">Not run: the lexer or parser found ${r.stats.errors} error(s). A real compiler stops here too.</li>`;
    return;
  }
  const syms = r.symbols.slice(0, step);
  $("xrSyms").innerHTML = syms
    .map((s, i) => `<tr class="${i === syms.length - 1 ? "fresh" : ""}"><td>${escapeHtml(s.name)}</td><td><span class="kind-tag ${s.kind}">${s.kind}</span></td><td>${s.type}</td><td>${s.line}:${s.col}</td></tr>`)
    .join("");
  const checks = r.errors.filter((e) => e.phase === "semantic").slice(0, Math.max(0, step - r.symbols.length));
  const cur = step <= r.symbols.length ? r.symbols[step - 1] : null;
  if (cur) {
    const [a, b] = spanOffsets([cur.line, cur.col, cur.line, cur.col + cur.name.length]);
    showSource(a, b, 0);
  } else if (checks.length) {
    const e = checks[checks.length - 1];
    const [a, b] = spanOffsets([e.line, e.col, e.line, e.col + Math.max(1, e.length)]);
    showSource(a, b, 0);
  }
  const allDone = step >= r.symbols.length + r.errors.filter((e) => e.phase === "semantic").length;
  $("xrChecks").innerHTML =
    checks.map((e) => `<li class="${e.severity}">${escapeHtml(e.message)}</li>`).join("") +
    (allDone ? `<li class="ok">${sema.status === "ok" ? "Types check out: every name is declared and every comparison is well-typed." : "Errors found: code generation is skipped."}</li>` : "");
}

function renderIr(step) {
  const shown = r.ir.slice(0, step);
  $("xrIrCount").textContent = `${shown.filter((i) => i.op !== "rule").length} instructions`;
  $("xrIr").innerHTML = shown
    .map((ins, i) => `<li class="${ins.op === "rule" ? "rule-row" : ins.op === "label" ? "" : "indent"}${i === shown.length - 1 ? " fresh" : ""}"><span class="ins">${irHtml(ins)}</span></li>`)
    .join("");
  const cur = shown[shown.length - 1];
  if (cur && cur.src && cur.src[0]) { const [a, b] = spanOffsets(cur.src); showSource(a, b, 0); }
  else showSource(0, 0, 0);
  $("xrIr").scrollTop = $("xrIr").scrollHeight;
}

function renderOpt(step) {
  const snap = r.optTrace[step];
  $("xrPass").textContent = step === 0 ? "Before optimization" : `Pass: ${snap.pass}  ·  round ${snap.round}`;
  $("xrCount").textContent = `${snap.count} instructions`;
  $("xrOpt").innerHTML = snapshotHtml(r, step);
  showSource(0, 0, 0);
}

function renderGen(step) {
  const c = r.targets[0];
  const lines = c.code.replace(/\n$/, "").split("\n").slice(0, step);
  let inComment = false;
  $("xrGen").innerHTML = lines.map((line, i) => {
    const t = line.trim();
    let html;
    if (inComment || t.startsWith("/*")) { html = `<span class="c-comment">${escapeHtml(line)}</span>`; inComment = !t.endsWith("*/"); }
    else html = highlightCode(line, "c");
    return `<li class="${i === lines.length - 1 ? "fresh" : ""}"><span class="ins">${html || " "}</span></li>`;
  }).join("");
  const map = c.lines[step - 1];
  if (map && map[1]) { const [a, b] = spanOffsets(map.slice(1)); showSource(a, b, 0); }
  else showSource(0, 0, 0);
  $("xrGen").scrollTop = $("xrGen").scrollHeight;
}

function renderDone() {
  const ok = r.stats.errors === 0;
  const cards = [
    ["Characters", state.traceSource.length],
    ["Tokens", r.tokens.length],
    ["Syntax tree nodes", treeView ? treeView.nodes.length : "–"],
    ["Symbols", r.symbols.length],
    ["IR instructions", ok ? `${r.stats.irBefore} → ${r.stats.irAfter}` : "–"],
    ["Lines of C", ok ? r.targets[0].code.split("\n").length - 1 : "–"],
  ];
  $("xrSummary").innerHTML =
    `<div class="xr-big ${ok ? "ok" : "bad"}">${ok ? "Compiled" : "Stopped with errors"}</div>` +
    `<p>${ok ? "Source text became tokens, a syntax tree, a checked program, three-address code, optimized code and finally C, Arduino, Python and JavaScript." : "The compiler reported the problems shown in the Problems tab, so it did not generate code."}</p>` +
    `<div class="xr-stats">${cards.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join("")}</div>` +
    (ok ? '<button type="button" class="btn btn-primary" id="xrToTwin">See it run in the smart home</button>' : "");
  const btn = $("xrToTwin");
  if (btn) btn.addEventListener("click", () => { closeXray(); if (onFinish) onFinish(); });
}

function render() {
  const f = frames[pos];
  if (!f) return;
  if (built !== f.phase) buildStage(f.phase);
  const p = PHASES[f.phase];
  $("xrPhase").textContent = p.name;
  $("xrCaption").innerHTML = p.caption;
  document.querySelectorAll(".xr-steps li").forEach((li, i) => {
    li.classList.toggle("active", i === f.phase);
    li.classList.toggle("done", i < f.phase);
  });
  $("xrScrub").value = pos;
  $("xrCounter").textContent = `${pos + 1} / ${frames.length}`;
  [renderScan, renderParse, renderSema, renderIr, renderOpt, renderGen, renderDone][f.phase](f.step);
}

function tick() {
  if (pos >= frames.length - 1) return pause();
  pos++;
  render();
  const f = frames[pos];
  const next = frames[pos + 1];
  // linger a little longer when a phase changes
  const wait = PHASES[f.phase].ms / speed + (next && next.phase !== f.phase ? 900 / speed : 0);
  timer = setTimeout(tick, wait);
}

function play() {
  if (timer) return;
  if (pos >= frames.length - 1) pos = 0;
  $("xrPlay").textContent = "Pause";
  $("xrPlay").setAttribute("aria-label", "Pause");
  timer = setTimeout(tick, 200);
}

function pause() {
  clearTimeout(timer);
  timer = null;
  $("xrPlay").textContent = "Play";
  $("xrPlay").setAttribute("aria-label", "Play");
}

function jump(i) {
  pause();
  pos = Math.max(0, Math.min(frames.length - 1, i));
  render();
}

function jumpPhase(phase) {
  const i = frames.findIndex((f) => f.phase === phase);
  if (i >= 0) jump(i);
}

export function openXray(result, finish) {
  r = result;
  onFinish = finish;
  starts = lineStarts(state.traceSource);
  tokOffsets = r.tokens.map((t) => {
    const a = toOffset(starts, t.line, t.col);
    return [a, a + Math.max(t.length, 1)];
  });
  buildFrames();
  built = "";
  pos = 0;
  $("xrScrub").max = frames.length - 1;
  $("xray").hidden = false;
  document.body.classList.add("modal-open");
  render();
  play();
  $("xrPlay").focus();
}

export function closeXray() {
  pause();
  $("xray").hidden = true;
  document.body.classList.remove("modal-open");
  bus.emit("xray-closed");
}

export function initXray() {
  const steps = $("xrSteps");
  steps.innerHTML = PHASES.map((p, i) => `<li><button type="button" data-phase="${i}"><span>${i + 1}</span>${p.name}</button></li>`).join("");
  steps.addEventListener("click", (e) => { const b = e.target.closest("button[data-phase]"); if (b) jumpPhase(+b.dataset.phase); });
  $("xrPlay").addEventListener("click", () => (timer ? pause() : play()));
  $("xrPrev").addEventListener("click", () => jump(pos - 1));
  $("xrNext").addEventListener("click", () => jump(pos + 1));
  $("xrScrub").addEventListener("input", (e) => jump(+e.target.value));
  $("xrSpeed").addEventListener("change", (e) => (speed = +e.target.value));
  $("xrClose").addEventListener("click", closeXray);
  document.addEventListener("keydown", (e) => {
    if ($("xray").hidden) return;
    if (e.key === "Escape") closeXray();
    else if (e.key === " " && e.target.tagName !== "BUTTON" && e.target.tagName !== "SELECT") { e.preventDefault(); timer ? pause() : play(); }
    else if (e.key === "ArrowRight" && e.target.type !== "range") jump(pos + 1);
    else if (e.key === "ArrowLeft" && e.target.type !== "range") jump(pos - 1);
  });
}
