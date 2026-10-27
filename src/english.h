// english.h — translates a program back into plain English.
//
// A small "reverse compiler": it walks the AST and produces sentences such as
//   "Rule 1: If the temperature is above 30 and the door is open,
//    turn on the fan. Otherwise, turn off the fan."
// It needs no AI, so programs can always be explained, even offline.
#pragma once

#include <string>
#include <vector>

#include "ast.h"

std::vector<std::string> describeProgram(const Program& program);
