// grammar.h — the DSL grammar as data, with FIRST/FOLLOW sets and the LL(1) table.
//
// The parser in parser.cpp is written by hand from this grammar. Here the
// same grammar (in BNF, with the EBNF repetitions turned into "tail"
// nonterminals) is analysed the textbook way:
//   FIRST(X)   = terminals that can begin a string derived from X
//   FOLLOW(A)  = terminals that can appear right after A
//   M[A, a]    = the production to use when expanding A with lookahead a
// The grammar is LL(1) exactly when no table cell holds two productions,
// which is what lets a recursive-descent parser decide with one token.
#pragma once

#include <map>
#include <set>
#include <string>
#include <vector>

struct Production {
    std::string lhs;
    std::vector<std::string> rhs;   // empty = epsilon
};

struct GrammarAnalysis {
    std::vector<Production> productions;
    std::vector<std::string> nonterminals;   // in definition order
    std::vector<std::string> terminals;      // including "$" (end of input)
    std::map<std::string, std::set<std::string>> first;    // "" stands for epsilon
    std::map<std::string, std::set<std::string>> follow;
    std::map<std::string, std::map<std::string, std::vector<int>>> table;   // M[A][a] -> production indices
    std::vector<std::string> conflicts;      // empty when the grammar is LL(1)
    std::map<std::string, std::string> parserFunction;   // nonterminal -> function in parser.cpp
};

const GrammarAnalysis& grammarAnalysis();

// FIRST of a sequence of grammar symbols ("" in the result = epsilon).
std::set<std::string> firstOfSequence(const GrammarAnalysis& g, const std::vector<std::string>& seq);
