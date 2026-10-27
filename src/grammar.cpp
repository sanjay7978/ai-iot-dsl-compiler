// grammar.cpp — FIRST/FOLLOW computation and LL(1) table construction.

#include "grammar.h"

#include <algorithm>

namespace {

// The grammar in BNF. "" never appears; an empty right-hand side means epsilon.
// Terminals: keywords in capitals, id, num, and punctuation/operators as written.
const std::vector<Production> kProductions = {
    {"program", {"items"}},
    {"items", {"item", "items"}},
    {"items", {}},
    {"item", {"decl"}},
    {"item", {"rule"}},
    {"decl", {"SENSOR", "id", ":", "type"}},
    {"decl", {"DEVICE", "id", "id_tail"}},
    {"type", {"NUMBER"}},
    {"type", {"STATE"}},
    {"id_tail", {",", "id", "id_tail"}},
    {"id_tail", {}},
    {"rule", {"IF", "expr", "THEN", "actions", "rule_tail"}},
    {"rule_tail", {"ELSE", "else_tail"}},
    {"rule_tail", {}},
    {"else_tail", {"IF", "expr", "THEN", "actions", "rule_tail"}},
    {"else_tail", {"actions"}},
    {"actions", {"action", "action_tail"}},
    {"action_tail", {"action", "action_tail"}},
    {"action_tail", {}},
    {"action", {"id", "(", "args", ")"}},
    {"args", {"expr", "arg_tail"}},
    {"args", {}},
    {"arg_tail", {",", "expr", "arg_tail"}},
    {"arg_tail", {}},
    {"expr", {"and_expr", "or_tail"}},
    {"or_tail", {"OR", "and_expr", "or_tail"}},
    {"or_tail", {}},
    {"and_expr", {"not_expr", "and_tail"}},
    {"and_tail", {"AND", "not_expr", "and_tail"}},
    {"and_tail", {}},
    {"not_expr", {"NOT", "not_expr"}},
    {"not_expr", {"rel_expr"}},
    {"rel_expr", {"arith", "rel_tail"}},
    {"rel_tail", {"relop", "arith"}},
    {"rel_tail", {}},
    {"relop", {">"}}, {"relop", {"<"}}, {"relop", {">="}},
    {"relop", {"<="}}, {"relop", {"=="}}, {"relop", {"!="}},
    {"arith", {"term", "arith_tail"}},
    {"arith_tail", {"+", "term", "arith_tail"}},
    {"arith_tail", {"-", "term", "arith_tail"}},
    {"arith_tail", {}},
    {"term", {"unary", "term_tail"}},
    {"term_tail", {"*", "unary", "term_tail"}},
    {"term_tail", {"/", "unary", "term_tail"}},
    {"term_tail", {}},
    {"unary", {"-", "unary"}},
    {"unary", {"primary"}},
    {"primary", {"num"}},
    {"primary", {"id"}},
    {"primary", {"state"}},
    {"primary", {"(", "expr", ")"}},
    {"state", {"ON"}}, {"state", {"OFF"}}, {"state", {"OPEN"}},
    {"state", {"CLOSED"}}, {"state", {"TRUE"}}, {"state", {"FALSE"}},
};

GrammarAnalysis analyse() {
    GrammarAnalysis g;
    g.productions = kProductions;

    std::set<std::string> nts;
    for (const Production& p : g.productions)
        if (nts.insert(p.lhs).second) g.nonterminals.push_back(p.lhs);
    std::set<std::string> ts;
    for (const Production& p : g.productions)
        for (const std::string& s : p.rhs)
            if (!nts.count(s) && ts.insert(s).second) g.terminals.push_back(s);
    g.terminals.push_back("$");

    // FIRST: iterate until nothing changes.
    for (const std::string& t : g.terminals) g.first[t] = {t};
    for (const std::string& a : g.nonterminals) g.first[a] = {};
    bool changed = true;
    while (changed) {
        changed = false;
        for (const Production& p : g.productions) {
            std::set<std::string> f = firstOfSequence(g, p.rhs);
            size_t before = g.first[p.lhs].size();
            g.first[p.lhs].insert(f.begin(), f.end());
            if (g.first[p.lhs].size() != before) changed = true;
        }
    }

    // FOLLOW: $ follows the start symbol; for A -> x B y, FIRST(y) - eps is in
    // FOLLOW(B), and if y can vanish, FOLLOW(A) is in FOLLOW(B) too.
    for (const std::string& a : g.nonterminals) g.follow[a] = {};
    g.follow["program"].insert("$");
    changed = true;
    while (changed) {
        changed = false;
        for (const Production& p : g.productions)
            for (size_t i = 0; i < p.rhs.size(); ++i) {
                const std::string& b = p.rhs[i];
                if (!nts.count(b)) continue;
                std::vector<std::string> rest(p.rhs.begin() + static_cast<long>(i) + 1, p.rhs.end());
                std::set<std::string> f = firstOfSequence(g, rest);
                size_t before = g.follow[b].size();
                for (const std::string& t : f)
                    if (!t.empty()) g.follow[b].insert(t);
                if (f.count("")) g.follow[b].insert(g.follow[p.lhs].begin(), g.follow[p.lhs].end());
                if (g.follow[b].size() != before) changed = true;
            }
    }

    // LL(1) table.
    for (size_t i = 0; i < g.productions.size(); ++i) {
        const Production& p = g.productions[i];
        std::set<std::string> f = firstOfSequence(g, p.rhs);
        for (const std::string& t : f)
            if (!t.empty()) g.table[p.lhs][t].push_back(static_cast<int>(i));
        if (f.count(""))
            for (const std::string& t : g.follow[p.lhs]) g.table[p.lhs][t].push_back(static_cast<int>(i));
    }
    for (const auto& row : g.table)
        for (const auto& cell : row.second)
            if (cell.second.size() > 1)
                g.conflicts.push_back("M[" + row.first + ", " + cell.first + "] has " +
                                      std::to_string(cell.second.size()) + " productions");

    g.parserFunction = {
        {"program", "parse"}, {"items", "parse"}, {"item", "parse"},
        {"decl", "parseSensorDecl / parseDeviceDecl"}, {"type", "parseSensorDecl"}, {"id_tail", "parseDeviceDecl"},
        {"rule", "parseRule"}, {"rule_tail", "parseRule"}, {"else_tail", "parseRule"},
        {"actions", "parseActionList"}, {"action_tail", "parseActionList"}, {"action", "parseAction"},
        {"args", "parseAction"}, {"arg_tail", "parseAction"},
        {"expr", "parseExpr"}, {"or_tail", "parseExpr"}, {"and_expr", "parseAnd"}, {"and_tail", "parseAnd"},
        {"not_expr", "parseNot"}, {"rel_expr", "parseRelational"}, {"rel_tail", "parseRelational"},
        {"relop", "parseRelational"}, {"arith", "parseArith"}, {"arith_tail", "parseArith"},
        {"term", "parseTerm"}, {"term_tail", "parseTerm"}, {"unary", "parseUnary"},
        {"primary", "parsePrimary"}, {"state", "parsePrimary"},
    };
    return g;
}

}  // namespace

std::set<std::string> firstOfSequence(const GrammarAnalysis& g, const std::vector<std::string>& seq) {
    std::set<std::string> out;
    for (const std::string& s : seq) {
        auto it = g.first.find(s);
        if (it == g.first.end()) { out.insert(s); return out; }
        bool nullable = false;
        for (const std::string& t : it->second) {
            if (t.empty()) nullable = true;
            else out.insert(t);
        }
        if (!nullable) return out;
    }
    out.insert("");   // every symbol can vanish (or the sequence is empty)
    return out;
}

const GrammarAnalysis& grammarAnalysis() {
    static const GrammarAnalysis g = analyse();
    return g;
}
