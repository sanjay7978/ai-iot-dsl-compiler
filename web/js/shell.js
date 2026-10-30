// shell.js — the Studio's application shell: the resizable editor/output split,
// the left rail (section links and its active state) and the program name.

import { $, bus } from "./util.js";

const SPLIT_KEY = "kelvin-split";
const clampSplit = (v) => Math.min(0.75, Math.max(0.25, v));

function setSplit(v, save = true) {
  document.documentElement.style.setProperty("--split", v);
  if (save) { try { localStorage.setItem(SPLIT_KEY, String(v)); } catch (e) { /* storage unavailable */ } }
  window.dispatchEvent(new Event("resize"));   // graphs and the tab indicator re-measure
}

function initSplitter() {
  const handle = $("splitter");
  const ws = $("workspace");
  if (!handle || !ws) return;
  let dragging = false;
  const move = (e) => {
    if (!dragging) return;
    const r = ws.getBoundingClientRect();
    setSplit(clampSplit((e.clientX - r.left) / r.width), false);
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.classList.remove("resizing");
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--split")) || 0.5;
    setSplit(v);
  };
  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("dblclick", () => setSplit(0.5));
  handle.addEventListener("keydown", (e) => {
    const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--split")) || 0.5;
    if (e.key === "ArrowLeft") { e.preventDefault(); setSplit(clampSplit(cur - 0.03)); }
    if (e.key === "ArrowRight") { e.preventDefault(); setSplit(clampSplit(cur + 0.03)); }
  });
}

function initRail() {
  const links = Array.from(document.querySelectorAll(".rail-link[data-section]"));
  const setActive = (id) => links.forEach((l) => l.classList.toggle("active", l.dataset.section === id));
  links.forEach((l) => l.addEventListener("click", (e) => {
    e.preventDefault();
    const target = $(l.dataset.section);
    if (l.dataset.section === "workspace") window.scrollTo({ top: 0, behavior: "smooth" });
    else target.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(l.dataset.section);
  }));
  document.querySelectorAll(".rail-link[data-open-tab]").forEach((b) => b.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    bus.emit("show-tab", b.dataset.openTab);
    setActive("workspace");
  }));
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => e.isIntersecting && setActive(e.target.id));
    }, { rootMargin: "-45% 0px -50% 0px" });
    ["workspace", "smartHome"].forEach((id) => $(id) && io.observe($(id)));
  }
}

export function setProgramName(name) {
  const el = $("programName");
  if (!el) return;
  const file = (name || "untitled").trim().replace(/\s+/g, "_").toLowerCase();
  el.textContent = file.endsWith(".iot") ? file : file + ".iot";
  document.title = `${el.textContent} · Kelvin Studio`;
}

export function initShell() {
  initSplitter();
  initRail();
}
