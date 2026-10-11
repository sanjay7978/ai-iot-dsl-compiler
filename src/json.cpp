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

}  // namespace

std::string toJson(const std::vector<Token>& tokens,
                   const DisplayNode* ast,
                   const std::vector<Diagnostic>& errors,
                   const CompileStats& stats) {
    std::ostringstream out;
    out << "{\"success\":" << (errors.empty() ? "true" : "false");

    out << ",\"tokens\":[";
    bool first = true;
    for (const Token& t : tokens) {
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
    if (ast) writeNode(*ast, out);
    else out << "null";

    out << ",\"errors\":[";
    for (size_t i = 0; i < errors.size(); ++i) {
        const Diagnostic& d = errors[i];
        if (i) out << ",";
        out << "{\"phase\":" << quote(d.phase)
            << ",\"line\":" << d.line
            << ",\"col\":" << d.col
            << ",\"length\":" << d.length
            << ",\"message\":" << quote(d.message) << "}";
    }
    out << "]";

    char ms[32];
    std::snprintf(ms, sizeof ms, "%.3f", stats.timeMs);
    out << ",\"stats\":{\"tokens\":" << stats.tokens
        << ",\"rules\":" << stats.rules
        << ",\"declarations\":" << stats.declarations
        << ",\"errors\":" << errors.size()
        << ",\"timeMs\":" << ms << "}}";
    return out.str();
}
