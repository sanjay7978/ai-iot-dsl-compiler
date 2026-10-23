// app.js — web interface for the IoT DSL compiler.
// All compiling is done by the C++ compiler on the server (POST /api/compile).
// The browser only displays the results, colours the editor (cosmetic) and
// runs the optimized intermediate code in the simulator.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {};
  [
    "source", "highlight", "gutterInner", "examples", "compileBtn", "clearBtn", "shortcut", "cursorPos",
    "lineCount", "themeToggle", "tabIndicator", "tokenCount", "problemCount", "tokensEmpty", "tokenTable",
    "tokenBody", "astTools", "astEmpty", "astTree", "symbolsEmpty", "symbolsBody", "symbolRows", "irEmpty",
    "irBody", "irSummary", "optReport", "irList", "cEmpty", "cBody", "cCode", "copyC", "runC", "runOutput",
    "simEmpty", "simBody", "sensorList", "deviceGrid", "ruleList", "problemsEmpty", "errorList", "status",
    "statusText", "statTokens", "statRules", "statErrors", "statWarnings", "statIr", "statTime", "aiForm",
    "aiInput", "aiBtn", "aiBadge", "aiResult", "aiCheck", "aiMeta", "aiCode", "aiNote", "aiReplace",
    "aiAppend", "aiDismiss",
  ].forEach((id) => (el[id] = $(id)));

  const state = {
    result: null,          // last JSON returned by the compiler
    compiledSource: null,  // source text that produced `result`
    hover: null,           // {start, end} offsets to highlight in the editor
    activeTab: "tokens",
    irView: "original",
    simInputs: {},         // sensor name -> value, kept across recompiles
    aiDsl: null,           // last DSL suggested by the AI
    explanations: {},      // problem index -> explanation text
  };

  const LINE_HEIGHT = 22;

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "server error " + res.status);
    return data;
  }

  const fresh = () => state.result && state.compiledSource === el.source.value;

  // ---------------------------------------------------------------- theme

  function currentTheme() {
    const set = document.documentElement.dataset.theme;
    if (set) return set;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  el.themeToggle.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("iotc-theme", next); } catch (e) { /* storage unavailable */ }
  });

  // --------------------------------------------------------------- editor

  const KEYWORDS = new Set(["IF", "THEN", "ELSE", "AND", "OR", "NOT", "SENSOR", "DEVICE", "NUMBER", "STATE"]);
  const STATES = new Set(["ON", "OFF", "OPEN", "CLOSED", "TRUE", "FALSE"]);

  // Cosmetic per-character classes for the editor overlay.
  function colourClasses(src) {
    const cls = new Array(src.length).fill("");
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      let j = i + 1;
      let k = "";
      if (c === "#") {
        while (j < src.length && src[j] !== "\n") j++;
        k = "s-comment";
      } else if (/[A-Za-z_]/.test(c)) {
        while (j < src.length && /\w/.test(src[j])) j++;
        const word = src.slice(i, j);
        k = KEYWORDS.has(word) ? "s-kw" : STATES.has(word) ? "s-state" : "";
      } else if (/[0-9]/.test(c)) {
        while (j < src.length && /[0-9.]/.test(src[j])) j++;
        k = "s-num";
      } else if (/[<>=!(),:]/.test(c)) {
        k = "s-op";
      } else if (!/\s/.test(c)) {
        k = "s-bad";
      }
      for (let p = i; p < j; p++) cls[p] = k;
      i = j;
    }
    return cls;
  }

  function highlightDsl(src) {
    const cls = colourClasses(src);
    let html = "";
    for (let i = 0; i < src.length; ) {
      let j = i + 1;
      while (j < src.length && cls[j] === cls[i]) j++;
      const text = escapeHtml(src.slice(i, j));
      html += cls[i] ? `<span class="${cls[i]}">${text}</span>` : text;
      i = j;
    }
    return html;
  }

  function lineStarts(src) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
    return starts;
  }

  function toOffset(starts, line, col) {
    const base = starts[Math.min(Math.max(line, 1), starts.length) - 1];
    return base + Math.max(col, 1) - 1;
  }

  function problemRanges(src) {
    if (!fresh()) return [];
    const starts = lineStarts(src);
    return state.result.errors.map((e) => {
      let start = toOffset(starts, e.line, e.col);
      // Errors just past the end of a line (e.g. a missing ')') mark the last character.
      if ((start >= src.length || src[start] === "\n") && start > 0) start--;
      return { start, end: start + Math.max(e.length, 1), line: e.line, warning: e.severity === "warning" };
    });
  }

  function render() {
    const src = el.source.value;
    const cls = colourClasses(src);
    const probs = problemRanges(src);
    const hover = state.hover;

    const mark = new Uint8Array(src.length);   // 1 = warning, 2 = error
    for (const r of probs)
      for (let p = r.start; p < Math.min(r.end, src.length); p++) mark[p] = Math.max(mark[p], r.warning ? 1 : 2);

    const key = (p) => cls[p] + "|" + mark[p] + "|" + (hover && p >= hover.start && p < hover.end ? 1 : 0);
    let html = "";
    let i = 0;
    while (i < src.length) {
      const k = key(i);
      let j = i + 1;
      while (j < src.length && key(j) === k && src[j] !== "\n") j++;
      const [c, m, h] = k.split("|");
      const classes = [c, m === "2" ? "m-error" : m === "1" ? "m-warn" : "", h === "1" ? "m-hover" : ""]
        .filter(Boolean).join(" ");
      const text = escapeHtml(src.slice(i, j));
      html += classes ? `<span class="${classes}">${text}</span>` : text;
      i = j;
    }
    el.highlight.innerHTML = html + "\n";

    const lines = src.split("\n").length;
    const errLines = new Set(probs.filter((r) => !r.warning).map((r) => r.line));
    let g = "";
    for (let n = 1; n <= lines; n++) g += `<div${errLines.has(n) ? ' class="err"' : ""}>${n}</div>`;
    el.gutterInner.innerHTML = g;
    el.lineCount.textContent = lines + (lines === 1 ? " line" : " lines");
    syncScroll();
  }

  function syncScroll() {
    el.highlight.scrollTop = el.source.scrollTop;
    el.highlight.scrollLeft = el.source.scrollLeft;
    el.gutterInner.style.transform = `translateY(${-el.source.scrollTop}px)`;
  }

  function updateCursor() {
    const before = el.source.value.slice(0, el.source.selectionStart);
    const line = before.split("\n").length;
    const col = before.length - before.lastIndexOf("\n");
    el.cursorPos.textContent = `Ln ${line}, Col ${col}`;
  }

  function setHover(range) {
    state.hover = range;
    render();
  }

  function rangeFromPositions(start, end) {
    const starts = lineStarts(el.source.value);
    return { start: toOffset(starts, start[0], start[1]), end: toOffset(starts, end[0], end[1]) };
  }

  function revealRange(range, select) {
    const line = el.source.value.slice(0, range.start).split("\n").length;
    el.source.scrollTop = Math.max(0, (line - 1) * LINE_HEIGHT - el.source.clientHeight / 2 + LINE_HEIGHT);
    if (select) {
      el.source.focus({ preventScroll: true });
      el.source.setSelectionRange(range.start, Math.max(range.end, range.start + 1));
      updateCursor();
    }
    syncScroll();
  }

  // Hover/click on any element with data-line/data-col/data-len highlights that span in the editor.
  function wireSourceLinks(container, rangeOf) {
    container.addEventListener("mouseover", (e) => {
      const r = fresh() && rangeOf(e.target);
      if (r) setHover(r);
    });
    container.addEventListener("mouseleave", () => setHover(null));
    container.addEventListener("click", (e) => {
      if (e.target.closest("button, input")) return;
      const r = fresh() && rangeOf(e.target);
      if (r) revealRange(r, true);
    });
  }

  el.source.addEventListener("input", () => {
    state.hover = null;
    if (state.result) markStale();
    render();
    updateCursor();
  });
  el.source.addEventListener("scroll", syncScroll);
  ["keyup", "click", "select"].forEach((ev) => el.source.addEventListener(ev, updateCursor));

  el.source.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      el.source.setRangeText("    ", el.source.selectionStart, el.source.selectionEnd, "end");
      el.source.dispatchEvent(new Event("input"));
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target !== el.aiInput) {
      e.preventDefault();
      compile();
    }
  });

  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) el.shortcut.textContent = "⌘ ↵";

  // ----------------------------------------------------------------- tabs

  const tabs = Array.from(document.querySelectorAll(".tab"));
  const steps = Array.from(document.querySelectorAll(".step"));

  function positionIndicator() {
    const active = tabs.find((t) => t.dataset.tab === state.activeTab);
    if (!active) return;
    el.tabIndicator.style.left = active.offsetLeft + 6 + "px";
    el.tabIndicator.style.width = active.offsetWidth - 12 + "px";
  }

  function showTab(name) {
    state.activeTab = name;
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      if (on) {   // keep the active tab visible inside the (scrollable) tab bar only
        const bar = t.parentElement, left = t.offsetLeft, right = left + t.offsetWidth;
        if (left < bar.scrollLeft) bar.scrollLeft = left - 8;
        else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth + 8;
      }
    });
    document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + name));
    positionIndicator();
  }

  tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  window.addEventListener("resize", positionIndicator);

  steps.forEach((s) =>
    s.addEventListener("click", () => {
      if (s.dataset.ir) setIrView(s.dataset.ir);
      showTab(s.dataset.tab);
    })
  );

  // ------------------------------------------------------------- examples

  async function loadExamples() {
    try {
      const list = await (await fetch("/api/examples")).json();
      for (const ex of list) {
        const opt = document.createElement("option");
        opt.value = ex.source;
        opt.textContent = ex.name.replace(/^\d+_/, "").replace(/_/g, " ");
        el.examples.appendChild(opt);
      }
      if (list.length && !el.source.value) {
        el.examples.selectedIndex = 1;
        el.source.value = list[0].source;
        render();
        compile();
      }
    } catch (e) {
      setStatus("fail", "Cannot reach the compiler server. Start it with: make run");
    }
  }

  function loadSource(text) {
    el.source.value = text;
    el.source.scrollTop = 0;
    state.hover = null;
    render();
    updateCursor();
    compile();
  }

  el.examples.addEventListener("change", () => {
    if (el.examples.value) loadSource(el.examples.value);
  });

  el.clearBtn.addEventListener("click", () => {
    el.source.value = "";
    el.examples.selectedIndex = 0;
    state.result = null;
    state.compiledSource = null;
    state.hover = null;
    resetOutput();
    render();
    updateCursor();
    el.source.focus();
  });

  // -------------------------------------------------------------- compile

  async function compile() {
    const source = el.source.value;
    el.compileBtn.classList.add("busy");
    setStatus("", "Compiling…");
    try {
      const data = await postJson("/api/compile", { source });
      state.result = data;
      state.compiledSource = source;
      state.hover = null;
      state.explanations = {};
      showResult(data);
      render();
    } catch (e) {
      setStatus("fail", e instanceof TypeError ? "Cannot reach the compiler server. Start it with: make run" : e.message);
    } finally {
      el.compileBtn.classList.remove("busy");
    }
  }

  el.compileBtn.addEventListener("click", compile);

  function setStatus(kind, text) {
    el.status.className = "status" + (kind ? " " + kind : "");
    el.statusText.textContent = text;
  }

  function markStale() {
    if (state.compiledSource !== el.source.value) setStatus("stale", "Edited since last compile");
    else showStatus(state.result);
  }

  function showStatus(r) {
    const errs = r.stats.errors, warns = r.stats.warnings;
    if (errs === 0)
      setStatus("ok", warns ? `Compiled with ${warns} warning${warns === 1 ? "" : "s"}` : "Compiled successfully");
    else setStatus("fail", `Found ${errs} error${errs === 1 ? "" : "s"}`);
  }

  function setEmpty(emptyEl, bodyEl, isEmpty, html) {
    emptyEl.hidden = !isEmpty;
    if (bodyEl) bodyEl.hidden = isEmpty;
    if (isEmpty && html) emptyEl.innerHTML = `<span>${html}</span>`;
  }

  function resetOutput() {
    el.tokenCount.textContent = "0";
    el.problemCount.textContent = "0";
    el.problemCount.classList.remove("bad");
    setEmpty(el.tokensEmpty, el.tokenTable, true, "Press <strong>Compile</strong> to run the lexer.");
    setEmpty(el.astEmpty, el.astTools, true, "Press <strong>Compile</strong> to build the syntax tree.");
    el.astTree.innerHTML = "";
    setEmpty(el.symbolsEmpty, el.symbolsBody, true, "Press <strong>Compile</strong> to build the symbol table.");
    setEmpty(el.irEmpty, el.irBody, true, "Intermediate code is generated once the program passes semantic analysis.");
    setEmpty(el.cEmpty, el.cBody, true, "C code is generated once the program compiles without errors.");
    setEmpty(el.simEmpty, el.simBody, true, "The simulator runs once the program compiles without errors.");
    setEmpty(el.problemsEmpty, null, true, "Press <strong>Compile</strong> to check the program.");
    el.errorList.innerHTML = "";
    steps.forEach((s) => delete s.dataset.status);
    ["statTokens", "statRules", "statErrors", "statWarnings", "statIr", "statTime"].forEach((k) => (el[k].textContent = "–"));
    setStatus("", "Ready");
  }

  function showResult(r) {
    showStatus(r);
    const status = Object.fromEntries(r.phases.map((p) => [p.id, p.status]));
    steps.forEach((s) => {
      s.dataset.status = status[s.dataset.step] || "";
      const p = r.phases.find((x) => x.id === s.dataset.step);
      s.title = p ? `${p.name}: ${{ ok: "passed", error: "errors found", skipped: "not run" }[p.status]}` : "";
    });

    renderTokens(r.tokens);
    renderAst(r.ast, r.stats.errors > 0);
    renderSymbols(r);
    renderIr();
    renderC(r);
    renderSim(r);
    renderProblems(r.errors);

    el.statTokens.textContent = r.stats.tokens;
    el.statRules.textContent = r.stats.rules;
    el.statErrors.textContent = r.stats.errors;
    el.statWarnings.textContent = r.stats.warnings;
    el.statIr.textContent = r.ir.length ? `${r.stats.irBefore} → ${r.stats.irAfter}` : "–";
    el.statTime.textContent = r.stats.timeMs.toFixed(3) + " ms";

    if (r.stats.errors) showTab("problems");
    else if (state.activeTab === "problems" && !r.errors.length) showTab("tokens");
  }

  // Tokens ---------------------------------------------------------------

  function renderTokens(tokens) {
    el.tokenCount.textContent = tokens.length;
    setEmpty(el.tokensEmpty, el.tokenTable, tokens.length === 0, "No tokens. The program is empty.");
    el.tokenBody.innerHTML = tokens
      .map(
        (t, i) =>
          `<tr data-line="${t.line}" data-col="${t.col}" data-len="${t.length}"><td>${i + 1}</td><td>${t.line}:${t.col}</td>` +
          `<td><span class="pill ${t.category}">${t.type}</span></td><td>${escapeHtml(t.lexeme)}</td></tr>`
      )
      .join("");
  }

  const spanOf = (target) => {
    const row = target.closest("[data-line]");
    if (!row) return null;
    const line = +row.dataset.line, col = +row.dataset.col;
    return rangeFromPositions([line, col], [line, col + Math.max(+row.dataset.len, 1)]);
  };
  wireSourceLinks(el.tokenBody, spanOf);
  wireSourceLinks(el.symbolRows, spanOf);

  // Syntax tree ----------------------------------------------------------

  const CHEVRON =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 4 4 4-4 4"/></svg>';

  let astNodes = [];

  function nodeParts(n) {
    if (n.kind === "logic") return { name: "Logical", value: n.label, vcls: "v-logic" };
    const i = n.label.indexOf(": ");
    if (i >= 0) {
      const vcls = n.kind === "number" ? "v-number" : n.kind === "state" ? "v-state" : "";
      return { name: n.label.slice(0, i), value: n.label.slice(i + 2), vcls };
    }
    return { name: n.label, value: "", vcls: "" };
  }

  function buildNode(n, ruleIndex) {
    const id = astNodes.push(n) - 1;
    const parts = nodeParts(n);
    const name = parts.name + (n.kind === "rule" ? " " + ruleIndex : "");
    const hasKids = n.children.length > 0;
    const pos = n.start[0] ? `${n.start[0]}:${n.start[1]}` : "";

    let html =
      `<li><div class="node" data-id="${id}">` +
      `<button type="button" class="twisty${hasKids ? "" : " leaf"}" tabindex="${hasKids ? 0 : -1}" aria-label="Toggle">${CHEVRON}</button>` +
      `<span class="kind k-${n.kind}"></span>` +
      `<span class="node-label">${escapeHtml(name)}</span>` +
      (parts.value ? `<span class="node-value ${parts.vcls}">${escapeHtml(parts.value)}</span>` : "") +
      `<span class="node-pos">${pos}</span></div>`;

    if (hasKids) {
      let rule = 0;
      html += "<ul>" + n.children.map((c) => buildNode(c, c.kind === "rule" ? ++rule : 0)).join("") + "</ul>";
    }
    return html + "</li>";
  }

  function renderAst(ast, hasErrors) {
    astNodes = [];
    const empty = !ast || ast.children.length === 0;
    setEmpty(el.astEmpty, el.astTools, empty,
      hasErrors ? "No statement could be parsed. See the <strong>Problems</strong> tab." : "The program has no statements.");
    el.astTree.innerHTML = empty ? "" : "<ul>" + buildNode(ast, 0) + "</ul>";
  }

  el.astTree.addEventListener("click", (e) => {
    const tw = e.target.closest(".twisty");
    if (tw && !tw.classList.contains("leaf")) {
      tw.closest("li").classList.toggle("collapsed");
      return;
    }
    const node = e.target.closest(".node");
    if (!node || !fresh()) return;
    const n = astNodes[+node.dataset.id];
    if (n.start[0]) revealRange(rangeFromPositions(n.start, n.end), true);
  });
  el.astTree.addEventListener("mouseover", (e) => {
    const node = e.target.closest(".node");
    if (!node || !fresh()) return;
    const n = astNodes[+node.dataset.id];
    setHover(n.start[0] ? rangeFromPositions(n.start, n.end) : null);
  });
  el.astTree.addEventListener("mouseleave", () => setHover(null));

  $("expandAll").addEventListener("click", () =>
    el.astTree.querySelectorAll("li.collapsed").forEach((li) => li.classList.remove("collapsed"))
  );
  $("collapseAll").addEventListener("click", () =>
    el.astTree.querySelectorAll("li").forEach((li) => {
      if (li.querySelector("ul") && li.parentElement !== el.astTree.firstElementChild) li.classList.add("collapsed");
    })
  );

  // Symbols --------------------------------------------------------------

  function renderSymbols(r) {
    const ran = r.phases.find((p) => p.id === "semantic").status !== "skipped";
    if (!ran) {
      setEmpty(el.symbolsEmpty, el.symbolsBody, true,
        "Semantic analysis did not run because of lexical or syntax errors. See the <strong>Problems</strong> tab.");
      return;
    }
    if (!r.symbols.length) {
      setEmpty(el.symbolsEmpty, el.symbolsBody, true,
        "No SENSOR or DEVICE declarations. Every name used by a rule must be declared.");
      return;
    }
    setEmpty(el.symbolsEmpty, el.symbolsBody, false);
    el.symbolRows.innerHTML = r.symbols
      .map(
        (s) =>
          `<tr data-line="${s.line}" data-col="${s.col}" data-len="${s.name.length}"><td>${escapeHtml(s.name)}</td>` +
          `<td><span class="kind-tag ${s.kind}">${s.kind}</span></td><td>${s.type}</td>` +
          `<td>${s.line}:${s.col}</td><td class="${s.uses ? "" : "uses-zero"}">${s.uses}</td></tr>`
      )
      .join("");
  }

  // Intermediate code ----------------------------------------------------

  function irHtml(ins) {
    const text = escapeHtml(ins.text);
    if (ins.op === "rule") return `<span class="i-comment">${text}</span>`;
    return text.replace(
      /\b(IF_FALSE|GOTO|CALL|NOT|AND|OR)\b|\b(t\d+)\b|\b(L\d+)\b|\b(ON|OFF|OPEN|CLOSED|TRUE|FALSE)\b|(-?\b\d+(?:\.\d+)?)\b/g,
      (m, kw, temp, label, st, num) =>
        `<span class="${kw ? "i-kw" : temp ? "i-temp" : label ? "i-label" : st ? "i-state" : "i-num"}">${m}</span>`
    );
  }

  function setIrView(view) {
    state.irView = view;
    document.querySelectorAll(".seg[data-ir]").forEach((b) => b.classList.toggle("active", b.dataset.ir === view));
    renderIr();
  }

  document.querySelectorAll(".seg[data-ir]").forEach((b) => b.addEventListener("click", () => setIrView(b.dataset.ir)));

  function renderIr() {
    const r = state.result;
    if (!r || !r.ir.length) {
      const msg = r && r.phases.find((p) => p.id === "ir").status === "ok"
        ? "The program has no rules, so there is no code to generate."
        : "Intermediate code is generated once the program passes semantic analysis.";
      setEmpty(el.irEmpty, el.irBody, true, msg);
      return;
    }
    setEmpty(el.irEmpty, el.irBody, false);

    const optimized = state.irView === "optimized";
    const code = optimized ? r.optimizedIr : r.ir;
    const o = r.optimization;
    if (optimized) {
      const saved = o.before ? Math.round((100 * (o.before - o.after)) / o.before) : 0;
      el.irSummary.textContent = `${o.before} → ${o.after} instructions` + (saved ? ` (−${saved}%)` : "");
      const used = o.passes.filter((p) => p.count > 0);
      el.optReport.hidden = false;
      el.optReport.innerHTML = used.length
        ? used.map((p) => `<span class="chip" title="${escapeHtml(p.description)}">${escapeHtml(p.name)}<b>${p.count}</b></span>`).join("")
        : '<span class="chip">No optimization applied: the code was already minimal</span>';
    } else {
      el.irSummary.textContent = `${o.before} instructions, three-address code`;
      el.optReport.hidden = true;
    }

    let n = 0;
    el.irList.innerHTML = code
      .map((ins, i) => {
        const isRule = ins.op === "rule";
        const emptyRule = isRule && (i + 1 === code.length || code[i + 1].op === "rule");
        const cls = isRule ? "rule-row" + (emptyRule ? " empty-rule" : "") : ins.op === "label" ? "" : "indent";
        const ln = isRule ? "" : ++n;
        return `<li class="${cls}"><span class="ln">${ln}</span><span class="ins">${irHtml(ins)}</span></li>`;
      })
      .join("");
  }

  // C code ---------------------------------------------------------------

  function highlightC(code) {
    const re = /(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*")|(#include)|\b(if|else|void|const|enum|return)\b|\b(bool|double|char|int|state_t)\b|\b(STATE_[A-Z]+|DEV_[A-Z0-9_]+|true|false)\b|\b(\d+(?:\.\d+)?)\b/g;
    let out = "", last = 0, m;
    while ((m = re.exec(code))) {
      out += escapeHtml(code.slice(last, m.index));
      const cls = m[1] ? "c-comment" : m[2] ? "c-str" : m[3] ? "c-pre" : m[4] ? "c-kw" : m[5] ? "c-type" : m[6] ? "c-const" : "c-num";
      out += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
      last = m.index + m[0].length;
    }
    return out + escapeHtml(code.slice(last));
  }

  function renderC(r) {
    el.runOutput.hidden = true;
    if (!r.cCode) {
      setEmpty(el.cEmpty, el.cBody, true, "C code is generated once the program compiles without errors.");
      return;
    }
    setEmpty(el.cEmpty, el.cBody, false);
    el.cCode.innerHTML = highlightC(r.cCode);
  }

  el.copyC.addEventListener("click", async () => {
    if (!state.result) return;
    try {
      await navigator.clipboard.writeText(state.result.cCode);
      el.copyC.textContent = "Copied";
    } catch (e) {
      el.copyC.textContent = "Copy failed";
    }
    setTimeout(() => (el.copyC.textContent = "Copy"), 1400);
  });

  el.runC.addEventListener("click", async () => {
    if (!fresh()) return;
    el.runC.classList.add("busy");
    el.runC.disabled = true;
    el.runOutput.hidden = false;
    el.runOutput.className = "run-output";
    el.runOutput.innerHTML = "<pre>Compiling the C code with the runtime library…</pre>";
    try {
      const d = await postJson("/api/run", { source: state.compiledSource, inputs: state.simInputs });
      if (!d.ok) throw new Error(d.error);
      el.runOutput.innerHTML =
        `<div class="cmd">$ ${d.commands.map(escapeHtml).join("<br>$ ")}</div>` +
        `<pre>${escapeHtml(d.output + (d.stderr ? "\n" + d.stderr : ""))}</pre>`;
    } catch (e) {
      el.runOutput.className = "run-output bad";
      el.runOutput.innerHTML = `<pre>${escapeHtml(e.message)}</pre>`;
    } finally {
      el.runC.classList.remove("busy");
      el.runC.disabled = false;
    }
  });

  // Simulator ------------------------------------------------------------
  // A tiny virtual machine that executes the optimized three-address code.

  const COUNTERPART = { ON: "OFF", OFF: "ON", OPEN: "CLOSED", CLOSED: "OPEN", TRUE: "FALSE", FALSE: "TRUE" };

  // Values a sensor is compared with in the (unoptimized) IR.
  function comparedValues(name, kind) {
    const vals = [];
    for (const ins of state.result.ir) {
      if (ins.op !== "binary") continue;
      if (ins.a.kind === "sensor" && ins.a.text === name && ins.b.kind === kind) vals.push(ins.b.text);
      if (ins.b.kind === "sensor" && ins.b.text === name && ins.a.kind === kind) vals.push(ins.a.text);
    }
    return vals;
  }

  function stateOptions(name) {
    const opts = [...new Set(comparedValues(name, "state"))];
    if (opts.length === 1) opts.push(COUNTERPART[opts[0]]);
    return opts.length ? opts : ["ON", "OFF"];
  }

  function numberRange(name) {
    const nums = comparedValues(name, "number").map(Number);
    const hi = Math.max(100, ...nums.map((n) => Math.ceil((n * 1.5) / 10) * 10));
    const lo = Math.min(0, ...nums);
    const step = comparedValues(name, "number").some((t) => t.includes(".")) ? 0.5 : 1;
    return { lo, hi, step, first: nums.length ? nums[0] : 0 };
  }

  function renderSim(r) {
    if (!r.cCode) {
      setEmpty(el.simEmpty, el.simBody, true, "The simulator runs once the program compiles without errors.");
      return;
    }
    setEmpty(el.simEmpty, el.simBody, false);

    const sensors = r.symbols.filter((s) => s.kind === "sensor");
    el.sensorList.innerHTML = sensors.length ? "" : '<p class="sim-intro">No sensors declared.</p>';
    for (const s of sensors) {
      const row = document.createElement("div");
      row.className = "sensor";
      const label = `<div class="sensor-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}<span class="sensor-type">${s.type}</span></div>`;
      if (s.type === "NUMBER") {
        const rg = numberRange(s.name);
        if (typeof state.simInputs[s.name] !== "number") state.simInputs[s.name] = rg.first;
        const v = state.simInputs[s.name];
        row.innerHTML = label +
          `<input type="range" min="${rg.lo}" max="${Math.max(rg.hi, v)}" step="${rg.step}" value="${v}" aria-label="${escapeHtml(s.name)}">` +
          `<input type="number" step="${rg.step}" value="${v}" aria-label="${escapeHtml(s.name)} value">`;
        const [range, num] = row.querySelectorAll("input");
        const set = (val, from) => {
          if (Number.isNaN(val)) return;
          state.simInputs[s.name] = val;
          if (from !== range) range.value = val;
          if (from !== num) num.value = val;
          runSim();
        };
        range.addEventListener("input", () => set(parseFloat(range.value), range));
        num.addEventListener("input", () => set(parseFloat(num.value), num));
      } else {
        const opts = stateOptions(s.name);
        if (!opts.includes(state.simInputs[s.name])) state.simInputs[s.name] = opts[opts.length > 1 ? 1 : 0];
        row.innerHTML = label + '<div class="segmented" role="group">' +
          opts.map((o) => `<button type="button" class="seg${o === state.simInputs[s.name] ? " active" : ""}" data-v="${o}">${o}</button>`).join("") +
          "</div>";
        row.querySelectorAll(".seg").forEach((b) =>
          b.addEventListener("click", () => {
            state.simInputs[s.name] = b.dataset.v;
            row.querySelectorAll(".seg").forEach((x) => x.classList.toggle("active", x === b));
            runSim();
          })
        );
      }
      el.sensorList.appendChild(row);
    }
    runSim();
  }

  function executeIr(code, inputs, deviceNames) {
    const labels = {};
    code.forEach((ins, i) => ins.op === "label" && (labels[ins.label] = i));
    const temps = {};
    const devices = Object.fromEntries(deviceNames.map((d) => [d, { on: false, level: 0 }]));
    const actions = {};   // rule number -> list of executed calls

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
      }
      return false;
    };

    for (let pc = 0, guard = 0; pc < code.length && guard < 100000; guard++) {
      const ins = code[pc++];
      switch (ins.op) {
        case "binary": temps[ins.dest] = binop(ins.oper, val(ins.a), val(ins.b)); break;
        case "not": temps[ins.dest] = !val(ins.a); break;
        case "copy": temps[ins.dest] = val(ins.a); break;
        case "if_false": if (!val(ins.a)) pc = labels[ins.label]; break;
        case "goto": pc = labels[ins.label]; break;
        case "call": {
          const args = ins.args.map(val);
          const d = devices[args[0]];
          if (d) {
            if (ins.callee === "turn_on") { d.on = true; if (!d.level) d.level = 100; }
            else if (ins.callee === "turn_off") { d.on = false; d.level = 0; }
            else if (ins.callee === "toggle") { d.on = !d.on; d.level = d.on ? 100 : 0; }
            else if (ins.callee === "set_level") { d.level = args[1]; d.on = args[1] > 0; }
          }
          (actions[ins.rule] = actions[ins.rule] || []).push(ins.text.replace(/^CALL /, ""));
          break;
        }
      }
    }
    return { devices, actions };
  }

  function runSim() {
    const r = state.result;
    if (!r || !r.cCode) return;
    const deviceNames = r.symbols.filter((s) => s.kind === "device").map((s) => s.name);
    const { devices, actions } = executeIr(r.optimizedIr, state.simInputs, deviceNames);

    el.deviceGrid.innerHTML = deviceNames.length ? deviceNames
      .map((name) => {
        const d = devices[name];
        const lvl = d.on && d.level !== 100 ? ` · level ${d.level}` : "";
        return `<div class="device${d.on ? " on" : ""}"><div class="device-name">${escapeHtml(name)}</div>` +
          `<div class="device-state"><i></i>${d.on ? "ON" : "OFF"}${lvl}</div>` +
          `<div class="level-bar"><span style="width:${Math.min(100, Math.max(0, d.on ? d.level : 0))}%"></span></div></div>`;
      })
      .join("") : '<p class="sim-intro">No devices declared.</p>';

    el.ruleList.innerHTML = r.optimizedIr
      .filter((ins) => ins.op === "rule")
      .map((ins) => {
        const acts = actions[ins.rule];
        return `<li class="${acts ? "fired" : ""}"><span class="rule-name">Rule ${ins.rule}<small>line ${ins.line}</small></span>` +
          `<span class="rule-acts">${acts ? escapeHtml(acts.join(", ")) : "no action"}</span></li>`;
      })
      .join("");
  }

  // Problems -------------------------------------------------------------

  function formatMessage(msg) {
    return escapeHtml(msg).replace(/'([^']*)'/g, "<code>'$1'</code>");
  }

  function renderProblems(errors) {
    const nErr = errors.filter((e) => e.severity === "error").length;
    el.problemCount.textContent = errors.length;
    el.problemCount.classList.toggle("bad", nErr > 0);

    if (!errors.length) {
      el.errorList.innerHTML = "";
      el.problemsEmpty.hidden = false;
      el.problemsEmpty.className = "empty ok";
      el.problemsEmpty.innerHTML =
        '<div><div class="ok-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg></div>' +
        "No errors or warnings. The program passed every compiler phase.</div>";
      return;
    }
    el.problemsEmpty.hidden = true;
    el.problemsEmpty.className = "empty";
    el.errorList.innerHTML = errors
      .map(
        (e, i) =>
          `<li class="error-item ${e.severity}" data-i="${i}">` +
          `<span class="phase ${e.phase}">${e.phase}</span>` +
          `<span class="err-pos">${e.line}:${e.col}</span>` +
          `<span class="err-msg">${e.severity === "warning" ? '<span class="sev">warning</span>' : ""}${formatMessage(e.message)}</span>` +
          `<button type="button" class="link-btn explain-btn">Explain</button></li>`
      )
      .join("");
  }

  function problemRange(i) {
    const e = state.result.errors[i];
    return rangeFromPositions([e.line, e.col], [e.line, e.col + Math.max(e.length, 1)]);
  }

  el.errorList.addEventListener("click", async (ev) => {
    const item = ev.target.closest(".error-item");
    if (!item || !state.result) return;
    const i = +item.dataset.i;

    if (ev.target.closest(".explain-btn")) {
      const btn = ev.target.closest(".explain-btn");
      let box = item.querySelector(".explanation");
      if (box) { box.remove(); btn.textContent = "Explain"; return; }
      box = document.createElement("div");
      box.className = "explanation";
      box.textContent = "Asking the AI assistant…";
      item.appendChild(box);
      btn.textContent = "Hide";
      try {
        const d = state.explanations[i] ||
          (state.explanations[i] = await postJson("/api/explain", { source: state.compiledSource, error: state.result.errors[i] }));
        box.textContent = d.text;
        const by = document.createElement("span");
        by.className = "by";
        by.textContent = "Explained by " + d.provider;
        box.appendChild(by);
      } catch (e) {
        box.textContent = "Could not get an explanation: " + e.message;
      }
      return;
    }
    if (ev.target.closest(".explanation") || !fresh()) return;
    revealRange(problemRange(i), true);
  });
  el.errorList.addEventListener("mouseover", (ev) => {
    const item = ev.target.closest(".error-item");
    if (item && fresh()) setHover(problemRange(+item.dataset.i));
  });
  el.errorList.addEventListener("mouseleave", () => setHover(null));

  // ------------------------------------------------------- AI assistant

  async function loadAiStatus() {
    try {
      const s = await (await fetch("/api/ai-status")).json();
      el.aiBadge.textContent = s.mode === "llm" ? `AI · ${s.provider} · ${s.model}` : "AI · offline rules";
      el.aiBadge.classList.toggle("live", s.mode === "llm");
      el.aiBadge.title = s.mode === "llm"
        ? "English is converted by a language model; the result is checked by the compiler"
        : "No AI model is configured, so a built-in rule-based converter is used (see .env.example)";
    } catch (e) {
      el.aiBadge.textContent = "AI · unavailable";
    }
  }

  el.aiForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = el.aiInput.value.trim();
    if (!text) { el.aiInput.focus(); return; }
    el.aiBtn.classList.add("busy");
    el.aiBtn.disabled = true;
    el.aiBtn.textContent = "Converting…";
    try {
      const d = await postJson("/api/nl2dsl", { text, context: el.source.value });
      showAiResult(d);
    } catch (err) {
      showAiResult({ ok: false, error: err.message });
    } finally {
      el.aiBtn.classList.remove("busy");
      el.aiBtn.disabled = false;
      el.aiBtn.textContent = "Convert to DSL";
    }
  });

  function showAiResult(d) {
    el.aiResult.hidden = false;
    el.aiNote.hidden = !d.note;
    el.aiNote.textContent = d.note || "";
    const canUse = d.ok && d.dsl;
    el.aiReplace.hidden = el.aiAppend.hidden = !canUse;
    if (!canUse) {
      state.aiDsl = null;
      el.aiCheck.className = "ai-check bad";
      el.aiCheck.textContent = "Couldn't convert this sentence";
      el.aiMeta.textContent = d.provider || "";
      el.aiCode.textContent = d.error || "Unknown error";
      return;
    }
    state.aiDsl = d.dsl;
    el.aiCheck.className = "ai-check " + (d.valid ? "ok" : "bad");
    el.aiCheck.textContent = d.valid
      ? "✓ Checked by the compiler: no errors"
      : `Compiler found ${d.errors.length} error${d.errors.length === 1 ? "" : "s"}: ${d.errors[0]}`;
    el.aiMeta.textContent = "Generated by " + d.provider + (d.model ? " · " + d.model : "") +
      (d.attempts > 1 ? " · repaired once using compiler errors" : "");
    el.aiCode.innerHTML = highlightDsl(d.dsl);
  }

  // Adds the AI output to the editor, skipping declarations it already has.
  function mergeDsl(existing, generated) {
    const declared = new Set();
    existing.replace(/^\s*SENSOR\s+(\w+)/gm, (m, n) => declared.add(n));
    existing.replace(/^\s*DEVICE\s+(.+)$/gm, (m, l) => l.split(",").forEach((n) => declared.add(n.trim())));
    const out = [];
    for (const line of generated.split("\n")) {
      let m;
      if ((m = line.match(/^\s*SENSOR\s+(\w+)/))) {
        if (declared.has(m[1])) continue;
        declared.add(m[1]);
        out.push(line);
      } else if ((m = line.match(/^\s*DEVICE\s+(.+)$/))) {
        const names = m[1].split(",").map((s) => s.trim()).filter((n) => n && !declared.has(n));
        names.forEach((n) => declared.add(n));
        if (names.length) out.push("DEVICE " + names.join(", "));
      } else {
        out.push(line);
      }
    }
    const addition = out.join("\n").replace(/^\s+/, "");
    return existing.trim() ? existing.replace(/\s*$/, "") + "\n\n" + addition : addition;
  }

  el.aiReplace.addEventListener("click", () => {
    if (!state.aiDsl) return;
    el.examples.selectedIndex = 0;
    loadSource(state.aiDsl);
    el.aiResult.hidden = true;
  });
  el.aiAppend.addEventListener("click", () => {
    if (!state.aiDsl) return;
    loadSource(mergeDsl(el.source.value, state.aiDsl));
    el.source.scrollTop = el.source.scrollHeight;
    syncScroll();
    el.aiResult.hidden = true;
  });
  el.aiDismiss.addEventListener("click", () => (el.aiResult.hidden = true));

  // ----------------------------------------------------------------- init

  render();
  updateCursor();
  showTab("tokens");
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionIndicator);
  loadExamples();
  loadAiStatus();
})();
