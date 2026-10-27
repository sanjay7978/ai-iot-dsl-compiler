// codegen.h — Phase 7: target code generation from the optimized IR.
//
// The back end is retargetable: one structured emitter turns the IR's
// IF_FALSE/GOTO/label patterns back into if / else blocks, and a small Target
// class supplies the syntax of each output language. The same optimized IR
// becomes C, Arduino/ESP32, Python or JavaScript.
//
// Every output line remembers the IR instruction and source span it came
// from, so the web page can link generated code back to the program.
#pragma once

#include <memory>
#include <set>
#include <string>
#include <vector>

#include "ir.h"
#include "semantic.h"

struct GeneratedLine {
    std::string text;
    int ir = -1;              // index of the IR instruction (-1 = boilerplate)
    Pos srcStart, srcEnd;     // source span (line 0 = none)
};

struct GeneratedCode {
    std::string target;       // c, arduino, python, js
    std::string name;         // display name
    std::string fileName;     // e.g. program.c
    std::string code;
    std::vector<GeneratedLine> lines;
};

class Emitter;

// Syntax of one output language.
class Target {
public:
    virtual ~Target() = default;
    virtual std::string id() const = 0;
    virtual std::string name() const = 0;
    virtual std::string fileName() const = 0;

    // Names
    virtual const std::set<std::string>& reserved() const = 0;
    std::string identifier(const std::string& name) const;   // adds '_' to reserved words
    virtual std::string device(const std::string& name) const;
    virtual std::string state(const std::string& s) const { return "STATE_" + s; }
    virtual std::string boolean(bool b) const { return b ? "true" : "false"; }

    // Expressions and statements
    virtual std::string op(const std::string& op) const;              // AND -> &&, ...
    virtual std::string notExpr(const std::string& a) const { return "!" + a; }
    virtual std::string assign(const std::string& temp, bool numeric, const std::string& expr) const = 0;
    virtual std::string ifOpen(const std::string& cond) const = 0;
    virtual std::string elseLine() const = 0;
    virtual std::string blockClose() const = 0;   // "" = no closing line (Python)
    virtual std::string emptyBody() const { return ""; }
    virtual std::string call(const std::string& callee, const std::vector<std::string>& args) const = 0;
    virtual std::string comment(const std::string& text) const = 0;
    virtual std::string gotoStmt(const std::string& label) const = 0;
    virtual std::string labelStmt(const std::string& label) const = 0;

    // File structure: everything before the rule code (ending inside the
    // evaluation function, after the sensor reads) and everything after it.
    virtual void prologue(Emitter& out, const std::vector<IrInstr>& code, const SymbolTable& symbols,
                          const std::set<std::string>& usedSensors, const std::string& sourceName) const = 0;
    virtual void epilogue(Emitter& out, const SymbolTable& symbols) const = 0;
};

class Emitter {
public:
    void line(int indent, const std::string& text, const IrInstr* from = nullptr, int irIndex = -1);
    void blank() { line(0, ""); }
    size_t size() const { return lines_.size(); }
    std::vector<GeneratedLine>& lines() { return lines_; }

private:
    std::vector<GeneratedLine> lines_;
};

// Generates code for one target.
GeneratedCode generateCode(const std::vector<IrInstr>& code, const SymbolTable& symbols,
                           const std::string& sourceName, const Target& target);

// All targets, in display order: C, Arduino, Python, JavaScript.
const std::vector<std::unique_ptr<Target>>& allTargets();
const Target* findTarget(const std::string& id);

// Compatibility helpers used elsewhere.
std::string cIdentifier(const std::string& name);
std::string deviceConstant(const std::string& name);
