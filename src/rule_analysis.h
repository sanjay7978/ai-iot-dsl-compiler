// rule_analysis.h — logical analysis of rule conditions (part of Phase 4).
//
// After type checking, every condition is rewritten into disjunctive normal
// form (an OR of ANDs of simple comparisons). For each AND-group the analyzer
// checks whether some sensor values can satisfy it:
//   * NUMBER sensors: the comparisons are intersected as intervals,
//     e.g. temperature > 30 AND temperature < 20 gives an empty interval;
//   * STATE sensors: the set of allowed states is intersected.
// This finds
//   * conditions that can never be true, or are always true,
//   * ELSE IF / ELSE parts that can never run,
//   * conflicting rules: two rules that control the same device differently
//     and can both apply at the same time (with example sensor values).
// Comparisons it cannot reason about (arithmetic on sensors, sensor vs
// sensor) are treated as "may be true", so it never reports a false
// "impossible"; such conflicts are reported as "may conflict".
#pragma once

#include <vector>

#include "ast.h"
#include "semantic.h"
#include "token.h"

std::vector<Diagnostic> analyzeRules(const Program& program, const SymbolTable& symbols);
