// parser.h — Phase 2: syntax analysis (token stream -> AST).
//
// A hand-written recursive-descent parser: one function per grammar rule.
// The grammar is LL(1), so one token of lookahead always decides what to do.
#pragma once

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "ast.h"
#include "token.h"

// One event of the recursive-descent parse (for the visualizer):
// "enter"/"exit" a grammar function, "token" consumed, or "error".
struct ParseEvent {
    std::string kind;
    std::string name;    // grammar rule (enter/exit), lexeme (token), expected (error)
    int token;           // index of the current token
    int depth;           // call-stack depth
};

class Parser {
public:
    explicit Parser(const std::vector<Token>& tokens);

    void enableTrace() { trace_ = true; }
    const std::vector<ParseEvent>& trace() const { return events_; }

    // Parses the whole program. On a syntax error the parser records it,
    // skips ahead to the next statement (panic-mode recovery) and continues,
    // so the returned tree holds every statement that parsed correctly.
    std::unique_ptr<Program> parse();

    const std::vector<Diagnostic>& errors() const { return errors_; }
    int ruleCount() const { return rules_; }
    int declarationCount() const { return declarations_; }

private:
    struct ParseError {};   // thrown to unwind to the statement level

    // Records enter/exit of a grammar function in the trace (RAII).
    struct Scope {
        Parser& parser;
        const char* rule;
        Scope(Parser& p, const char* name);
        ~Scope();
    };

    // Grammar rules
    std::unique_ptr<Statement> parseSensorDecl();
    std::unique_ptr<Statement> parseDeviceDecl();
    std::unique_ptr<Statement> parseRule();
    std::unique_ptr<Expr> parseExpr();         // OR   (lowest precedence)
    std::unique_ptr<Expr> parseAnd();          // AND
    std::unique_ptr<Expr> parseNot();          // NOT
    std::unique_ptr<Expr> parseRelational();   // > < >= <= == !=
    std::unique_ptr<Expr> parseArith();        // + -
    std::unique_ptr<Expr> parseTerm();         // * /
    std::unique_ptr<Expr> parseUnary();        // unary -
    std::unique_ptr<Expr> parsePrimary();      // literal | name | ( expr )   (highest)
    std::unique_ptr<Expr> binary(const std::string& op, std::unique_ptr<Expr> l, std::unique_ptr<Expr> r);
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
    [[noreturn]] void fail(const std::string& expected, const std::string& hint = "",
                           std::optional<Fix> fix = std::nullopt);
    Fix insertAfterPrevious(const std::string& text, const std::string& title) const;
    void synchronize();

    static Pos startOf(const Token& t) { return Pos{t.line, t.col}; }
    static Pos endOf(const Token& t) { return Pos{t.line, t.col + t.length}; }

    const std::vector<Token>& tokens_;
    size_t current_ = 0;
    std::vector<Diagnostic> errors_;
    int rules_ = 0;
    int declarations_ = 0;

    static const size_t kMaxTraceEvents = 6000;
    bool trace_ = false;
    int depth_ = 0;
    std::vector<ParseEvent> events_;
};
