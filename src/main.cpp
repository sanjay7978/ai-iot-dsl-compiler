// main.cpp — command-line driver for the IoT DSL compiler front end.
//
// Usage: iotc [file.iot] [--tokens] [--ast] [--dot] [--json]
//   No file      read the program from standard input
//   --tokens     print only the token table
//   --ast        print only the abstract syntax tree
//   --dot        print the AST in Graphviz DOT format
//   --json       print everything as JSON (used by the web interface)
// Exit status is 0 on success and 1 if any lexical or syntax error was found.

#include <cctype>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

#include "ast.h"
#include "json.h"
#include "lexer.h"
#include "parser.h"

namespace {

struct Options {
    std::string file;
    bool tokens = false;
    bool ast = false;
    bool dot = false;
    bool json = false;
};

void usage() {
    std::cerr << "usage: iotc [file.iot] [--tokens] [--ast] [--dot] [--json]\n";
}

bool parseArgs(int argc, char** argv, Options& opt) {
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--tokens") opt.tokens = true;
        else if (a == "--ast") opt.ast = true;
        else if (a == "--dot") opt.dot = true;
        else if (a == "--json") opt.json = true;
        else if (a == "-h" || a == "--help") { usage(); std::exit(0); }
        else if (!a.empty() && a[0] == '-') { std::cerr << "unknown option: " << a << "\n"; return false; }
        else if (opt.file.empty()) opt.file = a;
        else { std::cerr << "only one input file is allowed\n"; return false; }
    }
    if (!opt.tokens && !opt.ast) opt.tokens = opt.ast = true;
    return true;
}

std::string plural(int n, const std::string& word) {
    return std::to_string(n) + " " + word + (n == 1 ? "" : "s");
}

std::string capitalize(std::string s) {
    if (!s.empty()) s[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(s[0])));
    return s;
}

void printTokens(const std::vector<Token>& tokens) {
    std::cout << "=== PHASE 1: LEXICAL ANALYSIS ===\n\n";
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

}  // namespace

int main(int argc, char** argv) {
    Options opt;
    if (!parseArgs(argc, argv, opt)) { usage(); return 2; }

    // Read the source program.
    std::stringstream buffer;
    if (opt.file.empty()) {
        buffer << std::cin.rdbuf();
    } else {
        std::ifstream in(opt.file, std::ios::binary);
        if (!in) { std::cerr << "iotc: cannot open '" << opt.file << "'\n"; return 2; }
        buffer << in.rdbuf();
    }
    std::string source = buffer.str();

    auto t0 = std::chrono::steady_clock::now();

    // Phase 1: lexical analysis
    Lexer lexer(source);
    std::vector<Token> tokens = lexer.tokenize();

    // Phase 2: syntax analysis
    Parser parser(tokens);
    std::unique_ptr<Program> program = parser.parse();

    auto t1 = std::chrono::steady_clock::now();

    std::vector<Diagnostic> errors = lexer.errors();
    errors.insert(errors.end(), parser.errors().begin(), parser.errors().end());

    DisplayNode tree = program->display();

    CompileStats stats;
    stats.tokens = static_cast<int>(tokens.size()) - 1;   // exclude EOF
    stats.rules = parser.ruleCount();
    stats.declarations = parser.declarationCount();
    stats.timeMs = std::chrono::duration<double, std::milli>(t1 - t0).count();

    if (opt.json) {
        std::cout << toJson(tokens, &tree, errors, stats) << "\n";
        return errors.empty() ? 0 : 1;
    }
    if (opt.dot) {
        printDot(tree, std::cout);
        return errors.empty() ? 0 : 1;
    }

    if (opt.tokens) printTokens(tokens);
    if (opt.ast) {
        std::cout << "=== PHASE 2: SYNTAX ANALYSIS (ABSTRACT SYNTAX TREE) ===\n\n";
        printTree(tree, std::cout);
        std::cout << "\n";
    }

    if (!errors.empty()) {
        std::cout << "=== ERRORS ===\n\n";
        for (const Diagnostic& d : errors)
            std::cout << capitalize(d.phase) << " Error [" << d.line << ":" << d.col << "]: "
                      << d.message << "\n";
        std::cout << "\n";
    }

    std::cout << (errors.empty() ? "Front end succeeded: " : "Front end failed: ")
              << plural(stats.tokens, "token") << ", " << plural(stats.declarations, "declaration")
              << ", " << plural(stats.rules, "rule") << ", "
              << plural(static_cast<int>(errors.size()), "error") << ".\n";
    return errors.empty() ? 0 : 1;
}
