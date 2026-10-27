// state.js — the page's shared state.

export const state = {
  result: null,           // last JSON returned by the compiler
  compiledSource: null,   // the source text that produced `result`
  traceResult: null,      // compile result with scanner/parser traces (X-ray)
  language: null,         // scanner DFA + grammar analysis (static)
  examples: [],
  exampleName: "",
  hover: null,            // {start, end} offsets highlighted in the editor
  link: null,             // linked spans [{start,end}] from cross-pane hovering
  activeTab: "tokens",
  astView: "graph",       // graph | list
  irView: "original",     // original | optimized | machine | cfg
  target: "c",
  live: true,             // compile while typing
  simInputs: {},          // sensor name -> value, kept across recompiles
  manualSensors: false,   // the user (or a phone) set sensors by hand: pause the day player
  explanations: {},       // problem index -> explanation
};

export const fresh = () => state.result && state.compiledSource === document.getElementById("source").value;
