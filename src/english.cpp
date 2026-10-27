// english.cpp — AST -> English sentences.

#include "english.h"

namespace {

// soil_moisture -> "soil moisture"
std::string words(const std::string& name) {
    std::string s;
    for (char c : name) s += c == '_' ? ' ' : c;
    return s;
}

std::string lower(const std::string& s) {
    std::string r;
    for (char c : s) r += static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c);
    return r;
}

std::string capitalize(std::string s) {
    if (!s.empty() && s[0] >= 'a' && s[0] <= 'z') s[0] = static_cast<char>(s[0] - 'a' + 'A');
    return s;
}

std::string joinList(const std::vector<std::string>& items) {
    std::string s;
    for (size_t i = 0; i < items.size(); ++i)
        s += (i == 0 ? "" : i + 1 == items.size() ? " and " : ", ") + items[i];
    return s;
}

std::string mirror(const std::string& op) {   // 30 < t  ->  t > 30
    if (op == ">") return "<";
    if (op == "<") return ">";
    if (op == ">=") return "<=";
    if (op == "<=") return ">=";
    return op;
}

std::string negate(const std::string& op) {
    if (op == ">") return "<=";
    if (op == "<") return ">=";
    if (op == ">=") return "<";
    if (op == "<=") return ">";
    if (op == "==") return "!=";
    return "==";
}

std::string value(const Expr& e);

std::string arithWord(const std::string& op) {
    if (op == "+") return "plus";
    if (op == "-") return "minus";
    if (op == "*") return "times";
    return "divided by";
}

// A number-valued expression in words.
std::string value(const Expr& e) {
    if (const Operand* o = dynamic_cast<const Operand*>(&e)) {
        if (o->kind == OperandKind::Identifier) return "the " + words(o->text);
        if (o->kind == OperandKind::State) return lower(o->text);
        return o->text;
    }
    if (const UnaryExpr* u = dynamic_cast<const UnaryExpr*>(&e)) return "minus " + value(*u->operand);
    const BinaryExpr& b = dynamic_cast<const BinaryExpr&>(e);
    auto side = [](const Expr& x) {   // brackets show grouping: "(22 minus the temperature) times 10"
        return dynamic_cast<const BinaryExpr*>(&x) ? "(" + value(x) + ")" : value(x);
    };
    return side(*b.left) + " " + arithWord(b.op) + " " + side(*b.right);
}

// "the temperature is above 30", "the door is not open"
std::string comparison(const BinaryExpr& c, bool negated) {
    std::string op = negated ? negate(c.op) : c.op;
    const Expr* subject = c.left.get();
    const Expr* object = c.right.get();
    const Operand* l = dynamic_cast<const Operand*>(subject);
    const Operand* r = dynamic_cast<const Operand*>(object);
    if (l && l->kind != OperandKind::Identifier && !(r && r->kind != OperandKind::Identifier)) {
        std::swap(subject, object);   // put the sensor first: "30 < t" -> "t > 30"
        op = mirror(op);
    }
    std::string verb;
    if (op == ">") verb = "is above";
    else if (op == "<") verb = "is below";
    else if (op == ">=") verb = "is at least";
    else if (op == "<=") verb = "is at most";
    else if (op == "==") verb = "is";
    else verb = "is not";
    return value(*subject) + " " + verb + " " + value(*object);
}

std::string condition(const Expr& e, bool negated = false);

std::string condition(const Expr& e, bool negated) {
    if (const UnaryExpr* u = dynamic_cast<const UnaryExpr*>(&e)) {
        if (u->op == "NOT") return condition(*u->operand, !negated);
        return (negated ? "not " : "") + value(e);
    }
    if (const BinaryExpr* b = dynamic_cast<const BinaryExpr*>(&e)) {
        if (isRelationalOp(b->op)) return comparison(*b, negated);
        if (isLogicalOp(b->op)) {
            // De Morgan when negated: NOT (a AND b) = NOT a OR NOT b
            bool isAnd = (b->op == "AND") != negated;
            auto side = [&](const Expr& s) {
                std::string text = condition(s, negated);
                const BinaryExpr* sb = dynamic_cast<const BinaryExpr*>(&s);
                bool other = sb && isLogicalOp(sb->op) && ((sb->op == "AND") != negated) != isAnd;
                return other ? "(" + text + ")" : text;
            };
            std::string l = side(*b->left), r = side(*b->right);
            return isAnd ? l + " and " + r : "either " + l + " or " + r;
        }
        return (negated ? "not " : "") + value(e);
    }
    const Operand& o = dynamic_cast<const Operand&>(e);
    return (negated ? "not " : "") + value(o);
}

std::string action(const Action& a) {
    std::string device = a.args.empty() ? "" : value(*a.args[0]);
    if (a.name == "turn_on") return "turn on " + device;
    if (a.name == "turn_off") return "turn off " + device;
    if (a.name == "toggle") return "toggle " + device;
    if (a.name == "set_level" && a.args.size() == 2) return "set " + device + " to level " + value(*a.args[1]);
    return a.name + " " + device;
}

std::string actions(const std::vector<Action>& list) {
    std::vector<std::string> parts;
    for (const Action& a : list) parts.push_back(action(a));
    return joinList(parts);
}

}  // namespace

std::vector<std::string> describeProgram(const Program& program) {
    std::vector<std::string> out;
    std::vector<std::string> numbers, states, devices;
    for (const auto& s : program.statements) {
        if (const SensorDecl* d = dynamic_cast<const SensorDecl*>(s.get()))
            (d->type == "NUMBER" ? numbers : states).push_back(words(d->name.text));
        else if (const DeviceDecl* d = dynamic_cast<const DeviceDecl*>(s.get()))
            for (const Operand& n : d->names) devices.push_back(words(n.text));
    }
    if (!numbers.empty() || !states.empty() || !devices.empty()) {
        std::vector<std::string> parts;
        auto noun = [](const std::vector<std::string>& v, const std::string& w) {
            return w + (v.size() == 1 ? " " : "s ") + joinList(v);
        };
        if (!numbers.empty()) parts.push_back("reads the number " + noun(numbers, "sensor"));
        if (!states.empty()) parts.push_back("reads the state " + noun(states, "sensor"));
        if (!devices.empty()) parts.push_back("controls the " + noun(devices, "device"));
        out.push_back("The program " + joinList(parts) + ".");
    }

    int n = 0;
    for (const auto& s : program.statements) {
        const Rule* r = dynamic_cast<const Rule*>(s.get());
        if (!r) continue;
        std::string text = "Rule " + std::to_string(++n) + ": ";
        for (size_t i = 0; i < r->branches.size(); ++i) {
            const Branch& b = r->branches[i];
            std::string sentence = (i == 0 ? "if " : "otherwise, if ") + condition(*b.condition) + ", " +
                                   actions(b.actions) + ".";
            text += (i == 0 ? capitalize(sentence) : " " + capitalize(sentence));
        }
        if (!r->elseActions.empty()) text += " Otherwise, " + actions(r->elseActions) + ".";
        out.push_back(text);
    }
    return out;
}
