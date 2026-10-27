// util.js — small helpers shared by every module.

export const $ = (id) => document.getElementById(id);

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "server error " + res.status);
  return data;
}

export async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("server error " + res.status);
  return res.json();
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- positions ----------------------------------------------------------------

export function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}

export function toOffset(starts, line, col) {
  const base = starts[Math.min(Math.max(line, 1), starts.length) - 1];
  return base + Math.max(col, 1) - 1;
}

export function offsetToPos(src, offset) {
  const before = src.slice(0, offset);
  const line = before.split("\n").length;
  return { line, col: offset - before.lastIndexOf("\n") };
}

// A source span is [startLine, startCol, endLine, endCol] (end exclusive).
export const spanKey = (s) => s.join(",");
export const posLess = (l1, c1, l2, c2) => l1 < l2 || (l1 === l2 && c1 < c2);
export const posLE = (l1, c1, l2, c2) => l1 < l2 || (l1 === l2 && c1 <= c2);
export function spanValid(s) {
  return s && s[0] > 0 && posLess(s[0], s[1], s[2], s[3]);
}
export function spanInside(inner, outer) {
  return posLE(outer[0], outer[1], inner[0], inner[1]) && posLE(inner[2], inner[3], outer[2], outer[3]);
}
export function spanSize(s) {
  return (s[2] - s[0]) * 1000 + (s[3] - s[1]);
}

// ---- events -------------------------------------------------------------------

const handlers = {};
export const bus = {
  on(event, fn) {
    (handlers[event] = handlers[event] || []).push(fn);
  },
  emit(event, data) {
    (handlers[event] || []).forEach((fn) => fn(data));
  },
};

// ---- small UI helpers -----------------------------------------------------------

let toastTimer;
export function toast(message, kind = "") {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast " + kind), 2600);
}

export function download(fileName, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function svgEl(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

export function fmtNum(v) {
  if (typeof v !== "number") return String(v);
  return String(+v.toFixed(2));
}

// Text width in the monospace editor font (cached canvas).
let measureCtx;
export function textWidth(text, font = "12px ui-monospace, SFMono-Regular, Menlo, monospace") {
  measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

// Pan and zoom for an SVG whose content lives in one <g>.
export function panZoom(svg, group, opts = {}) {
  const view = { x: 0, y: 0, k: 1 };
  const apply = () => group.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("[data-click]")) return;
    drag = { x: e.clientX - view.x, y: e.clientY - view.y };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    view.x = e.clientX - drag.x;
    view.y = e.clientY - drag.y;
    apply();
  });
  const end = () => {
    drag = null;
    svg.classList.remove("dragging");
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey || opts.wheelZoom)) return;
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = Math.min(3, Math.max(0.25, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
      view.x = mx - ((mx - view.x) * k) / view.k;
      view.y = my - ((my - view.y) * k) / view.k;
      view.k = k;
      apply();
    },
    { passive: false }
  );
  return {
    zoom(f) {
      const r = svg.getBoundingClientRect();
      const mx = r.width / 2, my = r.height / 2;
      const k = Math.min(3, Math.max(0.25, view.k * f));
      view.x = mx - ((mx - view.x) * k) / view.k;
      view.y = my - ((my - view.y) * k) / view.k;
      view.k = k;
      apply();
    },
    fit(width, height) {
      const r = svg.getBoundingClientRect();
      if (!r.width || !width) return;
      view.k = Math.min(1.2, (r.width - 24) / width, (r.height - 24) / height);
      view.x = (r.width - width * view.k) / 2;
      view.y = 12;
      apply();
    },
    reset() {
      view.x = view.y = 0;
      view.k = 1;
      apply();
    },
  };
}
