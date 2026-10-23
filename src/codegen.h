// codegen.h — Phase 7: target code generation (optimized IR -> C).
//
// The generated file defines evaluate_rules() plus the device table, and is
// linked with runtime/iot_runtime.c, which reads sensor values and performs
// the device actions.
#pragma once

#include <string>
#include <vector>

#include "ir.h"
#include "semantic.h"

class CodeGenerator {
public:
    std::string generate(const std::vector<IrInstr>& code, const SymbolTable& symbols,
                         const std::string& sourceName);

private:
    // Emits code[from, to). A jump to exitLabel means "leave this range".
    void emitRange(const std::vector<IrInstr>& code, size_t from, size_t to, int indent,
                   const std::string& exitLabel);
    std::string value(const IrValue& v) const;
    std::string line(int indent) const { return std::string(static_cast<size_t>(indent) * 4, ' '); }

    std::string out_;
};

// C name for a DSL identifier (adds '_' if it clashes with a C keyword).
std::string cIdentifier(const std::string& name);
// Enum constant for a device: fan -> DEV_FAN
std::string deviceConstant(const std::string& name);
