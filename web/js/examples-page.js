// examples-page.js — the examples gallery. Every example is compiled by the real
// compiler when the page loads; "Open in Studio" passes the program in the link.

import { initSite } from "./site.js";
import { getJson, postJson, escapeHtml, copyText, toast } from "./util.js";
import { highlightDsl } from "./highlight.js";
import { encodeProgram } from "./share.js";

const $ = (id) => document.getElementById(id);
initSite();

const pretty = (name) => name.replace(/^\d+_/, "").replace(/_/g, " ");

// The first comment line of an example is its description.
function describe(source) {
  const lines = source.split("\n").filter((l) => l.trim().startsWith("#")).map((l) => l.replace(/^\s*#\s?/, ""));
  return lines[0] || "";
}

function tagsFor(r) {
  const tags = [];
  if (r.stats.errors) {
    const phases = [...new Set(r.errors.filter((e) => e.severity !== "warning").map((e) => e.phase))];
    phases.forEach((p) => tags.push({ cls: "err", text: `${p} errors`, key: "errors" }));
  } else tags.push({ cls: "ok", text: "compiles", key: "valid" });
  if (r.stats.warnings) tags.push({ cls: "warn", text: `${r.stats.warnings} warnings`, key: "warnings" });
  if (r.stats.irAfter < r.stats.irBefore) tags.push({ cls: "", text: `optimized ${r.stats.irBefore}→${r.stats.irAfter}`, key: "optimized" });
  return tags;
}

let cards = [];
let filter = "all";

function draw() {
  const shown = cards.filter((c) => filter === "all" || c.tags.some((t) => t.key === filter));
  $("gallery").innerHTML = shown.map((c, i) => `
    <article class="ex-card" style="--i:${i}">
      <div class="ex-head">
        <div><h3>${escapeHtml(pretty(c.name))}</h3><p>${escapeHtml(c.description)}</p></div>
        <span class="ex-num">${escapeHtml(c.name.split("_")[0])}</span>
      </div>
      <div class="ex-tags">${c.tags.map((t) => `<span class="tag ${t.cls}">${escapeHtml(t.text)}</span>`).join("")}</div>
      <pre class="ex-code">${highlightDsl(c.source)}</pre>
      <div class="ex-stats">
        <span><b>${c.result.stats.tokens}</b>tokens</span>
        <span><b>${c.result.stats.rules}</b>rules</span>
        <span><b>${c.result.stats.timeMs.toFixed(2)}</b>ms</span>
      </div>
      <div class="ex-foot">
        <button class="link-btn" type="button" data-copy="${c.name}">Copy source</button>
        <a class="btn btn-primary" href="${c.link}">Open in Studio
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>
      </div>
    </article>`).join("") || '<p class="gallery-empty">No examples match this filter.</p>';
  $("gallery").querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    const c = cards.find((x) => x.name === b.dataset.copy);
    toast((await copyText(c.source)) ? "Source copied" : "Could not copy", "");
  }));
}

function drawFilters() {
  const count = (key) => cards.filter((c) => c.tags.some((t) => t.key === key)).length;
  const items = [["all", "All", cards.length], ["valid", "Compiles", count("valid")], ["errors", "Has errors", count("errors")],
    ["warnings", "Rule warnings", count("warnings")], ["optimized", "Optimized", count("optimized")]];
  $("filters").innerHTML = items.map(([k, label, n]) => `<button type="button" class="filter${k === filter ? " active" : ""}" data-f="${k}">${label}<span>${n}</span></button>`).join("");
  $("filters").querySelectorAll(".filter").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.f; drawFilters(); draw(); }));
}

(async function start() {
  try {
    const examples = await getJson("/api/examples");
    cards = await Promise.all(examples.map(async (ex) => {
      const result = await postJson("/api/compile", { source: ex.source });
      return { ...ex, result, description: describe(ex.source), tags: tagsFor(result), link: "studio.html#p=" + (await encodeProgram(ex.source)) + "&n=" + ex.name.replace(/^\d+_/, "") };
    }));
    drawFilters();
    draw();
  } catch (e) {
    $("gallery").innerHTML = '<p class="gallery-empty">The examples are compiled by the local server. Start it with <code class="inline">make run</code> and reload this page.</p>';
  }
})();
