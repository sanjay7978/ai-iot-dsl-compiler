// semantic.h — Phase 4: semantic analysis (symbol table + type checking).
//
// The parser only checks the *form* of the program. This phase checks its
// *meaning*: every name must be declared, sensors and devices must be used in
// the right places, and values must have compatible types.
#pragma once

#include <string>
#include <unordered_map>
#include <vector>

#include "ast.h"
#include "token.h"

enum class SymbolKind { Sensor, Device };
enum class ValueType { Number, State, Bool, None };   // None for devices and errors

struct Symbol {
    std::string name;
    SymbolKind kind;
    ValueType type;
    Pos declared;
    int uses = 0;
};

class SymbolTable {
public:
    // Returns false if the name already exists.
    bool add(const Symbol& s);
    Symbol* find(const std::string& name);
    const Symbol* find(const std::string& name) const;
    const std::vector<Symbol>& all() const { return symbols_; }

private:
    std::vector<Symbol> symbols_;                     // in declaration order
    std::unordered_map<std::string, size_t> index_;   // name -> position in symbols_
};

// Parameter kinds of the built-in actions.
enum class ParamKind { Device, Number };

struct ActionSignature {
    std::string name;
    std::vector<ParamKind> params;
};

// turn_on(device), turn_off(device), toggle(device), set_level(device, number)
const std::vector<ActionSignature>& builtinActions();
const ActionSignature* findAction(const std::string& name);

const char* symbolKindName(SymbolKind k);
const char* valueTypeName(ValueType t);

class SemanticAnalyzer {
public:
    // Fills `table` from the declarations and checks every rule.
    // Returns errors and warnings (Diagnostic::severity).
    std::vector<Diagnostic> analyze(const Program& program, SymbolTable& table);

private:
    void declare(const Statement& s);
    void checkRule(const Rule& rule);
    void checkAction(const Action& a);
    ValueType typeOf(const Expr& e, bool& ok);   // type checking of expressions
    std::string describe(const Expr& e, ValueType t) const;

    void error(const Node& at, const std::string& msg);
    void warning(const Node& at, const std::string& msg);
    std::string suggest(const std::string& name, SymbolKind kind) const;

    SymbolTable* table_ = nullptr;
    std::vector<Diagnostic> diags_;
};
