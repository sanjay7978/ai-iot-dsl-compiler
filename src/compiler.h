// compiler.h — runs all compiler phases in order and collects their output.
#pragma once

#include <memory>
#include <string>
#include <vector>

#include "ast.h"
#include "cfg.h"
#include "ir.h"
#include "optimizer.h"
#include "semantic.h"
#include "token.h"

// Status of one phase: "ok", "error" (the phase found errors) or
// "skipped" (an earlier phase failed, so this one did not run).
struct PhaseStatus {
    std::string id;     // lexer, parser, ast, semantic, ir, optimizer, codegen
    std::string name;   // display name
    std::string status;
};

struct CompileResult {
    std::vector<Token> tokens;
    std::unique_ptr<Program> program;
    SymbolTable symbols;
    std::vector<IrInstr> ir;
    std::vector<IrInstr> optimizedIr;
    OptReport optimization;
    Cfg cfg;                               // basic blocks of the optimized code, with liveness
    std::string cCode;

    std::vector<Diagnostic> diagnostics;   // errors and warnings from every phase
    std::vector<PhaseStatus> phases;
    int rules = 0;
    int declarations = 0;
    double timeMs = 0.0;

    int errorCount() const;
    int warningCount() const;
    bool generatedCode() const { return !cCode.empty(); }
};

// Each phase runs only if every earlier phase finished without errors
// (warnings do not stop compilation). The lexer and parser always both run so
// that lexical and syntax errors can be reported together.
CompileResult compile(const std::string& source, const std::string& sourceName = "<input>");
