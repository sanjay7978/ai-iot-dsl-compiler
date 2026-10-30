CXX      ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -pedantic -O2

SRC   := src/lexer.cpp src/parser.cpp src/ast.cpp src/semantic.cpp src/rule_analysis.cpp \
         src/ir.cpp src/cfg.cpp src/optimizer.cpp src/codegen.cpp src/english.cpp src/grammar.cpp \
         src/compiler.cpp src/json.cpp src/main.cpp
OBJ   := $(SRC:src/%.cpp=build/%.o)
HDRS  := $(wildcard src/*.h)
BIN   := iotc

.PHONY: all run remote test stats demo clean

all: $(BIN)

$(BIN): $(OBJ)
	$(CXX) $(CXXFLAGS) -o $@ $^

build/%.o: src/%.cpp $(HDRS) | build
	$(CXX) $(CXXFLAGS) -c $< -o $@

build:
	mkdir -p build

# Build the compiler and start the web interface on http://127.0.0.1:8000
run: $(BIN)
	python3 server.py

# Same, but phones on the same Wi-Fi can open the remote sensor panel (QR code in the page)
remote: $(BIN)
	python3 server.py --lan

test: $(BIN)
	sh tests/run_tests.sh
	python3 -m unittest discover -s tests -q
	python3 tools/project_stats.py

# Refresh the real project numbers shown on the website (web/data/project.json)
stats: $(BIN)
	python3 tools/project_stats.py

# Compile a DSL program to C, build it with the runtime and run it, e.g.
#   make demo FILE=examples/02_smart_home.iot ARGS="temperature=32 door=OPEN motion=OFF humidity=30"
FILE ?= examples/01_basic.iot
ARGS ?= temperature=32 door=OPEN
CC   ?= cc
demo: $(BIN) | build
	./$(BIN) $(FILE) -o build/program.c
	$(CC) -std=c99 -Wall -Wextra -Werror -Iruntime build/program.c runtime/iot_runtime.c -o build/program
	./build/program $(ARGS)

clean:
	rm -rf build $(BIN)
