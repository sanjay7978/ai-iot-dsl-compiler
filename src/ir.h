// ir.h — Phase 5: intermediate representation (three-address code).
//
// Every instruction has at most one operator, e.g.
//     t1 = temperature > 30
//     t2 = door == OPEN
//     t3 = t1 AND t2
//     IF_FALSE t3 GOTO L1
//     CALL turn_on(fan)
//     L1:
#pragma once

#include <string>
#include <vector>

#include "ast.h"

// One operand of an instruction.
struct IrValue {
    enum class Kind { None, Temp, Sensor, Number, State, Bool, Device };
    Kind kind = Kind::None;
    std::string text;   // t1, temperature, 30, OPEN, true/false, fan

    static IrValue temp(const std::string& t)   { return {Kind::Temp, t}; }
    static IrValue boolean(bool b)              { return {Kind::Bool, b ? "true" : "false"}; }
    bool isConstant() const { return kind == Kind::Number || kind == Kind::State || kind == Kind::Bool; }
    bool operator==(const IrValue& o) const { return kind == o.kind && text == o.text; }
    bool operator!=(const IrValue& o) const { return !(*this == o); }
};

enum class IrOp {
    Binary,    // dest = a op b      (op: > < >= <= == != AND OR + - * /)
    Not,       // dest = NOT a
    Neg,       // dest = - a
    Copy,      // dest = a
    IfFalse,   // IF_FALSE a GOTO label
    Goto,      // GOTO label
    Label,     // label:
    Call,      // CALL name(args)
    Rule       // marker comment: start of rule `rule` (source line `line`)
};

struct IrInstr {
    IrOp op = IrOp::Rule;
    std::string dest;            // Binary, Not, Copy
    std::string oper;            // Binary operator
    IrValue a, b;                // operands
    std::string label;           // IfFalse, Goto, Label
    std::string callee;          // Call
    std::vector<IrValue> args;   // Call
    int rule = 0;                // rule number this instruction belongs to
    int line = 0;                // Rule: source line of the rule
    bool numeric = false;        // dest holds a number (true) or true/false (false)

    static IrInstr of(IrOp op) { IrInstr in; in.op = op; return in; }
};

std::string irToString(const IrInstr& in);
const char* irOpName(IrOp op);
const char* irKindName(IrValue::Kind k);

// Number of real instructions (Rule markers are comments and do not count).
int irInstructionCount(const std::vector<IrInstr>& code);

class IrGenerator {
public:
    std::vector<IrInstr> generate(const Program& program);

private:
    IrValue genExpr(const Expr& e);
    void genActions(const std::vector<Action>& actions);
    std::string newTemp() { return "t" + std::to_string(++temps_); }
    std::string newLabel() { return "L" + std::to_string(++labels_); }
    void emit(IrInstr in) { in.rule = rule_; code_.push_back(std::move(in)); }

    std::vector<IrInstr> code_;
    int temps_ = 0;
    int labels_ = 0;
    int rule_ = 0;
};
