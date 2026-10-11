// parser.h — Phase 2: syntax analysis (token stream -> AST).
//
// A hand-written recursive-descent parser: one function per grammar rule.
// The grammar is LL(1), so one token of lookahead always decides what to do.
#pragma once

#include <memory>
#include <string>
#include <vector>

#include "ast.h"
#include "token.h"

class Parser {
public:
    explicit Parser(const std::vector<Token>& tokens);

    // Parses the whole program. On a syntax error the parser records it,
    // skips ahead to the next statement (panic-mode recovery) and continues,
    // so the returned tree holds every statement that parsed correctly.
    std::unique_ptr<Program> parse();

    const std::vector<Diagnostic>& errors() const { return errors_; }
    int ruleCount() const { return rules_; }
    int declarationCount() const { return declarations_; }

private:
    struct ParseError {};   // thrown to unwind to the statement level

    // Grammar rules
    std::unique_ptr<Statement> parseSensorDecl();
    std::unique_ptr<Statement> parseDeviceDecl();
    std::unique_ptr<Statement> parseRule();
    std::unique_ptr<Condition> parseCondition();   // OR level
    std::unique_ptr<Condition> parseAnd();         // AND level
    std::unique_ptr<Condition> parseNot();         // NOT level
    std::unique_ptr<Condition> parsePrimary();     // ( condition ) | comparison
    Operand parseOperand(const std::string& what);
    Action parseAction();
    std::vector<Action> parseActionList(const std::string& after);

    // Token helpers
    const Token& peek() const { return tokens_[current_]; }
    const Token& previous() const { return tokens_[current_ - 1]; }
    bool check(TokenType t) const { return peek().type == t; }
    bool match(TokenType t);
    const Token& advance();
    const Token& expect(TokenType t, const std::string& what);

    // Error handling
    [[noreturn]] void fail(const std::string& expected, const std::string& hint = "");
    void synchronize();

    static Pos startOf(const Token& t) { return Pos{t.line, t.col}; }
    static Pos endOf(const Token& t) { return Pos{t.line, t.col + t.length}; }

    const std::vector<Token>& tokens_;
    size_t current_ = 0;
    std::vector<Diagnostic> errors_;
    int rules_ = 0;
    int declarations_ = 0;
};
