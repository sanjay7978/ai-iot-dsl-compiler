// json.h — serializes the compiler's results as JSON for the web interface.
#pragma once

#include <string>

#include "compiler.h"

std::string toJson(const CompileResult& result, bool trace = false);

// The scanner's DFA and the grammar's FIRST/FOLLOW sets and LL(1) table.
std::string languageJson();
