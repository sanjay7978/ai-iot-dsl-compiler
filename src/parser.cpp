// parser.cpp — recursive-descent parser for the IoT DSL.

#include "parser.h"

#include <cctype>

#include "lexer.h"

namespace {

const size_t kMaxErrors = 50;

std::string describe(const Token& t) {
    if (t.type == TokenType::END_OF_FILE) return "end of file";
    return "'" + t.lexeme + "'";
}

std::string upperCase(const std::string& s) {
    std::string upper;
    for (char c : s) upper += static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return upper;
}

// If `t` is a lowercase spelling of a keyword (e.g. "if"), returns a hint.
std::string keywordCaseHint(const Token& t) {
    if (t.type != TokenType::IDENTIFIER) return "";
    std::string upper = upperCase(t.lexeme);
    TokenType kw;
    if (upper != t.lexeme && lookupKeyword(upper, kw))
        return "keywords are uppercase, did you mean '" + upper + "'?";
    return "";
}

bool isRelOp(TokenType t) {
    return t == TokenType::GT || t == TokenType::LT || t == TokenType::GE ||
           t == TokenType::LE || t == TokenType::EQ || t == TokenType::NE;
}

bool isStateLiteral(TokenType t) {
    return t == TokenType::ON || t == TokenType::OFF || t == TokenType::OPEN ||
           t == TokenType::CLOSED || t == TokenType::TRUE_KW || t == TokenType::FALSE_KW;
}

bool startsStatement(TokenType t) {
    return t == TokenType::IF || t == TokenType::SENSOR || t == TokenType::DEVICE;
}

}  // namespace

Parser::Parser(const std::vector<Token>& tokens) : tokens_(tokens) {}

// ---------- Token helpers ---------------------------------------------------

const Token& Parser::advance() {
    if (!check(TokenType::END_OF_FILE)) {
        if (trace_ && events_.size() < kMaxTraceEvents)
            events_.push_back(ParseEvent{"token", tokens_[current_].lexeme, static_cast<int>(current_), depth_});
        ++current_;
    }
    return previous();
}

Parser::Scope::Scope(Parser& p, const char* name) : parser(p), rule(name) {
    if (p.trace_ && p.events_.size() < kMaxTraceEvents)
        p.events_.push_back(ParseEvent{"enter", name, static_cast<int>(p.current_), p.depth_});
    ++p.depth_;
}

Parser::Scope::~Scope() {
    --parser.depth_;
    if (parser.trace_ && parser.events_.size() < kMaxTraceEvents)
        parser.events_.push_back(ParseEvent{"exit", rule, static_cast<int>(parser.current_), parser.depth_});
}

bool Parser::match(TokenType t) {
    if (!check(t)) return false;
    advance();
    return true;
}

const Token& Parser::expect(TokenType t, const std::string& what) {
    if (check(t)) return advance();
    // A missing THEN or ')' can be repaired by inserting it.
    if (t == TokenType::THEN) {
        const Token& at = peek();
        if (at.type == TokenType::END_OF_FILE) fail(what, "", insertAfterPrevious(" THEN", "Insert 'THEN'"));
        fail(what, "", Fix{"Insert 'THEN'", at.line, at.col, 0, "THEN "});
    }
    if (t == TokenType::RPAREN) fail(what, "", insertAfterPrevious(")", "Insert ')'"));
    fail(what);
}

Fix Parser::insertAfterPrevious(const std::string& text, const std::string& title) const {
    const Token& p = previous();
    return Fix{title, p.line, p.col + p.length, 0, text};
}

// ---------- Error handling --------------------------------------------------

void Parser::fail(const std::string& expected, const std::string& hint, std::optional<Fix> fix) {
    const Token& t = peek();
    std::string msg = "expected " + expected + " but found " + describe(t);
    std::string h = hint.empty() ? keywordCaseHint(t) : hint;
    if (!h.empty()) msg += " (" + h + ")";
    if (!fix && hint.empty() && !keywordCaseHint(t).empty())
        fix = Fix{"Change to '" + upperCase(t.lexeme) + "'", t.line, t.col, t.length, upperCase(t.lexeme)};
    if (trace_ && events_.size() < kMaxTraceEvents)
        events_.push_back(ParseEvent{"error", expected, static_cast<int>(current_), depth_});

    // At end of file, point just after the last real token instead of at an
    // empty line, since that is where the missing token belongs.
    if (t.type == TokenType::END_OF_FILE && current_ > 0) {
        const Token& last = previous();
        errors_.push_back(Diagnostic{"syntax", last.line, last.col + last.length, 1, msg});
    } else {
        errors_.push_back(Diagnostic{"syntax", t.line, t.col, t.length > 0 ? t.length : 1, msg});
    }
    if (fix) errors_.back().fixes.push_back(*fix);
    throw ParseError{};
}

// Panic-mode recovery: discard tokens until one that can start a statement.
void Parser::synchronize() {
    while (!check(TokenType::END_OF_FILE) && !startsStatement(peek().type)) advance();
}

// ---------- Grammar rules ---------------------------------------------------

// program -> { declaration | rule } EOF
std::unique_ptr<Program> Parser::parse() {
    Scope scope(*this, "program");
    auto program = std::make_unique<Program>();
    program->start = startOf(peek());

    while (!check(TokenType::END_OF_FILE) && errors_.size() < kMaxErrors) {
        size_t statementStart = current_;
        try {
            if (check(TokenType::SENSOR))      program->statements.push_back(parseSensorDecl());
            else if (check(TokenType::DEVICE)) program->statements.push_back(parseDeviceDecl());
            else if (check(TokenType::IF))     program->statements.push_back(parseRule());
            else fail("'IF', 'SENSOR' or 'DEVICE' at the start of a statement");
        } catch (const ParseError&) {
            if (current_ == statementStart) advance();   // always make progress
            synchronize();
        }
    }

    program->end = program->statements.empty() ? program->start : program->statements.back()->end;
    return program;
}

// declaration -> SENSOR IDENT ':' ( NUMBER | STATE )
std::unique_ptr<Statement> Parser::parseSensorDecl() {
    Scope scope(*this, "decl");
    auto decl = std::make_unique<SensorDecl>();
    decl->start = startOf(expect(TokenType::SENSOR, "'SENSOR'"));

    const Token& name = expect(TokenType::IDENTIFIER, "a sensor name after 'SENSOR'");
    decl->name.kind = OperandKind::Identifier;
    decl->name.text = name.lexeme;
    decl->name.start = startOf(name);
    decl->name.end = endOf(name);

    expect(TokenType::COLON, "':' after the sensor name");

    if (!check(TokenType::TYPE_NUMBER) && !check(TokenType::TYPE_STATE))
        fail("a sensor type (NUMBER or STATE)");
    const Token& type = advance();
    decl->type = type.lexeme;
    decl->typeStart = startOf(type);
    decl->typeEnd = endOf(type);

    decl->end = endOf(type);
    ++declarations_;
    return decl;
}

// declaration -> DEVICE IDENT { ',' IDENT }
std::unique_ptr<Statement> Parser::parseDeviceDecl() {
    Scope scope(*this, "decl");
    auto decl = std::make_unique<DeviceDecl>();
    decl->start = startOf(expect(TokenType::DEVICE, "'DEVICE'"));

    do {
        const Token& name = expect(TokenType::IDENTIFIER, "a device name");
        Operand op;
        op.kind = OperandKind::Identifier;
        op.text = name.lexeme;
        op.start = startOf(name);
        op.end = endOf(name);
        decl->names.push_back(op);
    } while (match(TokenType::COMMA));

    decl->end = endOf(previous());
    ++declarations_;
    return decl;
}

// rule -> IF expr THEN actions { ELSE IF expr THEN actions } [ ELSE actions ]
std::unique_ptr<Statement> Parser::parseRule() {
    Scope scope(*this, "rule");
    auto rule = std::make_unique<Rule>();
    rule->start = startOf(expect(TokenType::IF, "'IF'"));

    Branch first;
    first.start = rule->start;
    first.condition = parseExpr();
    expect(TokenType::THEN, "'THEN' after the condition");
    first.actions = parseActionList("THEN");
    rule->branches.push_back(std::move(first));

    while (match(TokenType::ELSE)) {
        Pos elsePos = startOf(previous());
        if (match(TokenType::IF)) {                 // ELSE IF
            Branch b;
            b.start = elsePos;
            b.condition = parseExpr();
            expect(TokenType::THEN, "'THEN' after the ELSE IF condition");
            b.actions = parseActionList("THEN");
            rule->branches.push_back(std::move(b));
        } else {                                    // final ELSE
            rule->elseActions = parseActionList("ELSE");
            break;
        }
    }

    rule->end = endOf(previous());
    ++rules_;
    return rule;
}

// One or more actions. Actions always start with an identifier, so we keep
// reading while the next token is an IDENTIFIER.
std::vector<Action> Parser::parseActionList(const std::string& after) {
    Scope scope(*this, "actions");
    if (!check(TokenType::IDENTIFIER))
        fail("an action such as turn_on(fan) after '" + after + "'");

    std::vector<Action> actions;
    while (check(TokenType::IDENTIFIER)) actions.push_back(parseAction());
    return actions;
}

// action -> IDENT '(' [ expr { ',' expr } ] ')'
Action Parser::parseAction() {
    Scope scope(*this, "action");
    Action action;
    const Token& name = expect(TokenType::IDENTIFIER, "an action name");
    action.name = name.lexeme;
    action.start = startOf(name);

    if (!check(TokenType::LPAREN)) {
        // A lowercase keyword ("if") after an action is read as an identifier.
        std::string hint = keywordCaseHint(name);
        std::optional<Fix> fix;
        if (!hint.empty()) {
            hint = "'" + name.lexeme + "' was read as an action name; " + hint;
            fix = Fix{"Change to '" + upperCase(name.lexeme) + "'", name.line, name.col, name.length,
                      upperCase(name.lexeme)};
        }
        fail("'(' after action name '" + name.lexeme + "'", hint, fix);
    }
    advance();   // '('

    if (!check(TokenType::RPAREN)) {
        action.args.push_back(parseExpr());
        while (match(TokenType::COMMA)) action.args.push_back(parseExpr());
    }
    if (!check(TokenType::RPAREN))
        fail("',' or ')' in the argument list of '" + action.name + "'", "", insertAfterPrevious(")", "Insert ')'"));
    advance();   // ')'

    action.end = endOf(previous());
    return action;
}

std::unique_ptr<Expr> Parser::binary(const std::string& op, std::unique_ptr<Expr> l,
                                     std::unique_ptr<Expr> r) {
    auto node = std::make_unique<BinaryExpr>();
    node->op = op;
    node->start = l->start;
    node->end = r->end;
    node->left = std::move(l);
    node->right = std::move(r);
    return node;
}

// expr -> and_expr { OR and_expr }            (lowest precedence)
std::unique_ptr<Expr> Parser::parseExpr() {
    Scope scope(*this, "expr");
    auto left = parseAnd();
    while (match(TokenType::OR)) left = binary("OR", std::move(left), parseAnd());
    return left;
}

// and_expr -> not_expr { AND not_expr }
std::unique_ptr<Expr> Parser::parseAnd() {
    Scope scope(*this, "and_expr");
    auto left = parseNot();
    while (match(TokenType::AND)) left = binary("AND", std::move(left), parseNot());
    return left;
}

// not_expr -> NOT not_expr | rel_expr
std::unique_ptr<Expr> Parser::parseNot() {
    Scope scope(*this, "not_expr");
    if (match(TokenType::NOT)) {
        auto node = std::make_unique<UnaryExpr>();
        node->op = "NOT";
        node->start = startOf(previous());
        node->operand = parseNot();
        node->end = node->operand->end;
        return node;
    }
    return parseRelational();
}

// rel_expr -> arith [ relop arith ]       (comparisons do not chain)
std::unique_ptr<Expr> Parser::parseRelational() {
    Scope scope(*this, "rel_expr");
    auto left = parseArith();
    if (isRelOp(peek().type)) {
        std::string op = advance().lexeme;
        return binary(op, std::move(left), parseArith());
    }
    return left;
}

// arith -> term { ('+' | '-') term }
std::unique_ptr<Expr> Parser::parseArith() {
    Scope scope(*this, "arith");
    auto left = parseTerm();
    while (check(TokenType::PLUS) || check(TokenType::MINUS)) {
        std::string op = advance().lexeme;
        left = binary(op, std::move(left), parseTerm());
    }
    return left;
}

// term -> unary { ('*' | '/') unary }
std::unique_ptr<Expr> Parser::parseTerm() {
    Scope scope(*this, "term");
    auto left = parseUnary();
    while (check(TokenType::STAR) || check(TokenType::SLASH)) {
        std::string op = advance().lexeme;
        left = binary(op, std::move(left), parseUnary());
    }
    return left;
}

// unary -> '-' unary | primary
std::unique_ptr<Expr> Parser::parseUnary() {
    Scope scope(*this, "unary");
    if (match(TokenType::MINUS)) {
        auto node = std::make_unique<UnaryExpr>();
        node->op = "-";
        node->start = startOf(previous());
        node->operand = parseUnary();
        node->end = node->operand->end;
        return node;
    }
    return parsePrimary();
}

// primary -> NUMBER | IDENT | ON | OFF | OPEN | CLOSED | TRUE | FALSE | '(' expr ')'
std::unique_ptr<Expr> Parser::parsePrimary() {
    Scope scope(*this, "primary");
    if (match(TokenType::LPAREN)) {
        Pos open = startOf(previous());
        auto inner = parseExpr();
        expect(TokenType::RPAREN, "')' to close the '(' at line " + std::to_string(open.line) +
                                  ", column " + std::to_string(open.col));
        return inner;
    }

    const Token& t = peek();
    auto op = std::make_unique<Operand>();
    if (t.type == TokenType::IDENTIFIER)  op->kind = OperandKind::Identifier;
    else if (t.type == TokenType::NUMBER) op->kind = OperandKind::Number;
    else if (isStateLiteral(t.type))      op->kind = OperandKind::State;
    else fail("a condition or value such as 'temperature > 30'");

    advance();
    op->text = t.lexeme;
    op->start = startOf(t);
    op->end = endOf(t);
    return op;
}
