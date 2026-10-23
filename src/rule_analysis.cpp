// rule_analysis.cpp — impossible / always-true conditions and conflicting rules.

#include "rule_analysis.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <map>
#include <set>
#include <string>

namespace {

const size_t kMaxTerms = 256;   // DNF size limit; bigger conditions are not analysed
struct TooBig {};

// ---------- Atoms and DNF ---------------------------------------------------

// One comparison in normalized form: sensor op value.
struct Atom {
    enum Kind { Number, State, Unknown, Const } kind = Unknown;
    std::string sensor;
    std::string op;          // > < >= <= == !=
    double num = 0;
    std::string state;
    bool value = false;      // for Const
};

using Conj = std::vector<Atom>;   // AND of atoms
using Dnf = std::vector<Conj>;    // OR of ANDs;  {} = false, {{}} = true

std::string negateOp(const std::string& op) {
    if (op == ">") return "<=";
    if (op == "<") return ">=";
    if (op == ">=") return "<";
    if (op == "<=") return ">";
    if (op == "==") return "!=";
    return "==";
}

std::string mirrorOp(const std::string& op) {   // 30 < t  ->  t > 30
    if (op == ">") return "<";
    if (op == "<") return ">";
    if (op == ">=") return "<=";
    if (op == "<=") return ">=";
    return op;
}

Dnf product(const Dnf& a, const Dnf& b) {
    if (a.size() * b.size() > kMaxTerms) throw TooBig{};
    Dnf out;
    for (const Conj& x : a)
        for (const Conj& y : b) {
            Conj c = x;
            c.insert(c.end(), y.begin(), y.end());
            out.push_back(c);
        }
    return out;
}

Dnf join(Dnf a, const Dnf& b) {
    if (a.size() + b.size() > kMaxTerms) throw TooBig{};
    a.insert(a.end(), b.begin(), b.end());
    return a;
}

bool evalConst(const std::string& op, const Operand& l, const Operand& r) {
    if (l.kind == OperandKind::Number) {
        double x = std::strtod(l.text.c_str(), nullptr), y = std::strtod(r.text.c_str(), nullptr);
        if (op == ">") return x > y;
        if (op == "<") return x < y;
        if (op == ">=") return x >= y;
        if (op == "<=") return x <= y;
        if (op == "==") return x == y;
        return x != y;
    }
    return op == "==" ? l.text == r.text : l.text != r.text;
}

Dnf atomDnf(const BinaryExpr& cmp, bool negate) {
    const Operand* l = dynamic_cast<const Operand*>(cmp.left.get());
    const Operand* r = dynamic_cast<const Operand*>(cmp.right.get());
    std::string op = negate ? negateOp(cmp.op) : cmp.op;
    Atom a;

    if (l && r && l->kind != OperandKind::Identifier && r->kind != OperandKind::Identifier) {
        a.kind = Atom::Const;
        a.value = evalConst(cmp.op, *l, *r) != negate;
        return a.value ? Dnf{Conj{}} : Dnf{};
    }
    const Operand* sensor = nullptr;
    const Operand* lit = nullptr;
    if (l && r && l->kind == OperandKind::Identifier && r->kind != OperandKind::Identifier) {
        sensor = l; lit = r;
    } else if (l && r && r->kind == OperandKind::Identifier && l->kind != OperandKind::Identifier) {
        sensor = r; lit = l; op = mirrorOp(op);
    }
    if (sensor) {
        a.sensor = sensor->text;
        a.op = op;
        if (lit->kind == OperandKind::Number) { a.kind = Atom::Number; a.num = std::strtod(lit->text.c_str(), nullptr); }
        else { a.kind = Atom::State; a.state = lit->text; }
    }   // otherwise Unknown (arithmetic, sensor vs sensor)
    return Dnf{Conj{a}};
}

// DNF of e (or of NOT e when negate is true), pushing NOT inwards (De Morgan).
Dnf toDnf(const Expr& e, bool negate) {
    if (const UnaryExpr* u = dynamic_cast<const UnaryExpr*>(&e)) return toDnf(*u->operand, !negate);
    if (const BinaryExpr* b = dynamic_cast<const BinaryExpr*>(&e)) {
        if (b->op == "AND" || b->op == "OR") {
            Dnf l = toDnf(*b->left, negate), r = toDnf(*b->right, negate);
            bool isAnd = (b->op == "AND") != negate;
            return isAnd ? product(l, r) : join(l, r);
        }
        if (isRelationalOp(b->op)) return atomDnf(*b, negate);
    }
    return Dnf{Conj{Atom{}}};   // anything else: unknown
}

// ---------- Satisfiability ---------------------------------------------------

struct Interval {
    double lo = -std::numeric_limits<double>::infinity();
    double hi = std::numeric_limits<double>::infinity();
    bool loOpen = true, hiOpen = true;
    std::set<double> excluded;

    void apply(const std::string& op, double v) {
        if (op == ">" || op == ">=") {
            bool open = op == ">";
            if (v > lo || (v == lo && open)) { lo = v; loOpen = open; }
        } else if (op == "<" || op == "<=") {
            bool open = op == "<";
            if (v < hi || (v == hi && open)) { hi = v; hiOpen = open; }
        } else if (op == "==") {
            apply(">=", v);
            apply("<=", v);
        } else {
            excluded.insert(v);
        }
    }
    bool contains(double x) const {
        if (x < lo || x > hi) return false;
        if (x == lo && loOpen) return false;
        if (x == hi && hiOpen) return false;
        return !excluded.count(x);
    }
    bool empty() const {
        if (lo > hi) return true;
        if (lo == hi) return loOpen || hiOpen || excluded.count(lo);
        return false;
    }
    // A readable value inside the interval, for example messages.
    double witness() const {
        std::vector<double> cands;
        if (std::isfinite(lo)) { cands.push_back(lo); cands.push_back(std::floor(lo) + 1); cands.push_back(lo + 0.5); }
        if (std::isfinite(hi)) { cands.push_back(hi); cands.push_back(std::ceil(hi) - 1); cands.push_back(hi - 0.5); }
        if (std::isfinite(lo) && std::isfinite(hi)) cands.push_back((lo + hi) / 2);
        cands.push_back(0);
        cands.push_back(1);
        for (double c : cands)
            if (contains(c)) return c;
        for (double d = 0.25; d < 1e6; d *= 2)
            if (contains(lo + d)) return lo + d;
        return lo;
    }
};

const std::vector<std::string> kStates = {"ON", "OFF", "OPEN", "CLOSED", "TRUE", "FALSE"};

struct Result {
    bool sat = false;
    bool unknown = false;                      // the group relies on comparisons we can't analyse
    std::vector<std::string> example;          // "temperature = 31"
};

std::string fmt(double v) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%g", v);
    return buf;
}

Result satisfiable(const Conj& c) {
    Result r;
    std::map<std::string, Interval> nums;
    std::map<std::string, std::set<std::string>> states;
    std::vector<std::string> order;   // sensors in order of appearance
    for (const Atom& a : c) {
        if (a.kind == Atom::Unknown) { r.unknown = true; continue; }
        if (a.kind == Atom::Const) { if (!a.value) return r; continue; }
        if (!nums.count(a.sensor) && !states.count(a.sensor)) order.push_back(a.sensor);
        if (a.kind == Atom::Number) {
            nums[a.sensor].apply(a.op, a.num);
        } else {
            auto it = states.find(a.sensor);
            if (it == states.end()) it = states.emplace(a.sensor, std::set<std::string>(kStates.begin(), kStates.end())).first;
            if (a.op == "==") {
                bool had = it->second.count(a.state) > 0;
                it->second.clear();
                if (had) it->second.insert(a.state);
            } else {
                it->second.erase(a.state);
            }
        }
    }
    for (const auto& n : nums) if (n.second.empty()) return r;
    for (const auto& s : states) if (s.second.empty()) return r;

    r.sat = true;
    for (const std::string& name : order) {
        if (nums.count(name)) {
            r.example.push_back(name + " = " + fmt(nums[name].witness()));
        } else {
            const std::set<std::string>& allowed = states[name];
            std::string pick;
            for (const Atom& a : c)   // prefer a state the rule mentions
                if (a.sensor == name && a.kind == Atom::State && allowed.count(a.state)) { pick = a.state; break; }
            if (pick.empty())
                for (const std::string& s : kStates) if (allowed.count(s)) { pick = s; break; }
            r.example.push_back(name + " = " + pick);
        }
    }
    return r;
}

// Satisfiable if any AND-group is; prefers a group without unknown comparisons.
Result satisfiable(const Dnf& d) {
    Result best;
    for (const Conj& c : d) {
        Result r = satisfiable(c);
        if (!r.sat) continue;
        if (!r.unknown) return r;
        if (!best.sat) best = r;
    }
    return best;
}

bool usesSensor(const Expr& e) {
    if (const Operand* o = dynamic_cast<const Operand*>(&e)) return o->kind == OperandKind::Identifier;
    if (const UnaryExpr* u = dynamic_cast<const UnaryExpr*>(&e)) return usesSensor(*u->operand);
    const BinaryExpr& b = dynamic_cast<const BinaryExpr&>(e);
    return usesSensor(*b.left) || usesSensor(*b.right);
}

std::string joinWords(const std::vector<std::string>& v) {
    std::string s;
    for (size_t i = 0; i < v.size(); ++i) s += (i == 0 ? "" : i + 1 == v.size() ? " and " : ", ") + v[i];
    return s;
}

// ---------- Device effects -------------------------------------------------

struct Effect {
    std::string device;
    std::string kind;        // on, off, toggle, level
    std::string level;       // for level: the value text ("" if computed)
    const Action* action;
};

std::string exprText(const Expr& e) {
    if (const Operand* o = dynamic_cast<const Operand*>(&e)) return o->text;
    if (const UnaryExpr* u = dynamic_cast<const UnaryExpr*>(&e))
        return (u->op == "NOT" ? "NOT " : "-") + exprText(*u->operand);
    const BinaryExpr& b = dynamic_cast<const BinaryExpr&>(e);
    return "(" + exprText(*b.left) + " " + b.op + " " + exprText(*b.right) + ")";
}

std::vector<Effect> effectsOf(const std::vector<Action>& actions) {
    std::vector<Effect> out;
    for (const Action& a : actions) {
        if (a.args.empty()) continue;
        const Operand* dev = dynamic_cast<const Operand*>(a.args[0].get());
        if (!dev) continue;
        Effect e{dev->text, "", "", &a};
        if (a.name == "turn_on") e.kind = "on";
        else if (a.name == "turn_off") e.kind = "off";
        else if (a.name == "toggle") e.kind = "toggle";
        else if (a.name == "set_level" && a.args.size() == 2) { e.kind = "level"; e.level = exprText(*a.args[1]); }
        else continue;
        out.push_back(e);
    }
    return out;
}

bool differ(const Effect& a, const Effect& b) {
    if (a.kind == "toggle" || b.kind == "toggle") return true;
    if (a.kind != b.kind) return true;
    return a.kind == "level" && a.level != b.level;
}

std::string verb(const Effect& e) {
    if (e.kind == "on") return "turns '" + e.device + "' on";
    if (e.kind == "off") return "turns '" + e.device + "' off";
    if (e.kind == "toggle") return "toggles '" + e.device + "'";
    return "sets '" + e.device + "' to level " + e.level;
}

// ---------- The analysis -----------------------------------------------------

struct Part {               // one branch (or the ELSE) of one rule
    int rule;
    int line;
    Dnf when;               // effective condition: own condition AND NOT earlier ones
    std::vector<Effect> effects;
};

class Analyzer {
public:
    std::vector<Diagnostic> run(const Program& program) {
        int ruleNo = 0;
        std::vector<Part> parts;
        for (const auto& s : program.statements) {
            const Rule* r = dynamic_cast<const Rule*>(s.get());
            if (!r) continue;
            ++ruleNo;
            try {
                analyseRule(*r, ruleNo, parts);
            } catch (const TooBig&) {
                // condition too large to analyse: skip this rule
            }
        }
        findConflicts(parts);
        return diags_;
    }

private:
    void warn(const Node& at, const std::string& msg) {
        int len = at.end.line == at.start.line ? std::max(1, at.end.col - at.start.col) : 1;
        diags_.push_back(Diagnostic{"semantic", at.start.line, at.start.col, len, msg, "warning"});
    }

    void analyseRule(const Rule& r, int ruleNo, std::vector<Part>& parts) {
        Dnf earlierFalse{Conj{}};   // "no earlier condition was true" (starts as true)
        for (size_t i = 0; i < r.branches.size(); ++i) {
            const Branch& b = r.branches[i];
            const Expr& cond = *b.condition;
            Dnf own = toDnf(cond, false);
            Dnf when = product(own, earlierFalse);
            bool sensors = usesSensor(cond);

            if (sensors && !satisfiable(own).sat) {
                warn(cond, "this condition can never be true, so its actions never run");
            } else if (i > 0 && !satisfiable(when).sat) {
                warn(cond, "this ELSE IF can never run: whenever its condition is true, an earlier condition "
                           "of the same rule is already true");
            } else if (sensors && !satisfiable(toDnf(cond, true)).sat) {
                warn(cond, "this condition is always true" +
                           std::string(i + 1 < r.branches.size() || !r.elseActions.empty()
                                           ? ", so the parts after it never run" : ", so the rule always runs"));
            }

            if (satisfiable(when).sat) parts.push_back({ruleNo, r.start.line, when, effectsOf(b.actions)});
            earlierFalse = product(earlierFalse, toDnf(cond, true));
        }
        if (!r.elseActions.empty()) {
            if (!satisfiable(earlierFalse).sat)
                warn(r.elseActions.front(), "the ELSE part can never run: one of the conditions is always true");
            else
                parts.push_back({ruleNo, r.start.line, earlierFalse, effectsOf(r.elseActions)});
        }
    }

    void findConflicts(const std::vector<Part>& parts) {
        // Inside one branch: two different actions on the same device.
        for (const Part& p : parts)
            for (size_t i = 0; i < p.effects.size(); ++i)
                for (size_t j = 0; j < i; ++j)
                    if (p.effects[i].device == p.effects[j].device && differ(p.effects[i], p.effects[j])) {
                        warn(*p.effects[i].action, "conflict: this branch " + verb(p.effects[j]) + " and then " +
                                                   verb(p.effects[i]) + "; only the last action has effect");
                        break;
                    }

        // Between rules: same device, different effect, conditions can hold together.
        std::set<std::string> reported;
        for (size_t j = 0; j < parts.size(); ++j)
            for (size_t i = 0; i < j; ++i) {
                const Part& a = parts[i];
                const Part& b = parts[j];
                if (a.rule == b.rule) continue;   // branches of one rule never run together
                for (const Effect& eb : b.effects)
                    for (const Effect& ea : a.effects) {
                        if (ea.device != eb.device || !differ(ea, eb)) continue;
                        std::string key = std::to_string(a.rule) + "/" + std::to_string(b.rule) + "/" + eb.device;
                        if (reported.count(key)) continue;
                        Result both;
                        try {
                            both = satisfiable(product(a.when, b.when));
                        } catch (const TooBig&) {
                            continue;
                        }
                        if (!both.sat) continue;
                        reported.insert(key);
                        std::string when = both.example.empty() ? "" : ", e.g. when " + joinWords(both.example);
                        if (both.unknown)
                            warn(*eb.action, "possible conflict: rule " + std::to_string(b.rule) + " " + verb(eb) +
                                             " while rule " + std::to_string(a.rule) + " (line " +
                                             std::to_string(a.line) + ") " + verb(ea) +
                                             "; both may apply at the same time" + when +
                                             ". The later rule wins");
                        else
                            warn(*eb.action, "conflict: rule " + std::to_string(b.rule) + " " + verb(eb) +
                                             " while rule " + std::to_string(a.rule) + " (line " +
                                             std::to_string(a.line) + ") " + verb(ea) + when +
                                             ". The later rule wins");
                    }
            }
    }

    std::vector<Diagnostic> diags_;
};

}  // namespace

std::vector<Diagnostic> analyzeRules(const Program& program, const SymbolTable&) {
    return Analyzer().run(program);
}
