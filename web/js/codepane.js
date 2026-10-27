// codepane.js — the Code tab: one optimized IR, four target languages.

import { $, escapeHtml, postJson, download, copyText, toast } from "./util.js";
import { state, fresh } from "./state.js";
import { highlightCode } from "./highlight.js";

const RUNNABLE = { c: "Build & run", python: "Run with Python", js: "Run with Node.js" };

export function renderCode() {
  const r = state.result;
  const has = r && r.targets && r.targets.length;
  $("codeEmpty").hidden = !!has;
  $("codeBody").hidden = !has;
  if (!has) return;
  const t = r.targets.find((x) => x.id === state.target) || r.targets[0];
  document.querySelectorAll(".seg[data-target]").forEach((b) => b.classList.toggle("active", b.dataset.target === t.id));
  $("runCode").hidden = !RUNNABLE[t.id];
  $("runCode").textContent = RUNNABLE[t.id] || "";
  $("codeFile").textContent = t.fileName;
  $("runOutput").hidden = true;

  const lines = t.code.replace(/\n$/, "").split("\n");
  let inComment = false;
  $("codeLines").innerHTML = lines
    .map((line, i) => {
      const map = t.lines[i] || [-1, 0, 0, 0, 0];
      const trimmed = line.trim();
      // Multi-line /* ... */ header comments are coloured line by line.
      let html;
      if (inComment || trimmed.startsWith("/*")) {
        html = `<span class="c-comment">${escapeHtml(line)}</span>`;
        inComment = !trimmed.endsWith("*/");
      } else {
        html = highlightCode(line, t.id);
      }
      const src = map[1] ? `${map[1]},${map[2]},${map[3]},${map[4]}` : "";
      return `<li data-src="${src}"${src ? ' class="mapped"' : ""}><span class="ln">${i + 1}</span><span class="ins">${html || " "}</span></li>`;
    })
    .join("");
}

export function initCode() {
  document.querySelectorAll(".seg[data-target]").forEach((b) =>
    b.addEventListener("click", () => {
      state.target = b.dataset.target;
      renderCode();
    })
  );
  $("copyCode").addEventListener("click", async () => {
    const t = state.result && state.result.targets.find((x) => x.id === state.target);
    if (t && (await copyText(t.code))) toast("Copied " + t.fileName);
  });
  $("downloadCode").addEventListener("click", () => {
    const t = state.result && state.result.targets.find((x) => x.id === state.target);
    if (t) download(t.fileName, t.code);
  });
  $("runCode").addEventListener("click", async () => {
    if (!fresh()) return toast("Compile the program first");
    const btn = $("runCode");
    const out = $("runOutput");
    btn.classList.add("busy");
    btn.disabled = true;
    out.hidden = false;
    out.className = "run-output";
    out.innerHTML = "<pre>Building and running the generated program…</pre>";
    try {
      const sensors = state.result.symbols.filter((s) => s.kind === "sensor").map((s) => s.name);
      const inputs = Object.fromEntries(sensors.filter((n) => n in state.simInputs).map((n) => [n, state.simInputs[n]]));
      const d = await postJson("/api/run", { source: state.compiledSource, inputs, target: state.target });
      if (!d.ok) throw new Error(d.error);
      out.innerHTML =
        `<div class="cmd">$ ${d.commands.map(escapeHtml).join("<br>$ ")}</div>` +
        `<pre>${escapeHtml(d.output + (d.stderr ? "\n" + d.stderr : ""))}</pre>`;
    } catch (e) {
      out.className = "run-output bad";
      out.innerHTML = `<pre>${escapeHtml(e.message)}</pre>`;
    } finally {
      btn.classList.remove("busy");
      btn.disabled = false;
    }
  });
}
