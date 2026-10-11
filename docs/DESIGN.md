# IoT DSL Compiler — Design (Milestone 1)

## 1. Overview

The project is an AI-assisted compiler for a small domain-specific language (DSL) for IoT automation rules.

```
Natural language → AI (assist) → IoT DSL → Lexer → Parser → AST → Semantic analysis
                 → Intermediate code → Optimization → Target code
```

The AI layer only assists the user: it turns English into DSL text, explains errors and suggests fixes.
The compiler itself is written by hand in C++17, with no Lex/Yacc or other generator tools.

### Progress

| # | Phase | Status | Output |
|---|-------|--------|--------|
| 1 | Lexical analysis | **Done** | Token stream with line:column positions |
| 2 | Syntax analysis | **Done** | Grammar check, syntax errors, error recovery |
| 3 | AST construction | **Done** | Abstract syntax tree (text, Graphviz, JSON) |
| 4 | Semantic analysis | Planned | Symbol table, type and declaration checks |
| 5 | Intermediate code | Planned | Three-address code |
| 6 | Optimization | Planned | Constant folding, dead-code removal |
| 7 | Code generation | Planned | C target code |
| – | AI assistance | Planned | Natural language → DSL, error explanations |

## 2. Example

```
SENSOR temperature : NUMBER
SENSOR door : STATE
DEVICE fan

IF temperature > 30 AND door == OPEN
THEN turn_on(fan)
ELSE turn_off(fan)
```

## 3. Lexical specification (Phase 1)

| Token class | Pattern | Examples |
|-------------|---------|----------|
| Keywords | `IF THEN ELSE AND OR NOT SENSOR DEVICE NUMBER STATE` | `IF`, `THEN` |
| State literals | `ON OFF OPEN CLOSED TRUE FALSE` | `OPEN` |
| IDENTIFIER | `[A-Za-z_][A-Za-z0-9_]*` (not a keyword) | `temperature`, `turn_on` |
| NUMBER | `[0-9]+ ( '.' [0-9]+ )?` | `30`, `22.5` |
| Relational operators | `>  <  >=  <=  ==  !=` | `>=` |
| Punctuation | `(  )  ,  :` | `(` |
| Comment (skipped) | `#` to end of line | `# rule 1` |
| Whitespace (skipped) | space, tab, newline | |

- Keywords are uppercase and case-sensitive. `if` is an identifier, and the parser suggests `IF`.
- Longest match (maximal munch): `>=` is one token, not `>` followed by `=`.
- Every token records its line, column and length for error messages and editor highlighting.

**Lexical errors.** The lexer reports the error and keeps scanning, so every error in the file is reported in one run:

| Input | Message |
|-------|---------|
| `@`, `$`, `é` | `unexpected character '@'` |
| `=` | `unexpected '=': assignment is not supported, did you mean '=='?` (treated as `==` so parsing can continue) |
| `!` | `use NOT for negation or '!=' for not-equal` |
| `30.` | `malformed number '30.': expected a digit after '.'` |
| `3x` | `invalid numeric literal '3x'` |

## 4. Grammar (Phase 2)

EBNF, where `{ }` means zero or more and `[ ]` means optional:

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

**Operator precedence** (highest first): comparison, `NOT`, `AND`, `OR`.
This is built into the grammar's levels, so `a OR b AND c` parses as `a OR (b AND c)`.
`AND` and `OR` are left-associative because of the `{ }` loops.

**Why recursive descent.** The grammar is LL(1): the next token always decides which rule to apply.
For example, `primary` uses `(` to choose a bracketed condition, and anything else must be a comparison.
So each grammar rule becomes one C++ function (`parseRule`, `parseCondition`, `parseAnd`, ...).

**Syntax errors and recovery.** The message says what was expected and what was found, with the position:

```
Syntax Error [5:1]: expected 'THEN' after the condition but found 'turn_on'
```

After an error the parser uses *panic-mode recovery*. It skips tokens until one that can start a statement (`IF`, `SENSOR`, `DEVICE`) and then continues, so it reports several errors in one run.

## 5. Abstract syntax tree (Phase 3)

| Node | Fields |
|------|--------|
| `Program` | list of statements |
| `SensorDecl` | name, type (`NUMBER` / `STATE`) |
| `DeviceDecl` | list of device names |
| `Rule` | condition, THEN actions, ELSE actions |
| `LogicalCond` | operator (`AND` / `OR`), left, right |
| `NotCond` | operand |
| `Comparison` | operator, left operand, right operand |
| `Action` | name, argument list |
| `Operand` | kind (identifier / number / state), text |

AST for `IF temperature > 30 AND door == OPEN THEN turn_on(fan)`:

```
Program
└── Rule
    ├── Condition
    │   └── AND
    │       ├── Comparison: >
    │       │   ├── Identifier: temperature
    │       │   └── Number: 30
    │       └── Comparison: ==
    │           ├── Identifier: door
    │           └── State: OPEN
    └── Then
        └── Action: turn_on
            └── Identifier: fan
```

Each node stores its source position, so later phases can report errors at the right place.

## 6. Source layout

| File | Role |
|------|------|
| `src/token.h` | Token types, `Token`, `Diagnostic` |
| `src/lexer.h/.cpp` | Phase 1: scanner |
| `src/parser.h/.cpp` | Phase 2: recursive-descent parser |
| `src/ast.h/.cpp` | Phase 3: AST nodes, tree printer, Graphviz export |
| `src/json.h/.cpp` | JSON output for the web interface |
| `src/main.cpp` | Command-line driver (`iotc`) |
| `server.py` | Local web server that runs `iotc --json` (glue only) |
| `web/` | Web interface (HTML, CSS, JavaScript) |
| `examples/` | Sample programs, both valid and with errors |
| `tests/run_tests.sh` | Automated tests |

## 7. Roadmap (remaining phases)

1. **Semantic analysis.** Build a symbol table from `SENSOR` / `DEVICE` declarations, then check:
   - every identifier in a condition is a declared sensor
   - every action argument is a declared device
   - `NUMBER` sensors are compared with numbers, and `STATE` sensors with state literals
   - `>`, `<`, `>=` and `<=` are used only on numeric sensors

   Example error: `Error: 'fan' is not a registered device`.
2. **Intermediate code.** Three-address code using temporaries and labels:
   ```
   t1 = temperature > 30
   t2 = door == OPEN
   t3 = t1 AND t2
   IF_FALSE t3 GOTO L1
   CALL turn_on, fan
   L1:
   ```
3. **Optimization.** Constant folding (`IF 5 > 3` becomes always true), removal of unreachable branches, and common sub-expression reuse across rules.
4. **Code generation.** Emit C code, for example `if (temperature > 30 && door == OPEN) { turn_on(FAN); }`.
5. **AI assistance.** A natural-language box that asks an LLM to produce DSL text. The DSL then goes through the same compiler, so the AI never skips the compiler's checks. The LLM can also explain compiler errors in plain English.
