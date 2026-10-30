# IoT DSL Compiler

An AI-assisted compiler for a small rule language for IoT automation, written by hand in C++17.

```
SENSOR temperature : NUMBER
SENSOR outside : NUMBER
SENSOR window : STATE
DEVICE heater, vent

IF window == OPEN THEN turn_off(heater)
ELSE IF temperature < 18 THEN set_level(heater, (22 - temperature) * 10)
ELSE turn_off(heater)

IF temperature - outside > 5 THEN turn_on(vent)
```

All seven compiler phases are implemented:
1. lexical analysis
2. syntax analysis
3. abstract syntax tree
4. semantic analysis (symbol table, type checks, and rule analysis that finds impossible conditions, unreachable branches and conflicting rules)
5. three-address intermediate code
6. optimization on basic blocks and a control-flow graph, using liveness and available-expressions dataflow analysis
7. code generation for C, Arduino/ESP32, Python and JavaScript

Around the compiler:
- **Compiler X-ray**: an animated replay of the compilation, from the scanner DFA through the parser call stack to optimizer passes and code generation.
- **Language tab**: the scanner DFA, FIRST/FOLLOW sets and the LL(1) parse table, which the compiler computes from its own grammar.
- **Smart-home digital twin**: runs the compiled code, with a 24-hour closed-loop simulation.
- **Smart editor**: live compile, autocomplete, hover info and quick fixes.
- **Free AI assistant**: English or voice to DSL, explanations and fixes. The compiler checks everything it writes.
- **Demo tools**: presentation mode, share links, a PDF report, and a **phone remote** connected with a QR code.
See [docs/DESIGN.md](docs/DESIGN.md) for the full design.

## Requirements

- A C/C++ compiler (`g++`/`clang++` and `cc`)
- Python 3 (standard library only)
- Optional, for AI: [Ollama](https://ollama.com) running locally, or a free Groq or Gemini API key. Without one, a built-in offline converter is used.

## Run the web interface

```bash
make run
```

Then open http://127.0.0.1:8000.

The website ("Kelvin") has five pages:
- **Home** (`/`): a live compiler demo in the hero, the seven phases with real figures, and numbers measured from the project.
- **Studio** (`/studio.html`): the compiler workbench, described below.
- **Docs** (`/docs.html`): language reference, live grammar and DFA, targets, error catalogue, AI setup, CLI.
- **Examples** (`/examples.html`): every example, compiled when the page loads, with "Open in Studio".
- **About** (`/about.html`): motivation, architecture and team. The team list is in `web/js/about.js`.

In the Studio:
- **Describe a rule in English** and press **Convert to DSL**. The result is checked by the compiler before you add it to the editor.
- Choose an example or type a program, then press **Compile** (Ctrl/⌘ + Enter).
- Each phase in the phase strip shows whether it passed. Click a phase to open its output.
- **Watch it compile** opens the Compiler X-ray. **Present** starts a guided tour for presenting.
- **Tabs:**
  - Overview (summary and charts of the last compile)
  - Tokens
  - Syntax tree (graph or list)
  - Language (DFA, grammar, FIRST/FOLLOW, LL(1) table)
  - Symbols
  - IR (original, optimized, time machine, CFG)
  - Code (C, Arduino, Python, JavaScript, with Run and Download)
  - Problems (with quick fixes, Explain and AI fix)
- **Smart home**: change sensors by hand, or press **Play a day**.
- Hovering in any pane highlights the matching parts everywhere else.
- Drag the bar between the editor and the output to resize them (double-click resets).
- **Ctrl/⌘ + K** lists every command.
- The button in the top-right corner switches between light and dark mode.

### Phone remote

```bash
make remote
```

Then press **Phone remote** in the page and scan the QR code with a phone on the same Wi-Fi.

### AI settings (optional, all free)

Copy `.env.example` to `.env` and set one of the following:
- `GROQ_API_KEY`
- `GEMINI_API_KEY`
- `OLLAMA_MODEL`

With nothing set, a running Ollama is detected automatically. If none is found, the offline converter is used.

## Command line

```bash
make
./iotc examples/02_smart_home.iot              # every phase
./iotc examples/07_optimization.iot --ir --opt # IR before and after optimization
./iotc examples/09_thermostat.iot --cfg        # basic blocks, CFG edges, liveness
./iotc examples/08_rule_analysis.iot           # impossible conditions, conflicts
./iotc examples/06_semantic_error.iot          # semantic errors
./iotc examples/01_basic.iot --c               # generated C only
./iotc examples/09_thermostat.iot --target arduino   # also: python, js
./iotc examples/09_thermostat.iot --english    # the program in plain English
./iotc --grammar                               # FIRST/FOLLOW sets and LL(1) table
make demo FILE=examples/09_thermostat.iot ARGS="window=CLOSED temperature=15 outside=10"
make test                                      # all tests
```

## Project layout

```
src/        C++ compiler (lexer, parser, AST, semantic, IR, optimizer, codegen, driver)
runtime/    C runtime linked with generated programs
web/        Website and Studio (HTML, CSS, JavaScript, no frameworks; fonts bundled in web/fonts)
tools/      project_stats.py: writes the real numbers shown on the website (run by make test)
server.py   Local server: compiles, runs generated C, forwards AI requests
ai.py       AI assistant (Groq / Gemini / Ollama / offline), standard library only
examples/   Sample programs
tests/      Test script and AI unit tests
docs/       Design document and demo script
```
