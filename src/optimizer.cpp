// optimizer.cpp — optimization passes over three-address code.
//
// The structural passes work on the control-flow graph (src/cfg.cpp):
//   * common sub-expression elimination uses AVAILABLE EXPRESSIONS, so a value
//     computed only inside one branch (e.g. an ELSE IF condition) is never
//     reused where that branch may not have run;
//   * unreachable code is found by REACHABILITY from the entry block;
//   * dead code is found by LIVENESS analysis.
// Sensors are read once per evaluation and every temporary is assigned
// exactly once, so expressions are never "killed" by later assignments.

#include "optimizer.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <set>

#include "cfg.h"

namespace {

enum Pass { kFold, kAlgebra, kCse, kCopy, kBranch, kUnreachable, kJumps, kDead, kPassCount };

bool isNumber(const IrValue& v, double value) {
    return v.kind == IrValue::Kind::Number && std::strtod(v.text.c_str(), nullptr) == value;
}

IrValue number(double v) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.10g", v);
    std::string s = buf;
    if (s == "-0") s = "0";
    return {IrValue::Kind::Number, s};
}

// Evaluates `a op b` when both operands are constants. Arithmetic gives a number,
// everything else gives true/false.
bool evaluate(const std::string& op, const IrValue& a, const IrValue& b, IrValue& result) {
    if (a.kind != b.kind) return false;
    if (a.kind == IrValue::Kind::Number) {
        double x = std::strtod(a.text.c_str(), nullptr), y = std::strtod(b.text.c_str(), nullptr);
        if (op == "+") { result = number(x + y); return true; }
        if (op == "-") { result = number(x - y); return true; }
        if (op == "*") { result = number(x * y); return true; }
        if (op == "/") { if (y == 0) return false; result = number(x / y); return true; }
        if (op == ">")  { result = IrValue::boolean(x > y);  return true; }
        if (op == "<")  { result = IrValue::boolean(x < y);  return true; }
        if (op == ">=") { result = IrValue::boolean(x >= y); return true; }
        if (op == "<=") { result = IrValue::boolean(x <= y); return true; }
        if (op == "==") { result = IrValue::boolean(x == y); return true; }
        if (op == "!=") { result = IrValue::boolean(x != y); return true; }
        return false;
    }
    if (a.kind == IrValue::Kind::State || a.kind == IrValue::Kind::Bool) {
        bool same = a.text == b.text;
        if (op == "==") { result = IrValue::boolean(same);  return true; }
        if (op == "!=") { result = IrValue::boolean(!same); return true; }
        if (a.kind == IrValue::Kind::Bool) {
            bool x = a.text == "true", y = b.text == "true";
            if (op == "AND") { result = IrValue::boolean(x && y); return true; }
            if (op == "OR")  { result = IrValue::boolean(x || y); return true; }
        }
    }
    return false;
}

void makeCopy(IrInstr& in, const IrValue& v) {
    in.op = IrOp::Copy;
    in.a = v;
    in.b = IrValue{};
    in.oper.clear();
}

bool definesTemp(const IrInstr& in) {
    return in.op == IrOp::Binary || in.op == IrOp::Not || in.op == IrOp::Neg || in.op == IrOp::Copy;
}

// Calls f on every operand that an instruction reads.
template <typename F>
void forEachUse(IrInstr& in, F f) {
    switch (in.op) {
        case IrOp::Binary:  f(in.a); f(in.b); break;
        case IrOp::Not:
        case IrOp::Neg:
        case IrOp::Copy:
        case IrOp::IfFalse: f(in.a); break;
        case IrOp::Call:    for (IrValue& v : in.args) f(v); break;
        default: break;
    }
}

}  // namespace

std::vector<IrInstr> Optimizer::optimize(std::vector<IrInstr> code, OptReport& report) {
    report = OptReport{};
    report.passes = {
        {"Constant folding", "Evaluates operations whose operands are all constants, e.g. 5 > 3 becomes true and 22 - 2 becomes 20", 0},
        {"Algebraic simplification", "x AND true -> x, x OR false -> x, NOT NOT x -> x, x + 0 -> x, x * 1 -> x, x * 0 -> 0", 0},
        {"Common sub-expression elimination", "Reuses a value that is available on every path (available-expressions analysis on the CFG)", 0},
        {"Copy propagation", "Replaces uses of t2 after t2 = t1 with t1 and removes the copy", 0},
        {"Constant branch elimination", "IF_FALSE true is removed; IF_FALSE false becomes GOTO", 0},
        {"Unreachable code elimination", "Removes basic blocks that cannot be reached from the entry block of the CFG", 0},
        {"Jump optimization", "Removes jumps to the very next instruction and labels nobody jumps to", 0},
        {"Dead code elimination", "Removes instructions whose result is not live (liveness analysis on the CFG)", 0},
    };
    report_ = &report;
    report.before = irInstructionCount(code);

    bool changed = true;
    for (int round = 0; changed && round < 50; ++round) {
        changed = false;
        changed |= constantFolding(code);
        changed |= algebraicSimplification(code);
        changed |= commonSubexpressions(code);
        changed |= copyPropagation(code);
        changed |= constantBranches(code);
        changed |= unreachableCode(code);
        changed |= redundantJumps(code);
        changed |= deadTemporaries(code);
    }

    report.after = irInstructionCount(code);
    return code;
}

bool Optimizer::constantFolding(std::vector<IrInstr>& code) {
    bool changed = false;
    for (IrInstr& in : code) {
        IrValue r;
        if (in.op == IrOp::Binary && in.a.isConstant() && in.b.isConstant() && evaluate(in.oper, in.a, in.b, r)) {
            makeCopy(in, r);
        } else if (in.op == IrOp::Not && in.a.kind == IrValue::Kind::Bool) {
            makeCopy(in, IrValue::boolean(in.a.text != "true"));
        } else if (in.op == IrOp::Neg && in.a.kind == IrValue::Kind::Number) {
            makeCopy(in, number(-std::strtod(in.a.text.c_str(), nullptr)));
        } else {
            continue;
        }
        bump(kFold);
        changed = true;
    }
    return changed;
}

bool Optimizer::algebraicSimplification(std::vector<IrInstr>& code) {
    std::map<std::string, const IrInstr*> def;   // temp -> defining instruction
    bool changed = false;
    auto simplified = [&](IrInstr& in, const IrValue& v) { makeCopy(in, v); bump(kAlgebra); changed = true; };

    for (IrInstr& in : code) {
        if (in.op == IrOp::Binary && (in.oper == "AND" || in.oper == "OR")) {
            bool isAnd = in.oper == "AND";
            for (int side = 0; side < 2 && in.op == IrOp::Binary; ++side) {
                const IrValue c = side == 0 ? in.a : in.b;
                const IrValue other = side == 0 ? in.b : in.a;
                if (c.kind != IrValue::Kind::Bool) continue;
                bool v = c.text == "true";
                simplified(in, isAnd == v ? other : IrValue::boolean(v));   // x AND true -> x, x OR true -> true
            }
            if (in.op == IrOp::Binary && in.a == in.b) simplified(in, in.a);   // x AND x, x OR x
        } else if (in.op == IrOp::Binary && (in.oper == "+" || in.oper == "-" || in.oper == "*" || in.oper == "/")) {
            if (in.oper == "+" && isNumber(in.a, 0)) simplified(in, in.b);
            else if ((in.oper == "+" || in.oper == "-") && isNumber(in.b, 0)) simplified(in, in.a);
            else if (in.oper == "*" && isNumber(in.a, 1)) simplified(in, in.b);
            else if ((in.oper == "*" || in.oper == "/") && isNumber(in.b, 1)) simplified(in, in.a);
            else if (in.oper == "*" && (isNumber(in.a, 0) || isNumber(in.b, 0))) simplified(in, number(0));
        } else if ((in.op == IrOp::Not || in.op == IrOp::Neg) && in.a.kind == IrValue::Kind::Temp) {
            auto it = def.find(in.a.text);
            if (it != def.end() && it->second->op == in.op) simplified(in, it->second->a);   // NOT NOT x, - - x
        }
        if (definesTemp(in)) def[in.dest] = &in;
    }
    return changed;
}

// CSE driven by available expressions: an expression is reused only if it was
// computed on EVERY path from the entry to this point.
bool Optimizer::commonSubexpressions(std::vector<IrInstr>& code) {
    Cfg cfg = buildCfg(code);
    std::vector<std::map<std::string, std::string>> availIn = availableExpressions(cfg, code);
    bool changed = false;
    for (const BasicBlock& b : cfg.blocks) {
        std::map<std::string, std::string> avail = availIn[static_cast<size_t>(b.id - 1)];
        for (size_t i = b.first; i < b.last; ++i) {
            IrInstr& in = code[i];
            std::string k = expressionKey(in);
            if (k.empty()) continue;
            auto it = avail.find(k);
            if (it != avail.end() && it->second != in.dest) {
                makeCopy(in, IrValue::temp(it->second));
                bump(kCse);
                changed = true;
            } else {
                avail.emplace(k, in.dest);
            }
        }
    }
    return changed;
}

// Safe globally: a copy t2 = v is only created where v is available, and every
// use of t2 comes after its single definition.
bool Optimizer::copyPropagation(std::vector<IrInstr>& code) {
    bool changed = false;
    for (size_t i = 0; i < code.size();) {
        if (code[i].op != IrOp::Copy) { ++i; continue; }
        const std::string dest = code[i].dest;
        const IrValue value = code[i].a;
        for (IrInstr& in : code)
            forEachUse(in, [&](IrValue& v) {
                if (v.kind == IrValue::Kind::Temp && v.text == dest) v = value;
            });
        code.erase(code.begin() + static_cast<long>(i));
        bump(kCopy);
        changed = true;
    }
    return changed;
}

bool Optimizer::constantBranches(std::vector<IrInstr>& code) {
    bool changed = false;
    for (size_t i = 0; i < code.size();) {
        IrInstr& in = code[i];
        if (in.op == IrOp::IfFalse && in.a.kind == IrValue::Kind::Bool) {
            bump(kBranch);
            changed = true;
            if (in.a.text == "true") { code.erase(code.begin() + static_cast<long>(i)); continue; }
            in.op = IrOp::Goto;   // IF_FALSE false GOTO L  ==  GOTO L
            in.a = IrValue{};
        }
        ++i;
    }
    return changed;
}

// Removes every basic block that cannot be reached from the entry block.
// Rule markers are comments and are kept so the listing stays readable.
bool Optimizer::unreachableCode(std::vector<IrInstr>& code) {
    Cfg cfg = buildCfg(code);
    std::set<int> reachable = reachableBlocks(cfg);
    std::vector<bool> drop(code.size(), false);
    int removed = 0;
    for (const BasicBlock& b : cfg.blocks) {
        if (reachable.count(b.id)) continue;
        for (size_t i = b.first; i < b.last; ++i)
            if (code[i].op != IrOp::Rule) { drop[i] = true; ++removed; }
    }
    if (!removed) return false;
    std::vector<IrInstr> kept;
    for (size_t i = 0; i < code.size(); ++i)
        if (!drop[i]) kept.push_back(code[i]);
    code = std::move(kept);
    bump(kUnreachable, removed);
    return true;
}

bool Optimizer::redundantJumps(std::vector<IrInstr>& code) {
    bool changed = false;

    // GOTO L / IF_FALSE x GOTO L immediately followed by L:
    for (size_t i = 0; i + 1 < code.size();) {
        const IrInstr& in = code[i];
        if ((in.op == IrOp::Goto || in.op == IrOp::IfFalse) &&
            code[i + 1].op == IrOp::Label && code[i + 1].label == in.label) {
            code.erase(code.begin() + static_cast<long>(i));
            bump(kJumps);
            changed = true;
            continue;
        }
        ++i;
    }

    // Labels that no jump refers to.
    std::set<std::string> targets;
    for (const IrInstr& in : code)
        if (in.op == IrOp::Goto || in.op == IrOp::IfFalse) targets.insert(in.label);
    for (size_t i = 0; i < code.size();) {
        if (code[i].op == IrOp::Label && !targets.count(code[i].label)) {
            code.erase(code.begin() + static_cast<long>(i));
            bump(kJumps);
            changed = true;
            continue;
        }
        ++i;
    }
    return changed;
}

// Dead code elimination with liveness: walking each block backwards from its
// live-out set, an instruction whose result is not live is removed.
bool Optimizer::deadTemporaries(std::vector<IrInstr>& code) {
    Cfg cfg = buildCfg(code);
    computeLiveness(cfg, code);
    std::vector<bool> drop(code.size(), false);
    int removed = 0;
    for (const BasicBlock& b : cfg.blocks) {
        std::set<std::string> live = b.liveOut;
        for (size_t i = b.last; i-- > b.first;) {
            const IrInstr& in = code[i];
            if (definesTemp(in)) {
                if (!live.count(in.dest)) { drop[i] = true; ++removed; continue; }
                live.erase(in.dest);
            }
            for (const std::string& t : tempsUsed(in)) live.insert(t);
        }
    }
    if (!removed) return false;
    std::vector<IrInstr> kept;
    for (size_t i = 0; i < code.size(); ++i)
        if (!drop[i]) kept.push_back(code[i]);
    code = std::move(kept);
    bump(kDead, removed);
    return true;
}
