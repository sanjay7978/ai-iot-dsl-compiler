#!/bin/sh
# Runs the compiler on every example and checks the exit code and messages.
cd "$(dirname "$0")/.." || exit 1

pass=0
fail=0

check() {   # check <file> <expected exit> [expected text]
    out=$(./iotc "$1" 2>&1)
    code=$?
    if [ "$code" -ne "$2" ]; then
        echo "FAIL  $1: exit $code, expected $2"; fail=$((fail + 1)); return
    fi
    if [ -n "$3" ] && ! printf '%s' "$out" | grep -qF -- "$3"; then
        echo "FAIL  $1: output does not contain: $3"; fail=$((fail + 1)); return
    fi
    echo "ok    $1"; pass=$((pass + 1))
}

check_src() {   # check_src <name> <source> <expected exit> [expected text]
    out=$(printf '%s' "$2" | ./iotc 2>&1)
    code=$?
    if [ "$code" -ne "$3" ] || { [ -n "$4" ] && ! printf '%s' "$out" | grep -qF -- "$4"; }; then
        echo "FAIL  $1"; fail=$((fail + 1)); return
    fi
    echo "ok    $1"; pass=$((pass + 1))
}

check examples/01_basic.iot        0 "13 tokens"
check examples/02_smart_home.iot   0 "3 rules"
check examples/03_greenhouse.iot   0 "2 rules"
check examples/04_lexical_error.iot 1 "unexpected character '@'"
check examples/05_syntax_error.iot 1 "expected 'THEN' after the condition"

check_src "precedence: AND binds tighter than OR" \
    "IF a == 1 OR b == 2 AND c == 3 THEN f(x)" 0 "└── OR"
check_src "two-character operators" \
    "IF a >= 1 AND b <= 2 AND c != 3 THEN f(x)" 0 "Comparison: !="
check_src "decimal numbers" "IF t > 22.5 THEN f(x)" 0 "Number: 22.5"
check_src "missing condition" "IF THEN f(x)" 1 "expected a condition"
check_src "missing action" "IF t > 1 THEN" 1 "expected an action"
check_src "unclosed parenthesis" "IF (t > 1 THEN f(x)" 1 "expected ')' to close"
check_src "lowercase keyword hint" "if t > 1 THEN f(x)" 1 "did you mean 'IF'?"
check_src "bad number" "IF t > 3x THEN f(x)" 1 "invalid numeric literal '3x'"
check_src "empty program" "" 0 "0 tokens"
check_src "json output is valid" "IF t > 1 THEN f(x)" 0 ""
printf 'IF t > 1 THEN f(x)' | ./iotc --json | python3 -m json.tool > /dev/null \
    && { echo "ok    json parses"; pass=$((pass + 1)); } \
    || { echo "FAIL  json parses"; fail=$((fail + 1)); }

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
