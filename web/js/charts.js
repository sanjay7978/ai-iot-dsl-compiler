// charts.js — the Overview tab: a summary of the last compile drawn from the
// compiler's own result (phases, token categories, optimizer passes, problems).

import { $, bus, escapeHtml } from "./util.js";

const PHASE_TAB = { lexer: "tokens", parser: "problems", ast: "ast", semantic: "symbols", ir: "ir", optimizer: "ir", codegen: "code" };
const CATEGORY_COLOUR = {
  keyword: "var(--syn-kw)", identifier: "var(--ink-2)", number: "var(--syn-num)", state: "var(--syn-state)",
  operator: "var(--syn-op)", punctuation: "var(--line-strong)", type: "var(--cool)", error: "var(--error)",
};

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function countNodes(n) { return n ? 1 + (n.children || []).reduce((a, c) => a + countNodes(c), 0) : 0; }

// Short metric shown under each pipeline step after a compile.
export function phaseMetrics(r) {
  const errs = (phase) => r.errors.filter((e) => e.phase === phase && e.severity !== "warning").length;
  const c = r.targets && r.targets.find((t) => t.id === "c");
  return {
    lexer: errs("lexical") ? plural(errs("lexical"), "error") : plural(r.stats.tokens, "token"),
    parser: errs("syntax") ? plural(errs("syntax"), "error") : r.ast ? "LL(1) ✓" : "–",
    ast: !r.ast ? "not built" : r.phases.find((p) => p.id === "ast").status === "ok" ? plural(countNodes(r.ast), "node") : "incomplete",
    semantic: errs("semantic") ? plural(errs("semantic"), "error") : r.stats.warnings ? plural(r.stats.warnings, "warning") : r.ast ? plural(r.symbols.length, "symbol") : "not run",
    ir: r.ir.length ? plural(r.stats.irBefore, "instr") : "not run",
    optimizer: r.ir.length ? `${r.stats.irBefore} → ${r.stats.irAfter}` : "not run",
    codegen: c ? `${c.code.trimEnd().split("\n").length} lines C` : "not run",
  };
}

export function renderOverview(r) {
  const body = $("overviewBody");
  if (!body) return;
  $("overviewEmpty").hidden = !!r;
  body.hidden = !r;
  if (!r) { body.innerHTML = ""; return; }

  const ok = r.stats.errors === 0;
  const metrics = phaseMetrics(r);
  const cats = {};
  r.tokens.forEach((t) => (cats[t.category] = (cats[t.category] || 0) + 1));
  const catList = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const passes = (r.optimization && r.optimization.passes) || [];
  const maxPass = Math.max(1, ...passes.map((p) => p.count));
  const problems = r.errors.slice(0, 6);
  const maxIr = Math.max(1, r.stats.irBefore);

  body.innerHTML = `
    <div class="ov-card wide">
      <div class="ov-verdict">
        <div>
          <div class="big ${ok ? "ok" : "bad"}">${ok ? (r.stats.warnings ? "Compiled, with warnings" : "Compiled") : plural(r.stats.errors, "error")}</div>
          <p>${ok ? `All seven phases ran in ${r.stats.timeMs.toFixed(3)} ms (time measured inside the compiler).` : `Stopped in ${escapeHtml((r.phases.find((p) => p.status === "error") || {}).name || "a phase")}. Open Problems for quick fixes.`}</p>
        </div>
      </div>
      <div class="ov-kpis">
        <div><b>${r.stats.tokens}</b><span>tokens</span></div>
        <div><b>${r.stats.rules}</b><span>${r.stats.rules === 1 ? "rule" : "rules"}</span></div>
        <div><b>${r.symbols.length}</b><span>symbols</span></div>
        <div><b>${r.ir.length ? `${r.stats.irBefore}→${r.stats.irAfter}` : "–"}</b><span>IR instructions</span></div>
      </div>
    </div>

    <div class="ov-card">
      <h3>Phases</h3>
      <ol class="ov-phases">
        ${r.phases.map((p) => `<li class="${p.status}" data-tab="${PHASE_TAB[p.id]}" title="Open ${escapeHtml(p.name)}"><i>${p.status === "ok" ? "✓" : p.status === "error" ? "!" : ""}</i><span>${escapeHtml(p.name)}</span><span>${escapeHtml(metrics[p.id] || "")}</span></li>`).join("")}
      </ol>
    </div>

    <div class="ov-card">
      <h3>Tokens by category <span>${r.tokens.length}</span></h3>
      ${r.tokens.length ? `<div class="stack-bar">${catList.map(([c, n]) => `<span style="flex-grow:${n};background:${CATEGORY_COLOUR[c] || "var(--faint)"}" title="${c}: ${n}"></span>`).join("")}</div>
      <div class="stack-legend">${catList.map(([c, n]) => `<span><i style="background:${CATEGORY_COLOUR[c] || "var(--faint)"}"></i>${c} ${n}</span>`).join("")}</div>` : '<p class="ov-none">No tokens.</p>'}
      <h3 style="margin-top:20px">Instructions <span>before → after</span></h3>
      ${r.ir.length ? `<div class="ov-shrink">
        <div><b style="height:${(r.stats.irBefore / maxIr) * 100}%"></b><span>${r.stats.irBefore} before</span></div>
        <div><b style="height:${(r.stats.irAfter / maxIr) * 100}%"></b><span>${r.stats.irAfter} after</span></div>
      </div>` : '<p class="ov-none">No intermediate code: the program has errors.</p>'}
    </div>

    <div class="ov-card">
      <h3>Optimizer passes <span>changes made</span></h3>
      ${passes.length ? `<div class="ov-bars">${passes.map((p) => `<div class="ov-bar${p.count ? "" : " zero"}" title="${escapeHtml(p.description || "")}"><span>${escapeHtml(p.name)}</span><span>${p.count}</span><i><b style="width:${(p.count / maxPass) * 100}%"></b></i></div>`).join("")}</div>`
        : `<p class="ov-none">${r.ir.length ? "Nothing to optimize: the code was already minimal." : "The optimizer did not run."}</p>`}
    </div>

    <div class="ov-card">
      <h3>Problems <span>${r.errors.length}</span></h3>
      ${problems.length ? `<ul class="ov-list">${problems.map((e) => `<li class="${e.severity}" data-tab="problems"><b>${e.severity}</b>line ${e.line}: ${escapeHtml(e.message)}</li>`).join("")}</ul>`
        : '<p class="ov-none">No errors and no warnings. Rule analysis found no impossible conditions and no conflicting rules.</p>'}
    </div>`;

  body.querySelectorAll("[data-tab]").forEach((el) => el.addEventListener("click", () => bus.emit("show-tab", el.dataset.tab)));
}
