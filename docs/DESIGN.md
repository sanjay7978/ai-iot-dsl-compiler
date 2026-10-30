# IoT DSL Compiler — Design

## 1. Overview

This project is an AI-assisted compiler for a small domain-specific language (DSL) for IoT automation rules.

```
English ──AI assistant──► IoT DSL
IoT DSL ─► Lexer ─► Parser ─► AST ─► Semantic analysis ─► Intermediate code
        ─► Optimizer ─► C code generator ─► C program (+ runtime library)
```

The AI only helps the user. It turns English into DSL text and explains compiler messages.
Everything the AI writes still goes through the compiler, so the AI can never bypass the compiler's checks.
The compiler itself is written by hand in C++17, without generator tools such as Lex or Yacc.

| # | Phase | Source | Output |
|---|-------|--------|--------|
| 1 | Lexical analysis | `src/lexer.cpp` | Tokens with line:column positions |
| 2 | Syntax analysis | `src/parser.cpp` | Grammar check, syntax errors, error recovery |
| 3 | AST construction | `src/ast.cpp` | Abstract syntax tree |
| 4 | Semantic analysis | `src/semantic.cpp`, `src/rule_analysis.cpp` | Symbol table, types, declaration errors, rule analysis warnings |
| 5 | Intermediate code | `src/ir.cpp` | Three-address code |
| 6 | Optimization | `src/cfg.cpp`, `src/optimizer.cpp` | Basic blocks, CFG, dataflow analyses, optimized code and a report |
| 7 | Code generation | `src/codegen.cpp` | C, Arduino/ESP32, Python and JavaScript (`runtime/` supplies sensors and devices) |
| – | Grammar analysis | `src/grammar.cpp` | FIRST/FOLLOW sets and the LL(1) parse table (proves the grammar is LL(1)) |
| – | English back-translation | `src/english.cpp` | The program explained in plain English, without AI |
| – | AI assistance | `ai.py` | English → DSL, error explanations, AI fixes (all re-checked by the compiler) |

`src/compiler.cpp` runs the phases in order. A phase runs only if every earlier phase finished without errors; warnings never stop compilation.
The lexer and the parser always both run, so lexical and syntax errors are reported together.

## 2. Example

```
SENSOR temperature : NUMBER
SENSOR door : STATE
DEVICE fan

IF temperature > 30 AND door == OPEN
THEN turn_on(fan)
ELSE turn_off(fan)
```

## 3. Phase 1 — Lexical analysis

| Token class | Pattern | Examples |
|-------------|---------|----------|
| Keywords | `IF THEN ELSE AND OR NOT SENSOR DEVICE NUMBER STATE` | `IF`, `THEN` |
| State literals | `ON OFF OPEN CLOSED TRUE FALSE` | `OPEN` |
| IDENTIFIER | `[A-Za-z_][A-Za-z0-9_]*` (not a keyword) | `temperature`, `turn_on` |
| NUMBER | `[0-9]+ ( '.' [0-9]+ )?` | `30`, `22.5` |
| Relational operators | `>  <  >=  <=  ==  !=` | `>=` |
| Arithmetic operators | `+  -  *  /` | `-` |
| Punctuation | `(  )  ,  :` | `(` |
| Comment (skipped) | `#` to end of line | `# rule 1` |

- Keywords are uppercase and case-sensitive.
- The lexer uses the longest-match rule (maximal munch), so `>=` is one token.
- Every token records its line, column and length.
- **Error recovery.** The lexer reports an error and keeps scanning. Examples:
  - `@` gives *unexpected character*.
  - `=` gives *did you mean '=='?* and is then treated as `==`.
  - `3x` gives *invalid numeric literal*.

## 4. Phases 2–3 — Syntax analysis and the AST

```
program     → { declaration | rule } EOF
declaration → SENSOR IDENT ':' ( NUMBER | STATE )
            | DEVICE IDENT { ',' IDENT }
rule        → IF expr THEN actions { ELSE IF expr THEN actions } [ ELSE actions ]
actions     → action { action }
expr        → and_expr { OR and_expr }
and_expr    → not_expr { AND not_expr }
not_expr    → NOT not_expr | rel_expr
rel_expr    → arith [ relop arith ]
arith       → term { ( '+' | '-' ) term }
term        → unary { ( '*' | '/' ) unary }
unary       → '-' unary | primary
primary     → NUMBER_LITERAL | IDENT | ON | OFF | OPEN | CLOSED | TRUE | FALSE | '(' expr ')'
relop       → '>' | '<' | '>=' | '<=' | '==' | '!='
action      → IDENT '(' [ expr { ',' expr } ] ')'
```

- **Parser.** A recursive-descent parser with one C++ function per grammar rule. The grammar is LL(1), so one token of lookahead always decides what to do.
- **One expression grammar.** Conditions and arithmetic use the same grammar, the way C does. The parser handles only structure; semantic analysis decides which parts are numbers, states or true/false values. This also avoids an LL(1) conflict between `(condition)` and `(arithmetic)`.
- **Precedence** (highest first): unary minus, `* /`, `+ -`, comparison, `NOT`, `AND`, `OR`. The grammar's levels enforce it, so `a + b * 2 > 10 OR c == 1` parses as `((a + (b * 2)) > 10) OR (c == 1)`.
- **ELSE IF** is just `ELSE` followed by `IF`, so no new keyword is needed.
- **Error recovery.** After a syntax error the parser uses *panic mode*: it skips tokens until the next `IF`, `SENSOR` or `DEVICE`, then continues. This lets it report several errors in one run.
- **AST nodes:**
  - `Program`, `SensorDecl`, `DeviceDecl`
  - `Rule`, which is a list of `Branch` (a condition plus actions) and the ELSE actions
  - `BinaryExpr`, `UnaryExpr`, `Operand`, `Action`

  Every node keeps its source span.

## 5. Phase 4 — Semantic analysis

Declarations can appear anywhere in the file, so the analyzer makes two passes:
1. Collect every declaration into the **symbol table**: name, kind (sensor/device), type (NUMBER/STATE), declaration position and use count.
2. Check every rule.

**Built-in actions:** `turn_on(device)`, `turn_off(device)`, `toggle(device)`, `set_level(device, number)`. The number argument of `set_level` may be any NUMBER expression, e.g. `set_level(heater, (22 - temperature) * 10)`.

**Types.** Every expression gets a type:
- **NUMBER:** numbers, NUMBER sensors, and arithmetic.
- **STATE:** state literals and STATE sensors.
- **true/false:** comparisons, AND, OR and NOT.

A rule's condition must be true/false.

| Check | Example message |
|-------|-----------------|
| Name declared twice | `'fan' is already declared as a device at line 3` |
| Undeclared sensor (with spelling suggestion) | `'temprature' is not a declared sensor (did you mean 'temperature'?)` |
| Undeclared device | `'fan' is not a registered device` |
| Device used in a condition | `'fan' is a device, not a sensor; conditions can only test sensors` |
| Sensor passed to an action | `'temperature' is a sensor, not a device` |
| Type mismatch | `cannot compare NUMBER sensor 'temperature' with state OPEN` |
| Ordering a STATE | `operator '>' cannot be used on STATE values; use == or !=` |
| Arithmetic on a non-number | `arithmetic '+' needs numbers, but STATE sensor 'door' is not a number` |
| Condition that isn't true/false | `the condition must be true or false, but it is a NUMBER expression` |
| AND/OR/NOT on a non-condition | `AND needs true/false conditions on both sides, ...` |
| Unknown action | `unknown action 'start' (available actions: ...)` |
| Wrong argument count or kind | `'set_level' expects 2 arguments set_level(device, number) but got 1` |
| *Warning:* unused declaration | `device 'light' is declared but never used` |
| *Warning:* constant condition | `condition compares two constants, so it is always true or always false` |
| *Warning:* level out of range | `level 150 is outside the usual range 0-100` |
| *Warning:* division by zero | `division by zero` |

### Rule analysis (`src/rule_analysis.cpp`)

The type checks look at one comparison at a time. Rule analysis instead reasons about **what the conditions mean together**. It runs only when the program has no type errors.

1. **Normal form.** Each condition is rewritten into *disjunctive normal form* (DNF): an OR of AND-groups of simple comparisons. NOT is pushed inwards with De Morgan's laws and flipped comparisons (`NOT (t > 30)` becomes `t <= 30`). There is a limit of 256 groups.
2. **Can a group be true?** For each AND-group the analyzer intersects the constraints per sensor:
   - **NUMBER sensors:** an *interval* with open or closed ends, plus excluded points for `!=`. For example, `t > 30 AND t < 20` gives an empty interval.
   - **STATE sensors:** the *set* of allowed values out of ON, OFF, OPEN, CLOSED, TRUE, FALSE. For example, `door == OPEN AND door == CLOSED` gives an empty set.
   - Comparisons it cannot reason about (arithmetic on sensors, sensor vs. sensor) count as "may be true". The analysis therefore never wrongly calls a condition impossible.
3. **Effective conditions.** Branch *k* of a rule runs when its condition is true AND every earlier condition is false. ELSE runs when all conditions are false.

| Warning | When |
|---------|------|
| `this condition can never be true, so its actions never run` | No AND-group of the condition can be satisfied |
| `this condition is always true ...` | The negation of the condition can never be satisfied |
| `this ELSE IF can never run ...` | Its effective condition is impossible, e.g. `IF t > 30 … ELSE IF t > 40` |
| `the ELSE part can never run ...` | The conditions before it cover every case |
| `conflict: rule 4 turns 'fan' off while rule 3 (line 15) turns 'fan' on, e.g. when temperature = 31 and door = OPEN. The later rule wins` | Two rules act differently on the same device (on, off, toggle, or a different level), and both effective conditions can hold at once. The example values come from the interval and set reasoning. If arithmetic is involved, the message says *possible conflict* |
| `... only the last action has effect` | One branch changes the same device twice |

Branches of the same rule are never compared with each other, because they can never run together.

## 6. Phase 5 — Intermediate code (three-address code)

Each instruction has at most one operator. The instruction forms are:
- `t = a op b`
- `t = NOT a`
- `t = - a`
- `t = a`
- `IF_FALSE t GOTO L`
- `GOTO L`
- `L:`
- `CALL f(args)`

A `# Rule n` comment marks each rule. Arithmetic results are number temporaries, and all others are true/false temporaries.

An ELSE IF chain becomes a series of tests, each jumping to the next test when its condition is false. Every branch ends with a jump to the common end label:

```
# Rule 1 (line 8)                  IF window == OPEN THEN turn_off(heater)
    t1 = window == OPEN            ELSE IF temperature < 18
    IF_FALSE t1 GOTO L1                THEN set_level(heater, (22 - temperature) * 10)
    CALL turn_off(heater)          ELSE turn_off(heater)
    GOTO L2
L1:
    t2 = temperature < 18
    IF_FALSE t2 GOTO L3
    t3 = 22 - temperature
    t4 = t3 * 10
    CALL set_level(heater, t4)
    GOTO L2
L3:
    CALL turn_off(heater)
L2:
```

Every temporary is assigned exactly once, and sensors are read once per evaluation, so values never change after they are computed. However, `t2` above is computed **only on some paths**: only when `t1` is false. This is why the optimizer must reason about control flow.

## 7. Phase 6 — Basic blocks, control-flow graph, dataflow and optimization

### Basic blocks and the CFG (`src/cfg.cpp`)
1. **Leaders** are the first instruction, every label, every rule marker, and every instruction after a jump.
2. A **basic block** runs from one leader up to the next. Control enters only at its first instruction and leaves only at its last.
3. **Edges** go from a block to its jump target and/or the next block (fall-through). A block that falls off the end of the program leads to EXIT.

### Dataflow analyses
| Analysis | Direction | Equations | Used for |
|----------|-----------|-----------|----------|
| **Liveness** | backward | `IN[B] = USE[B] ∪ (OUT[B] − DEF[B])`, `OUT[B] = ∪ IN[S]` over successors | Dead code elimination |
| **Available expressions** | forward | `OUT[B] = IN[B] ∪ GEN[B]`, `IN[B] = ∩ OUT[P]` over predecessors | Common sub-expression elimination |

Both are solved iteratively until nothing changes (a fixpoint).
- **Liveness** works on temporaries. Sensors are program inputs, not variables.
- **Available expressions.** A fact is "expression *e* is held in temporary *t*". Nothing ever kills a fact, because temporaries are assigned once and sensors don't change during an evaluation. Intersecting over predecessors is what makes CSE correct with ELSE IF: in the example above, `temperature < 18` is not available after `L2:`, so a later rule must compute it again.

`iotc --cfg` and the web page's **IR → Basic blocks** view show each block, its edges, and its live-in and live-out sets.

### Optimization passes
The passes run repeatedly until nothing changes, because one optimization often enables another. The CFG is rebuilt in every round.

| Pass | What it does |
|------|--------------|
| Constant folding | `10 > 5` → `true`, `22 - 2` → `20`, `-(5)` → `-5` (a division by 0 is never folded) |
| Algebraic simplification | `x AND true` → `x`, `x OR false` → `x`, `x AND false` → `false`, `NOT NOT x` → `x`, `x + 0` → `x`, `x * 1` → `x`, `x * 0` → `0` |
| Common sub-expression elimination | Reuses a value that is **available on every path** (available-expressions analysis) |
| Copy propagation | After `t2 = t1`, uses of `t2` become `t1` and the copy is removed |
| Constant branch elimination | `IF_FALSE true` is removed; `IF_FALSE false GOTO L` becomes `GOTO L` |
| Unreachable code elimination | Removes blocks that cannot be **reached from the entry block** of the CFG |
| Jump optimization | Removes a jump to the very next line, and labels that nothing jumps to |
| Dead code elimination | Removes instructions whose result is **not live** (liveness analysis) |

`examples/07_optimization.iot` shrinks from 21 to 10 instructions. It uses all eight passes.

## 8. Phase 7 — Code generation (retargetable)

One **structured emitter** reads the optimized IR and recognizes the two shapes the IR generator emits:
- `IF_FALSE c GOTO L1 … L1:` becomes `if (c) { … }`
- `IF_FALSE c GOTO L1 … GOTO L2 L1: … L2:` becomes `if (c) { … } else { … }`

A jump to the end label of the enclosing range means "leave this block". This turns an ELSE IF chain into nested `if { } else { if { } else { } }`.

The emitter asks a small **`Target`** class for the syntax: literals, operators, declarations, blocks, calls and the file's beginning and end. Four targets share the same control-flow recovery:

| Target | File | Notes |
|--------|------|-------|
| C | `program.c` | `bool`/`double` temporaries; linked with `runtime/iot_runtime.c` |
| Arduino / ESP32 | `program.ino` | `setup()` and `loop()`, a pin table, `analogRead`/`digitalRead` inputs, `digitalWrite` for on/off, PWM `analogWrite` for levels |
| Python | `program.py` | indentation blocks (`pass` for an empty block); `runtime/iot_runtime.py` |
| JavaScript | `program.js` | `const` temporaries and `===`; `runtime/iot_runtime.js` |

- **Reserved words.** Each target has its own list, so a sensor named `if`, `not` or `window` becomes `if_` or `not_` only where needed.
- **Source map.** Every generated line remembers the IR instruction and source span it came from.
- **Same results everywhere.** The three runtimes read `name=value` arguments and print the same output. The test suite runs every example through C, Python and JavaScript with several inputs and checks the outputs are identical. Arduino sketches are compiled against `tests/arduino_stub.h`.

```bash
make demo FILE=examples/09_thermostat.iot ARGS="window=CLOSED temperature=15 outside=10"
./iotc examples/09_thermostat.iot --target python -o program.py
```

## 9. Grammar analysis, traces and source maps

- **FIRST, FOLLOW and the LL(1) table (`src/grammar.cpp`).**
  - The grammar is stored as data in BNF: 61 productions, with "tail" nonterminals for the EBNF repetitions.
  - FIRST and FOLLOW are computed by the textbook fixpoint algorithms.
  - The LL(1) table is built as follows: `M[A, a]` holds `A → α` for every `a` in FIRST(α), and for every `a` in FOLLOW(A) when α can derive ε.
  - No cell holds two productions, which proves the grammar is LL(1). That is exactly why the hand-written recursive-descent parser can always decide with one token.
  - `iotc --grammar` prints everything; the web page's **Language** tab draws it.
- **Scanner DFA.** `lexerDfa()` describes the automaton the hand-written lexer implements (17 states). With tracing on, every character step `from → to` is recorded.
- **Parse trace.** With tracing on, the parser records entering and leaving each grammar function, consuming tokens, and errors. Together with the DFA trace, this drives the X-ray animation.
- **Source maps.** Every IR instruction and every generated line keeps the source span it came from.
- **Optimizer snapshots.** The code is recorded after every pass that changed it (the "time machine").
- **Quick fixes.** Diagnostics carry IDE-style edits:
  - rename to the close match
  - declare the missing `DEVICE` / `SENSOR` (with the type inferred from the comparison)
  - insert `THEN` or `)`
  - `=` → `==`
  - uppercase a keyword
  - remove a bad character
- **English back-translation (`src/english.cpp`).** The AST is turned into sentences such as "If the temperature is above 30 and the door is open, turn on the fan." It applies De Morgan's laws to negations and keeps grouping in arithmetic.

## 10. The web interface

Everything is plain HTML, CSS and JavaScript (ES modules, no libraries), served by `server.py`. The pages only *show* what the C++ compiler produced.

### Website and design system

The site is branded **Kelvin**. The name is a temperature unit, and the colours follow the same idea: *ember* (warm orange) marks actions and live state, and *ice* (cool blue) marks data and success. Dark mode is designed first, and light mode is a warm off-white.

| Page | Files | What it shows |
|------|-------|---------------|
| Home | `index.html`, `js/landing.js`, `css/landing.css` | A hero demo that compiles presets or a typed sentence (`/api/nl2dsl` then `/api/compile`), runs the optimized IR in a small simulated room, and lights a six-stage rail with real metrics. Below it: the seven phases with live figures (DFA, grammar and FIRST sets, AST, symbol table and warnings, TAC, an optimizer chart from `optTrace`, four targets) and charts of the bundled examples. |
| Studio | `studio.html`, `js/main.js`, `js/shell.js`, `js/charts.js`, `css/studio.css` | The compiler workbench: top bar, left rail, composer, pipeline with per-phase metrics, resizable editor/output split, Overview tab, smart home, status bar. |
| Docs | `docs.html`, `js/docs.js` | Language reference, live grammar and DFA, targets, error catalogue (real compiler messages), AI setup, phone remote, CLI. |
| Examples | `examples.html`, `js/examples-page.js` | Every example compiled on page load, with filters, tags and "Open in Studio" (a share link carrying the program). |
| About | `about.html`, `js/about.js` | Motivation, architecture, technology choices, team. |

- **Design tokens (`css/tokens.css`).**
  - Colour roles for both themes; the old variable names are kept so modules that generate markup restyle automatically.
  - Type scale, spacing, radii, motion and layers.
  - Native cross-page transitions (`@view-transition`).
- **Shared components (`css/components.css`).** Buttons, inputs, badges, segmented controls, toasts, code frames.
- **Fonts.** Geist, Geist Mono and Instrument Serif (open-source, SIL OFL) are self-hosted in `web/fonts/`, so the site works offline.
- **Real numbers only.** `tools/project_stats.py` writes `web/data/project.json` every time `make test` runs: test counts, compiler size, grammar facts, per-example results, and the hero presets compiled by `iotc`. The hero falls back to these recorded results if the server is not running.
- **Accessibility.** Body text is at least 14–15 px, focus rings are visible, and status is never shown by colour alone (each state also has a symbol or text). All motion respects `prefers-reduced-motion`.

### Studio features

- **Compiler X-ray (`web/js/xray.js`).** A full-screen player of the real traces:
  1. The scanner cursor moves while the DFA lights up its states.
  2. The parser call stack and the lookahead token are shown while the syntax tree grows.
  3. The symbol table fills and the checks appear.
  4. IR lines appear next to their source.
  5. The optimizer passes run one by one.
  6. C is written line by line.
  7. A summary is shown.
- **Smart editor (`editor.js`).**
  - Live compile while typing.
  - Autocomplete for keywords, declared names and actions.
  - Hover info (kind, type, declaration, uses) and Ctrl/⌘-click to go to the declaration.
  - Problem tooltips and one-click quick fixes that keep undo working.
- **Cross-pane linking (`panes.js`).** Hovering a token, AST node, IR line, CFG block, problem or generated line highlights the matching source and the matching items in every other pane, using the source maps.
- **Graphs (`graph.js`).** The AST is a tidy top-down tree. The CFG is drawn in layers with true/false edges and live-in/live-out sets. The DFA is a hand-laid-out state diagram. All three support pan and zoom.
- **Digital twin (`twin.js`, `vm.js`).** A floor plan whose devices are placed and animated by name (fan, light, heater, cooler, pump, alarm, vent, lock …). Every sensor change runs the **optimized IR** in a small virtual machine. A rule that changes a device shows a "Rule n" label; rules fighting over a device turn it red.
- **24-hour day (`timeline.js`).** Each number sensor follows a daily curve that crosses the thresholds the program tests. State sensors follow plausible schedules, such as the door opening in the morning and evening. Simple physics closes the loop: heaters warm the room, coolers cool it, pumps raise soil moisture. The rules run every 5 minutes, and the chart shows sensors, devices and conflict marks like a logic analyzer.
- **AI (`ai.js`).**
  - English to DSL, typed or spoken via the browser's Web Speech API.
  - "Explain program", using the compiler's English with an optional friendlier AI version.
  - Per-problem explanations.
  - "AI fix", which is offered only if the compiler accepts the AI's corrected program.
- **Demo extras.**
  - Presentation mode (`tour.js`).
  - Command palette (Ctrl/⌘+K).
  - Share links, where the program is deflate-compressed into `#p=…` (`share.js`).
  - A printable report of every phase, to save as PDF (`report.js`).

### Phone remote

`make remote` starts the server on the Wi-Fi address with a random session key. The page shows the remote URL as a **QR code** made by a hand-written encoder (`web/js/qr.js`: byte mode, error correction M, versions 1–10, Reed–Solomon over GF(256)).

```
phone ──POST /api/remote/state?k=KEY──▶ server ──Server-Sent Events──▶ laptop page ──▶ VM ──▶ twin
phone ◀──GET /api/remote/config?k=KEY── server ◀──POST /api/remote/config── laptop page
```

**Security.** Requests that do not come from the laptop itself can only reach the remote page and these two endpoints, and must carry the key. Everything else is localhost-only: compiling, running code, AI, the event stream and changing the configuration. Sensor names and values are validated before use.

## 11. AI assistance (details)

`ai.py` uses only the Python standard library and free providers. It picks one automatically, unless `AI_PROVIDER` is set in `.env` (see `.env.example`):
1. **Groq** if `GROQ_API_KEY` is set
2. **Gemini** if `GEMINI_API_KEY` is set
3. **Ollama** (a local model, for example `qwen3`) if it is running
4. otherwise a built-in **offline rule-based converter**

**English → DSL**
- The prompt contains the language reference, two examples, and the names already declared in the editor.
- The model's reply is cleaned up (thinking blocks and code fences are removed).
- The reply is then **compiled by `iotc`**. If it has errors, the model gets one retry that includes the compiler's error messages.
- The web page shows whether the final DSL compiled cleanly. The user can replace the editor contents or add the rule to the program; existing declarations are not duplicated.

**Explain.** Each problem has an Explain button. The model gets the numbered source and the diagnostic, and answers in 2–3 sentences followed by a `Fix:` line. Without a model, built-in templates are used.

## 12. Source layout

| Path | Role |
|------|------|
| `src/token.h` | Token types, `Token`, `Diagnostic` |
| `src/lexer.*`, `src/parser.*`, `src/ast.*` | Phases 1–3 |
| `src/semantic.*` | Phase 4: symbol table and checks |
| `src/rule_analysis.*` | Phase 4: DNF, interval and state-set reasoning, conflict detection |
| `src/ir.*` | Phase 5: three-address code |
| `src/cfg.*` | Phase 6: basic blocks, CFG, liveness, available expressions |
| `src/optimizer.*` | Phase 6: optimization passes |
| `src/codegen.*`, `runtime/` | Phase 7: structured emitter, four targets, C/Python/JS runtimes |
| `src/grammar.*`, `src/english.*` | FIRST/FOLLOW/LL(1) analysis; English back-translation |
| `src/compiler.*` | Pipeline driver |
| `src/json.*`, `src/main.cpp` | JSON output and the `iotc` command-line tool |
| `web/` | Website and Studio (see section 10) |
| `tools/project_stats.py` | Real project numbers for the website |
| `server.py`, `ai.py` | Local web server, phone-remote relay and AI assistant (Python standard library only) |
| `web/`, `web/js/` | Web interface as ES modules (no frameworks); `web/remote.html` is the phone page |
| `examples/` | Sample programs: valid ones, ones with lexical, syntax and semantic errors, rule analysis (`08`) and a thermostat with ELSE IF and arithmetic (`09`) |
| `tests/` | `run_tests.sh` (all phases, every target), `test_ai.py`, `test_server.py`, `arduino_stub.h` |
