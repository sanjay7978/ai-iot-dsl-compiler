// about.js — the About page: real project numbers and the team list.

import { initSite, projectStats, countUp } from "./site.js";
import { escapeHtml } from "./util.js";

// ---- Edit the team here -------------------------------------------------------------
// Replace the placeholders with real names, roll numbers and roles. Remove
// `placeholder: true` from an entry once it is filled in.
const TEAM = [
  { name: "Team member 1", detail: "Roll number · role", placeholder: true },
  { name: "Team member 2", detail: "Roll number · role", placeholder: true },
  { name: "Team member 3", detail: "Roll number · role", placeholder: true },
];
const GUIDE = { name: "Faculty guide", detail: "Department of Computer Science", placeholder: true };
// --------------------------------------------------------------------------------------

initSite();

const initials = (n) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const card = (m, role) => `<div class="member${m.placeholder ? " placeholder" : ""}"><span class="avatar" aria-hidden="true">${escapeHtml(initials(m.name))}</span>` +
  `<b>${escapeHtml(m.name)}</b><span>${escapeHtml(role ? role + " · " + m.detail : m.detail)}</span></div>`;
document.getElementById("teamGrid").innerHTML = TEAM.map((m) => card(m)).join("") + card(GUIDE, "Guide");
if ([...TEAM, GUIDE].some((m) => m.placeholder)) {
  document.getElementById("teamNote").textContent = "Placeholder entries: edit the TEAM list at the top of web/js/about.js.";
}

projectStats().then((s) => {
  if (!s) return;
  const values = {
    lines: s.compiler.lines, tests: s.tests.total ?? s.tests.python, productions: s.grammar.productions,
    dfa: s.dfaStates, examples: s.examples.length, web: s.web.lines,
  };
  document.querySelectorAll("#facts [data-f]").forEach((el) => countUp(el, values[el.dataset.f] || 0));
});
