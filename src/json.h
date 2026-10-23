// json.h — serializes the compiler's results as JSON for the web interface.
#pragma once

#include <string>

#include "compiler.h"

std::string toJson(const CompileResult& result);
