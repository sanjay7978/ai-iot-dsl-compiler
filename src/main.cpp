// main.cpp — command-line driver for the IoT DSL compiler (iotc).
//
// Usage: iotc [file.iot] [options]
//   No file      read the program from standard input
//   --tokens     Phase 1: token table
//   --ast        Phases 2-3: abstract syntax tree
//   --symbols    Phase 4: symbol table
//   --ir         Phase 5: intermediate code (three-address code)
//   --opt        Phase 6: optimized intermediate code and report
//   --c          Phase 7: generated C code only (handy for redirecting)
//   -o FILE      write the generated C code to FILE
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
#include "json.h"

namespace {

struct Options {
    std::string file;
    std::string outFile;
    bool tokens = false, ast = false, symbols = false, ir = false, opt = false;
    bool c = false, dot = false, json = false;
};

void usage() {
    std::cerr << "usage: iotc [file.iot] [--tokens] [--ast] [--symbols] [--ir] [--opt] [--c] "
                 "[-o out.c] [--dot] [--json]\n";
}

bool parseArgs(int argc, char** argv, Options& opt) {
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--tokens") opt.tokens = true;
        else if (a == "--ast") opt.ast = true;
        else if (a == "--symbols") opt.symbols = true;
        else if (a == "--ir") opt.ir = true;
        else if (a == "--opt") opt.opt = true;
        else if (a == "--c") opt.c = true;
        else if (a == "--dot") opt.dot = true;
        else if (a == "--json") opt.json = true;
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

}  // namespace

int main(int argc, char** argv) {
    Options opt;
    if (!parseArgs(argc, argv, opt)) { usage(); return 2; }

    std::stringstream buffer;
    if (opt.file.empty()) {
        buffer << std::cin.rdbuf();
    } else {
        std::ifstream in(opt.file, std::ios::binary);
        if (!in) { std::cerr << "iotc: cannot open '" << opt.file << "'\n"; return 2; }
        buffer << in.rdbuf();
    }

    std::string name = opt.file.empty() ? "<stdin>" : opt.file;
    CompileResult r = compile(buffer.str(), name);
    int status = r.errorCount() == 0 ? 0 : 1;

    if (opt.json) {
        std::cout << toJson(r) << "\n";
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

    if (!opt.outFile.empty()) {
        if (r.generatedCode()) {
            std::ofstream out(opt.outFile);
            if (!out) { std::cerr << "iotc: cannot write '" << opt.outFile << "'\n"; return 2; }
            out << r.cCode;
        }
    }

    // --c: raw C on stdout (diagnostics on stderr) so it can be redirected.
    if (opt.c) {
        printDiagnostics(std::cerr);
        if (r.generatedCode()) std::cout << r.cCode;
        return status;
    }

    bool any = opt.tokens || opt.ast || opt.symbols || opt.ir || opt.opt;
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
