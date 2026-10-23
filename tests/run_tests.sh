#!/bin/sh
# Tests for every compiler phase: runs iotc and checks exit codes and output.
cd "$(dirname "$0")/.." || exit 1

pass=0
fail=0
DECLS="SENSOR a : NUMBER
SENSOR b : NUMBER
SENSOR c : NUMBER
SENSOR t : NUMBER
SENSOR door : STATE
DEVICE f, g
"

ok()  { echo "ok    $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1${2:+: $2}"; fail=$((fail + 1)); }

check() {   # check <file> <expected exit> [expected text] [options]
    out=$(./iotc "$1" $4 2>&1)
    code=$?
    if [ "$code" -ne "$2" ]; then bad "$1" "exit $code, expected $2"; return; fi
    if [ -n "$3" ] && ! printf '%s' "$out" | grep -qF -- "$3"; then bad "$1" "missing: $3"; return; fi
    ok "$1 $4"
}

check_src() {   # check_src <name> <source> <expected exit> [expected text] [options]
    out=$(printf '%s' "$2" | ./iotc $5 2>&1)
    code=$?
    if [ "$code" -ne "$3" ]; then bad "$1" "exit $code, expected $3"; return; fi
    if [ -n "$4" ] && ! printf '%s' "$out" | grep -qF -- "$4"; then bad "$1" "missing: $4"; return; fi
    ok "$1"
}

echo "--- examples"
check examples/01_basic.iot         0 "Compilation succeeded"
check examples/02_smart_home.iot    0 "3 rules"
check examples/03_greenhouse.iot    0 "2 rules"
check examples/04_lexical_error.iot 1 "unexpected character '@'"
check examples/05_syntax_error.iot  1 "expected 'THEN' after the condition"
check examples/06_semantic_error.iot 1 "'fan' is not a registered device"
check examples/07_optimization.iot  0 "Instructions: 21 -> 10" --opt

echo "--- lexer and parser"
check_src "precedence: AND binds tighter than OR" \
    "${DECLS}IF a == 1 OR b == 2 AND c == 3 THEN turn_on(f)" 0 "└── OR" --ast
check_src "two-character operators" \
    "${DECLS}IF a >= 1 AND b <= 2 AND c != 3 THEN turn_on(f)" 0 "Comparison: !=" --ast
check_src "decimal numbers" "${DECLS}IF t > 22.5 THEN turn_on(f)" 0 "Number: 22.5" --ast
check_src "missing condition" "IF THEN f(x)" 1 "expected a condition"
check_src "missing action" "IF t > 1 THEN" 1 "expected an action"
check_src "unclosed parenthesis" "IF (t > 1 THEN f(x)" 1 "expected ')' to close"
check_src "lowercase keyword hint" "if t > 1 THEN f(x)" 1 "did you mean 'IF'?"
check_src "bad number" "IF t > 3x THEN f(x)" 1 "invalid numeric literal '3x'"
check_src "empty program" "" 0 "0 tokens"

echo "--- semantic analysis"
check_src "undeclared sensor" "DEVICE f
IF x > 1 THEN turn_on(f)" 1 "'x' is not a declared sensor"
check_src "undeclared device" "SENSOR t : NUMBER
IF t > 1 THEN turn_on(fan)" 1 "'fan' is not a registered device"
check_src "duplicate declaration" "${DECLS}DEVICE f
IF t > 1 THEN turn_on(f)" 1 "already declared"
check_src "NUMBER vs state" "${DECLS}IF t == OPEN THEN turn_on(f)" 1 "type mismatch"
check_src "relational on STATE" "${DECLS}IF door > OPEN THEN turn_on(f)" 1 "cannot be used on STATE values"
check_src "device in condition" "${DECLS}IF f == ON THEN turn_on(g)" 1 "is a device, not a sensor"
check_src "sensor as device" "${DECLS}IF t > 1 THEN turn_on(t)" 1 "is a sensor, not a device"
check_src "unknown action" "${DECLS}IF t > 1 THEN blink(f)" 1 "unknown action 'blink'"
check_src "wrong argument count" "${DECLS}IF t > 1 THEN set_level(f)" 1 "expects 2 arguments"
check_src "spelling suggestion" "${DECLS}SENSOR humidity : NUMBER
IF humidty > 1 THEN turn_on(f)" 1 "did you mean 'humidity'?"
check_src "unused warning does not fail" "${DECLS}IF t > 1 THEN turn_on(f)" 0 "declared but never used"
check_src "sensor as level" "${DECLS}IF t > 1 THEN set_level(f, t)" 0 "set_level(f, t)" --ir

echo "--- intermediate code and optimization"
check_src "three-address code" "${DECLS}IF t > 30 AND door == OPEN THEN turn_on(f)" 0 "t3 = t1 AND t2" --ir
check_src "ELSE uses GOTO and labels" "${DECLS}IF t > 1 THEN turn_on(f) ELSE turn_off(f)" 0 "GOTO L2" --ir
check_src "constant folding" "${DECLS}IF 5 > 3 THEN turn_on(f)" 0 "Constant folding" --opt
check_src "common sub-expression" "${DECLS}IF t > 1 THEN turn_on(f)
IF t > 1 THEN turn_on(g)" 0 "Common sub-expression elimination" --opt
check_src "dead branch removed" "${DECLS}IF 1 > 2 THEN turn_on(f) ELSE turn_off(f)" 0 "Instructions: 7 -> 1" --opt

echo "--- code generation (compile and run the C output)"
mkdir -p build
run_c() {   # run_c <name> <file> <expected text> <sensor args...>
    name=$1; file=$2; expect=$3; shift 3
    if ! ./iotc "$file" -o build/test.c > /dev/null 2>&1; then bad "$name" "iotc failed"; return; fi
    if ! cc -std=c99 -Wall -Wextra -Werror -Iruntime build/test.c runtime/iot_runtime.c -o build/test_prog 2> build/cc.log; then
        bad "$name" "C compile failed: $(head -3 build/cc.log)"; return
    fi
    out=$(./build/test_prog "$@" 2>&1)
    if printf '%s' "$out" | grep -qE -- "$expect"; then ok "$name"; else bad "$name" "got: $out"; fi
}
run_c "basic: hot and open -> fan on"  examples/01_basic.iot "fan +ON" temperature=32 door=OPEN
run_c "basic: cool -> fan off"         examples/01_basic.iot "fan +OFF" temperature=20 door=OPEN
run_c "smart home: ELSE branch"        examples/02_smart_home.iot "turn_off\(fan\)" temperature=20 door=OPEN motion=OFF humidity=50
run_c "smart home: set_level"          examples/02_smart_home.iot "ac +ON \(level 22.5\)" temperature=36 door=CLOSED motion=OFF humidity=30
run_c "greenhouse: pump on"            examples/03_greenhouse.iot "pump +ON" soil_moisture=20 light_level=500 rain=FALSE
run_c "optimized program"              examples/07_optimization.iot "heater +OFF" temperature=10 door=CLOSED

echo "--- JSON"
printf '%s' "${DECLS}IF t > 1 THEN turn_on(f)" | ./iotc --json | python3 -m json.tool > /dev/null \
    && ok "json parses" || bad "json parses"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
