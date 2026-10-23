// ir.cpp — translates the AST into three-address code.

#include "ir.h"

const char* irOpName(IrOp op) {
    switch (op) {
        case IrOp::Binary:  return "binary";
        case IrOp::Not:     return "not";
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

IrValue IrGenerator::operandValue(const Operand& op) const {
    switch (op.kind) {
        case OperandKind::Number:     return {IrValue::Kind::Number, op.text};
        case OperandKind::State:      return {IrValue::Kind::State, op.text};
        case OperandKind::Identifier: return {IrValue::Kind::Sensor, op.text};
    }
    return {};
}

// Emits code that computes the condition and returns where the result is.
IrValue IrGenerator::genCondition(const Condition& c) {
    if (const Comparison* cmp = dynamic_cast<const Comparison*>(&c)) {
        IrInstr in = IrInstr::of(IrOp::Binary);
        in.dest = newTemp();
        in.oper = cmp->op;
        in.a = operandValue(cmp->lhs);
        in.b = operandValue(cmp->rhs);
        emit(in);
        return IrValue::temp(in.dest);
    }
    if (const LogicalCond* l = dynamic_cast<const LogicalCond*>(&c)) {
        IrValue left = genCondition(*l->left);
        IrValue right = genCondition(*l->right);
        IrInstr in = IrInstr::of(IrOp::Binary);
        in.dest = newTemp();
        in.oper = l->op;
        in.a = left;
        in.b = right;
        emit(in);
        return IrValue::temp(in.dest);
    }
    const NotCond& n = dynamic_cast<const NotCond&>(c);
    IrValue v = genCondition(*n.operand);
    IrInstr in = IrInstr::of(IrOp::Not);
    in.dest = newTemp();
    in.a = v;
    emit(in);
    return IrValue::temp(in.dest);
}

void IrGenerator::genActions(const std::vector<Action>& actions) {
    for (const Action& a : actions) {
        IrInstr in = IrInstr::of(IrOp::Call);
        in.callee = a.name;
        for (size_t i = 0; i < a.args.size(); ++i) {
            const Operand& arg = a.args[i];
            if (arg.kind == OperandKind::Number) in.args.push_back({IrValue::Kind::Number, arg.text});
            else if (i == 0) in.args.push_back({IrValue::Kind::Device, arg.text});   // first arg is the device
            else in.args.push_back({IrValue::Kind::Sensor, arg.text});
        }
        emit(in);
    }
}

// rule:  IF c THEN A ELSE B          rule without ELSE:
//          <code for c in tN>           <code for c in tN>
//          IF_FALSE tN GOTO L1          IF_FALSE tN GOTO L1
//          <A>                          <A>
//          GOTO L2                      L1:
//        L1:
//          <B>
//        L2:
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

        IrValue cond = genCondition(*r->condition);
        std::string elseLabel = newLabel();
        IrInstr jump = IrInstr::of(IrOp::IfFalse);
        jump.a = cond;
        jump.label = elseLabel;
        emit(jump);

        genActions(r->thenActions);

        if (r->elseActions.empty()) {
            IrInstr lbl = IrInstr::of(IrOp::Label);
            lbl.label = elseLabel;
            emit(lbl);
        } else {
            std::string endLabel = newLabel();
            IrInstr skip = IrInstr::of(IrOp::Goto);
            skip.label = endLabel;
            emit(skip);
            IrInstr lbl = IrInstr::of(IrOp::Label);
            lbl.label = elseLabel;
            emit(lbl);
            genActions(r->elseActions);
            IrInstr end = IrInstr::of(IrOp::Label);
            end.label = endLabel;
            emit(end);
        }
    }
    return code_;
}
