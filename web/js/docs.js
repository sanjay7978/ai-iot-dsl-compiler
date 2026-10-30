// docs.js — the documentation page: live grammar and DFA from the compiler,
// the AI status, a highlighted sample program and the table-of-contents highlight.

import { initSite } from "./site.js";
import { getJson, escapeHtml } from "./util.js";
import { highlightDsl } from "./highlight.js";
import { renderDfa } from "./graph.js";

const $ = (id) => document.getElementById(id);

initSite();

const SAMPLE = `# Smart home automation rules
SENSOR temperature : NUMBER
SENSOR door        : STATE
SENSOR motion      : STATE
DEVICE fan, light, ac

# Cool the room, otherwise switch the fan off
IF temperature > 30 AND door == OPEN
THEN turn_on(fan)
ELSE IF temperature > 26
THEN set_level(fan, 50)
ELSE turn_off(fan)

# AND binds tighter than OR
IF motion == ON OR temperature >= 35
THEN turn_on(light)
     set_level(ac, 22.5)
`;
$("sampleProgram").innerHTML = highlightDsl(SAMPLE);

const sym = (s) => `<span class="${/^[a-z_]+$/.test(s) && !["id", "num"].includes(s) ? "g-nt" : "g-t"}">${escapeHtml(s)}</span>`;

getJson("/api/language").then((lang) => {
  const g = lang.grammar;
  $("llLine").textContent = g.conflicts.length
    ? `${g.conflicts.length} LL(1) conflicts found`
    : `✓ LL(1): ${g.productions.length} productions, ${g.nonterminals.length} nonterminals, ${g.terminals.length} terminals, no conflicts`;
  $("docGrammar").innerHTML = g.nonterminals.map((nt) => {
    const alts = g.productions.filter((p) => p.lhs === nt).map((p) => (p.rhs.length ? p.rhs.map(sym).join(" ") : '<span class="g-eps">ε</span>'));
    return `<div class="g-row"><span>${sym(nt)}</span><span class="g-arrow">→</span><span>${alts.join(' <span class="g-bar">|</span> ')}</span></div>`;
  }).join("");
  renderDfa($("docDfa"), lang.dfa);
}).catch(() => {
  $("docGrammar").innerHTML = '<p class="muted">Start the compiler server (<code class="inline">make run</code>) to load the grammar.</p>';
  $("docDfa").innerHTML = '<p class="muted">Start the compiler server to draw the DFA.</p>';
});

getJson("/api/ai-status").then((s) => {
  $("docsAi").innerHTML = `<i class="led"></i>Active right now: ${escapeHtml(s.mode === "llm" ? `${s.provider} · ${s.model}` : "Offline rules")}`;
}).catch(() => { $("docsAi").innerHTML = '<i class="led"></i>Server not running'; });

// Highlight the section being read in the sidebar.
const links = Array.from(document.querySelectorAll("#docsToc a"));
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (!e.isIntersecting) return;
    links.forEach((a) => a.classList.toggle("current", a.getAttribute("href") === "#" + e.target.id));
  });
}, { rootMargin: "-20% 0px -70% 0px" });
document.querySelectorAll(".docs-main section[id]").forEach((s) => io.observe(s));
