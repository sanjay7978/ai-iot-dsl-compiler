// json.h — serializes the compiler's results as JSON for the web interface.
#pragma once

#include <string>
#include <vector>

#include "ast.h"
#include "token.h"

struct CompileStats {
    int tokens = 0;
    int rules = 0;
    int declarations = 0;
    double timeMs = 0.0;
};

std::string toJson(const std::vector<Token>& tokens,
                   const DisplayNode* ast,
                   const std::vector<Diagnostic>& errors,
                   const CompileStats& stats);
