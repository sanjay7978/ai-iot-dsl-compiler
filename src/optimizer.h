// optimizer.h — Phase 6: machine-independent optimization of the IR.
//
// The passes run repeatedly until none of them changes the code (a fixpoint),
// because one optimization often enables another: folding a constant
// condition makes a branch constant, which makes code unreachable, which
// makes temporaries dead.
#pragma once

#include <string>
#include <vector>

#include "ir.h"

struct OptPass {
    std::string name;
    std::string description;
    int count = 0;   // how many times it changed the code
};

struct OptReport {
    int before = 0;   // instruction count before optimization
    int after = 0;    // and after
    std::vector<OptPass> passes;
};

class Optimizer {
public:
    std::vector<IrInstr> optimize(std::vector<IrInstr> code, OptReport& report);

private:
    bool constantFolding(std::vector<IrInstr>& code);
    bool algebraicSimplification(std::vector<IrInstr>& code);
    bool commonSubexpressions(std::vector<IrInstr>& code);
    bool copyPropagation(std::vector<IrInstr>& code);
    bool constantBranches(std::vector<IrInstr>& code);
    bool unreachableCode(std::vector<IrInstr>& code);
    bool redundantJumps(std::vector<IrInstr>& code);
    bool deadTemporaries(std::vector<IrInstr>& code);

    void bump(size_t pass, int n = 1) { report_->passes[pass].count += n; }
    OptReport* report_ = nullptr;
};
