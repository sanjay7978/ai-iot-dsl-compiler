# IoT DSL Compiler

A compiler for a small domain-specific language for IoT automation rules, written by hand in C++17.

```
IF temperature > 30 AND door == OPEN
THEN turn_on(fan)
```

**Milestone 1 (about 30%):** lexical analysis, syntax analysis and AST construction, with a web interface for the demo.
See [docs/DESIGN.md](docs/DESIGN.md) for the token specification, grammar, AST design and roadmap.

## Requirements

- A C++17 compiler (`g++` or `clang++`)
- Python 3 (only for the local web server; it uses the standard library only)

## Run the web demo

```bash
make run
```

Then open http://127.0.0.1:8000 in a browser.

- Choose a program from **Examples**, or type your own, then press **Compile** (or Ctrl/⌘ + Enter).
- **Tokens** lists the lexer output. Hover over a row to highlight the token in the editor.
- **Syntax tree** shows the AST. Nodes can be collapsed, and hovering a node highlights its source text.
- **Errors** lists lexical and syntax errors with line and column. Click one to jump to it.
- The button in the top-right corner switches between light and dark mode.

## Command line

```bash
make
./iotc examples/01_basic.iot             # tokens + AST
./iotc examples/02_smart_home.iot --ast  # AST only
./iotc examples/05_syntax_error.iot      # error reporting
./iotc examples/01_basic.iot --dot > ast.dot   # Graphviz (dot -Tpng ast.dot -o ast.png)
make test                                # run the automated tests
```

## Project layout

```
src/        C++ compiler: lexer, parser, AST, JSON output, driver
web/        Web interface (HTML, CSS, JavaScript, no frameworks)
server.py   Local server: serves web/ and runs ./iotc --json
examples/   Sample programs (valid and with errors)
tests/      Test script
docs/       Design document
```
