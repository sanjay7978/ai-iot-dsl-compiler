// lexer.h — Phase 1: lexical analysis (source text -> token stream).
#pragma once

#include <string>
#include <vector>

#include "token.h"

class Lexer {
public:
    explicit Lexer(std::string source);

    // Scans the whole source. The returned vector always ends with END_OF_FILE.
    // Invalid characters are reported in errors() and skipped, so scanning
    // continues and every lexical error in the file is reported in one run.
    std::vector<Token> tokenize();

    const std::vector<Diagnostic>& errors() const { return errors_; }

private:
    bool atEnd() const { return pos_ >= src_.size(); }
    char peek(size_t ahead = 0) const;
    char advance();
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
};

// Looks up a reserved word. Returns true and sets `type` if `word` is a keyword.
bool lookupKeyword(const std::string& word, TokenType& type);
