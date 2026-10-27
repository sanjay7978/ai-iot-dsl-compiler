// json.cpp — a minimal hand-written JSON writer (no external libraries).

#include "json.h"

#include "grammar.h"
#include "lexer.h"

#include <cstdio>
#include <sstream>

namespace {

std::string quote(const std::string& s) {
    std::string r = "\"";
    for (char c : s) {
        switch (c) {
            case '"':  r += "\\\""; break;
            case '\\': r += "\\\\"; break;
            case '\n': r += "\\n";  break;
            case '\r': r += "\\r";  break;
            case '\t': r += "\\t";  break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof buf, "\\u%04x", c);
                    r += buf;
                } else {
                    r += c;
                }
        }
    }
    return r + "\"";
}

std::string pos(const Pos& p) {
    return "[" + std::to_string(p.line) + "," + std::to_string(p.col) + "]";
}

void writeNode(const DisplayNode& n, std::ostringstream& out) {
    out << "{\"kind\":" << quote(n.kind)
        << ",\"label\":" << quote(n.label)
        << ",\"start\":" << pos(n.start)
        << ",\"end\":" << pos(n.end)
        << ",\"children\":[";
    for (size_t i = 0; i < n.children.size(); ++i) {
        if (i) out << ",";
        writeNode(n.children[i], out);
    }
    out << "]}";
}

std::string value(const IrValue& v) {
    return "{\"kind\":" + quote(irKindName(v.kind)) + ",\"text\":" + quote(v.text) + "}";
}

void writeIr(const std::vector<IrInstr>& code, std::ostringstream& out) {
    out << "[";
    for (size_t i = 0; i < code.size(); ++i) {
        const IrInstr& in = code[i];
        if (i) out << ",";
        out << "{\"op\":" << quote(irOpName(in.op))
            << ",\"text\":" << quote(irToString(in))
            << ",\"rule\":" << in.rule
            << ",\"numeric\":" << (in.numeric ? "true" : "false")
            << ",\"src\":[" << in.srcStart.line << "," << in.srcStart.col << "," << in.srcEnd.line << ","
            << in.srcEnd.col << "]";
        switch (in.op) {
            case IrOp::Binary:
                out << ",\"dest\":" << quote(in.dest) << ",\"oper\":" << quote(in.oper)
                    << ",\"a\":" << value(in.a) << ",\"b\":" << value(in.b);
                break;
            case IrOp::Not:
            case IrOp::Neg:
            case IrOp::Copy:
                out << ",\"dest\":" << quote(in.dest) << ",\"a\":" << value(in.a);
                break;
            case IrOp::IfFalse:
                out << ",\"a\":" << value(in.a) << ",\"label\":" << quote(in.label);
                break;
            case IrOp::Goto:
            case IrOp::Label:
                out << ",\"label\":" << quote(in.label);
                break;
            case IrOp::Call:
                out << ",\"callee\":" << quote(in.callee) << ",\"args\":[";
                for (size_t k = 0; k < in.args.size(); ++k) out << (k ? "," : "") << value(in.args[k]);
                out << "]";
                break;
            case IrOp::Rule:
                out << ",\"line\":" << in.line;
                break;
        }
        out << "}";
    }
    out << "]";
}

}  // namespace

std::string toJson(const CompileResult& r, bool trace) {
    std::ostringstream out;
    out << "{\"success\":" << (r.errorCount() == 0 ? "true" : "false");

    out << ",\"phases\":[";
    for (size_t i = 0; i < r.phases.size(); ++i)
        out << (i ? "," : "") << "{\"id\":" << quote(r.phases[i].id) << ",\"name\":" << quote(r.phases[i].name)
            << ",\"status\":" << quote(r.phases[i].status) << "}";
    out << "]";

    out << ",\"tokens\":[";
    bool first = true;
    for (const Token& t : r.tokens) {
        if (t.type == TokenType::END_OF_FILE) continue;
        if (!first) out << ",";
        first = false;
        out << "{\"type\":" << quote(tokenTypeName(t.type))
            << ",\"category\":" << quote(tokenCategory(t.type))
            << ",\"lexeme\":" << quote(t.lexeme)
            << ",\"line\":" << t.line
            << ",\"col\":" << t.col
            << ",\"length\":" << t.length << "}";
    }
    out << "]";

    out << ",\"ast\":";
    if (r.program) writeNode(r.program->display(), out);
    else out << "null";

    out << ",\"symbols\":[";
    const std::vector<Symbol>& syms = r.symbols.all();
    for (size_t i = 0; i < syms.size(); ++i) {
        const Symbol& s = syms[i];
        out << (i ? "," : "") << "{\"name\":" << quote(s.name)
            << ",\"kind\":" << quote(symbolKindName(s.kind))
            << ",\"type\":" << quote(valueTypeName(s.type))
            << ",\"line\":" << s.declared.line << ",\"col\":" << s.declared.col
            << ",\"uses\":" << s.uses << "}";
    }
    out << "]";

    out << ",\"ir\":";
    writeIr(r.ir, out);
    out << ",\"optimizedIr\":";
    writeIr(r.optimizedIr, out);

    out << ",\"optimization\":{\"before\":" << r.optimization.before
        << ",\"after\":" << r.optimization.after << ",\"passes\":[";
    for (size_t i = 0; i < r.optimization.passes.size(); ++i) {
        const OptPass& p = r.optimization.passes[i];
        out << (i ? "," : "") << "{\"name\":" << quote(p.name) << ",\"description\":" << quote(p.description)
            << ",\"count\":" << p.count << "}";
    }
    out << "]}";

    out << ",\"cfg\":[";
    for (size_t i = 0; i < r.cfg.blocks.size(); ++i) {
        const BasicBlock& b = r.cfg.blocks[i];
        auto list = [&](const std::set<std::string>& s) {
            std::string t = "[";
            bool first = true;
            for (const std::string& x : s) { t += (first ? "" : ",") + quote(x); first = false; }
            return t + "]";
        };
        out << (i ? "," : "") << "{\"id\":" << b.id << ",\"first\":" << b.first << ",\"last\":" << b.last
            << ",\"exits\":" << (b.exits ? "true" : "false") << ",\"succ\":[";
        for (size_t k = 0; k < b.succ.size(); ++k) out << (k ? "," : "") << b.succ[k];
        out << "],\"pred\":[";
        for (size_t k = 0; k < b.pred.size(); ++k) out << (k ? "," : "") << b.pred[k];
        out << "],\"liveIn\":" << list(b.liveIn) << ",\"liveOut\":" << list(b.liveOut) << "}";
    }
    out << "]";

    out << ",\"cCode\":" << quote(r.cCode);

    out << ",\"targets\":[";
    for (size_t i = 0; i < r.targets.size(); ++i) {
        const GeneratedCode& g = r.targets[i];
        out << (i ? "," : "") << "{\"id\":" << quote(g.target) << ",\"name\":" << quote(g.name)
            << ",\"fileName\":" << quote(g.fileName) << ",\"code\":" << quote(g.code) << ",\"lines\":[";
        for (size_t k = 0; k < g.lines.size(); ++k) {
            const GeneratedLine& l = g.lines[k];
            out << (k ? "," : "") << "[" << l.ir << "," << l.srcStart.line << "," << l.srcStart.col << ","
                << l.srcEnd.line << "," << l.srcEnd.col << "]";
        }
        out << "]}";
    }
    out << "]";

    out << ",\"english\":[";
    for (size_t i = 0; i < r.english.size(); ++i) out << (i ? "," : "") << quote(r.english[i]);
    out << "]";

    out << ",\"optTrace\":[";
    for (size_t i = 0; i < r.optimization.trace.size(); ++i) {
        const OptSnapshot& snap = r.optimization.trace[i];
        out << (i ? "," : "") << "{\"pass\":" << quote(snap.pass) << ",\"round\":" << snap.round
            << ",\"count\":" << irInstructionCount(snap.code) << ",\"code\":";
        writeIr(snap.code, out);
        out << "}";
    }
    out << "]";

    if (trace) {
        out << ",\"lexTrace\":[";
        for (size_t i = 0; i < r.lexTrace.size(); ++i) {
            const LexStep& st = r.lexTrace[i];
            out << (i ? "," : "") << "[" << st.offset << "," << quote(st.from) << "," << quote(st.to) << "]";
        }
        out << "],\"parseTrace\":[";
        for (size_t i = 0; i < r.parseTrace.size(); ++i) {
            const ParseEvent& e = r.parseTrace[i];
            out << (i ? "," : "") << "[" << quote(e.kind) << "," << quote(e.name) << "," << e.token << ","
                << e.depth << "]";
        }
        out << "]";
    }

    out << ",\"errors\":[";
    for (size_t i = 0; i < r.diagnostics.size(); ++i) {
        const Diagnostic& d = r.diagnostics[i];
        if (i) out << ",";
        out << "{\"phase\":" << quote(d.phase)
            << ",\"severity\":" << quote(d.severity)
            << ",\"line\":" << d.line
            << ",\"col\":" << d.col
            << ",\"length\":" << d.length
            << ",\"message\":" << quote(d.message) << ",\"fixes\":[";
        for (size_t k = 0; k < d.fixes.size(); ++k) {
            const Fix& f = d.fixes[k];
            out << (k ? "," : "") << "{\"title\":" << quote(f.title) << ",\"line\":" << f.line
                << ",\"col\":" << f.col << ",\"length\":" << f.length << ",\"text\":" << quote(f.text) << "}";
        }
        out << "]}";
    }
    out << "]";

    char ms[32];
    std::snprintf(ms, sizeof ms, "%.3f", r.timeMs);
    out << ",\"stats\":{\"tokens\":" << (r.tokens.empty() ? 0 : r.tokens.size() - 1)
        << ",\"rules\":" << r.rules
        << ",\"declarations\":" << r.declarations
        << ",\"errors\":" << r.errorCount()
        << ",\"warnings\":" << r.warningCount()
        << ",\"irBefore\":" << r.optimization.before
        << ",\"irAfter\":" << r.optimization.after
        << ",\"timeMs\":" << ms << "}}";
    return out.str();
}

// Static description of the language: the scanner's DFA and the grammar analysis.
std::string languageJson() {
    std::ostringstream out;
    const LexerDfa& dfa = lexerDfa();
    out << "{\"dfa\":{\"states\":[";
    for (size_t i = 0; i < dfa.states.size(); ++i)
        out << (i ? "," : "") << "{\"id\":" << quote(dfa.states[i].id) << ",\"label\":" << quote(dfa.states[i].label)
            << ",\"accepting\":" << (dfa.states[i].accepting ? "true" : "false") << "}";
    out << "],\"edges\":[";
    for (size_t i = 0; i < dfa.edges.size(); ++i)
        out << (i ? "," : "") << "[" << quote(dfa.edges[i].from) << "," << quote(dfa.edges[i].to) << ","
            << quote(dfa.edges[i].label) << "]";
    out << "]}";

    const GrammarAnalysis& g = grammarAnalysis();
    auto strings = [&](const std::vector<std::string>& v) {
        std::string t = "[";
        for (size_t i = 0; i < v.size(); ++i) t += (i ? "," : "") + quote(v[i]);
        return t + "]";
    };
    auto set = [&](const std::set<std::string>& s) {
        std::vector<std::string> v;
        for (const std::string& x : s) v.push_back(x.empty() ? "ε" : x);
        return strings(v);
    };
    out << ",\"grammar\":{\"productions\":[";
    for (size_t i = 0; i < g.productions.size(); ++i)
        out << (i ? "," : "") << "{\"lhs\":" << quote(g.productions[i].lhs) << ",\"rhs\":"
            << strings(g.productions[i].rhs) << "}";
    out << "],\"nonterminals\":" << strings(g.nonterminals) << ",\"terminals\":" << strings(g.terminals);
    out << ",\"first\":{";
    for (size_t i = 0; i < g.nonterminals.size(); ++i)
        out << (i ? "," : "") << quote(g.nonterminals[i]) << ":" << set(g.first.at(g.nonterminals[i]));
    out << "},\"follow\":{";
    for (size_t i = 0; i < g.nonterminals.size(); ++i)
        out << (i ? "," : "") << quote(g.nonterminals[i]) << ":" << set(g.follow.at(g.nonterminals[i]));
    out << "},\"table\":[";
    bool first = true;
    for (const auto& row : g.table)
        for (const auto& cell : row.second)
            for (int p : cell.second) {
                out << (first ? "" : ",") << "[" << quote(row.first) << "," << quote(cell.first) << "," << p << "]";
                first = false;
            }
    out << "],\"conflicts\":" << strings(g.conflicts) << ",\"functions\":{";
    first = true;
    for (const auto& f : g.parserFunction) {
        out << (first ? "" : ",") << quote(f.first) << ":" << quote(f.second);
        first = false;
    }
    out << "}}}";
    return out.str();
}
