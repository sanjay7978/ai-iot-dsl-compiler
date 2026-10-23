// codegen.cpp — emits structured C from the optimized three-address code.
//
// The IR generator always produces one of two shapes per rule:
//     IF_FALSE c GOTO L1  <then>  L1:                       ->  if (c) { then }
//     IF_FALSE c GOTO L1  <then>  GOTO L2  L1:  <else>  L2:  ->  if (c) { then } else { else }
// so the generator turns them back into if / if-else blocks instead of gotos.

#include "codegen.h"

#include <cctype>
#include <set>

namespace {

const std::set<std::string> kCKeywords = {
    "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else",
    "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long", "register",
    "restrict", "return", "short", "signed", "sizeof", "static", "struct", "switch", "typedef",
    "union", "unsigned", "void", "volatile", "while", "bool", "true", "false", "main",
};

std::string upper(const std::string& s) {
    std::string r;
    for (char c : s) r += static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return r;
}

size_t findLabel(const std::vector<IrInstr>& code, size_t from, size_t to, const std::string& label) {
    for (size_t i = from; i < to; ++i)
        if (code[i].op == IrOp::Label && code[i].label == label) return i;
    return to;
}

}  // namespace

std::string cIdentifier(const std::string& name) {
    return kCKeywords.count(name) ? name + "_" : name;
}

std::string deviceConstant(const std::string& name) { return "DEV_" + upper(name); }

std::string CodeGenerator::value(const IrValue& v) const {
    switch (v.kind) {
        case IrValue::Kind::Temp:   return v.text;
        case IrValue::Kind::Sensor: return cIdentifier(v.text);
        case IrValue::Kind::Number: return v.text;
        case IrValue::Kind::State:  return "STATE_" + v.text;
        case IrValue::Kind::Bool:   return v.text;
        case IrValue::Kind::Device: return deviceConstant(v.text);
        case IrValue::Kind::None:   return "";
    }
    return "";
}

void CodeGenerator::emitRange(const std::vector<IrInstr>& code, size_t from, size_t to, int indent,
                              const std::string& exitLabel) {
    for (size_t i = from; i < to; ++i) {
        const IrInstr& in = code[i];
        const std::string type = in.numeric ? "double " : "bool ";
        switch (in.op) {
            case IrOp::Rule:
                out_ += "\n" + line(indent) + "/* Rule " + std::to_string(in.rule) + " (source line " +
                        std::to_string(in.line) + ") */\n";
                break;

            case IrOp::Binary: {
                std::string op = in.oper == "AND" ? "&&" : in.oper == "OR" ? "||" : in.oper;
                out_ += line(indent) + type + in.dest + " = " + value(in.a) + " " + op + " " + value(in.b) + ";\n";
                break;
            }
            case IrOp::Not:
                out_ += line(indent) + "bool " + in.dest + " = !" + value(in.a) + ";\n";
                break;
            case IrOp::Neg:
                out_ += line(indent) + "double " + in.dest + " = -" + value(in.a) + ";\n";
                break;
            case IrOp::Copy:
                out_ += line(indent) + type + in.dest + " = " + value(in.a) + ";\n";
                break;

            case IrOp::Call: {
                std::string s = line(indent) + in.callee + "(";
                for (size_t k = 0; k < in.args.size(); ++k) s += (k ? ", " : "") + value(in.args[k]);
                out_ += s + ");\n";
                break;
            }

            case IrOp::IfFalse: {
                std::string cond = value(in.a);
                // IF_FALSE c GOTO <end of this range>:   if (c) { rest of range }
                if (in.label == exitLabel) {
                    out_ += line(indent) + "if (" + cond + ") {\n";
                    emitRange(code, i + 1, to, indent + 1, exitLabel);
                    out_ += line(indent) + "}\n";
                    i = to;
                    break;
                }
                size_t elseAt = findLabel(code, i + 1, to, in.label);
                if (elseAt == to) {   // not a shape we know: fall back to a goto
                    out_ += line(indent) + "if (!" + cond + ") goto " + in.label + ";\n";
                    break;
                }
                // Then-part ends with GOTO E?  Then the code after L1 is the ELSE part,
                // running up to label E (or to the end of this range if E is our exit).
                if (elseAt > i + 1 && code[elseAt - 1].op == IrOp::Goto) {
                    const std::string& e = code[elseAt - 1].label;
                    size_t endAt = e == exitLabel ? to : findLabel(code, elseAt + 1, to, e);
                    if (endAt != to || e == exitLabel) {
                        out_ += line(indent) + "if (" + cond + ") {\n";
                        emitRange(code, i + 1, elseAt - 1, indent + 1, e);
                        out_ += line(indent) + "} else {\n";
                        emitRange(code, elseAt + 1, endAt, indent + 1, e);
                        out_ += line(indent) + "}\n";
                        i = endAt;   // skips label E
                        break;
                    }
                }
                out_ += line(indent) + "if (" + cond + ") {\n";
                emitRange(code, i + 1, elseAt, indent + 1, in.label);
                out_ += line(indent) + "}\n";
                i = elseAt;   // skips label L1
                break;
            }

            case IrOp::Goto:
                if (in.label == exitLabel && i + 1 == to) break;   // leaving the range: nothing to do
                out_ += line(indent) + "goto " + in.label + ";\n";
                break;
            case IrOp::Label:
                out_ += in.label + ":;\n";
                break;
        }
    }
}

std::string CodeGenerator::generate(const std::vector<IrInstr>& code, const SymbolTable& symbols,
                                    const std::string& sourceName) {
    out_.clear();
    out_ += "/*\n * Generated by iotc from " + sourceName + ". Do not edit by hand.\n"
            " * Build: cc -std=c99 -Iruntime program.c runtime/iot_runtime.c -o program\n"
            " * Run:   ./program temperature=32 door=OPEN\n */\n\n";
    out_ += "#include \"iot_runtime.h\"\n\n";

    // Device table
    std::vector<std::string> devices;
    for (const Symbol& s : symbols.all())
        if (s.kind == SymbolKind::Device) devices.push_back(s.name);

    out_ += "/* Devices */\n";
    if (devices.empty()) {
        out_ += "const char *const iot_device_names[] = { \"\" };\nconst int iot_device_count = 0;\n";
    } else {
        out_ += "enum {";
        for (size_t i = 0; i < devices.size(); ++i)
            out_ += (i ? ", " : " ") + deviceConstant(devices[i]);
        out_ += " };\n";
        out_ += "const char *const iot_device_names[] = {";
        for (size_t i = 0; i < devices.size(); ++i) out_ += (i ? ", " : " ") + ("\"" + devices[i] + "\"");
        out_ += " };\n";
        out_ += "const int iot_device_count = " + std::to_string(devices.size()) + ";\n";
    }

    // Only read the sensors the optimized code still uses (avoids unused-variable warnings).
    std::set<std::string> usedSensors;
    for (const IrInstr& in : code) {
        auto note = [&](const IrValue& v) { if (v.kind == IrValue::Kind::Sensor) usedSensors.insert(v.text); };
        if (in.op == IrOp::Binary || in.op == IrOp::Not || in.op == IrOp::Neg || in.op == IrOp::Copy ||
            in.op == IrOp::IfFalse) {
            note(in.a);
            note(in.b);
        }
        for (const IrValue& v : in.args) note(v);
    }

    out_ += "\nvoid evaluate_rules(void)\n{\n";
    out_ += "    /* Read every sensor once, so all rules see the same snapshot */\n";
    bool anySensor = false;
    for (const Symbol& s : symbols.all()) {
        if (s.kind != SymbolKind::Sensor || !usedSensors.count(s.name)) continue;
        anySensor = true;
        if (s.type == ValueType::Number)
            out_ += "    double " + cIdentifier(s.name) + " = read_number(\"" + s.name + "\");\n";
        else
            out_ += "    state_t " + cIdentifier(s.name) + " = read_state(\"" + s.name + "\");\n";
    }
    if (!anySensor) out_ += "    /* (no sensors are needed) */\n";

    emitRange(code, 0, code.size(), 1, "");
    out_ += "}\n";
    return out_;
}
