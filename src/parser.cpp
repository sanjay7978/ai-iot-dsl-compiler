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

// If `t` is a lowercase spelling of a keyword (e.g. "if"), returns a hint.
std::string keywordCaseHint(const Token& t) {
    if (t.type != TokenType::IDENTIFIER) return "";
    std::string upper;
    for (char c : t.lexeme) upper += static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
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
    if (!check(TokenType::END_OF_FILE)) ++current_;
    return previous();
}

bool Parser::match(TokenType t) {
    if (!check(t)) return false;
    advance();
    return true;
}

const Token& Parser::expect(TokenType t, const std::string& what) {
    if (check(t)) return advance();
    fail(what);
}

// ---------- Error handling --------------------------------------------------

void Parser::fail(const std::string& expected, const std::string& hint) {
    const Token& t = peek();
    std::string msg = "expected " + expected + " but found " + describe(t);
    std::string h = hint.empty() ? keywordCaseHint(t) : hint;
    if (!h.empty()) msg += " (" + h + ")";

    // At end of file, point just after the last real token instead of at an
    // empty line, since that is where the missing token belongs.
    if (t.type == TokenType::END_OF_FILE && current_ > 0) {
        const Token& last = previous();
        errors_.push_back(Diagnostic{"syntax", last.line, last.col + last.length, 1, msg});
    } else {
        errors_.push_back(Diagnostic{"syntax", t.line, t.col, t.length > 0 ? t.length : 1, msg});
    }
    throw ParseError{};
}

// Panic-mode recovery: discard tokens until one that can start a statement.
void Parser::synchronize() {
    while (!check(TokenType::END_OF_FILE) && !startsStatement(peek().type)) advance();
}

// ---------- Grammar rules ---------------------------------------------------

// program -> { declaration | rule } EOF
std::unique_ptr<Program> Parser::parse() {
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

// rule -> IF condition THEN action { action } [ ELSE action { action } ]
std::unique_ptr<Statement> Parser::parseRule() {
    auto rule = std::make_unique<Rule>();
    rule->start = startOf(expect(TokenType::IF, "'IF'"));

    rule->condition = parseCondition();
    expect(TokenType::THEN, "'THEN' after the condition");
    rule->thenActions = parseActionList("THEN");

    if (match(TokenType::ELSE)) rule->elseActions = parseActionList("ELSE");

    rule->end = endOf(previous());
    ++rules_;
    return rule;
}

// One or more actions. Actions always start with an identifier, so we keep
// reading while the next token is an IDENTIFIER.
std::vector<Action> Parser::parseActionList(const std::string& after) {
    if (!check(TokenType::IDENTIFIER))
        fail("an action such as turn_on(fan) after '" + after + "'");

    std::vector<Action> actions;
    while (check(TokenType::IDENTIFIER)) actions.push_back(parseAction());
    return actions;
}

// action -> IDENT '(' [ operand { ',' operand } ] ')'
Action Parser::parseAction() {
    Action action;
    const Token& name = expect(TokenType::IDENTIFIER, "an action name");
    action.name = name.lexeme;
    action.start = startOf(name);

    if (!check(TokenType::LPAREN)) {
        // A lowercase keyword ("if") after an action is read as an identifier.
        std::string hint = keywordCaseHint(name);
        if (!hint.empty()) hint = "'" + name.lexeme + "' was read as an action name; " + hint;
        fail("'(' after action name '" + name.lexeme + "'", hint);
    }
    advance();   // '('

    if (!check(TokenType::RPAREN)) {
        action.args.push_back(parseOperand("an argument"));
        while (match(TokenType::COMMA)) action.args.push_back(parseOperand("an argument after ','"));
    }
    if (!check(TokenType::RPAREN)) fail("',' or ')' in the argument list of '" + action.name + "'");
    advance();   // ')'

    action.end = endOf(previous());
    return action;
}

// condition -> and_expr { OR and_expr }       (lowest precedence)
std::unique_ptr<Condition> Parser::parseCondition() {
    auto left = parseAnd();
    while (match(TokenType::OR)) {
        auto node = std::make_unique<LogicalCond>();
        node->op = "OR";
        node->left = std::move(left);
        node->right = parseAnd();
        node->start = node->left->start;
        node->end = node->right->end;
        left = std::move(node);
    }
    return left;
}

// and_expr -> not_expr { AND not_expr }
std::unique_ptr<Condition> Parser::parseAnd() {
    auto left = parseNot();
    while (match(TokenType::AND)) {
        auto node = std::make_unique<LogicalCond>();
        node->op = "AND";
        node->left = std::move(left);
        node->right = parseNot();
        node->start = node->left->start;
        node->end = node->right->end;
        left = std::move(node);
    }
    return left;
}

// not_expr -> NOT not_expr | primary          (highest precedence)
std::unique_ptr<Condition> Parser::parseNot() {
    if (match(TokenType::NOT)) {
        auto node = std::make_unique<NotCond>();
        node->start = startOf(previous());
        node->operand = parseNot();
        node->end = node->operand->end;
        return node;
    }
    return parsePrimary();
}

// primary -> '(' condition ')' | operand relop operand
std::unique_ptr<Condition> Parser::parsePrimary() {
    if (match(TokenType::LPAREN)) {
        Pos open = startOf(previous());
        auto inner = parseCondition();
        expect(TokenType::RPAREN, "')' to close the '(' at line " + std::to_string(open.line) +
                                  ", column " + std::to_string(open.col));
        return inner;
    }

    auto cmp = std::make_unique<Comparison>();
    cmp->lhs = parseOperand("a condition such as 'temperature > 30'");
    if (!isRelOp(peek().type)) fail("a comparison operator (>, <, >=, <=, ==, !=)");
    cmp->op = advance().lexeme;
    cmp->rhs = parseOperand("a value after '" + cmp->op + "'");
    cmp->start = cmp->lhs.start;
    cmp->end = cmp->rhs.end;
    return cmp;
}

// operand -> IDENT | NUMBER | ON | OFF | OPEN | CLOSED | TRUE | FALSE
Operand Parser::parseOperand(const std::string& what) {
    const Token& t = peek();
    Operand op;
    if (t.type == TokenType::IDENTIFIER)  op.kind = OperandKind::Identifier;
    else if (t.type == TokenType::NUMBER) op.kind = OperandKind::Number;
    else if (isStateLiteral(t.type))      op.kind = OperandKind::State;
    else fail(what);

    advance();
    op.text = t.lexeme;
    op.start = startOf(t);
    op.end = endOf(t);
    return op;
}
