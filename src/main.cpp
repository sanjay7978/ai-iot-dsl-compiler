// main.cpp — command-line driver for the IoT DSL compiler (iotc).
//
// Usage: iotc [file.iot] [options]
//   No file      read the program from standard input
//   --tokens     Phase 1: token table
//   --ast        Phases 2-3: abstract syntax tree
//   --symbols    Phase 4: symbol table
//   --ir         Phase 5: intermediate code (three-address code)
//   --opt        Phase 6: optimized intermediate code and report
//   --cfg        Phase 6: basic blocks, control-flow graph and liveness of the optimized code
//   --c          Phase 7: generated C code only (handy for redirecting)
//   --target T   Phase 7: generated code for T = c, arduino, python or js
//   -o FILE      write the generated code (C, or the --target language) to FILE
//   --english    the program explained in plain English
//   --opt-trace  the code after every optimization pass that changed it
//   --grammar    FIRST/FOLLOW sets and the LL(1) parse table of the grammar
//   --language   the scanner DFA and grammar analysis as JSON
//   --trace      with --json: include the scanner and parser traces
//   --dot        AST in Graphviz DOT format
//   --json       everything as JSON (used by the web interface)
// With no section options, every phase is printed.
// Exit status: 0 = success (warnings allowed), 1 = errors, 2 = usage error.

#include <cctype>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

#include "ast.h"
#include "compiler.h"
#include "codegen.h"
#include "grammar.h"
#include "json.h"

namespace {

struct Options {
    std::string file;
    std::string outFile;
    bool tokens = false, ast = false, symbols = false, ir = false, opt = false, cfg = false;
    bool c = false, dot = false, json = false;
    bool english = false, optTrace = false, grammar = false, language = false, trace = false;
    std::string target;
};

void usage() {
    std::cerr << "usage: iotc [file.iot] [--tokens] [--ast] [--symbols] [--ir] [--opt] [--cfg] [--c]\n"
                 "            [--target c|arduino|python|js] [-o FILE] [--english] [--opt-trace]\n"
                 "            [--grammar] [--language] [--dot] [--json [--trace]]\n";
}

bool parseArgs(int argc, char** argv, Options& opt) {
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--tokens") opt.tokens = true;
        else if (a == "--ast") opt.ast = true;
        else if (a == "--symbols") opt.symbols = true;
        else if (a == "--ir") opt.ir = true;
        else if (a == "--opt") opt.opt = true;
        else if (a == "--cfg") opt.cfg = true;
        else if (a == "--c") opt.c = true;
        else if (a == "--dot") opt.dot = true;
        else if (a == "--json") opt.json = true;
        else if (a == "--english") opt.english = true;
        else if (a == "--opt-trace") opt.optTrace = true;
        else if (a == "--grammar") opt.grammar = true;
        else if (a == "--language") opt.language = true;
        else if (a == "--trace") opt.trace = true;
        else if (a == "--target") {
            if (i + 1 >= argc || !findTarget(argv[i + 1])) {
                std::cerr << "--target needs one of: c, arduino, python, js\n";
                return false;
            }
            opt.target = argv[++i];
        }
        else if (a == "-o") {
            if (i + 1 >= argc) { std::cerr << "-o needs a file name\n"; return false; }
            opt.outFile = argv[++i];
        }
        else if (a == "-h" || a == "--help") { usage(); std::exit(0); }
        else if (!a.empty() && a[0] == '-') { std::cerr << "unknown option: " << a << "\n"; return false; }
        else if (opt.file.empty()) opt.file = a;
        else { std::cerr << "only one input file is allowed\n"; return false; }
    }
    return true;
}

std::string plural(int n, const std::string& word) {
    return std::to_string(n) + " " + word + (n == 1 ? "" : "s");
}

std::string capitalize(std::string s) {
    if (!s.empty()) s[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(s[0])));
    return s;
}

void heading(const std::string& title) { std::cout << "=== " << title << " ===\n\n"; }

void printTokens(const std::vector<Token>& tokens) {
    heading("PHASE 1: LEXICAL ANALYSIS");
    std::cout << std::left << std::setw(5) << "#" << std::setw(10) << "LINE:COL"
              << std::setw(14) << "TOKEN" << "LEXEME\n";
    std::cout << std::string(44, '-') << "\n";
    int n = 0;
    for (const Token& t : tokens) {
        if (t.type == TokenType::END_OF_FILE) continue;
        std::string lc = std::to_string(t.line) + ":" + std::to_string(t.col);
        std::cout << std::left << std::setw(5) << ++n << std::setw(10) << lc
                  << std::setw(14) << tokenTypeName(t.type) << t.lexeme << "\n";
    }
    std::cout << "\n";
}

void printSymbols(const SymbolTable& table) {
    heading("PHASE 4: SEMANTIC ANALYSIS (SYMBOL TABLE)");
    std::cout << std::left << std::setw(18) << "NAME" << std::setw(9) << "KIND" << std::setw(9) << "TYPE"
              << std::setw(10) << "DECLARED" << "USES\n";
    std::cout << std::string(50, '-') << "\n";
    for (const Symbol& s : table.all()) {
        std::string at = std::to_string(s.declared.line) + ":" + std::to_string(s.declared.col);
        std::cout << std::left << std::setw(18) << s.name << std::setw(9) << symbolKindName(s.kind)
                  << std::setw(9) << valueTypeName(s.type) << std::setw(10) << at << s.uses << "\n";
    }
    if (table.all().empty()) std::cout << "(no declarations)\n";
    std::cout << "\n";
}

void printIr(const std::vector<IrInstr>& code) {
    bool first = true;
    for (const IrInstr& in : code) {
        if (in.op == IrOp::Rule) { std::cout << (first ? "" : "\n") << irToString(in) << "\n"; first = false; }
        else if (in.op == IrOp::Label) std::cout << irToString(in) << "\n";
        else std::cout << "    " << irToString(in) << "\n";
    }
    std::cout << "\n";
}

void printOptimization(const CompileResult& r) {
    heading("PHASE 6: OPTIMIZATION");
    printIr(r.optimizedIr);
    std::cout << "Instructions: " << r.optimization.before << " -> " << r.optimization.after << "\n";
    for (const OptPass& p : r.optimization.passes)
        if (p.count > 0) std::cout << "  " << std::left << std::setw(36) << p.name << p.count << "\n";
    std::cout << "\n";
}

void printCfg(const CompileResult& r) {
    heading("PHASE 6: BASIC BLOCKS, CONTROL-FLOW GRAPH AND LIVENESS (optimized code)");
    auto set = [](const std::set<std::string>& s) {
        std::string t = "{";
        for (const std::string& x : s) t += (t.size() > 1 ? ", " : "") + x;
        return t + "}";
    };
    for (const BasicBlock& b : r.cfg.blocks) {
        std::cout << "B" << b.id << (b.id == 1 ? " (entry)" : "") << "\n";
        for (size_t i = b.first; i < b.last; ++i)
            std::cout << "    " << irToString(r.optimizedIr[i]) << "\n";
        std::cout << "    -> ";
        if (b.succ.empty() && !b.exits) std::cout << "(none)";
        for (size_t k = 0; k < b.succ.size(); ++k) std::cout << (k ? ", " : "") << "B" << b.succ[k];
        if (b.exits) std::cout << (b.succ.empty() ? "" : ", ") << "EXIT";
        std::cout << "\n    live in: " << set(b.liveIn) << "   live out: " << set(b.liveOut) << "\n\n";
    }
}

void printGrammar() {
    const GrammarAnalysis& g = grammarAnalysis();
    heading("GRAMMAR (BNF)");
    for (size_t i = 0; i < g.productions.size(); ++i) {
        std::cout << std::setw(3) << i << "  " << g.productions[i].lhs << " ->";
        if (g.productions[i].rhs.empty()) std::cout << " ε";
        for (const std::string& s : g.productions[i].rhs) std::cout << " " << s;
        std::cout << "\n";
    }
    auto set = [](const std::set<std::string>& s) {
        std::string t = "{ ";
        for (const std::string& x : s) t += (x.empty() ? "ε" : x) + " ";
        return t + "}";
    };
    std::cout << "\n";
    heading("FIRST AND FOLLOW SETS");
    for (const std::string& a : g.nonterminals)
        std::cout << std::left << std::setw(12) << a << " FIRST " << std::setw(44) << set(g.first.at(a))
                  << " FOLLOW " << set(g.follow.at(a)) << "\n";
    std::cout << "\n";
    heading("LL(1) PARSE TABLE (nonterminal, lookahead -> production)");
    for (const std::string& a : g.nonterminals) {
        auto row = g.table.find(a);
        if (row == g.table.end()) continue;
        std::cout << std::left << std::setw(12) << a;
        for (const auto& cell : row->second) {
            std::cout << " " << cell.first << ":";
            for (size_t k = 0; k < cell.second.size(); ++k) std::cout << (k ? "/" : "") << cell.second[k];
        }
        std::cout << "\n";
    }
    std::cout << "\n" << (g.conflicts.empty() ? "LL(1): no conflicts - every table cell has at most one production.\n"
                                              : "LL(1) conflicts:\n");
    for (const std::string& c : g.conflicts) std::cout << "  " << c << "\n";
}

}  // namespace

int main(int argc, char** argv) {
    Options opt;
    if (!parseArgs(argc, argv, opt)) { usage(); return 2; }
    if (opt.language) { std::cout << languageJson() << "\n"; return 0; }
    if (opt.grammar && opt.file.empty()) { printGrammar(); return 0; }

    std::stringstream buffer;
    if (opt.file.empty()) {
        buffer << std::cin.rdbuf();
    } else {
        std::ifstream in(opt.file, std::ios::binary);
        if (!in) { std::cerr << "iotc: cannot open '" << opt.file << "'\n"; return 2; }
        buffer << in.rdbuf();
    }

    std::string name = opt.file.empty() ? "<stdin>" : opt.file;
    CompileResult r = compile(buffer.str(), name, opt.trace);
    int status = r.errorCount() == 0 ? 0 : 1;

    if (opt.json) {
        std::cout << toJson(r, opt.trace) << "\n";
        return status;
    }
    if (opt.dot) {
        printDot(r.program->display(), std::cout);
        return status;
    }

    auto printDiagnostics = [&](std::ostream& os) {
        for (const Diagnostic& d : r.diagnostics)
            os << capitalize(d.phase) << " " << (d.severity == "error" ? "Error" : "Warning")
               << " [" << d.line << ":" << d.col << "]: " << d.message << "\n";
    };

    // Code for the chosen target (C by default).
    std::string code;
    for (const GeneratedCode& g : r.targets)
        if (g.target == (opt.target.empty() ? "c" : opt.target)) code = g.code;

    if (!opt.outFile.empty()) {
        if (r.generatedCode()) {
            std::ofstream out(opt.outFile);
            if (!out) { std::cerr << "iotc: cannot write '" << opt.outFile << "'\n"; return 2; }
            out << code;
        }
    }

    // --c / --target: raw code on stdout (diagnostics on stderr) so it can be redirected.
    if ((opt.c || !opt.target.empty()) && opt.outFile.empty()) {
        printDiagnostics(std::cerr);
        if (r.generatedCode()) std::cout << code;
        return status;
    }

    if (opt.grammar) printGrammar();
    if (opt.english) {
        heading("THE PROGRAM IN PLAIN ENGLISH");
        for (const std::string& s : r.english) std::cout << s << "\n";
        std::cout << "\n";
    }
    if (opt.optTrace) {
        heading("OPTIMIZER TIME MACHINE (code after each pass that changed it)");
        for (const OptSnapshot& snap : r.optimization.trace) {
            std::cout << "--- " << snap.pass << " (round " << snap.round << ", "
                      << irInstructionCount(snap.code) << " instructions)\n";
            printIr(snap.code);
        }
    }

    bool any = opt.tokens || opt.ast || opt.symbols || opt.ir || opt.opt || opt.cfg || opt.english ||
               opt.optTrace || opt.grammar;
    bool all = !any && opt.outFile.empty();

    if (all || opt.tokens) printTokens(r.tokens);
    if (all || opt.ast) {
        heading("PHASES 2-3: SYNTAX ANALYSIS (ABSTRACT SYNTAX TREE)");
        printTree(r.program->display(), std::cout);
        std::cout << "\n";
    }
    if ((all || opt.symbols) && r.phases[3].status != "skipped") printSymbols(r.symbols);
    if ((all || opt.ir) && r.phases[4].status == "ok") {
        heading("PHASE 5: INTERMEDIATE CODE (THREE-ADDRESS CODE)");
        printIr(r.ir);
    }
    if ((all || opt.opt) && r.phases[5].status == "ok") printOptimization(r);
    if ((all || opt.cfg) && r.phases[5].status == "ok") printCfg(r);
    if (all && r.generatedCode()) {
        heading("PHASE 7: GENERATED C CODE");
        std::cout << r.cCode << "\n";
    }

    if (!r.diagnostics.empty()) {
        heading("PROBLEMS");
        printDiagnostics(std::cout);
        std::cout << "\n";
    }

    std::cout << (status == 0 ? "Compilation succeeded: " : "Compilation failed: ")
              << plural(static_cast<int>(r.tokens.size()) - 1, "token") << ", "
              << plural(r.declarations, "declaration") << ", " << plural(r.rules, "rule") << ", "
              << plural(r.errorCount(), "error") << ", " << plural(r.warningCount(), "warning") << ".\n";
    if (!opt.outFile.empty() && r.generatedCode()) std::cout << "C code written to " << opt.outFile << "\n";
    return status;
}
