// semantic.cpp — symbol table construction and type checking.

#include "semantic.h"

#include <algorithm>
#include <cstdlib>

#include "rule_analysis.h"

// ---------- Symbol table ----------------------------------------------------

bool SymbolTable::add(const Symbol& s) {
    if (index_.count(s.name)) return false;
    index_[s.name] = symbols_.size();
    symbols_.push_back(s);
    return true;
}

Symbol* SymbolTable::find(const std::string& name) {
    auto it = index_.find(name);
    return it == index_.end() ? nullptr : &symbols_[it->second];
}

const Symbol* SymbolTable::find(const std::string& name) const {
    auto it = index_.find(name);
    return it == index_.end() ? nullptr : &symbols_[it->second];
}

const char* symbolKindName(SymbolKind k) {
    return k == SymbolKind::Sensor ? "sensor" : "device";
}

const char* valueTypeName(ValueType t) {
    switch (t) {
        case ValueType::Number: return "NUMBER";
        case ValueType::State:  return "STATE";
        case ValueType::Bool:   return "BOOL";
        case ValueType::None:   return "-";
    }
    return "-";
}

// ---------- Built-in actions -----------------------------------------------

const std::vector<ActionSignature>& builtinActions() {
    static const std::vector<ActionSignature> actions = {
        {"turn_on",   {ParamKind::Device}},
        {"turn_off",  {ParamKind::Device}},
        {"toggle",    {ParamKind::Device}},
        {"set_level", {ParamKind::Device, ParamKind::Number}},
    };
    return actions;
}

const ActionSignature* findAction(const std::string& name) {
    for (const ActionSignature& a : builtinActions())
        if (a.name == name) return &a;
    return nullptr;
}

namespace {

std::string signatureText(const ActionSignature& sig) {
    std::string s = sig.name + "(";
    for (size_t i = 0; i < sig.params.size(); ++i) {
        if (i) s += ", ";
        s += sig.params[i] == ParamKind::Device ? "device" : "number";
    }
    return s + ")";
}

bool isRelational(const std::string& op) {
    return op == ">" || op == "<" || op == ">=" || op == "<=";
}

// Levenshtein distance, used for "did you mean ...?" suggestions.
size_t editDistance(const std::string& a, const std::string& b) {
    std::vector<size_t> prev(b.size() + 1), cur(b.size() + 1);
    for (size_t j = 0; j <= b.size(); ++j) prev[j] = j;
    for (size_t i = 1; i <= a.size(); ++i) {
        cur[0] = i;
        for (size_t j = 1; j <= b.size(); ++j) {
            size_t sub = prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1);
            cur[j] = std::min({prev[j] + 1, cur[j - 1] + 1, sub});
        }
        std::swap(prev, cur);
    }
    return prev[b.size()];
}

}  // namespace

// ---------- Analyzer --------------------------------------------------------

void SemanticAnalyzer::error(const Node& at, const std::string& msg) {
    int len = at.end.line == at.start.line ? std::max(1, at.end.col - at.start.col) : 1;
    diags_.push_back(Diagnostic{"semantic", at.start.line, at.start.col, len, msg, "error"});
}

void SemanticAnalyzer::warning(const Node& at, const std::string& msg) {
    int len = at.end.line == at.start.line ? std::max(1, at.end.col - at.start.col) : 1;
    diags_.push_back(Diagnostic{"semantic", at.start.line, at.start.col, len, msg, "warning"});
}

// Closest declared name of the same kind (edit distance <= 2), or "".
std::string SemanticAnalyzer::bestMatch(const std::string& name, SymbolKind kind) const {
    std::string best;
    size_t bestDist = 3;
    for (const Symbol& s : table_->all()) {
        if (s.kind != kind) continue;
        size_t d = editDistance(name, s.name);
        if (d < bestDist) { bestDist = d; best = s.name; }
    }
    return best;
}

// Returns " (did you mean 'x'?)" for a close declared name of the same kind.
std::string SemanticAnalyzer::suggest(const std::string& name, SymbolKind kind) const {
    std::string best = bestMatch(name, kind);
    return best.empty() ? "" : " (did you mean '" + best + "'?)";
}

// A fix that inserts a declaration after the last existing one.
Fix SemanticAnalyzer::declareFix(const std::string& text, const std::string& title) const {
    if (hasDecl_) return Fix{title, declEnd_.line, declEnd_.col, 0, "\n" + text};
    return Fix{title, 1, 1, 0, text + "\n"};
}

// Quick fixes for an undeclared name: rename to a close match, or declare it.
void SemanticAnalyzer::fixUndeclared(const Operand& op, SymbolKind kind, const std::string& sensorType) {
    std::string best = bestMatch(op.text, kind);
    if (!best.empty())
        addFix(Fix{"Change to '" + best + "'", op.start.line, op.start.col,
                   static_cast<int>(op.text.size()), best});
    if (kind == SymbolKind::Device)
        addFix(declareFix("DEVICE " + op.text, "Declare 'DEVICE " + op.text + "'"));
    else
        addFix(declareFix("SENSOR " + op.text + " : " + sensorType,
                          "Declare 'SENSOR " + op.text + " : " + sensorType + "'"));
}

// The type of an undeclared sensor is guessed from what it is compared with.
void SemanticAnalyzer::retypeSensorFix(const Operand& op, const std::string& type) {
    for (Diagnostic& d : diags_) {
        if (d.line != op.start.line || d.col != op.start.col) continue;
        for (Fix& f : d.fixes) {
            size_t at = f.text.find(" : NUMBER");
            if (at == std::string::npos) continue;
            f.text.replace(at, 9, " : " + type);
            at = f.title.find(" : NUMBER");
            if (at != std::string::npos) f.title.replace(at, 9, " : " + type);
        }
    }
}

std::vector<Diagnostic> SemanticAnalyzer::analyze(const Program& program, SymbolTable& table) {
    table_ = &table;
    diags_.clear();

    // Pass 1: collect every declaration, so a rule may use a name declared later.
    for (const auto& s : program.statements) declare(*s);

    // Pass 2: check the rules.
    for (const auto& s : program.statements)
        if (const Rule* r = dynamic_cast<const Rule*>(s.get())) checkRule(*r);

    // Pass 3: logical analysis of the conditions (only for well-typed programs).
    bool typeErrors = std::any_of(diags_.begin(), diags_.end(),
                                  [](const Diagnostic& d) { return d.severity == "error"; });
    if (!typeErrors) {
        std::vector<Diagnostic> more = analyzeRules(program, table);
        diags_.insert(diags_.end(), more.begin(), more.end());
    }

    // Unused declarations are allowed, but probably a mistake.
    for (const Symbol& sym : table.all()) {
        if (sym.uses > 0) continue;
        Operand at;
        at.start = sym.declared;
        at.end = Pos{sym.declared.line, sym.declared.col + static_cast<int>(sym.name.size())};
        warning(at, std::string(symbolKindName(sym.kind)) + " '" + sym.name +
                    "' is declared but never used");
    }

    // Report in source order.
    std::stable_sort(diags_.begin(), diags_.end(), [](const Diagnostic& a, const Diagnostic& b) {
        return a.line != b.line ? a.line < b.line : a.col < b.col;
    });
    return diags_;
}

void SemanticAnalyzer::declare(const Statement& s) {
    auto add = [&](const Operand& name, SymbolKind kind, ValueType type) {
        Symbol sym{name.text, kind, type, name.start, 0};
        if (!table_->add(sym)) {
            const Symbol* prev = table_->find(name.text);
            error(name, "'" + name.text + "' is already declared as a " + symbolKindName(prev->kind) +
                        " at line " + std::to_string(prev->declared.line));
        }
        if (findAction(name.text))
            error(name, "'" + name.text + "' is the name of a built-in action and cannot be declared");
    };

    if (dynamic_cast<const SensorDecl*>(&s) || dynamic_cast<const DeviceDecl*>(&s)) {
        if (!hasDecl_ || s.end.line > declEnd_.line || (s.end.line == declEnd_.line && s.end.col > declEnd_.col))
            declEnd_ = s.end;
        hasDecl_ = true;
    }
    if (const SensorDecl* d = dynamic_cast<const SensorDecl*>(&s)) {
        add(d->name, SymbolKind::Sensor, d->type == "NUMBER" ? ValueType::Number : ValueType::State);
    } else if (const DeviceDecl* d = dynamic_cast<const DeviceDecl*>(&s)) {
        for (const Operand& n : d->names) add(n, SymbolKind::Device, ValueType::None);
    }
}

void SemanticAnalyzer::checkRule(const Rule& rule) {
    for (const Branch& b : rule.branches) {
        bool ok = true;
        ValueType t = typeOf(*b.condition, ok);
        if (ok && t != ValueType::Bool)
            error(*b.condition, "the condition must be true or false, but it is " + describe(*b.condition, t) +
                                " (compare it with something, e.g. using > or ==)");
        for (const Action& a : b.actions) checkAction(a);
    }
    for (const Action& a : rule.elseActions) checkAction(a);
}

namespace {

bool usesSensor(const Expr& e) {
    if (const Operand* o = dynamic_cast<const Operand*>(&e)) return o->kind == OperandKind::Identifier;
    if (const UnaryExpr* u = dynamic_cast<const UnaryExpr*>(&e)) return usesSensor(*u->operand);
    const BinaryExpr& b = dynamic_cast<const BinaryExpr&>(e);
    return usesSensor(*b.left) || usesSensor(*b.right);
}

void collectNames(const Expr& e, std::vector<const Operand*>& out) {
    if (const Operand* o = dynamic_cast<const Operand*>(&e)) {
        if (o->kind == OperandKind::Identifier) out.push_back(o);
    } else if (const UnaryExpr* u = dynamic_cast<const UnaryExpr*>(&e)) {
        collectNames(*u->operand, out);
    } else {
        const BinaryExpr& b = dynamic_cast<const BinaryExpr&>(e);
        collectNames(*b.left, out);
        collectNames(*b.right, out);
    }
}

std::string typeWord(ValueType t) {
    switch (t) {
        case ValueType::Number: return "NUMBER";
        case ValueType::State:  return "STATE";
        case ValueType::Bool:   return "true/false";
        case ValueType::None:   return "unknown";
    }
    return "unknown";
}

}  // namespace

// Human-readable description used in type errors, e.g. "STATE sensor 'door'", "number 5".
std::string SemanticAnalyzer::describe(const Expr& e, ValueType t) const {
    if (const Operand* o = dynamic_cast<const Operand*>(&e)) {
        if (o->kind == OperandKind::Identifier) return std::string(valueTypeName(t)) + " sensor '" + o->text + "'";
        return std::string(o->kind == OperandKind::Number ? "number " : "state ") + o->text;
    }
    if (t == ValueType::Bool) return "a true/false condition";
    return "a " + typeWord(t) + " expression";
}

// Computes the type of an expression, reporting errors. ok=false after an error.
ValueType SemanticAnalyzer::typeOf(const Expr& e, bool& ok) {
    if (const Operand* op = dynamic_cast<const Operand*>(&e)) {
        switch (op->kind) {
            case OperandKind::Number: return ValueType::Number;
            case OperandKind::State:  return ValueType::State;
            case OperandKind::Identifier: break;
        }
        Symbol* sym = table_->find(op->text);
        if (!sym) {
            error(*op, "'" + op->text + "' is not a declared sensor" + suggest(op->text, SymbolKind::Sensor));
            fixUndeclared(*op, SymbolKind::Sensor);
            ok = false;
            return ValueType::None;
        }
        sym->uses++;
        if (sym->kind == SymbolKind::Device) {
            error(*op, "'" + op->text + "' is a device, not a sensor; conditions can only test sensors");
            ok = false;
            return ValueType::None;
        }
        return sym->type;
    }

    if (const UnaryExpr* u = dynamic_cast<const UnaryExpr*>(&e)) {
        bool inner = true;
        ValueType t = typeOf(*u->operand, inner);
        if (!inner) { ok = false; return u->op == "NOT" ? ValueType::Bool : ValueType::Number; }
        if (u->op == "NOT") {
            if (t != ValueType::Bool) {
                error(e, "NOT needs a true/false condition, but " + describe(*u->operand, t) + " is not one");
                ok = false;
            }
            return ValueType::Bool;
        }
        if (t != ValueType::Number) {
            error(e, "'-' needs a number, but " + describe(*u->operand, t) + " is not a number");
            ok = false;
        }
        return ValueType::Number;
    }

    const BinaryExpr& b = dynamic_cast<const BinaryExpr&>(e);
    bool lok = true, rok = true;
    ValueType lt = typeOf(*b.left, lok);
    ValueType rt = typeOf(*b.right, rok);
    if (isRelationalOp(b.op)) {   // an undeclared sensor compared with a state is a STATE sensor
        const Operand* l = dynamic_cast<const Operand*>(b.left.get());
        const Operand* r = dynamic_cast<const Operand*>(b.right.get());
        if (!lok && l && l->kind == OperandKind::Identifier && !table_->find(l->text) && rt == ValueType::State)
            retypeSensorFix(*l, "STATE");
        if (!rok && r && r->kind == OperandKind::Identifier && !table_->find(r->text) && lt == ValueType::State)
            retypeSensorFix(*r, "STATE");
    }
    if (!lok || !rok) {
        ok = false;
        return isArithmeticOp(b.op) ? ValueType::Number : ValueType::Bool;
    }

    if (isLogicalOp(b.op)) {
        for (const Expr* side : {b.left.get(), b.right.get()}) {
            ValueType st = side == b.left.get() ? lt : rt;
            if (st != ValueType::Bool) {
                error(*side, b.op + " needs true/false conditions on both sides, but " + describe(*side, st) +
                             " is not one");
                ok = false;
            }
        }
        return ValueType::Bool;
    }

    if (isArithmeticOp(b.op)) {
        for (const Expr* side : {b.left.get(), b.right.get()}) {
            ValueType st = side == b.left.get() ? lt : rt;
            if (st != ValueType::Number) {
                error(*side, "arithmetic '" + b.op + "' needs numbers, but " + describe(*side, st) +
                             " is not a number");
                ok = false;
            }
        }
        if (b.op == "/") {
            const Operand* d = dynamic_cast<const Operand*>(b.right.get());
            if (d && d->kind == OperandKind::Number && std::strtod(d->text.c_str(), nullptr) == 0)
                warning(e, "division by zero");
        }
        return ValueType::Number;
    }

    // Relational operator
    if (lt != rt) {
        error(e, "type mismatch: cannot compare " + describe(*b.left, lt) + " with " + describe(*b.right, rt));
        ok = false;
    } else if (lt == ValueType::Bool) {
        error(e, "cannot compare two true/false conditions with '" + b.op + "'; combine them with AND, OR, NOT");
        ok = false;
    } else if (lt == ValueType::State && isRelational(b.op)) {
        error(e, "operator '" + b.op + "' cannot be used on STATE values; use == or !=");
        ok = false;
    } else if (!usesSensor(e)) {
        warning(e, "condition compares two constants, so it is always true or always false");
    }
    return ValueType::Bool;
}

void SemanticAnalyzer::checkAction(const Action& a) {
    const ActionSignature* sig = findAction(a.name);
    if (!sig || a.args.size() != sig->params.size()) {
        // Count uses anyway, so a wrong call doesn't also cause "never used" warnings.
        std::vector<const Operand*> names;
        for (const auto& arg : a.args) collectNames(*arg, names);
        for (const Operand* n : names)
            if (Symbol* sym = table_->find(n->text)) sym->uses++;
    }
    if (!sig) {
        std::string list, best;
        size_t bestDist = 4;
        for (const ActionSignature& s : builtinActions()) {
            list += (list.empty() ? "" : ", ") + s.name;
            size_t d = editDistance(a.name, s.name);
            if (d < bestDist) { bestDist = d; best = s.name; }
        }
        error(a, "unknown action '" + a.name + "' (available actions: " + list + ")");
        if (!best.empty())
            addFix(Fix{"Change to '" + best + "'", a.start.line, a.start.col, static_cast<int>(a.name.size()), best});
        return;
    }
    if (a.args.size() != sig->params.size()) {
        error(a, "'" + a.name + "' expects " + std::to_string(sig->params.size()) + " argument" +
                 (sig->params.size() == 1 ? "" : "s") + " " + signatureText(*sig) + " but got " +
                 std::to_string(a.args.size()));
        return;
    }

    for (size_t i = 0; i < a.args.size(); ++i) {
        const Expr& arg = *a.args[i];
        const Operand* op = dynamic_cast<const Operand*>(&arg);
        std::string where = "argument " + std::to_string(i + 1) + " of '" + a.name + "'";

        if (sig->params[i] == ParamKind::Device) {
            if (!op || op->kind != OperandKind::Identifier) {
                std::vector<const Operand*> names;
                collectNames(arg, names);
                for (const Operand* n : names)
                    if (Symbol* sym = table_->find(n->text)) sym->uses++;
                error(arg, where + " must be a device name");
                continue;
            }
            Symbol* sym = table_->find(op->text);
            if (!sym) {
                error(arg, "'" + op->text + "' is not a registered device" + suggest(op->text, SymbolKind::Device));
                fixUndeclared(*op, SymbolKind::Device);
                continue;
            }
            sym->uses++;
            if (sym->kind != SymbolKind::Device)
                error(arg, "'" + op->text + "' is a sensor, not a device; actions control devices");
            continue;
        }

        // Number parameter: any NUMBER expression (literal, NUMBER sensor, arithmetic).
        if (op && op->kind == OperandKind::State) {
            error(arg, where + " must be a number, not the state " + op->text);
            continue;
        }
        bool ok = true;
        ValueType t = typeOf(arg, ok);
        if (ok && t != ValueType::Number) {
            error(arg, where + " must be a number, but it is " + describe(arg, t));
            continue;
        }
        if (op && op->kind == OperandKind::Number) {
            double v = std::strtod(op->text.c_str(), nullptr);
            if (a.name == "set_level" && (v < 0 || v > 100))
                warning(arg, "level " + op->text + " is outside the usual range 0-100");
        }
    }
}
