// optimizer.cpp — optimization passes over three-address code.
//
// Every temporary is assigned exactly once and all temporaries are computed
// before a rule's branch, so a value computed in one rule is still valid in
// later rules (sensors are read once per evaluation). That makes global
// copy propagation and common sub-expression elimination safe.

#include "optimizer.h"

#include <algorithm>
#include <cstdlib>
#include <map>
#include <set>

namespace {

enum Pass { kFold, kAlgebra, kCse, kCopy, kBranch, kUnreachable, kJumps, kDead, kPassCount };

bool isBool(const IrValue& v, bool value) {
    return v.kind == IrValue::Kind::Bool && v.text == (value ? "true" : "false");
}

// Evaluates `a op b` when both operands are constants.
bool evaluate(const std::string& op, const IrValue& a, const IrValue& b, bool& result) {
    if (a.kind != b.kind) return false;
    if (a.kind == IrValue::Kind::Number) {
        double x = std::strtod(a.text.c_str(), nullptr), y = std::strtod(b.text.c_str(), nullptr);
        if (op == ">")  { result = x > y;  return true; }
        if (op == "<")  { result = x < y;  return true; }
        if (op == ">=") { result = x >= y; return true; }
        if (op == "<=") { result = x <= y; return true; }
        if (op == "==") { result = x == y; return true; }
        if (op == "!=") { result = x != y; return true; }
        return false;
    }
    if (a.kind == IrValue::Kind::State || a.kind == IrValue::Kind::Bool) {
        bool same = a.text == b.text;
        if (op == "==") { result = same;  return true; }
        if (op == "!=") { result = !same; return true; }
        if (a.kind == IrValue::Kind::Bool) {
            bool x = a.text == "true", y = b.text == "true";
            if (op == "AND") { result = x && y; return true; }
            if (op == "OR")  { result = x || y; return true; }
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

// Calls f on every operand that an instruction reads.
template <typename F>
void forEachUse(IrInstr& in, F f) {
    switch (in.op) {
        case IrOp::Binary:  f(in.a); f(in.b); break;
        case IrOp::Not:
        case IrOp::Copy:
        case IrOp::IfFalse: f(in.a); break;
        case IrOp::Call:    for (IrValue& v : in.args) f(v); break;
        default: break;
    }
}

bool definesTemp(const IrInstr& in) {
    return in.op == IrOp::Binary || in.op == IrOp::Not || in.op == IrOp::Copy;
}

std::string key(const IrValue& v) { return std::string(irKindName(v.kind)) + ":" + v.text; }

}  // namespace

std::vector<IrInstr> Optimizer::optimize(std::vector<IrInstr> code, OptReport& report) {
    report = OptReport{};
    report.passes = {
        {"Constant folding", "Evaluates operations whose operands are all constants, e.g. 5 > 3 becomes true", 0},
        {"Algebraic simplification", "x AND true -> x, x OR false -> x, x AND false -> false, NOT NOT x -> x", 0},
        {"Common sub-expression elimination", "Reuses a value that was already computed, e.g. the same comparison in two rules", 0},
        {"Copy propagation", "Replaces uses of t2 after t2 = t1 with t1 and removes the copy", 0},
        {"Constant branch elimination", "IF_FALSE true is removed; IF_FALSE false becomes GOTO", 0},
        {"Unreachable code removal", "Removes instructions that can never run because they follow a GOTO", 0},
        {"Jump optimization", "Removes jumps to the very next instruction and labels nobody jumps to", 0},
        {"Dead code elimination", "Removes temporaries whose value is never used", 0},
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
        if (in.op == IrOp::Binary && in.a.isConstant() && in.b.isConstant()) {
            bool r;
            if (evaluate(in.oper, in.a, in.b, r)) { makeCopy(in, IrValue::boolean(r)); bump(kFold); changed = true; }
        } else if (in.op == IrOp::Not && in.a.kind == IrValue::Kind::Bool) {
            makeCopy(in, IrValue::boolean(in.a.text != "true"));
            bump(kFold);
            changed = true;
        }
    }
    return changed;
}

bool Optimizer::algebraicSimplification(std::vector<IrInstr>& code) {
    std::map<std::string, const IrInstr*> def;   // temp -> defining instruction
    bool changed = false;
    for (IrInstr& in : code) {
        if (in.op == IrOp::Binary && (in.oper == "AND" || in.oper == "OR")) {
            bool isAnd = in.oper == "AND";
            for (int side = 0; side < 2; ++side) {
                const IrValue& c = side == 0 ? in.a : in.b;
                const IrValue other = side == 0 ? in.b : in.a;
                if (c.kind != IrValue::Kind::Bool) continue;
                bool v = c.text == "true";
                if (isAnd == v) makeCopy(in, other);                   // x AND true, x OR false
                else            makeCopy(in, IrValue::boolean(v));     // x AND false, x OR true
                bump(kAlgebra);
                changed = true;
                break;
            }
            if (in.op == IrOp::Binary && in.a == in.b) {               // x AND x, x OR x
                makeCopy(in, in.a);
                bump(kAlgebra);
                changed = true;
            }
        } else if (in.op == IrOp::Not && in.a.kind == IrValue::Kind::Temp) {
            auto it = def.find(in.a.text);
            if (it != def.end() && it->second->op == IrOp::Not) {      // NOT NOT x
                makeCopy(in, it->second->a);
                bump(kAlgebra);
                changed = true;
            }
        }
        if (definesTemp(in)) def[in.dest] = &in;
    }
    return changed;
}

bool Optimizer::commonSubexpressions(std::vector<IrInstr>& code) {
    std::map<std::string, std::string> seen;   // expression -> temp holding it
    bool changed = false;
    for (IrInstr& in : code) {
        std::string k;
        if (in.op == IrOp::Binary) {
            std::string a = key(in.a), b = key(in.b);
            bool commutative = in.oper == "==" || in.oper == "!=" || in.oper == "AND" || in.oper == "OR";
            if (commutative && b < a) std::swap(a, b);
            k = in.oper + "|" + a + "|" + b;
        } else if (in.op == IrOp::Not) {
            k = "NOT|" + key(in.a);
        } else {
            continue;
        }
        auto it = seen.find(k);
        if (it != seen.end()) {
            makeCopy(in, IrValue::temp(it->second));
            bump(kCse);
            changed = true;
        } else {
            seen[k] = in.dest;
        }
    }
    return changed;
}

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
            if (isBool(in.a, true)) { code.erase(code.begin() + static_cast<long>(i)); continue; }
            in.op = IrOp::Goto;   // IF_FALSE false GOTO L  ==  GOTO L
            in.a = IrValue{};
        }
        ++i;
    }
    return changed;
}

bool Optimizer::unreachableCode(std::vector<IrInstr>& code) {
    bool changed = false;
    for (size_t i = 0; i < code.size(); ++i) {
        if (code[i].op != IrOp::Goto) continue;
        size_t j = i + 1;
        while (j < code.size() && code[j].op != IrOp::Label && code[j].op != IrOp::Rule) ++j;
        if (j > i + 1) {
            bump(kUnreachable, static_cast<int>(j - i - 1));
            code.erase(code.begin() + static_cast<long>(i + 1), code.begin() + static_cast<long>(j));
            changed = true;
        }
    }
    return changed;
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

bool Optimizer::deadTemporaries(std::vector<IrInstr>& code) {
    std::set<std::string> used;
    for (IrInstr& in : code)
        forEachUse(in, [&](IrValue& v) {
            if (v.kind == IrValue::Kind::Temp) used.insert(v.text);
        });

    bool changed = false;
    for (size_t i = 0; i < code.size();) {
        if (definesTemp(code[i]) && !used.count(code[i].dest)) {
            code.erase(code.begin() + static_cast<long>(i));
            bump(kDead);
            changed = true;
            continue;
        }
        ++i;
    }
    return changed;
}
