// arduino_stub.h — just enough of the Arduino API to check that generated
// sketches compile with a normal C++ compiler (used by tests/run_tests.sh).
#pragma once
#include <cstdint>
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
enum { A0 = 14, A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11 };
inline int analogRead(int) { return 0; }
inline int digitalRead(int) { return 0; }
inline void digitalWrite(int, int) {}
inline void analogWrite(int, int) {}
inline void pinMode(int, int) {}
inline void delay(unsigned long) {}
template <typename T> T constrain(T x, T lo, T hi) { return x < lo ? lo : x > hi ? hi : x; }
inline double constrain(double x, int lo, int hi) { return x < lo ? lo : x > hi ? hi : x; }
struct SerialStub { void begin(long) {} } Serial;
