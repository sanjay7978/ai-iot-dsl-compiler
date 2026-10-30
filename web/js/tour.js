// tour.js — presentation mode: a guided tour with a spotlight and captions that
// walks through every phase on the projector.

import { $, bus, sleep } from "./util.js";

// Each step: what to highlight, what to say, and what to do on the page first.
const STEPS = [
  { sel: ".topbar", title: "An AI-assisted compiler for IoT rules",
    text: "Users write automation rules in our small language, and our compiler, written by hand in C++, checks them and turns them into real code. The AI only helps; the compiler does the work.",
    act: () => bus.emit("load-example", "01_basic") },
  { sel: ".assistant", title: "Describe a rule in English (or speak it)",
    text: "A free AI model turns English into our language. Everything it writes is compiled and checked before it can be used. The microphone accepts speech.",
    act: () => { $("aiInput").value = "If the temperature is above 30 and the door is open, turn on the fan"; } },
  { sel: ".pipeline", title: "Seven compiler phases",
    text: "Lexer, parser, syntax tree, semantic analysis, intermediate code, optimizer and code generator. Each phase shows what it produced, such as the number of tokens or instructions. Blue means passed, red means errors, and a dashed circle means the phase was not reached. Click any phase to open its output." },
  { sel: "#xrayBtn", title: "Compiler X-ray",
    text: "This plays the compilation step by step using the compiler's real traces: the DFA scanning characters, the parser's call stack, the optimizer passes and code generation. Press Next to start it.",
    act: () => {} },
  { sel: null, title: "Watching the compiler work", text: "Space pauses, the arrow keys step, and the phase buttons jump. Close the X-ray (Esc) to continue the tour.",
    act: () => bus.emit("open-xray"), wait: "xray-closed" },
  { sel: ".editor-panel", title: "A smart editor",
    text: "The program compiles as you type. Hover a name to see its type and declaration; autocomplete suggests keywords, sensors, devices and actions; problems are underlined." },
  { sel: ".output-panel", tab: "ast", title: "The syntax tree",
    text: "The parser's output drawn as a tree. Hover a node and the matching source, tokens, IR and C lines light up together: every phase keeps a source map." },
  { sel: ".output-panel", tab: "language", title: "The language itself",
    text: "The scanner's DFA, and the grammar's FIRST and FOLLOW sets with the LL(1) parse table, computed by the compiler. No table cell has two productions, which proves the grammar is LL(1)." },
  { sel: ".output-panel", tab: "problems", title: "Semantic and rule analysis",
    text: "Here the compiler reasons about meaning: impossible conditions, always-true conditions, ELSE IFs that can never run, and two rules fighting over the same device, with example sensor values.",
    act: () => bus.emit("load-example", "08_rule_analysis") },
  { sel: ".output-panel", tab: "ir", ir: "machine", title: "Optimizer time machine",
    text: "Three-address code before and after optimization. Step through each pass: constant folding, algebraic simplification, common sub-expressions, dead and unreachable code.",
    act: () => bus.emit("load-example", "07_optimization") },
  { sel: ".output-panel", tab: "ir", ir: "cfg", title: "Basic blocks and the control-flow graph",
    text: "The optimizer works on this graph. Liveness and available-expressions dataflow analyses decide what can be removed or reused.",
    act: () => bus.emit("load-example", "09_thermostat") },
  { sel: ".output-panel", tab: "code", title: "One compiler, four targets",
    text: "The same optimized IR becomes C, Arduino/ESP32 firmware, Python and JavaScript. Build & run compiles the C with a real C compiler." },
  { sel: "#smartHome", title: "The program running in a smart home",
    text: "A digital twin driven by the compiled code. Play a 24-hour day: sensors follow realistic curves, heaters warm the room, and conflicts between rules show up in red.",
    act: () => bus.emit("play-day") },
  { sel: ".top-actions", title: "Share, report and phone remote",
    text: "Share puts the program in a link. Report prints every phase as a PDF. Phone remote turns any phone on the same Wi-Fi into the sensor panel." },
];

let index = -1;
let waiting = null;

function place() {
  const step = STEPS[index];
  const spot = $("tourSpot"), card = $("tourCard");
  const target = step.sel ? document.querySelector(step.sel) : null;
  if (target) {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  setTimeout(() => {
    if (target) {
      const r = target.getBoundingClientRect();
      Object.assign(spot.style, { display: "block", left: r.left - 8 + "px", top: r.top - 8 + "px", width: r.width + 16 + "px", height: r.height + 16 + "px" });
      const below = r.bottom + 16 + card.offsetHeight < window.innerHeight;
      card.style.top = (below ? r.bottom + 16 : Math.max(16, r.top - card.offsetHeight - 16)) + "px";
      card.style.left = Math.min(window.innerWidth - card.offsetWidth - 16, Math.max(16, r.left)) + "px";
    } else {
      spot.style.display = "none";
      card.style.top = window.innerHeight / 2 - card.offsetHeight / 2 + "px";
      card.style.left = window.innerWidth / 2 - card.offsetWidth / 2 + "px";
    }
  }, target ? 380 : 0);
}

async function show(i) {
  index = i;
  const step = STEPS[i];
  $("tourTitle").textContent = step.title;
  $("tourText").textContent = step.text;
  $("tourCount").textContent = `${i + 1} / ${STEPS.length}`;
  $("tourPrev").disabled = i === 0;
  $("tourNext").textContent = i === STEPS.length - 1 ? "Finish" : "Next";
  if (step.act) step.act();
  if (step.tab) { await sleep(250); bus.emit("show-tab", step.tab); }
  if (step.ir) bus.emit("ir-view", step.ir);
  if (step.wait) {
    $("tour").classList.add("hidden-for-wait");
    waiting = step.wait;
    return;
  }
  place();
}

export function startTour() {
  $("tour").hidden = false;
  document.body.classList.add("touring");
  show(0);
}

function endTour() {
  $("tour").hidden = true;
  document.body.classList.remove("touring");
  index = -1;
}

export function initTour() {
  $("tourNext").addEventListener("click", () => (index >= STEPS.length - 1 ? endTour() : show(index + 1)));
  $("tourPrev").addEventListener("click", () => index > 0 && show(index - 1));
  $("tourExit").addEventListener("click", endTour);
  document.addEventListener("keydown", (e) => {
    if ($("tour").hidden || waiting) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); index >= STEPS.length - 1 ? endTour() : show(index + 1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); index > 0 && show(index - 1); }
    else if (e.key === "Escape") endTour();
  });
  window.addEventListener("resize", () => index >= 0 && !waiting && place());
  bus.on("xray-closed", () => {
    if (waiting !== "xray-closed") return;
    waiting = null;
    $("tour").classList.remove("hidden-for-wait");
    show(index + 1);
  });
}
