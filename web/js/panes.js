// panes.js — the output tabs: tokens, syntax tree, symbols, IR (original, optimized,
// time machine, CFG) and problems; plus Godbolt-style cross-pane linking.

import { $, bus, escapeHtml, spanValid, spanInside, spanSize } from "./util.js";
import { state, fresh } from "./state.js";
import { irHtml } from "./highlight.js";
import { renderTree, renderCfg } from "./graph.js";
import { rangeFromSpan, revealRange, setLinked } from "./editor.js";

const src4 = (s) => (s && s[0] ? s.join(",") : "");
const nodeSpan = (n) => (n.start && n.start[0] ? [n.start[0], n.start[1], n.end[0], n.end[1]] : null);

function setEmpty(emptyEl, bodyEl, isEmpty, html) {
  emptyEl.hidden = !isEmpty;
  if (bodyEl) bodyEl.hidden = isEmpty;
  if (isEmpty && html) emptyEl.innerHTML = `<span>${html}</span>`;
}

export function renderPanes(r) {
  renderTokens(r.tokens);
  renderAst(r);
  renderSymbols(r);
  renderIr();
  renderProblems(r.errors);
}

export function resetPanes() {
  $("tokenCount").textContent = "0";
  $("problemCount").textContent = "0";
  $("problemCount").classList.remove("bad");
  setEmpty($("tokensEmpty"), $("tokenTable"), true, "Press <strong>Compile</strong> to run the lexer.");
  setEmpty($("astEmpty"), $("astBody"), true, "Press <strong>Compile</strong> to build the syntax tree.");
  setEmpty($("symbolsEmpty"), $("symbolsBody"), true, "Press <strong>Compile</strong> to build the symbol table.");
  setEmpty($("irEmpty"), $("irBody"), true, "Intermediate code is generated once the program passes semantic analysis.");
  setEmpty($("problemsEmpty"), null, true, "Press <strong>Compile</strong> to check the program.");
  $("errorList").innerHTML = "";
}

// ---- Tokens ---------------------------------------------------------------------------

function renderTokens(tokens) {
  $("tokenCount").textContent = tokens.length;
  setEmpty($("tokensEmpty"), $("tokenTable"), tokens.length === 0, "No tokens. The program is empty.");
  $("tokenBody").innerHTML = tokens
    .map(
      (t, i) =>
        `<tr data-src="${t.line},${t.col},${t.line},${t.col + Math.max(t.length, 1)}"><td>${i + 1}</td><td>${t.line}:${t.col}</td>` +
        `<td><span class="pill ${t.category}">${t.type}</span></td><td>${escapeHtml(t.lexeme)}</td></tr>`
    )
    .join("");
}

// ---- Syntax tree ----------------------------------------------------------------------

const CHEVRON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 4 4 4-4 4"/></svg>';

function listNode(n, ruleIndex) {
  const i = n.label.indexOf(": ");
  const name = (n.kind === "logic" ? "Logical" : i >= 0 ? n.label.slice(0, i) : n.label) + (n.kind === "rule" ? " " + ruleIndex : "");
  const value = n.kind === "logic" ? n.label : i >= 0 ? n.label.slice(i + 2) : "";
  const vcls = n.kind === "logic" ? "v-logic" : n.kind === "number" ? "v-number" : n.kind === "state" ? "v-state" : "";
  const hasKids = n.children.length > 0;
  let html =
    `<li><div class="node" data-src="${src4(nodeSpan(n))}">` +
    `<button type="button" class="twisty${hasKids ? "" : " leaf"}" tabindex="${hasKids ? 0 : -1}" aria-label="Toggle">${CHEVRON}</button>` +
    `<span class="kind k-${n.kind}"></span><span class="node-label">${escapeHtml(name)}</span>` +
    (value ? `<span class="node-value ${vcls}">${escapeHtml(value)}</span>` : "") +
    `<span class="node-pos">${n.start[0] ? n.start[0] + ":" + n.start[1] : ""}</span></div>`;
  if (hasKids) {
    let rule = 0;
    html += "<ul>" + n.children.map((c) => listNode(c, c.kind === "rule" ? ++rule : 0)).join("") + "</ul>";
  }
  return html + "</li>";
}

export function renderAst(r = state.result) {
  if (!r) return;
  const ast = r.ast;
  const empty = !ast || ast.children.length === 0;
  setEmpty($("astEmpty"), $("astBody"), empty,
    r.stats.errors ? "No statement could be parsed. See the <strong>Problems</strong> tab." : "The program has no statements.");
  if (empty) return;
  document.querySelectorAll(".seg[data-ast]").forEach((b) => b.classList.toggle("active", b.dataset.ast === state.astView));
  $("astTree").hidden = state.astView !== "list";
  $("astGraph").hidden = state.astView !== "graph";
  $("astListTools").hidden = state.astView !== "list";
  if (state.astView === "list") {
    $("astTree").innerHTML = "<ul>" + listNode(ast, 0) + "</ul>";
  } else {
    renderTree($("astGraph"), ast, {
      onHover: (n, on) => bus.emit("link", on ? nodeSpan(n) : null),
      onClick: (n) => nodeSpan(n) && fresh() && revealRange(rangeFromSpan(nodeSpan(n)), true),
    });
  }
}

function wireAstList() {
  const tree = $("astTree");
  tree.addEventListener("click", (e) => {
    const tw = e.target.closest(".twisty");
    if (tw && !tw.classList.contains("leaf")) tw.closest("li").classList.toggle("collapsed");
  });
  $("expandAll").addEventListener("click", () => tree.querySelectorAll("li.collapsed").forEach((li) => li.classList.remove("collapsed")));
  $("collapseAll").addEventListener("click", () =>
    tree.querySelectorAll("li").forEach((li) => {
      if (li.querySelector("ul") && li.parentElement !== tree.firstElementChild) li.classList.add("collapsed");
    })
  );
  document.querySelectorAll(".seg[data-ast]").forEach((b) =>
    b.addEventListener("click", () => {
      state.astView = b.dataset.ast;
      renderAst();
    })
  );
}

// ---- Symbols ----------------------------------------------------------------------------

function renderSymbols(r) {
  const ran = r.phases.find((p) => p.id === "semantic").status !== "skipped";
  if (!ran)
    return setEmpty($("symbolsEmpty"), $("symbolsBody"), true,
      "Semantic analysis did not run because of lexical or syntax errors. See the <strong>Problems</strong> tab.");
  if (!r.symbols.length)
    return setEmpty($("symbolsEmpty"), $("symbolsBody"), true, "No SENSOR or DEVICE declarations. Every name used by a rule must be declared.");
  setEmpty($("symbolsEmpty"), $("symbolsBody"), false);
  $("symbolRows").innerHTML = r.symbols
    .map(
      (s) =>
        `<tr data-src="${s.line},${s.col},${s.line},${s.col + s.name.length}"><td>${escapeHtml(s.name)}</td>` +
        `<td><span class="kind-tag ${s.kind}">${s.kind}</span></td><td>${s.type}</td>` +
        `<td>${s.line}:${s.col}</td><td class="${s.uses ? "" : "uses-zero"}">${s.uses}</td></tr>`
    )
    .join("");
  const warnings = r.errors.filter((e) => e.phase === "semantic" && e.severity === "warning").length;
  $("ruleCheck").innerHTML = warnings
    ? `<b>${warnings}</b> rule-analysis warning${warnings === 1 ? "" : "s"}: impossible or always-true conditions, unreachable branches or conflicting rules. See <a href="#" data-goto="problems">Problems</a>.`
    : "Rule analysis found no impossible conditions, unreachable branches or conflicting rules.";
}

// ---- Intermediate code -------------------------------------------------------------------

let machine = { index: 0, timer: null };

export function setIrView(view) {
  state.irView = view;
  document.querySelectorAll(".seg[data-ir]").forEach((b) => b.classList.toggle("active", b.dataset.ir === view));
  renderIr();
}

function irLines(code, marks = {}) {
  let n = 0;
  return code
    .map((ins, i) => {
      const isRule = ins.op === "rule";
      const emptyRule = isRule && (i + 1 === code.length || code[i + 1].op === "rule");
      const cls = [isRule ? "rule-row" + (emptyRule ? " empty-rule" : "") : ins.op === "label" ? "" : "indent", marks[i] || ""].join(" ");
      const ln = isRule || marks[i] === "removed" ? "" : ++n;
      return `<li class="${cls}" data-src="${src4(ins.src)}"><span class="ln">${ln}</span><span class="ins">${irHtml(ins)}</span></li>`;
    })
    .join("");
}

export function renderIr() {
  const r = state.result;
  stopMachine();
  if (!r || !r.ir.length) {
    const msg = r && r.phases.find((p) => p.id === "ir").status === "ok"
      ? "The program has no rules, so there is no code to generate."
      : "Intermediate code is generated once the program passes semantic analysis.";
    return setEmpty($("irEmpty"), $("irBody"), true, msg);
  }
  setEmpty($("irEmpty"), $("irBody"), false);
  const view = state.irView;
  $("irList").hidden = view === "cfg";
  $("cfgGraph").hidden = view !== "cfg";
  $("machineBar").hidden = view !== "machine";
  const o = r.optimization;
  const report = $("optReport");

  if (view === "original") {
    $("irSummary").textContent = `${o.before} instructions, three-address code`;
    report.hidden = true;
    $("irList").innerHTML = irLines(r.ir);
  } else if (view === "optimized") {
    const saved = o.before ? Math.round((100 * (o.before - o.after)) / o.before) : 0;
    $("irSummary").textContent = `${o.before} → ${o.after} instructions` + (saved ? ` (−${saved}%)` : "");
    const used = o.passes.filter((p) => p.count > 0);
    report.hidden = false;
    report.innerHTML = used.length
      ? used.map((p) => `<span class="chip" title="${escapeHtml(p.description)}">${escapeHtml(p.name)}<b>${p.count}</b></span>`).join("")
      : '<span class="chip">No optimization applied: the code was already minimal</span>';
    $("irList").innerHTML = irLines(r.optimizedIr);
  } else if (view === "machine") {
    report.hidden = true;
    machine.index = 0;
    $("machineSlider").max = r.optTrace.length - 1;
    showSnapshot(0);
  } else {
    const edges = r.cfg.reduce((n, b) => n + b.succ.length, 0);
    $("irSummary").textContent = `${r.cfg.length} basic blocks · ${edges} edges`;
    report.hidden = false;
    report.innerHTML =
      '<span class="chip" title="Leaders: the first instruction, every label, every rule start and every instruction after a jump">Leaders start a new block</span>' +
      '<span class="chip" title="IN[B] = USE[B] ∪ (OUT[B] − DEF[B]),  OUT[B] = ∪ IN[successors]">Liveness: backward dataflow</span>' +
      '<span class="chip" title="IN[B] = ∩ OUT[predecessors],  OUT[B] = IN[B] ∪ GEN[B]">CSE: available expressions</span>';
    renderCfg($("cfgGraph"), r.cfg, r.optimizedIr, {
      onHover: (b, on) => {
        if (!on) return bus.emit("link", null);
        const spans = r.optimizedIr.slice(b.first, b.last).filter((i) => i.op !== "label" && i.op !== "rule").map((i) => i.src);
        bus.emit("link", spans.length ? spans : null);
      },
    });
  }
}

// Longest common subsequence of two instruction lists (by text), for the diff view.
function diff(prev, cur) {
  const a = prev.map((i) => i.text), b = cur.map((i) => i.text);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push({ ins: cur[j], mark: "" }); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ ins: cur[j], mark: "added" }); j++; }
    else { out.push({ ins: prev[i], mark: "removed" }); i++; }
  }
  return out;
}

export function snapshotHtml(r, k) {
  const snap = r.optTrace[k];
  const rows = k === 0 ? snap.code.map((ins) => ({ ins, mark: "" })) : diff(r.optTrace[k - 1].code, snap.code);
  const marks = {};
  rows.forEach((row, i) => (marks[i] = row.mark));
  return irLines(rows.map((row) => row.ins), marks);
}

function showSnapshot(k) {
  const r = state.result;
  const snap = r.optTrace[k];
  machine.index = k;
  $("machineSlider").value = k;
  $("machineStep").textContent = `${k + 1} / ${r.optTrace.length}`;
  $("machinePass").textContent = k === 0 ? "Original code" : `${snap.pass}`;
  $("machinePass").className = "machine-pass" + (k === 0 ? "" : " changed");
  $("irSummary").textContent = `${snap.count} instructions` + (k ? ` · round ${snap.round}` : "");
  $("irList").innerHTML = snapshotHtml(r, k);
}

function stopMachine() {
  clearInterval(machine.timer);
  machine.timer = null;
  const b = $("machinePlay");
  if (b) b.textContent = "Play";
}

function wireMachine() {
  $("machineSlider").addEventListener("input", (e) => { stopMachine(); showSnapshot(+e.target.value); });
  $("machinePrev").addEventListener("click", () => { stopMachine(); showSnapshot(Math.max(0, machine.index - 1)); });
  $("machineNext").addEventListener("click", () => { stopMachine(); showSnapshot(Math.min(state.result.optTrace.length - 1, machine.index + 1)); });
  $("machinePlay").addEventListener("click", () => {
    if (machine.timer) return stopMachine();
    const r = state.result;
    if (machine.index >= r.optTrace.length - 1) showSnapshot(0);
    $("machinePlay").textContent = "Pause";
    machine.timer = setInterval(() => {
      if (machine.index >= r.optTrace.length - 1) return stopMachine();
      showSnapshot(machine.index + 1);
    }, 1400);
  });
  document.querySelectorAll(".seg[data-ir]").forEach((b) => b.addEventListener("click", () => setIrView(b.dataset.ir)));
}

// ---- Problems --------------------------------------------------------------------------

function formatMessage(msg) {
  return escapeHtml(msg).replace(/'([^']*)'/g, "<code>'$1'</code>");
}

export function renderProblems(errors) {
  const nErr = errors.filter((e) => e.severity === "error").length;
  $("problemCount").textContent = errors.length;
  $("problemCount").classList.toggle("bad", nErr > 0);
  const list = $("errorList");
  const empty = $("problemsEmpty");
  if (!errors.length) {
    list.innerHTML = "";
    empty.hidden = false;
    empty.className = "empty ok";
    empty.innerHTML =
      '<div><div class="ok-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg></div>' +
      "No errors or warnings. The program passed every compiler phase.</div>";
    return;
  }
  empty.hidden = true;
  empty.className = "empty";
  list.innerHTML = errors
    .map(
      (e, i) =>
        `<li class="error-item ${e.severity}" data-i="${i}" data-src="${e.line},${e.col},${e.line},${e.col + Math.max(e.length, 1)}">` +
        `<span class="phase ${e.phase}">${e.phase}</span>` +
        `<span class="err-pos">${e.line}:${e.col}</span>` +
        `<span class="err-msg">${e.severity === "warning" ? '<span class="sev">warning</span>' : ""}${formatMessage(e.message)}</span>` +
        `<span class="err-actions">` +
        (e.fixes || []).map((f, k) => `<button type="button" class="fix-btn" data-fix="${k}" title="Apply this change to the program">${escapeHtml(f.title)}</button>`).join("") +
        (e.severity === "error" && !(e.fixes || []).length ? `<button type="button" class="link-btn ai-fix-btn">AI fix</button>` : "") +
        `<button type="button" class="link-btn explain-btn">Explain</button></span></li>`
    )
    .join("");
}

function wireProblems() {
  const list = $("errorList");
  list.addEventListener("click", (ev) => {
    const item = ev.target.closest(".error-item");
    if (!item || !state.result) return;
    const i = +item.dataset.i;
    const err = state.result.errors[i];
    const fixBtn = ev.target.closest(".fix-btn");
    if (fixBtn) return bus.emit("apply-fix", err.fixes[+fixBtn.dataset.fix]);
    if (ev.target.closest(".explain-btn")) return bus.emit("explain-problem", { item, index: i, button: ev.target.closest(".explain-btn") });
    if (ev.target.closest(".ai-fix-btn")) return bus.emit("ai-fix", { item, index: i, button: ev.target.closest(".ai-fix-btn") });
    if (ev.target.closest(".explanation, .ai-fix-box") || !fresh()) return;
    revealRange(rangeFromSpan([err.line, err.col, err.line, err.col + Math.max(err.length, 1)]), true);
  });
}

// ---- Cross-pane linking ------------------------------------------------------------------

const parseSpan = (s) => (s ? s.split(",").map(Number) : null);

function markGroup(group, spans) {
  const els = Array.from(group.querySelectorAll("[data-src]"));
  els.forEach((e) => e.classList.remove("linked"));
  if (!spans) return;
  for (const span of spans) {
    let hits = els.filter((e) => { const s = parseSpan(e.dataset.src); return spanValid(s) && spanInside(s, span); });
    if (!hits.length) {   // nothing inside: highlight the smallest element containing the span
      const containing = els.filter((e) => { const s = parseSpan(e.dataset.src); return spanValid(s) && spanInside(span, s); });
      const min = Math.min(...containing.map((e) => spanSize(parseSpan(e.dataset.src))));
      hits = containing.filter((e) => spanSize(parseSpan(e.dataset.src)) === min);
    }
    hits.forEach((e) => e.classList.add("linked"));
  }
}

export function linkSpans(spans, { editor = true } = {}) {
  if (spans && !Array.isArray(spans[0])) spans = [spans];
  spans = spans ? spans.filter(spanValid) : null;
  if (spans && !spans.length) spans = null;
  if (editor) setLinked(spans && fresh() ? spans.map(rangeFromSpan) : null);
  document.querySelectorAll("[data-link-group]").forEach((g) => markGroup(g, spans));
}

function wireLinking() {
  bus.on("link", (span) => linkSpans(span));
  bus.on("caret", (p) => linkSpans([p.line, p.col, p.line, p.col + 1], { editor: false }));
  document.querySelectorAll("[data-link-group]").forEach((group) => {
    group.addEventListener("mouseover", (e) => {
      const t = e.target.closest("[data-src]");
      if (t && t.dataset.src && fresh()) bus.emit("link", parseSpan(t.dataset.src));
    });
    group.addEventListener("mouseleave", () => bus.emit("link", null));
    group.addEventListener("click", (e) => {
      if (e.target.closest("button, a, input, .explanation, .ai-fix-box")) return;
      const t = e.target.closest("[data-src]");
      if (t && t.dataset.src && fresh() && !group.matches("#errorList")) revealRange(rangeFromSpan(parseSpan(t.dataset.src)), true);
    });
  });
}

export function initPanes() {
  wireAstList();
  wireMachine();
  wireProblems();
  wireLinking();
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-goto]");
    if (a) { e.preventDefault(); bus.emit("show-tab", a.dataset.goto); }
  });
}
