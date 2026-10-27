// highlight.js — syntax colouring for the DSL, IR and generated code (cosmetic only).

import { escapeHtml } from "./util.js";

export const KEYWORDS = ["IF", "THEN", "ELSE", "AND", "OR", "NOT", "SENSOR", "DEVICE", "NUMBER", "STATE"];
export const STATES = ["ON", "OFF", "OPEN", "CLOSED", "TRUE", "FALSE"];
const KW = new Set(KEYWORDS);
const ST = new Set(STATES);

// Per-character colour classes for the editor overlay.
export function colourClasses(src) {
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
      k = KW.has(word) ? "s-kw" : ST.has(word) ? "s-state" : "";
    } else if (/[0-9]/.test(c)) {
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      k = "s-num";
    } else if (/[<>=!(),:+\-*/]/.test(c)) {
      k = "s-op";
    } else if (!/\s/.test(c)) {
      k = "s-bad";
    }
    for (let p = i; p < j; p++) cls[p] = k;
    i = j;
  }
  return cls;
}

export function highlightDsl(src) {
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

export function irHtml(ins) {
  const text = escapeHtml(ins.text);
  if (ins.op === "rule") return `<span class="i-comment">${text}</span>`;
  return text.replace(
    /\b(IF_FALSE|GOTO|CALL|NOT|AND|OR)\b|\b(t\d+)\b|\b(L\d+)\b|\b(ON|OFF|OPEN|CLOSED|TRUE|FALSE)\b|(-?\b\d+(?:\.\d+)?)\b/g,
    (m, kw, temp, label, st, num) =>
      `<span class="${kw ? "i-kw" : temp ? "i-temp" : label ? "i-label" : st ? "i-state" : "i-num"}">${m}</span>`
  );
}

const CODE_KEYWORDS = {
  c: "if|else|void|const|enum|return|for|while|static|struct",
  arduino: "if|else|void|const|enum|return|for|while|static|struct",
  js: "if|else|const|let|function|return|require|module|exports|use strict",
  python: "if|else|elif|def|from|import|return|pass|and|or|not|True|False|None",
};
const CODE_TYPES = {
  c: "bool|double|char|int|state_t|true|false",
  arduino: "bool|double|char|int|State|true|false|HIGH|LOW|INPUT|OUTPUT",
  js: "true|false",
  python: "",
};

// Generated code in any target language.
export function highlightCode(code, target = "c") {
  const comment = target === "python" ? "#[^\\n]*" : "\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*";
  const kw = CODE_KEYWORDS[target] || CODE_KEYWORDS.c;
  const types = CODE_TYPES[target] || "";
  const re = new RegExp(
    `(${comment})|("(?:[^"\\\\]|\\\\.)*")|(#include)|\\b(${kw})\\b|${types ? `\\b(${types})\\b` : "(\\b\\B)"}|` +
      `\\b(STATE_[A-Z]+|DEV_[A-Z0-9_]+|PIN_[A-Z0-9_]+|A\\d)\\b|\\b(\\d+(?:\\.\\d+)?)\\b`,
    "g"
  );
  let out = "", last = 0, m;
  while ((m = re.exec(code))) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += escapeHtml(code.slice(last, m.index));
    const cls = m[1] ? "c-comment" : m[2] ? "c-str" : m[3] ? "c-pre" : m[4] ? "c-kw" : m[5] ? "c-type" : m[6] ? "c-const" : "c-num";
    out += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(code.slice(last));
}
