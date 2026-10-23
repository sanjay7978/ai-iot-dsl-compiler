// ir.cpp — translates the AST into three-address code.

#include "ir.h"

const char* irOpName(IrOp op) {
    switch (op) {
        case IrOp::Binary:  return "binary";
        case IrOp::Not:     return "not";
        case IrOp::Neg:     return "neg";
        case IrOp::Copy:    return "copy";
        case IrOp::IfFalse: return "if_false";
        case IrOp::Goto:    return "goto";
        case IrOp::Label:   return "label";
        case IrOp::Call:    return "call";
        case IrOp::Rule:    return "rule";
    }
    return "?";
}

const char* irKindName(IrValue::Kind k) {
    switch (k) {
        case IrValue::Kind::None:   return "none";
        case IrValue::Kind::Temp:   return "temp";
        case IrValue::Kind::Sensor: return "sensor";
        case IrValue::Kind::Number: return "number";
        case IrValue::Kind::State:  return "state";
        case IrValue::Kind::Bool:   return "bool";
        case IrValue::Kind::Device: return "device";
    }
    return "none";
}

std::string irToString(const IrInstr& in) {
    switch (in.op) {
        case IrOp::Binary:  return in.dest + " = " + in.a.text + " " + in.oper + " " + in.b.text;
        case IrOp::Not:     return in.dest + " = NOT " + in.a.text;
        case IrOp::Neg:     return in.dest + " = - " + in.a.text;
        case IrOp::Copy:    return in.dest + " = " + in.a.text;
        case IrOp::IfFalse: return "IF_FALSE " + in.a.text + " GOTO " + in.label;
        case IrOp::Goto:    return "GOTO " + in.label;
        case IrOp::Label:   return in.label + ":";
        case IrOp::Rule:    return "# Rule " + std::to_string(in.rule) + " (line " + std::to_string(in.line) + ")";
        case IrOp::Call: {
            std::string s = "CALL " + in.callee + "(";
            for (size_t i = 0; i < in.args.size(); ++i) s += (i ? ", " : "") + in.args[i].text;
            return s + ")";
        }
    }
    return "";
}

int irInstructionCount(const std::vector<IrInstr>& code) {
    int n = 0;
    for (const IrInstr& in : code)
        if (in.op != IrOp::Rule) ++n;
    return n;
}

// ---------- Generator -------------------------------------------------------

// Emits code that computes the expression and returns where the result is.
// Leaves (names and literals) need no instruction; every operator gets a temporary.
IrValue IrGenerator::genExpr(const Expr& e) {
    if (const Operand* op = dynamic_cast<const Operand*>(&e)) {
        switch (op->kind) {
            case OperandKind::Number:     return {IrValue::Kind::Number, op->text};
            case OperandKind::State:      return {IrValue::Kind::State, op->text};
            case OperandKind::Identifier: return {IrValue::Kind::Sensor, op->text};
        }
    }
    if (const UnaryExpr* u = dynamic_cast<const UnaryExpr*>(&e)) {
        IrValue v = genExpr(*u->operand);
        IrInstr in = IrInstr::of(u->op == "NOT" ? IrOp::Not : IrOp::Neg);
        in.dest = newTemp();
        in.a = v;
        in.numeric = u->op == "-";
        emit(in);
        return IrValue::temp(in.dest);
    }
    const BinaryExpr& b = dynamic_cast<const BinaryExpr&>(e);
    IrValue left = genExpr(*b.left);
    IrValue right = genExpr(*b.right);
    IrInstr in = IrInstr::of(IrOp::Binary);
    in.dest = newTemp();
    in.oper = b.op;
    in.a = left;
    in.b = right;
    in.numeric = isArithmeticOp(b.op);
    emit(in);
    return IrValue::temp(in.dest);
}

void IrGenerator::genActions(const std::vector<Action>& actions) {
    for (const Action& a : actions) {
        // Arguments are evaluated first; the first argument is always the device.
        std::vector<IrValue> args;
        for (size_t i = 0; i < a.args.size(); ++i) {
            const Operand* op = dynamic_cast<const Operand*>(a.args[i].get());
            if (i == 0 && op) args.push_back({IrValue::Kind::Device, op->text});
            else args.push_back(genExpr(*a.args[i]));
        }
        IrInstr in = IrInstr::of(IrOp::Call);
        in.callee = a.name;
        in.args = args;
        emit(in);
    }
}

// rule:  IF c1 THEN A ELSE IF c2 THEN B ELSE C
//          <code for c1 in tN>
//          IF_FALSE tN GOTO L1
//          <A>
//          GOTO Lend
//        L1:
//          <code for c2 in tM>
//          IF_FALSE tM GOTO L2
//          <B>
//          GOTO Lend
//        L2:
//          <C>
//        Lend:
// The last test jumps straight to Lend when there is no ELSE part, and a
// plain IF without ELSE needs no GOTO at all.
std::vector<IrInstr> IrGenerator::generate(const Program& program) {
    code_.clear();
    temps_ = labels_ = rule_ = 0;

    for (const auto& s : program.statements) {
        const Rule* r = dynamic_cast<const Rule*>(s.get());
        if (!r) continue;   // declarations produce no code

        ++rule_;
        IrInstr marker = IrInstr::of(IrOp::Rule);
        marker.line = r->start.line;
        emit(marker);

        bool hasElse = !r->elseActions.empty();
        bool single = r->branches.size() == 1 && !hasElse;
        std::string endLabel;   // created when first needed, so labels are numbered in order
        auto end = [&]() { if (endLabel.empty()) endLabel = newLabel(); return endLabel; };

        for (size_t i = 0; i < r->branches.size(); ++i) {
            const Branch& b = r->branches[i];
            bool last = i + 1 == r->branches.size();
            IrValue cond = genExpr(*b.condition);

            std::string next = (last && !hasElse && !single) ? end() : newLabel();
            IrInstr jump = IrInstr::of(IrOp::IfFalse);
            jump.a = cond;
            jump.label = next;
            emit(jump);

            genActions(b.actions);

            if (single) {
                IrInstr lbl = IrInstr::of(IrOp::Label);
                lbl.label = next;
                emit(lbl);
            } else if (!(last && !hasElse)) {
                IrInstr skip = IrInstr::of(IrOp::Goto);
                skip.label = end();
                emit(skip);
                IrInstr lbl = IrInstr::of(IrOp::Label);
                lbl.label = next;
                emit(lbl);
            }
        }

        if (hasElse) genActions(r->elseActions);
        if (!single) {
            IrInstr lbl = IrInstr::of(IrOp::Label);
            lbl.label = end();
            emit(lbl);
        }
    }
    return code_;
}
