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
| 7 | Code generation | `src/codegen.cpp` | C source code (`runtime/` supplies sensors and devices) |
| – | AI assistance | `ai.py` | English → DSL, plain-English error explanations |

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

## 8. Phase 7 — Code generation

The generator reads the optimized IR. It recognizes the two shapes the IR generator emits:
- `IF_FALSE c GOTO L1 … L1:` becomes `if (c) { … }`
- `IF_FALSE c GOTO L1 … GOTO L2 L1: … L2:` becomes `if (c) { … } else { … }`

A jump to the end label of the enclosing range means "leave this block". This turns an ELSE IF chain into nested `if { } else { if { } else { } }`. The C output therefore uses normal `if`/`else` blocks rather than `goto`.

Arithmetic temporaries are declared `double` and condition temporaries `bool`.

The generated C has:
- a device enum and a device-name table
- an `evaluate_rules()` function that reads each sensor it needs once, then runs the rules
- `bool` temporaries for the conditions

`runtime/iot_runtime.c` provides:
- `read_number` and `read_state`, which take sensor values from command-line arguments such as `temperature=32`
- the device actions
- a `main()` that prints the final device states

On a real board, these functions would read hardware and drive GPIO pins.

```bash
make demo FILE=examples/02_smart_home.iot ARGS="temperature=32 door=OPEN motion=OFF humidity=30"
```

## 9. AI assistance

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

## 10. Simulator

The web page includes a simulator.
- It builds controls from the symbol table: sliders for NUMBER sensors, and buttons for STATE sensors offering the values the rules compare against.
- It runs the **optimized IR** in a small virtual machine in the browser.
- It shows device states and which rules fired.

The C tab's **Build & run** button compiles the generated C with the same sensor values, as a cross-check.

## 11. Source layout

| Path | Role |
|------|------|
| `src/token.h` | Token types, `Token`, `Diagnostic` |
| `src/lexer.*`, `src/parser.*`, `src/ast.*` | Phases 1–3 |
| `src/semantic.*` | Phase 4: symbol table and checks |
| `src/rule_analysis.*` | Phase 4: DNF, interval and state-set reasoning, conflict detection |
| `src/ir.*` | Phase 5: three-address code |
| `src/cfg.*` | Phase 6: basic blocks, CFG, liveness, available expressions |
| `src/optimizer.*` | Phase 6: optimization passes |
| `src/codegen.*`, `runtime/` | Phase 7 and the C runtime |
| `src/compiler.*` | Pipeline driver |
| `src/json.*`, `src/main.cpp` | JSON output and the `iotc` command-line tool |
| `server.py`, `ai.py` | Local web server and AI assistant (Python standard library only) |
| `web/` | Web interface (HTML, CSS, JavaScript, no frameworks) |
| `examples/` | Sample programs: valid ones, ones with lexical, syntax and semantic errors, rule analysis (`08`) and a thermostat with ELSE IF and arithmetic (`09`) |
| `tests/` | `run_tests.sh` (all phases, including compiling and running the C output) and `test_ai.py` |
