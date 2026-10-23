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
| 4 | Semantic analysis | `src/semantic.cpp` | Symbol table, type and declaration errors, warnings |
| 5 | Intermediate code | `src/ir.cpp` | Three-address code |
| 6 | Optimization | `src/optimizer.cpp` | Optimized three-address code and a report |
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
rule        → IF condition THEN action { action } [ ELSE action { action } ]
condition   → and_expr { OR and_expr }
and_expr    → not_expr { AND not_expr }
not_expr    → NOT not_expr | primary
primary     → '(' condition ')' | operand relop operand
operand     → IDENT | NUMBER_LITERAL | ON | OFF | OPEN | CLOSED | TRUE | FALSE
relop       → '>' | '<' | '>=' | '<=' | '==' | '!='
action      → IDENT '(' [ operand { ',' operand } ] ')'
```

- **Parser.** A recursive-descent parser with one C++ function per grammar rule. The grammar is LL(1), so one token of lookahead always decides what to do.
- **Precedence** (highest first): comparison, `NOT`, `AND`, `OR`. The grammar's levels enforce it, so `a OR b AND c` parses as `a OR (b AND c)`.
- **Error recovery.** After a syntax error the parser uses *panic mode*: it skips tokens until the next `IF`, `SENSOR` or `DEVICE`, then continues. This lets it report several errors in one run.
- **AST nodes:** `Program`, `SensorDecl`, `DeviceDecl`, `Rule`, `LogicalCond`, `NotCond`, `Comparison`, `Action`, `Operand`. Every node keeps its source span, so later phases can report errors at the exact place.

## 5. Phase 4 — Semantic analysis

Declarations can appear anywhere in the file, so the analyzer makes two passes:
1. Collect every declaration into the **symbol table**: name, kind (sensor/device), type (NUMBER/STATE), declaration position and use count.
2. Check every rule.

**Built-in actions:** `turn_on(device)`, `turn_off(device)`, `toggle(device)`, `set_level(device, number)`. The number argument of `set_level` may also be a NUMBER sensor.

| Check | Example message |
|-------|-----------------|
| Name declared twice | `'fan' is already declared as a device at line 3` |
| Undeclared sensor (with spelling suggestion) | `'temprature' is not a declared sensor (did you mean 'temperature'?)` |
| Undeclared device | `'fan' is not a registered device` |
| Device used in a condition | `'fan' is a device, not a sensor; conditions can only test sensors` |
| Sensor passed to an action | `'temperature' is a sensor, not a device` |
| Type mismatch | `cannot compare NUMBER sensor 'temperature' with state OPEN` |
| Ordering a STATE | `operator '>' cannot be used on STATE values; use == or !=` |
| Unknown action | `unknown action 'start' (available actions: ...)` |
| Wrong argument count or kind | `'set_level' expects 2 arguments set_level(device, number) but got 1` |
| *Warning:* unused declaration | `device 'light' is declared but never used` |
| *Warning:* constant condition | `condition compares two constants, so it is always true or always false` |
| *Warning:* level out of range | `level 150 is outside the usual range 0-100` |

## 6. Phase 5 — Intermediate code (three-address code)

Each instruction has at most one operator. The instruction forms are:
- `t = a op b`
- `t = NOT a`
- `t = a`
- `IF_FALSE t GOTO L`
- `GOTO L`
- `L:`
- `CALL f(args)`

A `# Rule n` comment marks the start of each rule.

```
# Rule 1 (line 5)
    t1 = temperature > 30
    t2 = door == OPEN
    t3 = t1 AND t2
    IF_FALSE t3 GOTO L1
    CALL turn_on(fan)
    GOTO L2
L1:
    CALL turn_off(fan)
L2:
```

Every temporary is assigned exactly once. Temporaries are computed before the rule's branch, and sensors are read once per evaluation. This makes the global optimizations below safe.

## 7. Phase 6 — Optimization

The passes run repeatedly until nothing changes (a fixpoint), because one optimization often enables another.

| Pass | What it does |
|------|--------------|
| Constant folding | `10 > 5` becomes `true` |
| Algebraic simplification | `x AND true` → `x`; `x OR false` → `x`; `x AND false` → `false`; `NOT NOT x` → `x`; `x AND x` → `x` |
| Common sub-expression elimination | A comparison already computed (even in an earlier rule) is reused |
| Copy propagation | After `t2 = t1`, uses of `t2` become `t1` and the copy is removed |
| Constant branch elimination | `IF_FALSE true` is removed; `IF_FALSE false GOTO L` becomes `GOTO L` |
| Unreachable code removal | Code after a `GOTO`, up to the next label, is removed |
| Jump optimization | A jump to the very next line is removed, and so are labels that nothing jumps to |
| Dead code elimination | Temporaries whose value is never used are removed |

`examples/07_optimization.iot` shrinks from 21 to 10 instructions. It uses all eight passes.

## 8. Phase 7 — Code generation

The generator reads the optimized IR. It recognizes the two shapes the IR generator emits:
- `IF_FALSE c GOTO L1 … L1:` becomes `if (c) { … }`
- `IF_FALSE c GOTO L1 … GOTO L2 L1: … L2:` becomes `if (c) { … } else { … }`

So the C output uses normal `if`/`else` blocks rather than `goto`.

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
| `src/ir.*` | Phase 5: three-address code |
| `src/optimizer.*` | Phase 6 |
| `src/codegen.*`, `runtime/` | Phase 7 and the C runtime |
| `src/compiler.*` | Pipeline driver |
| `src/json.*`, `src/main.cpp` | JSON output and the `iotc` command-line tool |
| `server.py`, `ai.py` | Local web server and AI assistant (Python standard library only) |
| `web/` | Web interface (HTML, CSS, JavaScript, no frameworks) |
| `examples/` | Sample programs: valid ones, and ones with lexical, syntax and semantic errors |
| `tests/` | `run_tests.sh` (all phases, including compiling and running the C output) and `test_ai.py` |
