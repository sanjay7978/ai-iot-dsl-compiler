// cfg.h — basic blocks, control-flow graph and dataflow analyses on the IR.
//
// A basic block is a straight-line sequence of instructions with one entry
// (its first instruction) and one exit (its last). The control-flow graph
// (CFG) has an edge from block A to block B when control can pass from the
// end of A to the start of B.
//
// Two classic dataflow analyses run on the CFG:
//   * Liveness (backward):  IN[B]  = USE[B] ∪ (OUT[B] − DEF[B]),  OUT[B] = ∪ IN[S] over successors S
//   * Available expressions (forward):
//                           OUT[B] = IN[B] ∪ GEN[B],               IN[B]  = ∩ OUT[P] over predecessors P
#pragma once

#include <map>
#include <set>
#include <string>
#include <vector>

#include "ir.h"

struct BasicBlock {
    int id = 0;                    // B1, B2, ... (1-based)
    size_t first = 0, last = 0;    // instruction range [first, last)
    std::vector<int> succ, pred;   // block ids
    bool exits = false;            // control can leave the program from here
    std::set<std::string> use, def, liveIn, liveOut;   // temporaries
};

struct Cfg {
    std::vector<BasicBlock> blocks;   // blocks[i].id == i + 1
    BasicBlock& block(int id) { return blocks[static_cast<size_t>(id - 1)]; }
    const BasicBlock& block(int id) const { return blocks[static_cast<size_t>(id - 1)]; }
};

// Splits the code into basic blocks (leaders: first instruction, labels,
// rule markers, instructions after a jump) and connects them.
Cfg buildCfg(const std::vector<IrInstr>& code);

// Fills use/def/liveIn/liveOut of every block (iterates to a fixpoint).
void computeLiveness(Cfg& cfg, const std::vector<IrInstr>& code);

// Expressions available at the start of each block, as expression key -> temporary
// holding its value. Index i belongs to block id i+1.
std::vector<std::map<std::string, std::string>> availableExpressions(const Cfg& cfg,
                                                                     const std::vector<IrInstr>& code);

// Blocks reachable from the entry block.
std::set<int> reachableBlocks(const Cfg& cfg);

// Key identifying the value an instruction computes ("" if it computes none).
// Commutative operators are normalized, so "a == b" and "b == a" share a key.
std::string expressionKey(const IrInstr& in);

// Temporaries an instruction reads.
std::vector<std::string> tempsUsed(const IrInstr& in);
