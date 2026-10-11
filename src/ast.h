// ast.h — Abstract Syntax Tree produced by the parser (Phase 2).
//
// Grammar (see docs/DESIGN.md):
//   program     -> { declaration | rule } EOF
//   declaration -> SENSOR IDENT ':' (NUMBER | STATE) | DEVICE IDENT { ',' IDENT }
//   rule        -> IF condition THEN action { action } [ ELSE action { action } ]
//   condition   -> and_expr { OR and_expr }
//   and_expr    -> not_expr { AND not_expr }
//   not_expr    -> NOT not_expr | primary
//   primary     -> '(' condition ')' | operand relop operand
//   action      -> IDENT '(' [ operand { ',' operand } ] ')'
#pragma once

#include <memory>
#include <ostream>
#include <string>
#include <vector>

#include "token.h"

// A generic, printable view of any AST node. The tree printer, the Graphviz
// exporter and the JSON writer all work on this one shape.
struct DisplayNode {
    std::string kind;    // program, decl, rule, block, logic, compare, ident, number, state, type, action
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

// ---------- Operands -------------------------------------------------------

enum class OperandKind { Identifier, Number, State };

struct Operand : Node {
    OperandKind kind = OperandKind::Identifier;
    std::string text;
    DisplayNode display() const override;
};

// ---------- Conditions -----------------------------------------------------

struct Condition : Node {};

// left AND right, left OR right
struct LogicalCond : Condition {
    std::string op;
    std::unique_ptr<Condition> left, right;
    DisplayNode display() const override;
};

// NOT operand
struct NotCond : Condition {
    std::unique_ptr<Condition> operand;
    DisplayNode display() const override;
};

// lhs relop rhs, e.g. temperature > 30
struct Comparison : Condition {
    std::string op;
    Operand lhs, rhs;
    DisplayNode display() const override;
};

// ---------- Actions and statements -----------------------------------------

// turn_on(fan), set_level(ac, 22.5)
struct Action : Node {
    std::string name;
    std::vector<Operand> args;
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

// IF condition THEN actions [ELSE actions]
struct Rule : Statement {
    std::unique_ptr<Condition> condition;
    std::vector<Action> thenActions;
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
