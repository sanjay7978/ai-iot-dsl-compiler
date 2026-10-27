// editor.js — the source editor: colouring overlay, line numbers, problem underlines,
// hover tooltips, autocomplete, go-to-declaration and quick-fix edits.

import { $, bus, escapeHtml, lineStarts, toOffset, offsetToPos, textWidth, debounce } from "./util.js";
import { state, fresh } from "./state.js";
import { colourClasses, KEYWORDS, STATES } from "./highlight.js";

const LINE_HEIGHT = 22;
const PAD_X = 16, PAD_Y = 14;
let el;
let charWidth = 7.8;

export function initEditor() {
  el = {
    source: $("source"),
    highlight: $("highlight"),
    gutter: $("gutterInner"),
    cursorPos: $("cursorPos"),
    lineCount: $("lineCount"),
    code: document.querySelector(".editor .code"),
  };
  el.tip = document.createElement("div");
  el.tip.className = "editor-tip";
  el.tip.hidden = true;
  document.body.appendChild(el.tip);
  el.ac = document.createElement("ul");
  el.ac.className = "autocomplete";
  el.ac.hidden = true;
  el.ac.setAttribute("role", "listbox");
  el.code.appendChild(el.ac);

  measure();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);

  el.source.addEventListener("input", (e) => {
    state.hover = null;
    render();
    updateCursor();
    bus.emit("source-changed", el.source.value);
    if (e.inputType && e.inputType.startsWith("insert") && e.data && /\w/.test(e.data)) showCompletions();
    else if (e.inputType !== "insertText") hideCompletions();
  });
  el.source.addEventListener("scroll", () => { syncScroll(); hideCompletions(); });
  ["keyup", "click", "select"].forEach((ev) => el.source.addEventListener(ev, () => { updateCursor(); emitCaret(); }));
  el.source.addEventListener("keydown", onKeyDown);
  el.source.addEventListener("blur", () => setTimeout(hideCompletions, 150));
  el.source.addEventListener("mousemove", debounce(onHover, 60));
  el.source.addEventListener("mouseleave", () => (el.tip.hidden = true));
  el.source.addEventListener("click", onClick);
  window.addEventListener("resize", measure);
  render();
  updateCursor();
}

function measure() {
  const cs = getComputedStyle(el.source);
  charWidth = textWidth("0123456789", `${cs.fontSize} ${cs.fontFamily}`) / 10 || 7.8;
}

export const getSource = () => el.source.value;

export function setSource(text) {
  el.source.value = text;
  el.source.scrollTop = 0;
  state.hover = null;
  render();
  updateCursor();
}

// ---- rendering --------------------------------------------------------------------

function problemRanges(src) {
  if (!fresh()) return [];
  const starts = lineStarts(src);
  return state.result.errors.map((e) => {
    let start = toOffset(starts, e.line, e.col);
    if ((start >= src.length || src[start] === "\n") && start > 0) start--;
    return { start, end: start + Math.max(e.length, 1), line: e.line, warning: e.severity === "warning" };
  });
}

export function render() {
  const src = el.source.value;
  const cls = colourClasses(src);
  const probs = problemRanges(src);
  const hover = state.hover;
  const links = state.link || [];

  const mark = new Uint8Array(src.length);   // 1 = warning, 2 = error
  for (const r of probs)
    for (let p = r.start; p < Math.min(r.end, src.length); p++) mark[p] = Math.max(mark[p], r.warning ? 1 : 2);
  const linked = new Uint8Array(src.length);
  for (const r of links) for (let p = r.start; p < Math.min(r.end, src.length); p++) linked[p] = 1;

  const key = (p) => cls[p] + "|" + mark[p] + "|" + (hover && p >= hover.start && p < hover.end ? 1 : 0) + "|" + linked[p];
  let html = "";
  let i = 0;
  while (i < src.length) {
    const k = key(i);
    let j = i + 1;
    while (j < src.length && key(j) === k && src[j] !== "\n") j++;
    const [c, m, h, l] = k.split("|");
    const classes = [c, m === "2" ? "m-error" : m === "1" ? "m-warn" : "", h === "1" ? "m-hover" : "", l === "1" ? "m-link" : ""]
      .filter(Boolean).join(" ");
    const text = escapeHtml(src.slice(i, j));
    html += classes ? `<span class="${classes}">${text}</span>` : text;
    i = j;
  }
  el.highlight.innerHTML = html + "\n";

  const lines = src.split("\n").length;
  const errLines = new Set(probs.filter((r) => !r.warning).map((r) => r.line));
  const warnLines = new Set(probs.filter((r) => r.warning).map((r) => r.line));
  let g = "";
  for (let n = 1; n <= lines; n++)
    g += `<div${errLines.has(n) ? ' class="err"' : warnLines.has(n) ? ' class="warn"' : ""}>${n}</div>`;
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
  const p = offsetToPos(el.source.value, el.source.selectionStart);
  el.cursorPos.textContent = `Ln ${p.line}, Col ${p.col}`;
}

function emitCaret() {
  if (!fresh()) return;
  bus.emit("caret", offsetToPos(el.source.value, el.source.selectionStart));
}

export function setHover(range) {
  state.hover = range;
  render();
}

export function setLinked(ranges) {
  state.link = ranges;
  render();
}

export function rangeFromSpan(span) {
  const starts = lineStarts(el.source.value);
  return { start: toOffset(starts, span[0], span[1]), end: toOffset(starts, span[2], span[3]) };
}

export function revealRange(range, select) {
  const line = el.source.value.slice(0, range.start).split("\n").length;
  el.source.scrollTop = Math.max(0, (line - 1) * LINE_HEIGHT - el.source.clientHeight / 2 + LINE_HEIGHT);
  if (select) {
    el.source.focus({ preventScroll: true });
    el.source.setSelectionRange(range.start, Math.max(range.end, range.start + 1));
    updateCursor();
  }
  syncScroll();
}

// ---- editing ---------------------------------------------------------------------

// Replaces [start, end) with text through the browser's edit command, so Ctrl+Z works.
export function replaceRange(start, end, text) {
  el.source.focus({ preventScroll: true });
  el.source.setSelectionRange(start, end);
  let ok = false;
  try { ok = document.execCommand("insertText", false, text); } catch (e) { ok = false; }
  if (!ok) {
    el.source.setRangeText(text, start, end, "end");
    el.source.dispatchEvent(new Event("input"));
  }
}

// Applies a compiler quick fix ({line, col, length, text}).
export function applyFix(fix) {
  const src = el.source.value;
  const starts = lineStarts(src);
  let start;
  if (fix.line > starts.length) start = src.length;
  else start = Math.min(toOffset(starts, fix.line, fix.col), src.length);
  replaceRange(start, Math.min(start + fix.length, src.length), fix.text);
  revealRange({ start, end: start + fix.text.length }, false);
}

// ---- hover tooltips and go-to-declaration ------------------------------------------

function offsetAtMouse(e) {
  const r = el.source.getBoundingClientRect();
  const x = e.clientX - r.left - PAD_X + el.source.scrollLeft;
  const y = e.clientY - r.top - PAD_Y + el.source.scrollTop;
  if (x < 0 || y < 0) return -1;
  const line = Math.floor(y / LINE_HEIGHT) + 1;
  const col = Math.floor(x / charWidth) + 1;
  const src = el.source.value;
  const starts = lineStarts(src);
  if (line > starts.length) return -1;
  const lineEnd = line < starts.length ? starts[line] - 1 : src.length;
  const off = starts[line - 1] + col - 1;
  return off <= lineEnd ? off : -1;
}

function wordAt(off) {
  const src = el.source.value;
  if (off < 0 || !/\w/.test(src[off] || "")) return null;
  let a = off, b = off;
  while (a > 0 && /\w/.test(src[a - 1])) a--;
  while (b < src.length && /\w/.test(src[b])) b++;
  return { word: src.slice(a, b), start: a, end: b };
}

function onHover(e) {
  const off = offsetAtMouse(e);
  let html = "";
  if (off >= 0 && fresh()) {
    const probs = problemRanges(el.source.value);
    const hit = state.result.errors.filter((_, i) => off >= probs[i].start && off < probs[i].end);
    for (const p of hit)
      html += `<div class="tip-problem ${p.severity}"><b>${p.severity === "error" ? "Error" : "Warning"}</b> ${escapeHtml(p.message)}${p.fixes && p.fixes.length ? `<span class="tip-fix">Quick fix: ${escapeHtml(p.fixes[0].title)}</span>` : ""}</div>`;
    const w = wordAt(off);
    const sym = w && state.result.symbols.find((s) => s.name === w.word);
    if (sym)
      html += `<div class="tip-symbol"><code>${escapeHtml(sym.name)}</code> ${sym.kind}${sym.kind === "sensor" ? " · " + sym.type : ""} · declared at ${sym.line}:${sym.col} · used ${sym.uses}×<span class="tip-hint">${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}-click to go to the declaration</span></div>`;
    else if (w && /^(turn_on|turn_off|toggle|set_level)$/.test(w.word))
      html += `<div class="tip-symbol"><code>${w.word}(${w.word === "set_level" ? "device, number" : "device"})</code> built-in action</div>`;
  }
  if (!html) { el.tip.hidden = true; return; }
  el.tip.innerHTML = html;
  el.tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - el.tip.offsetWidth - 8);
  const y = e.clientY + 18 + el.tip.offsetHeight > window.innerHeight ? e.clientY - el.tip.offsetHeight - 10 : e.clientY + 18;
  el.tip.style.left = Math.max(8, x) + "px";
  el.tip.style.top = y + "px";
}

function onClick(e) {
  if (!(e.metaKey || e.ctrlKey) || !fresh()) return;
  const w = wordAt(el.source.selectionStart);
  const sym = w && state.result.symbols.find((s) => s.name === w.word);
  if (!sym) return;
  e.preventDefault();
  const r = rangeFromSpan([sym.line, sym.col, sym.line, sym.col + sym.name.length]);
  revealRange(r, true);
}

// ---- autocomplete -------------------------------------------------------------------

const ACTIONS = [
  { label: "turn_on", insert: "turn_on()", back: 1, detail: "turn_on(device)" },
  { label: "turn_off", insert: "turn_off()", back: 1, detail: "turn_off(device)" },
  { label: "toggle", insert: "toggle()", back: 1, detail: "toggle(device)" },
  { label: "set_level", insert: "set_level(, )", back: 3, detail: "set_level(device, number)" },
];
let ac = { items: [], index: 0, start: 0 };

function declaredNames() {
  const src = el.source.value;
  const names = [];
  src.replace(/^\s*SENSOR\s+(\w+)\s*:\s*(NUMBER|STATE)/gm, (m, n, t) => names.push({ label: n, kind: "sensor", detail: "sensor · " + t }));
  src.replace(/^\s*DEVICE\s+(.+)$/gm, (m, l) =>
    l.split(",").forEach((n) => (n = n.trim()) && /^\w+$/.test(n) && names.push({ label: n, kind: "device", detail: "device" }))
  );
  return names;
}

function showCompletions() {
  const src = el.source.value;
  const caret = el.source.selectionStart;
  let start = caret;
  while (start > 0 && /\w/.test(src[start - 1])) start--;
  const prefix = src.slice(start, caret);
  const lineStart = src.lastIndexOf("\n", caret - 1) + 1;
  if (!prefix || /^\d/.test(prefix) || src.slice(lineStart, caret).includes("#")) return hideCompletions();

  const lower = prefix.toLowerCase();
  const pool = [
    ...declaredNames(),
    ...KEYWORDS.map((k) => ({ label: k, kind: "keyword", detail: "keyword" })),
    ...STATES.map((k) => ({ label: k, kind: "state", detail: "state value" })),
    ...ACTIONS.map((a) => ({ ...a, kind: "action" })),
  ];
  const seen = new Set();
  const items = pool
    .filter((c) => c.label.toLowerCase().startsWith(lower) && c.label !== prefix && !seen.has(c.label) && seen.add(c.label))
    .sort((a, b) => (b.label.startsWith(prefix) - a.label.startsWith(prefix)) || a.label.length - b.label.length)
    .slice(0, 8);
  if (!items.length) return hideCompletions();

  ac = { items, index: 0, start };
  el.ac.innerHTML = items
    .map((c, i) => `<li role="option" data-i="${i}" class="${i === 0 ? "active" : ""}"><span class="ac-kind k-${c.kind}"></span><span class="ac-label">${escapeHtml(c.label)}</span><span class="ac-detail">${escapeHtml(c.detail)}</span></li>`)
    .join("");
  const p = offsetToPos(src, start);
  el.ac.style.left = Math.max(4, PAD_X + (p.col - 1) * charWidth - el.source.scrollLeft - 6) + "px";
  el.ac.style.top = PAD_Y + p.line * LINE_HEIGHT - el.source.scrollTop + 2 + "px";
  el.ac.hidden = false;
  el.ac.querySelectorAll("li").forEach((li) =>
    li.addEventListener("mousedown", (e) => { e.preventDefault(); ac.index = +li.dataset.i; accept(); })
  );
}

function hideCompletions() {
  el.ac.hidden = true;
}

function accept() {
  const c = ac.items[ac.index];
  if (!c) return;
  const insert = c.insert || c.label;
  replaceRange(ac.start, el.source.selectionStart, insert);
  if (c.back) {
    const pos = el.source.selectionStart - c.back;
    el.source.setSelectionRange(pos, pos);
  }
  hideCompletions();
}

function onKeyDown(e) {
  if (!el.ac.hidden) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      ac.index = (ac.index + (e.key === "ArrowDown" ? 1 : ac.items.length - 1)) % ac.items.length;
      el.ac.querySelectorAll("li").forEach((li, i) => li.classList.toggle("active", i === ac.index));
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); accept(); return; }
    if (e.key === "Escape") { e.preventDefault(); hideCompletions(); return; }
  }
  if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    replaceRange(el.source.selectionStart, el.source.selectionEnd, "    ");
  }
}
