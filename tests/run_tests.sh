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
printf 'SENSOR t : NUMBER\nSENSOR d : STATE\nDEVICE f, g\nIF d == OPEN THEN turn_on(f)\nELSE IF t > 30 THEN turn_off(f)\nIF t > 30 THEN turn_on(g)\n' > build/cse_branch.iot
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

echo "--- arithmetic and ELSE IF"
check_src "arithmetic precedence: * before +" "${DECLS}IF a + b * 2 > 10 THEN turn_on(f)" 0 "└── Arithmetic: *" --ast
check_src "parentheses and unary minus" "${DECLS}IF -(a - b) < 0 THEN turn_on(f)" 0 "Negate" --ast
check_src "arithmetic needs numbers" "${DECLS}IF door + 1 > 2 THEN turn_on(f)" 1 "arithmetic '+' needs numbers"
check_src "condition must be true/false" "${DECLS}IF t + 1 THEN turn_on(f)" 1 "the condition must be true or false"
check_src "division by zero warning" "${DECLS}IF t / 0 > 1 THEN turn_on(f)" 0 "division by zero"
check_src "constant arithmetic is folded" "${DECLS}IF t > 10 * 3 THEN turn_on(f)" 0 "t2 = t > 30" --opt
check_src "x * 1 simplified" "${DECLS}IF t * 1 > 3 THEN turn_on(f)" 0 "Algebraic simplification" --opt
check_src "expression as set_level argument" "${DECLS}IF t > 1 THEN set_level(f, t * 2)" 0 "CALL set_level(f, t2)" --ir
check_src "ELSE IF in the AST" "${DECLS}IF t > 30 THEN turn_on(f) ELSE IF t < 10 THEN turn_off(f)" 0 "Else If" --ast
check_src "ELSE IF chain in the IR" "${DECLS}IF t > 30 THEN turn_on(f) ELSE IF t < 10 THEN turn_off(f) ELSE turn_on(g)" 0 "IF_FALSE t2 GOTO L3" --ir
check_src "ELSE IF becomes nested if/else in C" "${DECLS}IF t > 30 THEN turn_on(f) ELSE IF t < 10 THEN turn_off(f)" 0 "} else {" --c

echo "--- rule analysis"
check_src "impossible condition" "${DECLS}IF t > 30 AND t < 20 THEN turn_on(f)" 0 "can never be true"
check_src "impossible STATE condition" "${DECLS}IF door == OPEN AND door == CLOSED THEN turn_on(f)" 0 "can never be true"
check_src "always-true condition" "${DECLS}IF t > 5 OR t <= 5 THEN turn_on(f)" 0 "always true"
check_src "unreachable ELSE IF" "${DECLS}IF t > 30 THEN turn_on(f) ELSE IF t > 40 THEN turn_off(f)" 0 "this ELSE IF can never run"
check_src "unreachable ELSE" "${DECLS}IF t > 5 THEN turn_on(f) ELSE IF t <= 5 THEN turn_off(f) ELSE turn_on(g)" 0 "the ELSE part can never run"
check_src "conflicting rules with example values" "${DECLS}IF t > 30 THEN turn_on(f)
IF door == OPEN THEN turn_off(f)" 0 "e.g. when t = 31 and door = OPEN"
check_src "conflict inside one branch" "${DECLS}IF t > 1 THEN turn_on(f) turn_off(f)" 0 "only the last action has effect"
check_src "possible conflict with arithmetic" "${DECLS}IF a - b > 2 THEN turn_on(f)
IF t > 1 THEN turn_off(f)" 0 "possible conflict"
out=$(printf '%s' "${DECLS}IF t > 30 THEN turn_on(f)
IF t < 20 THEN turn_off(f)" | ./iotc 2>&1)
if printf '%s' "$out" | grep -q "conflict"; then bad "no false conflict for disjoint conditions"; else ok "no false conflict for disjoint conditions"; fi
check examples/08_rule_analysis.iot 0 "rule 4 turns 'fan' off while rule 3"

echo "--- control-flow graph and dataflow"
check_src "basic blocks and edges" "${DECLS}IF t > 1 THEN turn_on(f) ELSE turn_off(f)" 0 "-> B2, B3" --cfg
check_src "liveness across blocks" "${DECLS}IF t > 1 THEN turn_on(f) ELSE turn_off(f)
IF t > 1 THEN turn_on(g)" 0 "live out: {t1}" --cfg
check_src "CSE when available on every path" "${DECLS}IF t > 1 THEN turn_on(f) ELSE turn_off(f)
IF t > 1 THEN turn_on(g)" 0 "Common sub-expression elimination" --opt
out=$(printf '%s' "${DECLS}IF door == OPEN THEN turn_on(f)
ELSE IF t > 30 THEN turn_off(f)
IF t > 30 THEN turn_on(g)" | ./iotc --opt 2>&1)
if printf '%s' "$out" | grep -q "Common sub-expression"; then bad "no CSE from inside a branch"; else ok "no CSE from inside a branch"; fi

echo "--- generated C for ELSE IF and arithmetic"
run_c "thermostat: window open"  examples/09_thermostat.iot "heater +OFF" window=OPEN temperature=10 outside=5
run_c "thermostat: heat level"   examples/09_thermostat.iot "heater +ON \(level 70\)" window=CLOSED temperature=15 outside=20
run_c "thermostat: cooling"      examples/09_thermostat.iot "cooler +ON" window=CLOSED temperature=30 outside=10
run_c "thermostat: vent"         examples/09_thermostat.iot "vent +ON" window=CLOSED temperature=30 outside=10
run_c "thermostat: idle"         examples/09_thermostat.iot "cooler +OFF" window=CLOSED temperature=22 outside=22
run_c "CSE stays correct with ELSE IF" build/cse_branch.iot "g +ON" d=OPEN t=35
run_c "rule analysis example compiles" examples/08_rule_analysis.iot "fan +OFF" temperature=35 door=OPEN

echo "--- New examples: home security and air quality"
check examples/10_home_security.iot 0 "3 rules"
check examples/11_air_quality.iot   0 "3 rules"
run_c "security: intruder -> alarm"       examples/10_home_security.iot "alarm +ON" armed=ON motion=ON front_door=CLOSED light_level=50
run_c "security: disarmed -> no alarm"    examples/10_home_security.iot "alarm +OFF" armed=OFF motion=ON front_door=OPEN light_level=50
run_c "security: dark, nobody -> dim"     examples/10_home_security.iot "porch_light +ON \(level 30\)" armed=OFF motion=OFF front_door=CLOSED light_level=5
run_c "air: vent in proportion to CO2"    examples/11_air_quality.iot "vent +ON \(level 50\)" co2=1000 humidity=50 occupancy=0 window=CLOSED
run_c "air: window open -> vent off"      examples/11_air_quality.iot "vent +OFF" co2=1500 humidity=50 occupancy=2 window=OPEN
run_c "air: dry -> humidifier"            examples/11_air_quality.iot "humidifier +ON" co2=400 humidity=30 occupancy=1 window=CLOSED
check examples/12_kitchen_safety.iot 0 "3 rules"
check examples/13_office_energy.iot  0 "4 rules"
run_c "kitchen: gas leak -> valve shut"   examples/12_kitchen_safety.iot "gas_valve +OFF" smoke=10 gas_level=400 temperature=25 stove=OFF
run_c "kitchen: cooking -> fan at 50"     examples/12_kitchen_safety.iot "exhaust_fan +ON \(level 50\)" smoke=10 gas_level=50 temperature=30 stove=ON
run_c "kitchen: fire -> sprinkler"        examples/12_kitchen_safety.iot "sprinkler +ON" smoke=90 gas_level=50 temperature=80 stove=ON
run_c "office: lights follow daylight"    examples/13_office_energy.iot "desk_lights +ON \(level 60\)" occupancy=3 light_level=400 temperature=24 hour=10 window=CLOSED
run_c "office: hot afternoon -> ac 80"    examples/13_office_energy.iot "ac +ON \(level 80\)" occupancy=3 light_level=400 temperature=30 hour=14 window=CLOSED
run_c "office: night -> monitors off"     examples/13_office_energy.iot "monitors +OFF" occupancy=0 light_level=0 temperature=20 hour=23 window=CLOSED

echo "--- grammar analysis, English, quick fixes, traces"
out=$(./iotc --grammar)
printf '%s' "$out" | grep -q "LL(1): no conflicts" && ok "grammar is LL(1)" || bad "grammar is LL(1)"
printf '%s' "$out" | grep -E "^expr +FIRST" | grep -q "NOT" && ok "FIRST(expr) contains NOT" || bad "FIRST(expr) contains NOT"
printf '%s' "$out" | grep -E "^actions +FIRST" | grep -q "FOLLOW { \$ DEVICE ELSE IF SENSOR }" && ok "FOLLOW(actions)" || bad "FOLLOW(actions)"
check examples/01_basic.iot 0 "If the temperature is above 30 and the door is open, turn on the fan." --english
check examples/09_thermostat.iot 0 "set the heater to level (22 minus the temperature) times 10" --english
json_has() {   # json_has <name> <source> <python expression on d>
    if printf '%s' "$2" | ./iotc --json --trace 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if ($3) else 1)"; then ok "$1"; else bad "$1"; fi
}
json_has "fix: did-you-mean" "${DECLS}IF tt > 1 THEN turn_on(f)" "any(f['text']=='t' for e in d['errors'] for f in e['fixes'])"
json_has "fix: declare device" "${DECLS}IF t > 1 THEN turn_on(fan)" "any(f['text']=='\\nDEVICE fan' for e in d['errors'] for f in e['fixes'])"
json_has "fix: declare STATE sensor" "${DECLS}IF gate == OPEN THEN turn_on(f)" "any(f['text']=='\\nSENSOR gate : STATE' for e in d['errors'] for f in e['fixes'])"
json_has "fix: = becomes ==" "${DECLS}IF t = 1 THEN turn_on(f)" "any(f['text']=='==' for e in d['errors'] for f in e['fixes'])"
json_has "fix: uppercase keyword" "if t > 1 THEN turn_on(f)" "any(f['text']=='IF' for e in d['errors'] for f in e['fixes'])"
json_has "fix: insert THEN" "${DECLS}IF t > 1 turn_on(f)" "any(f['text']=='THEN ' for e in d['errors'] for f in e['fixes'])"
json_has "fix: unknown action" "${DECLS}IF t > 1 THEN turnon(f)" "any(f['text']=='turn_on' for e in d['errors'] for f in e['fixes'])"
json_has "lexer DFA trace" "${DECLS}IF t >= 1 THEN turn_on(f)" "any(s[1]=='GT' and s[2]=='GE' for s in d['lexTrace'])"
json_has "parser call trace" "${DECLS}IF t > 1 THEN turn_on(f)" "['enter','rel_expr'] in [e[:2] for e in d['parseTrace']]"
json_has "IR source spans" "${DECLS}IF t > 1 THEN turn_on(f)" "d['ir'][1]['src'][:2]==[7,4]"
json_has "optimizer snapshots" "${DECLS}IF t > 1 AND 5 > 3 THEN turn_on(f)" "len(d['optTrace'])>=3 and d['optTrace'][0]['pass']=='Original'"
json_has "all four targets with line maps" "${DECLS}IF t > 1 THEN turn_on(f)" "[t['id'] for t in d['targets']]==['c','arduino','python','js'] and all(len(t['lines'])==t['code'].count(chr(10)) for t in d['targets'])"
./iotc --language | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d['grammar']['conflicts']==[] and len(d['dfa']['states'])>10 else 1)" && ok "language JSON" || bad "language JSON"

echo "--- every target gives the same result (C, Python, JavaScript; Arduino compiles)"
mkdir -p build/xt && cp runtime/iot_runtime.js runtime/iot_runtime.py build/xt/
for ex in 01_basic 02_smart_home 03_greenhouse 07_optimization 08_rule_analysis 09_thermostat 10_home_security 11_air_quality 12_kitchen_safety 13_office_energy; do
    ./iotc examples/$ex.iot -o build/xt/p.c > /dev/null
    ./iotc examples/$ex.iot --target python -o build/xt/p.py > /dev/null
    ./iotc examples/$ex.iot --target js -o build/xt/p.js > /dev/null
    ./iotc examples/$ex.iot --target arduino -o build/xt/p.ino > /dev/null
    cc -std=c99 -Wall -Werror -Iruntime build/xt/p.c runtime/iot_runtime.c -o build/xt/pc 2> /dev/null || { bad "$ex: C build"; continue; }
    same=1
    for A in "temperature=31 door=OPEN window=CLOSED outside=2 humidity=35 motion=ON soil_moisture=20 light_level=150 rain=FALSE front_door=OPEN armed=ON co2=1000 occupancy=2 smoke=80 gas_level=100 stove=ON hour=14" \
             "temperature=15.5 door=CLOSED window=OPEN outside=20 humidity=50 motion=OFF soil_moisture=60 light_level=900 rain=TRUE front_door=CLOSED armed=OFF co2=1500 occupancy=0 smoke=20 gas_level=350 stove=OFF hour=22" \
             "temperature=36 door=OPEN window=CLOSED outside=10 humidity=39.5 motion=OFF soil_moisture=34.9 light_level=200 rain=FALSE front_door=CLOSED armed=ON co2=650 occupancy=1 smoke=45 gas_level=10 stove=ON hour=9"; do
        c=$(build/xt/pc $A 2>/dev/null); p=$(python3 build/xt/p.py $A 2>/dev/null); j=$(node build/xt/p.js $A 2>/dev/null)
        [ "$c" = "$p" ] && [ "$c" = "$j" ] || same=0
    done
    [ $same = 1 ] && ok "$ex: C, Python and JavaScript agree" || bad "$ex: targets disagree"
    g++ -std=c++17 -fsyntax-only -Wall -Werror -include tests/arduino_stub.h -x c++ build/xt/p.ino 2> /dev/null \
        && ok "$ex: Arduino sketch compiles" || bad "$ex: Arduino sketch compiles"
done

echo "--- JSON"
printf '%s' "${DECLS}IF t > 1 THEN turn_on(f)" | ./iotc --json | python3 -m json.tool > /dev/null \
    && ok "json parses" || bad "json parses"

echo
echo "$pass passed, $fail failed"
mkdir -p build && printf '{"passed": %d, "failed": %d}\n' "$pass" "$fail" > build/test-summary.json
[ "$fail" -eq 0 ]
