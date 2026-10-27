// grammar.js — the Language tab: the scanner's DFA, the grammar in BNF,
// FIRST/FOLLOW sets and the LL(1) parse table (all computed by the C++ compiler).

import { $, escapeHtml } from "./util.js";
import { state } from "./state.js";
import { renderDfa } from "./graph.js";

const sym = (s) => `<span class="${/^[a-z_]+$/.test(s) && !["id", "num"].includes(s) ? "g-nt" : "g-t"}">${escapeHtml(s)}</span>`;

export function renderLanguage() {
  const lang = state.language;
  if (!lang) return;
  const g = lang.grammar;
  renderDfa($("dfaView"), lang.dfa);

  $("llBadge").className = "ll-badge" + (g.conflicts.length ? " bad" : "");
  $("llBadge").innerHTML = g.conflicts.length
    ? `${g.conflicts.length} LL(1) conflicts`
    : `<b>LL(1)</b> no conflicts · ${g.productions.length} productions · ${g.nonterminals.length} nonterminals · ${g.terminals.length} terminals`;

  // Productions, grouped by left-hand side.
  let html = "";
  g.nonterminals.forEach((nt) => {
    const prods = g.productions.map((p, i) => ({ p, i })).filter((x) => x.p.lhs === nt);
    html += `<div class="prod" data-nt="${nt}"><span class="prod-lhs">${sym(nt)}</span><span class="prod-arrow">→</span><span class="prod-rhs">` +
      prods.map(({ p, i }) => `<span class="prod-alt" data-p="${i}"><small>${i}</small>${p.rhs.length ? p.rhs.map(sym).join(" ") : '<span class="g-eps">ε</span>'}</span>`).join('<span class="prod-bar">|</span>') +
      `</span><span class="prod-fn">${escapeHtml(g.functions[nt] || "")}</span></div>`;
  });
  $("productions").innerHTML = html;

  // FIRST / FOLLOW.
  $("firstFollow").innerHTML =
    "<thead><tr><th>Nonterminal</th><th>FIRST</th><th>FOLLOW</th></tr></thead><tbody>" +
    g.nonterminals.map((nt) =>
      `<tr data-nt="${nt}"><td>${sym(nt)}</td><td>{ ${g.first[nt].map(escapeHtml).join(", ")} }</td><td>{ ${g.follow[nt].map(escapeHtml).join(", ")} }</td></tr>`
    ).join("") + "</tbody>";

  // LL(1) table matrix.
  const cells = {};
  g.table.forEach(([nt, t, p]) => ((cells[nt + "|" + t] = cells[nt + "|" + t] || []).push(p)));
  const used = g.terminals.filter((t) => g.nonterminals.some((nt) => cells[nt + "|" + t]));
  $("llTable").innerHTML =
    `<thead><tr><th class="corner">M[A, a]</th>${used.map((t) => `<th>${escapeHtml(t)}</th>`).join("")}</tr></thead><tbody>` +
    g.nonterminals.map((nt) =>
      `<tr><th>${escapeHtml(nt)}</th>` +
      used.map((t) => {
        const c = cells[nt + "|" + t];
        if (!c) return "<td></td>";
        const p = g.productions[c[0]];
        const title = `${nt} → ${p.rhs.length ? p.rhs.join(" ") : "ε"}`;
        return `<td class="${c.length > 1 ? "conflict" : p.rhs.length ? "" : "eps"}" data-p="${c.join(",")}" title="${escapeHtml(title)}">${c.join("/")}</td>`;
      }).join("") + "</tr>"
    ).join("") + "</tbody>";
}

export function initLanguage() {
  // Hovering a table cell highlights its production.
  $("llTable").addEventListener("mouseover", (e) => {
    const td = e.target.closest("td[data-p]");
    document.querySelectorAll(".prod-alt.hot").forEach((x) => x.classList.remove("hot"));
    if (!td) return;
    td.dataset.p.split(",").forEach((p) => {
      const alt = document.querySelector(`.prod-alt[data-p="${p}"]`);
      if (alt) alt.classList.add("hot");
    });
  });
  $("llTable").addEventListener("mouseleave", () => document.querySelectorAll(".prod-alt.hot").forEach((x) => x.classList.remove("hot")));
}
