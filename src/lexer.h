// lexer.h — Phase 1: lexical analysis (source text -> token stream).
#pragma once

#include <string>
#include <vector>

#include "token.h"

// One step of the scanner's finite automaton (for the visualizer).
struct LexStep {
    int offset;          // byte offset of the character read
    std::string from;    // DFA state before
    std::string to;      // DFA state after
};

// The deterministic finite automaton this hand-written scanner implements.
struct LexerDfa {
    struct State { std::string id, label; bool accepting; };
    struct Edge { std::string from, to, label; };
    std::vector<State> states;
    std::vector<Edge> edges;
};
const LexerDfa& lexerDfa();

class Lexer {
public:
    explicit Lexer(std::string source);

    // Record every DFA transition (see trace()).
    void enableTrace() { trace_ = true; }
    const std::vector<LexStep>& trace() const { return steps_; }

    // Scans the whole source. The returned vector always ends with END_OF_FILE.
    // Invalid characters are reported in errors() and skipped, so scanning
    // continues and every lexical error in the file is reported in one run.
    std::vector<Token> tokenize();

    const std::vector<Diagnostic>& errors() const { return errors_; }

private:
    bool atEnd() const { return pos_ >= src_.size(); }
    char peek(size_t ahead = 0) const;
    char advance(const char* state = nullptr);
    void skipWhitespaceAndComments();

    Token scanIdentifierOrKeyword();
    Token scanNumber();
    Token makeToken(TokenType type, size_t start, int line, int col) const;
    void error(int line, int col, int length, const std::string& message);

    std::string src_;
    size_t pos_ = 0;
    int line_ = 1;
    int col_ = 1;
    std::vector<Diagnostic> errors_;

    static const size_t kMaxTraceSteps = 6000;
    bool trace_ = false;
    std::string state_ = "START";
    std::vector<LexStep> steps_;
};

// Looks up a reserved word. Returns true and sets `type` if `word` is a keyword.
bool lookupKeyword(const std::string& word, TokenType& type);
