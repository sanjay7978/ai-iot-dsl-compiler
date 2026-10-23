# IoT DSL Compiler

An AI-assisted compiler for a small rule language for IoT automation, written by hand in C++17.

```
SENSOR temperature : NUMBER
SENSOR door : STATE
DEVICE fan

IF temperature > 30 AND door == OPEN
THEN turn_on(fan)
```

All seven compiler phases are implemented:
1. lexical analysis
2. syntax analysis
3. abstract syntax tree
4. semantic analysis (symbol table and type checks)
5. three-address intermediate code
6. optimization
7. C code generation

A free AI assistant turns plain English into DSL and explains errors; the compiler checks everything it writes.
The web interface also has a sensor simulator.
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

- **Describe a rule in English** and press **Convert to DSL**. The result is checked by the compiler before you add it to the editor.
- Choose an example or type a program, then press **Compile** (Ctrl/⌘ + Enter).
- Each phase in the phase strip shows whether it passed. Click a phase to open its output.
- **Tabs:**
  - Tokens
  - Syntax tree
  - Symbols
  - IR (original or optimized, with the optimization report)
  - C code (with **Build & run**)
  - Simulator
  - Problems (with an AI **Explain** button)
- The button in the top-right corner switches between light and dark mode.

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
./iotc examples/06_semantic_error.iot          # semantic errors
./iotc examples/01_basic.iot --c               # generated C only
make demo FILE=examples/02_smart_home.iot ARGS="temperature=32 door=OPEN motion=OFF humidity=30"
make test                                      # all tests
```

## Project layout

```
src/        C++ compiler (lexer, parser, AST, semantic, IR, optimizer, codegen, driver)
runtime/    C runtime linked with generated programs
web/        Web interface (HTML, CSS, JavaScript, no frameworks)
server.py   Local server: compiles, runs generated C, forwards AI requests
ai.py       AI assistant (Groq / Gemini / Ollama / offline), standard library only
examples/   Sample programs
tests/      Test script and AI unit tests
docs/       Design document and demo script
```
