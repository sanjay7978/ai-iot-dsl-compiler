// ast.h — Abstract Syntax Tree produced by the parser (Phase 2).
//
// Grammar (see docs/DESIGN.md):
//   program     -> { declaration | rule } EOF
//   declaration -> SENSOR IDENT ':' (NUMBER | STATE) | DEVICE IDENT { ',' IDENT }
//   rule        -> IF expr THEN actions { ELSE IF expr THEN actions } [ ELSE actions ]
//   expr        -> and_expr { OR and_expr }
//   and_expr    -> not_expr { AND not_expr }
//   not_expr    -> NOT not_expr | rel_expr
//   rel_expr    -> arith [ relop arith ]
//   arith       -> term { ('+' | '-') term }
//   term        -> unary { ('*' | '/') unary }
//   unary       -> '-' unary | primary
//   primary     -> NUMBER | IDENT | state_literal | '(' expr ')'
//   action      -> IDENT '(' [ expr { ',' expr } ] ')'
#pragma once

#include <memory>
#include <ostream>
#include <string>
#include <vector>

#include "token.h"

// A generic, printable view of any AST node. The tree printer, the Graphviz
// exporter and the JSON writer all work on this one shape.
struct DisplayNode {
    std::string kind;    // program, decl, rule, block, logic, compare, arith, ident, number, state, type, action
    std::string label;
    Pos start, end;      // source span (end is exclusive)
    std::vector<DisplayNode> children;
};

struct Node {
    Pos start, end;
    virtual ~Node() = default;
    virtual DisplayNode display() const = 0;

protected:
    DisplayNode makeDisplay(const std::string& kind, const std::string& label) const;
};

// ---------- Expressions ----------------------------------------------------
// Conditions and arithmetic share one expression tree; semantic analysis
// decides which sub-expressions are numbers, states or true/false values.

struct Expr : Node {};

enum class OperandKind { Identifier, Number, State };

// Leaf: a name (sensor or device), a number or a state literal.
struct Operand : Expr {
    OperandKind kind = OperandKind::Identifier;
    std::string text;
    DisplayNode display() const override;
};

// left op right, where op is AND, OR, > < >= <= == !=, + - * /
struct BinaryExpr : Expr {
    std::string op;
    std::unique_ptr<Expr> left, right;
    DisplayNode display() const override;
};

// NOT x, -x
struct UnaryExpr : Expr {
    std::string op;   // "NOT" or "-"
    std::unique_ptr<Expr> operand;
    DisplayNode display() const override;
};

bool isLogicalOp(const std::string& op);      // AND OR
bool isRelationalOp(const std::string& op);   // > < >= <= == !=
bool isArithmeticOp(const std::string& op);   // + - * /

// ---------- Actions and statements -----------------------------------------

// turn_on(fan), set_level(ac, 22.5), set_level(heater, (22 - temperature) * 10)
struct Action : Node {
    std::string name;
    std::vector<std::unique_ptr<Expr>> args;
    DisplayNode display() const override;
};

struct Statement : Node {};

// SENSOR temperature : NUMBER
struct SensorDecl : Statement {
    Operand name;
    std::string type;     // "NUMBER" or "STATE"
    Pos typeStart, typeEnd;
    DisplayNode display() const override;
};

// DEVICE fan, light
struct DeviceDecl : Statement {
    std::vector<Operand> names;
    DisplayNode display() const override;
};

// One "IF/ELSE IF condition THEN actions" part of a rule.
struct Branch {
    std::unique_ptr<Expr> condition;
    std::vector<Action> actions;
    Pos start;   // position of IF (or of ELSE for an ELSE IF)
};

// IF c1 THEN a1 ELSE IF c2 THEN a2 ... ELSE a3
struct Rule : Statement {
    std::vector<Branch> branches;     // first is the IF, the rest are ELSE IFs
    std::vector<Action> elseActions;
    DisplayNode display() const override;
};

struct Program : Node {
    std::vector<std::unique_ptr<Statement>> statements;
    DisplayNode display() const override;
};

// Prints the tree with box-drawing connectors (├── └──).
void printTree(const DisplayNode& node, std::ostream& out);

// Prints the tree in Graphviz DOT format (render with: dot -Tpng ast.dot -o ast.png).
void printDot(const DisplayNode& node, std::ostream& out);
