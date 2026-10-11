// app.js — web interface for the IoT DSL compiler.
// All compiling is done by the C++ compiler on the server (POST /api/compile).
// The syntax colouring in the editor is cosmetic only.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const el = {
    source: $("source"),
    highlight: $("highlight"),
    gutter: $("gutterInner"),
    examples: $("examples"),
    compileBtn: $("compileBtn"),
    clearBtn: $("clearBtn"),
    shortcut: $("shortcut"),
    cursorPos: $("cursorPos"),
    lineCount: $("lineCount"),
    themeToggle: $("themeToggle"),
    tabIndicator: $("tabIndicator"),
    tokenCount: $("tokenCount"),
    errorCount: $("errorCount"),
    tokensEmpty: $("tokensEmpty"),
    tokenTable: $("tokenTable"),
    tokenBody: $("tokenBody"),
    astTools: $("astTools"),
    astEmpty: $("astEmpty"),
    astTree: $("astTree"),
    errorsEmpty: $("errorsEmpty"),
    errorList: $("errorList"),
    status: $("status"),
    statusText: $("statusText"),
    statTokens: $("statTokens"),
    statDecls: $("statDecls"),
    statRules: $("statRules"),
    statErrors: $("statErrors"),
    statTime: $("statTime"),
  };

  const state = {
    result: null,          // last JSON returned by the compiler
    compiledSource: null,  // source text that produced `result`
    hover: null,           // {start, end} offsets to highlight in the editor
    activeTab: "tokens",
  };

  const LINE_HEIGHT = 22;

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

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

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

  function lineStarts(src) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
    return starts;
  }

  function toOffset(starts, line, col) {
    const base = starts[Math.min(Math.max(line, 1), starts.length) - 1];
    return base + Math.max(col, 1) - 1;
  }

  function errorRanges(src) {
    if (!state.result || state.compiledSource !== src) return [];
    const starts = lineStarts(src);
    return state.result.errors.map((e) => {
      let start = toOffset(starts, e.line, e.col);
      // Errors just past the end of a line (e.g. a missing ')') mark the last character.
      if ((start >= src.length || src[start] === "\n") && start > 0) start--;
      return { start, end: start + Math.max(e.length, 1), line: e.line };
    });
  }

  function render() {
    const src = el.source.value;
    const cls = colourClasses(src);
    const errs = errorRanges(src);
    const hover = state.hover;

    const errMark = new Uint8Array(src.length);
    for (const r of errs) for (let p = r.start; p < Math.min(r.end, src.length); p++) errMark[p] = 1;

    let html = "";
    let i = 0;
    while (i < src.length) {
      const key = (p) => cls[p] + "|" + errMark[p] + "|" + (hover && p >= hover.start && p < hover.end ? 1 : 0);
      const k = key(i);
      let j = i + 1;
      while (j < src.length && key(j) === k && src[j] !== "\n") j++;
      const [c, e, h] = k.split("|");
      const classes = [c, e === "1" ? "m-error" : "", h === "1" ? "m-hover" : ""].filter(Boolean).join(" ");
      const text = escapeHtml(src.slice(i, j));
      html += classes ? `<span class="${classes}">${text}</span>` : text;
      i = j;
    }
    el.highlight.innerHTML = html + "\n";

    // Line numbers
    const lines = src.split("\n").length;
    const errLines = new Set(errs.map((r) => r.line));
    let g = "";
    for (let n = 1; n <= lines; n++) g += `<div${errLines.has(n) ? ' class="err"' : ""}>${n}</div>`;
    el.gutter.innerHTML = g;
    el.lineCount.textContent = lines + (lines === 1 ? " line" : " lines");

    syncScroll();
  }

  function syncScroll() {
    el.highlight.scrollTop = el.source.scrollTop;
    el.highlight.scrollLeft = el.source.scrollLeft;
    el.gutter.style.transform = `translateY(${-el.source.scrollTop}px)`;
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
    const before = el.source.value.slice(0, range.start);
    const line = before.split("\n").length;
    const target = (line - 1) * LINE_HEIGHT - el.source.clientHeight / 2 + LINE_HEIGHT;
    el.source.scrollTop = Math.max(0, target);
    if (select) {
      el.source.focus({ preventScroll: true });
      el.source.setSelectionRange(range.start, Math.max(range.end, range.start + 1));
      updateCursor();
    }
    syncScroll();
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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      compile();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      el.source.setRangeText("    ", el.source.selectionStart, el.source.selectionEnd, "end");
      el.source.dispatchEvent(new Event("input"));
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target !== el.source) {
      e.preventDefault();
      compile();
    }
  });

  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) el.shortcut.textContent = "⌘ ↵";

  // ----------------------------------------------------------------- tabs

  const tabs = Array.from(document.querySelectorAll(".tab"));

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
    });
    document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + name));
    positionIndicator();
  }

  tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  window.addEventListener("resize", positionIndicator);

  // ------------------------------------------------------------- examples

  async function loadExamples() {
    try {
      const res = await fetch("/api/examples");
      const list = await res.json();
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

  el.examples.addEventListener("change", () => {
    if (!el.examples.value) return;
    el.source.value = el.examples.value;
    el.source.scrollTop = 0;
    state.hover = null;
    render();
    updateCursor();
    compile();
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
      const res = await fetch("/api/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "server error " + res.status);
      state.result = data;
      state.compiledSource = source;
      state.hover = null;
      showResult(data);
      render();
    } catch (e) {
      const msg = e instanceof TypeError ? "Cannot reach the compiler server. Start it with: make run" : e.message;
      setStatus("fail", msg);
    } finally {
      el.compileBtn.classList.remove("busy");
    }
  }

  el.compileBtn.addEventListener("click", compile);

  // -------------------------------------------------------------- results

  function setStatus(kind, text) {
    el.status.className = "status" + (kind ? " " + kind : "");
    el.statusText.textContent = text;
  }

  function markStale() {
    if (state.compiledSource !== el.source.value) setStatus("stale", "Edited since last compile");
    else showStatus(state.result);
  }

  function showStatus(r) {
    const n = r.errors.length;
    if (n === 0) setStatus("ok", "Compiled successfully");
    else setStatus("fail", `Found ${n} error${n === 1 ? "" : "s"}`);
  }

  function resetOutput() {
    el.tokenCount.textContent = "0";
    el.errorCount.textContent = "0";
    el.errorCount.classList.remove("bad");
    el.tokensEmpty.hidden = false;
    el.tokensEmpty.innerHTML = "<span>Press <strong>Compile</strong> to run the lexer.</span>";
    el.tokenTable.hidden = true;
    el.tokenBody.innerHTML = "";
    el.astTools.hidden = true;
    el.astEmpty.hidden = false;
    el.astEmpty.className = "empty";
    el.astEmpty.innerHTML = "<span>Press <strong>Compile</strong> to build the syntax tree.</span>";
    el.astTree.innerHTML = "";
    el.errorsEmpty.hidden = false;
    el.errorsEmpty.className = "empty";
    el.errorsEmpty.innerHTML = "<span>Press <strong>Compile</strong> to check the program.</span>";
    el.errorList.innerHTML = "";
    document.querySelectorAll(".step.done").forEach((s) => s.classList.remove("has-error"));
    ["statTokens", "statDecls", "statRules", "statErrors", "statTime"].forEach((k) => (el[k].textContent = "–"));
    setStatus("", "Ready");
  }

  function showResult(r) {
    showStatus(r);
    renderTokens(r.tokens);
    renderAst(r.ast, r.errors.length > 0);
    renderErrors(r.errors);

    const lexErr = r.errors.some((e) => e.phase === "lexical");
    const synErr = r.errors.some((e) => e.phase === "syntax");
    document.querySelector('[data-step="lexer"]').classList.toggle("has-error", lexErr);
    document.querySelector('[data-step="parser"]').classList.toggle("has-error", synErr);
    document.querySelector('[data-step="ast"]').classList.toggle("has-error", synErr);

    el.statTokens.textContent = r.stats.tokens;
    el.statDecls.textContent = r.stats.declarations;
    el.statRules.textContent = r.stats.rules;
    el.statErrors.textContent = r.stats.errors;
    el.statTime.textContent = r.stats.timeMs.toFixed(3) + " ms";

    if (r.errors.length) showTab("errors");
    else if (state.activeTab === "errors") showTab("ast");
  }

  // Tokens ---------------------------------------------------------------

  function renderTokens(tokens) {
    el.tokenCount.textContent = tokens.length;
    el.tokensEmpty.hidden = tokens.length > 0;
    el.tokenTable.hidden = tokens.length === 0;
    if (!tokens.length) el.tokensEmpty.innerHTML = "<span>No tokens. The program is empty.</span>";

    el.tokenBody.innerHTML = tokens
      .map(
        (t, i) =>
          `<tr data-i="${i}"><td>${i + 1}</td><td>${t.line}:${t.col}</td>` +
          `<td><span class="pill ${t.category}">${t.type}</span></td>` +
          `<td>${escapeHtml(t.lexeme)}</td></tr>`
      )
      .join("");
  }

  el.tokenBody.addEventListener("mouseover", (e) => {
    const row = e.target.closest("tr");
    if (!row || !state.result || state.compiledSource !== el.source.value) return;
    const t = state.result.tokens[+row.dataset.i];
    const range = rangeFromPositions([t.line, t.col], [t.line, t.col + t.length]);
    setHover(range);
  });
  el.tokenBody.addEventListener("mouseleave", () => setHover(null));
  el.tokenBody.addEventListener("click", (e) => {
    const row = e.target.closest("tr");
    if (!row || !state.result || state.compiledSource !== el.source.value) return;
    const t = state.result.tokens[+row.dataset.i];
    revealRange(rangeFromPositions([t.line, t.col], [t.line, t.col + t.length]), true);
  });

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
    let name = parts.name;
    if (n.kind === "rule") name += " " + ruleIndex;
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
    if (empty) {
      el.astTree.innerHTML = "";
      el.astTools.hidden = true;
      el.astEmpty.hidden = false;
      el.astEmpty.innerHTML = hasErrors
        ? "<span>No statement could be parsed. See the <strong>Errors</strong> tab.</span>"
        : "<span>The program has no statements.</span>";
      return;
    }
    el.astEmpty.hidden = true;
    el.astTools.hidden = false;
    el.astTree.innerHTML = "<ul>" + buildNode(ast, 0) + "</ul>";
  }

  el.astTree.addEventListener("click", (e) => {
    const tw = e.target.closest(".twisty");
    if (tw && !tw.classList.contains("leaf")) {
      tw.closest("li").classList.toggle("collapsed");
      return;
    }
    const node = e.target.closest(".node");
    if (!node || state.compiledSource !== el.source.value) return;
    const n = astNodes[+node.dataset.id];
    if (n.start[0]) revealRange(rangeFromPositions(n.start, n.end), true);
  });

  el.astTree.addEventListener("mouseover", (e) => {
    const node = e.target.closest(".node");
    if (!node || state.compiledSource !== el.source.value) return;
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

  // Errors ---------------------------------------------------------------

  function formatMessage(msg) {
    return escapeHtml(msg).replace(/'([^']*)'/g, "<code>'$1'</code>");
  }

  function renderErrors(errors) {
    el.errorCount.textContent = errors.length;
    el.errorCount.classList.toggle("bad", errors.length > 0);

    if (!errors.length) {
      el.errorList.innerHTML = "";
      el.errorsEmpty.hidden = false;
      el.errorsEmpty.className = "empty ok";
      el.errorsEmpty.innerHTML =
        '<div><div class="ok-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg></div>' +
        "No errors. The program is lexically and syntactically valid.</div>";
      return;
    }

    el.errorsEmpty.hidden = true;
    el.errorList.innerHTML = errors
      .map(
        (e, i) =>
          `<li class="error-item" data-i="${i}">` +
          `<span class="phase ${e.phase}">${e.phase}</span>` +
          `<span class="err-pos">${e.line}:${e.col}</span>` +
          `<span class="err-msg">${formatMessage(e.message)}</span></li>`
      )
      .join("");
  }

  function errorRange(i) {
    const e = state.result.errors[i];
    return rangeFromPositions([e.line, e.col], [e.line, e.col + Math.max(e.length, 1)]);
  }

  el.errorList.addEventListener("click", (ev) => {
    const item = ev.target.closest(".error-item");
    if (!item || state.compiledSource !== el.source.value) return;
    revealRange(errorRange(+item.dataset.i), true);
  });
  el.errorList.addEventListener("mouseover", (ev) => {
    const item = ev.target.closest(".error-item");
    if (!item || state.compiledSource !== el.source.value) return;
    setHover(errorRange(+item.dataset.i));
  });
  el.errorList.addEventListener("mouseleave", () => setHover(null));

  // ----------------------------------------------------------------- init

  render();
  updateCursor();
  showTab("tokens");
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionIndicator);
  loadExamples();
})();
