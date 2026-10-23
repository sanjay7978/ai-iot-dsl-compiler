// json.cpp — a minimal hand-written JSON writer (no external libraries).

#include "json.h"

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
            << ",\"rule\":" << in.rule;
        switch (in.op) {
            case IrOp::Binary:
                out << ",\"dest\":" << quote(in.dest) << ",\"oper\":" << quote(in.oper)
                    << ",\"a\":" << value(in.a) << ",\"b\":" << value(in.b);
                break;
            case IrOp::Not:
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

std::string toJson(const CompileResult& r) {
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

    out << ",\"cCode\":" << quote(r.cCode);

    out << ",\"errors\":[";
    for (size_t i = 0; i < r.diagnostics.size(); ++i) {
        const Diagnostic& d = r.diagnostics[i];
        if (i) out << ",";
        out << "{\"phase\":" << quote(d.phase)
            << ",\"severity\":" << quote(d.severity)
            << ",\"line\":" << d.line
            << ",\"col\":" << d.col
            << ",\"length\":" << d.length
            << ",\"message\":" << quote(d.message) << "}";
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
