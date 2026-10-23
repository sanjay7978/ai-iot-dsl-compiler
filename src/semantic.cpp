// semantic.cpp — symbol table construction and type checking.

#include "semantic.h"

#include <algorithm>
#include <cstdlib>

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

// Returns " (did you mean 'x'?)" for a close declared name of the same kind.
std::string SemanticAnalyzer::suggest(const std::string& name, SymbolKind kind) const {
    std::string best;
    size_t bestDist = 3;
    for (const Symbol& s : table_->all()) {
        if (s.kind != kind) continue;
        size_t d = editDistance(name, s.name);
        if (d < bestDist) { bestDist = d; best = s.name; }
    }
    return best.empty() ? "" : " (did you mean '" + best + "'?)";
}

std::vector<Diagnostic> SemanticAnalyzer::analyze(const Program& program, SymbolTable& table) {
    table_ = &table;
    diags_.clear();

    // Pass 1: collect every declaration, so a rule may use a name declared later.
    for (const auto& s : program.statements) declare(*s);

    // Pass 2: check the rules.
    for (const auto& s : program.statements)
        if (const Rule* r = dynamic_cast<const Rule*>(s.get())) checkRule(*r);

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

    if (const SensorDecl* d = dynamic_cast<const SensorDecl*>(&s)) {
        add(d->name, SymbolKind::Sensor, d->type == "NUMBER" ? ValueType::Number : ValueType::State);
    } else if (const DeviceDecl* d = dynamic_cast<const DeviceDecl*>(&s)) {
        for (const Operand& n : d->names) add(n, SymbolKind::Device, ValueType::None);
    }
}

void SemanticAnalyzer::checkRule(const Rule& rule) {
    checkCondition(*rule.condition);
    for (const Action& a : rule.thenActions) checkAction(a);
    for (const Action& a : rule.elseActions) checkAction(a);
}

void SemanticAnalyzer::checkCondition(const Condition& c) {
    if (const LogicalCond* l = dynamic_cast<const LogicalCond*>(&c)) {
        checkCondition(*l->left);
        checkCondition(*l->right);
    } else if (const NotCond* n = dynamic_cast<const NotCond*>(&c)) {
        checkCondition(*n->operand);
    } else if (const Comparison* cmp = dynamic_cast<const Comparison*>(&c)) {
        checkComparison(*cmp);
    }
}

// Type of one side of a comparison. Sets ok=false (after reporting) on error.
ValueType SemanticAnalyzer::operandType(const Operand& op, bool& ok) {
    switch (op.kind) {
        case OperandKind::Number: return ValueType::Number;
        case OperandKind::State:  return ValueType::State;
        case OperandKind::Identifier: break;
    }
    Symbol* sym = table_->find(op.text);
    if (!sym) {
        error(op, "'" + op.text + "' is not a declared sensor" + suggest(op.text, SymbolKind::Sensor));
        ok = false;
        return ValueType::None;
    }
    sym->uses++;
    if (sym->kind == SymbolKind::Device) {
        error(op, "'" + op.text + "' is a device, not a sensor; conditions can only test sensors");
        ok = false;
        return ValueType::None;
    }
    return sym->type;
}

void SemanticAnalyzer::checkComparison(const Comparison& c) {
    bool ok = true;
    ValueType lt = operandType(c.lhs, ok);
    ValueType rt = operandType(c.rhs, ok);
    if (!ok) return;

    auto describe = [&](const Operand& op, ValueType t) {
        if (op.kind == OperandKind::Identifier)
            return std::string(valueTypeName(t)) + " sensor '" + op.text + "'";
        return std::string(t == ValueType::Number ? "number " : "state ") + op.text;
    };

    if (lt != rt) {
        error(c, "type mismatch: cannot compare " + describe(c.lhs, lt) + " with " + describe(c.rhs, rt));
        return;
    }
    if (lt == ValueType::State && isRelational(c.op)) {
        error(c, "operator '" + c.op + "' cannot be used on STATE values; use == or !=");
        return;
    }
    if (c.lhs.kind != OperandKind::Identifier && c.rhs.kind != OperandKind::Identifier) {
        warning(c, "condition compares two constants, so it is always true or always false");
    }
}

void SemanticAnalyzer::checkAction(const Action& a) {
    // Count uses first, so a wrong call doesn't also cause "never used" warnings.
    for (const Operand& arg : a.args)
        if (arg.kind == OperandKind::Identifier)
            if (Symbol* sym = table_->find(arg.text)) sym->uses++;

    const ActionSignature* sig = findAction(a.name);
    if (!sig) {
        std::string list;
        for (const ActionSignature& s : builtinActions()) list += (list.empty() ? "" : ", ") + s.name;
        error(a, "unknown action '" + a.name + "' (available actions: " + list + ")");
        return;
    }
    if (a.args.size() != sig->params.size()) {
        error(a, "'" + a.name + "' expects " + std::to_string(sig->params.size()) + " argument" +
                 (sig->params.size() == 1 ? "" : "s") + " " + signatureText(*sig) + " but got " +
                 std::to_string(a.args.size()));
        return;
    }

    for (size_t i = 0; i < a.args.size(); ++i) {
        const Operand& arg = a.args[i];
        std::string where = "argument " + std::to_string(i + 1) + " of '" + a.name + "'";

        if (sig->params[i] == ParamKind::Device) {
            if (arg.kind != OperandKind::Identifier) {
                error(arg, where + " must be a device name, not '" + arg.text + "'");
                continue;
            }
            Symbol* sym = table_->find(arg.text);
            if (!sym) {
                error(arg, "'" + arg.text + "' is not a registered device" + suggest(arg.text, SymbolKind::Device));
                continue;
            }
            if (sym->kind != SymbolKind::Device)
                error(arg, "'" + arg.text + "' is a sensor, not a device; actions control devices");
        } else {   // Number: a number literal or a NUMBER sensor
            if (arg.kind == OperandKind::Number) {
                double v = std::strtod(arg.text.c_str(), nullptr);
                if (a.name == "set_level" && (v < 0 || v > 100))
                    warning(arg, "level " + arg.text + " is outside the usual range 0-100");
                continue;
            }
            if (arg.kind == OperandKind::State) {
                error(arg, where + " must be a number, not the state " + arg.text);
                continue;
            }
            Symbol* sym = table_->find(arg.text);
            if (!sym) {
                error(arg, "'" + arg.text + "' is not a declared sensor" + suggest(arg.text, SymbolKind::Sensor));
                continue;
            }
            if (sym->kind != SymbolKind::Sensor || sym->type != ValueType::Number)
                error(arg, where + " must be a number or a NUMBER sensor; '" + arg.text + "' is a " +
                           (sym->kind == SymbolKind::Device ? std::string("device")
                                                            : std::string("STATE sensor")));
        }
    }
}
