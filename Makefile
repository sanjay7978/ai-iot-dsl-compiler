CXX      ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -pedantic -O2

SRC   := src/lexer.cpp src/parser.cpp src/ast.cpp src/json.cpp src/main.cpp
OBJ   := $(SRC:src/%.cpp=build/%.o)
HDRS  := $(wildcard src/*.h)
BIN   := iotc

.PHONY: all run test clean

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

test: $(BIN)
	sh tests/run_tests.sh

clean:
	rm -rf build $(BIN)
