// palette.js — the command palette (Ctrl/⌘ + K): every action, searchable.

import { $, escapeHtml } from "./util.js";

let commands = [];
let shown = [];
let active = 0;

export function setCommands(list) {
  commands = list;
}

function render(q) {
  const query = q.trim().toLowerCase();
  shown = commands.filter((c) => !query || (c.title + " " + (c.group || "")).toLowerCase().includes(query)).slice(0, 12);
  active = 0;
  $("paletteList").innerHTML = shown
    .map((c, i) => `<li role="option" data-i="${i}" class="${i === 0 ? "active" : ""}"><span>${escapeHtml(c.title)}</span><small>${escapeHtml(c.group || "")}</small></li>`)
    .join("") || '<li class="none">No matching command</li>';
}

export function openPalette() {
  $("palette").hidden = false;
  $("paletteInput").value = "";
  render("");
  $("paletteInput").focus();
}

function close() {
  $("palette").hidden = true;
}

function run(i) {
  const c = shown[i];
  close();
  if (c) c.run();
}

export function initPalette() {
  $("paletteBtn").addEventListener("click", openPalette);
  $("paletteInput").addEventListener("input", (e) => render(e.target.value));
  $("paletteInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % Math.max(1, shown.length);
      $("paletteList").querySelectorAll("li").forEach((li, i) => li.classList.toggle("active", i === active));
    } else if (e.key === "Enter") { e.preventDefault(); run(active); }
    else if (e.key === "Escape") close();
  });
  $("paletteList").addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) { e.preventDefault(); run(+li.dataset.i); }
  });
  $("palette").addEventListener("click", (e) => e.target === $("palette") && close());
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("palette").hidden ? openPalette() : close(); }
  });
}
