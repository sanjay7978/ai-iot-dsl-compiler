// compiler.cpp — the compiler pipeline.

#include "compiler.h"

#include <chrono>

#include "codegen.h"
#include "lexer.h"
#include "parser.h"

int CompileResult::errorCount() const {
    int n = 0;
    for (const Diagnostic& d : diagnostics) n += d.severity == "error";
    return n;
}

int CompileResult::warningCount() const {
    return static_cast<int>(diagnostics.size()) - errorCount();
}

namespace {

bool hasErrors(const std::vector<Diagnostic>& diags) {
    for (const Diagnostic& d : diags)
        if (d.severity == "error") return true;
    return false;
}

}  // namespace

CompileResult compile(const std::string& source, const std::string& sourceName) {
    CompileResult r;
    r.phases = {
        {"lexer", "Lexical analysis", "skipped"},
        {"parser", "Syntax analysis", "skipped"},
        {"ast", "Abstract syntax tree", "skipped"},
        {"semantic", "Semantic analysis", "skipped"},
        {"ir", "Intermediate code", "skipped"},
        {"optimizer", "Optimization", "skipped"},
        {"codegen", "Code generation", "skipped"},
    };
    auto t0 = std::chrono::steady_clock::now();

    // Phase 1: lexical analysis
    Lexer lexer(source);
    r.tokens = lexer.tokenize();
    r.diagnostics = lexer.errors();
    r.phases[0].status = hasErrors(lexer.errors()) ? "error" : "ok";

    // Phases 2-3: syntax analysis and AST construction
    Parser parser(r.tokens);
    r.program = parser.parse();
    r.diagnostics.insert(r.diagnostics.end(), parser.errors().begin(), parser.errors().end());
    r.rules = parser.ruleCount();
    r.declarations = parser.declarationCount();
    bool syntaxOk = parser.errors().empty();
    r.phases[1].status = syntaxOk ? "ok" : "error";
    r.phases[2].status = syntaxOk ? "ok" : "error";

    if (!hasErrors(r.diagnostics)) {
        // Phase 4: semantic analysis
        SemanticAnalyzer sema;
        std::vector<Diagnostic> semDiags = sema.analyze(*r.program, r.symbols);
        r.diagnostics.insert(r.diagnostics.end(), semDiags.begin(), semDiags.end());
        r.phases[3].status = hasErrors(semDiags) ? "error" : "ok";

        if (!hasErrors(semDiags)) {
            // Phase 5: intermediate code
            IrGenerator irgen;
            r.ir = irgen.generate(*r.program);
            r.phases[4].status = "ok";

            // Phase 6: optimization
            Optimizer opt;
            r.optimizedIr = opt.optimize(r.ir, r.optimization);
            r.cfg = buildCfg(r.optimizedIr);
            computeLiveness(r.cfg, r.optimizedIr);
            r.phases[5].status = "ok";

            // Phase 7: code generation
            CodeGenerator gen;
            r.cCode = gen.generate(r.optimizedIr, r.symbols, sourceName);
            r.phases[6].status = "ok";
        }
    }

    auto t1 = std::chrono::steady_clock::now();
    r.timeMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
    return r;
}
