// cfg.cpp — basic blocks, control-flow graph, liveness and available expressions.

#include "cfg.h"

#include <algorithm>
#include <utility>

namespace {

bool definesTemp(const IrInstr& in) {
    return in.op == IrOp::Binary || in.op == IrOp::Not || in.op == IrOp::Neg || in.op == IrOp::Copy;
}

std::string valueKey(const IrValue& v) { return std::string(irKindName(v.kind)) + ":" + v.text; }

}  // namespace

std::vector<std::string> tempsUsed(const IrInstr& in) {
    std::vector<std::string> out;
    auto add = [&](const IrValue& v) { if (v.kind == IrValue::Kind::Temp) out.push_back(v.text); };
    switch (in.op) {
        case IrOp::Binary:  add(in.a); add(in.b); break;
        case IrOp::Not:
        case IrOp::Neg:
        case IrOp::Copy:
        case IrOp::IfFalse: add(in.a); break;
        case IrOp::Call:    for (const IrValue& v : in.args) add(v); break;
        default: break;
    }
    return out;
}

std::string expressionKey(const IrInstr& in) {
    if (in.op == IrOp::Not) return "NOT|" + valueKey(in.a);
    if (in.op == IrOp::Neg) return "NEG|" + valueKey(in.a);
    if (in.op != IrOp::Binary) return "";
    std::string a = valueKey(in.a), b = valueKey(in.b);
    bool commutative = in.oper == "==" || in.oper == "!=" || in.oper == "AND" || in.oper == "OR" ||
                       in.oper == "+" || in.oper == "*";
    if (commutative && b < a) std::swap(a, b);
    return in.oper + "|" + a + "|" + b;
}

Cfg buildCfg(const std::vector<IrInstr>& code) {
    Cfg cfg;
    if (code.empty()) return cfg;

    // 1. Find the leaders.
    std::vector<bool> leader(code.size(), false);
    leader[0] = true;
    for (size_t i = 0; i < code.size(); ++i) {
        if (code[i].op == IrOp::Label || code[i].op == IrOp::Rule) leader[i] = true;
        if ((code[i].op == IrOp::Goto || code[i].op == IrOp::IfFalse) && i + 1 < code.size()) leader[i + 1] = true;
    }

    // 2. A block runs from one leader up to (not including) the next.
    std::vector<int> blockOf(code.size());
    for (size_t i = 0; i < code.size(); ++i) {
        if (leader[i]) {
            BasicBlock b;
            b.id = static_cast<int>(cfg.blocks.size()) + 1;
            b.first = i;
            cfg.blocks.push_back(b);
        }
        cfg.blocks.back().last = i + 1;
        blockOf[i] = cfg.blocks.back().id;
    }

    std::map<std::string, int> labelBlock;
    for (size_t i = 0; i < code.size(); ++i)
        if (code[i].op == IrOp::Label) labelBlock[code[i].label] = blockOf[i];

    // 3. Edges: jump targets and fall-through.
    for (BasicBlock& b : cfg.blocks) {
        const IrInstr& end = code[b.last - 1];
        bool hasNext = b.id < static_cast<int>(cfg.blocks.size());
        auto edge = [&](int to) {
            if (std::find(b.succ.begin(), b.succ.end(), to) == b.succ.end()) b.succ.push_back(to);
        };
        if (end.op == IrOp::Goto) {
            if (labelBlock.count(end.label)) edge(labelBlock[end.label]);
        } else {
            if (hasNext) edge(b.id + 1);
            else b.exits = true;
            if (end.op == IrOp::IfFalse && labelBlock.count(end.label)) edge(labelBlock[end.label]);
        }
    }
    for (const BasicBlock& b : cfg.blocks)
        for (int s : b.succ) cfg.block(s).pred.push_back(b.id);
    return cfg;
}

void computeLiveness(Cfg& cfg, const std::vector<IrInstr>& code) {
    // USE: temporaries read before any write in the block; DEF: temporaries written.
    for (BasicBlock& b : cfg.blocks) {
        b.use.clear();
        b.def.clear();
        for (size_t i = b.first; i < b.last; ++i) {
            for (const std::string& t : tempsUsed(code[i]))
                if (!b.def.count(t)) b.use.insert(t);
            if (definesTemp(code[i])) b.def.insert(code[i].dest);
        }
        b.liveIn.clear();
        b.liveOut.clear();
    }

    // Backward analysis, repeated until nothing changes.
    bool changed = true;
    while (changed) {
        changed = false;
        for (auto it = cfg.blocks.rbegin(); it != cfg.blocks.rend(); ++it) {
            BasicBlock& b = *it;
            std::set<std::string> out;
            for (int s : b.succ) out.insert(cfg.block(s).liveIn.begin(), cfg.block(s).liveIn.end());
            std::set<std::string> in = b.use;
            for (const std::string& t : out)
                if (!b.def.count(t)) in.insert(t);
            if (in != b.liveIn || out != b.liveOut) {
                b.liveIn = std::move(in);
                b.liveOut = std::move(out);
                changed = true;
            }
        }
    }
}

std::vector<std::map<std::string, std::string>> availableExpressions(const Cfg& cfg,
                                                                     const std::vector<IrInstr>& code) {
    using Facts = std::set<std::pair<std::string, std::string>>;   // (expression key, temp)
    size_t n = cfg.blocks.size();

    std::vector<Facts> gen(n);
    Facts universe;
    for (const BasicBlock& b : cfg.blocks)
        for (size_t i = b.first; i < b.last; ++i) {
            std::string k = expressionKey(code[i]);
            if (k.empty()) continue;
            gen[static_cast<size_t>(b.id - 1)].insert({k, code[i].dest});
            universe.insert({k, code[i].dest});
        }

    // Forward analysis: OUT starts as "everything" (except the entry) and shrinks.
    std::vector<Facts> in(n), out(n, universe);
    if (n) out[0] = gen[0];
    bool changed = true;
    while (changed) {
        changed = false;
        for (const BasicBlock& b : cfg.blocks) {
            size_t i = static_cast<size_t>(b.id - 1);
            Facts newIn;
            if (b.id != 1 && !b.pred.empty()) {
                newIn = out[static_cast<size_t>(b.pred[0] - 1)];
                for (size_t p = 1; p < b.pred.size(); ++p) {
                    const Facts& other = out[static_cast<size_t>(b.pred[p] - 1)];
                    Facts both;
                    std::set_intersection(newIn.begin(), newIn.end(), other.begin(), other.end(),
                                          std::inserter(both, both.begin()));
                    newIn = std::move(both);
                }
            }
            Facts newOut = newIn;
            newOut.insert(gen[i].begin(), gen[i].end());
            if (newIn != in[i] || newOut != out[i]) {
                in[i] = std::move(newIn);
                out[i] = std::move(newOut);
                changed = true;
            }
        }
    }

    std::vector<std::map<std::string, std::string>> result(n);
    for (size_t i = 0; i < n; ++i)
        for (const auto& f : in[i]) result[i].emplace(f.first, f.second);
    return result;
}

std::set<int> reachableBlocks(const Cfg& cfg) {
    std::set<int> seen;
    if (cfg.blocks.empty()) return seen;
    std::vector<int> stack{1};
    while (!stack.empty()) {
        int id = stack.back();
        stack.pop_back();
        if (!seen.insert(id).second) continue;
        for (int s : cfg.block(id).succ) stack.push_back(s);
    }
    return seen;
}
