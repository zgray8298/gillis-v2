#pragma once
// =============================================================================
// pins.h — Teensy 4.1 pin assignments for Gillis V2.0
// =============================================================================
//
//  Digital Outputs — Stepper drivers (via 3.3V→5V opto board)
//    Step pulses: active HIGH, min 1µs width
//    Direction: HIGH = positive direction
//    ALL_ENABLE: active LOW to enable all three CL57Y drivers (shared opto channel)
//
//  Digital Outputs — Relay board (3.3V direct trigger, built-in opto)
//    Active HIGH to energise relay
//
//  Digital Inputs — Sensors via 24V opto boards
//    Opto output is ACTIVE LOW when sensor triggered (PNP sensor energises opto LED)
//
//  Analogue Input — Air pressure sensor
//    5V sensor → 10kΩ/20kΩ divider → ~3.3V max on Teensy ADC pin
// =============================================================================

// --- Stepper step/dir outputs ------------------------------------------------
#define PIN_X_STEP          2
#define PIN_X_DIR           3
#define PIN_YL_STEP         4
#define PIN_YL_DIR          5
#define PIN_YR_STEP         6
#define PIN_YR_DIR          7

// ALL_ENABLE: single opto channel wired to all three CL57Y ENABLE pins
// Active LOW = drivers enabled; HIGH = drivers disabled/free
#define PIN_ALL_ENABLE      8

// --- Relay board outputs (active HIGH) ---------------------------------------
#define PIN_Z_SOLENOID_A    9   // Ch1 — Energise = Z DOWN, de-energise = spring Z UP
#define PIN_LASER_RELAY     10  // Ch2 — Laser trigger (TBC — confirm interface)
#define PIN_SPARE_RELAY_1   11  // Ch3 — Future expansion
#define PIN_SPARE_RELAY_2   12  // Ch4 — Future expansion

// --- Sensor digital inputs (active LOW via opto board) -----------------------
#define PIN_X_HOME          14
#define PIN_Y_LEFT_HOME     15
#define PIN_Y_RIGHT_HOME    16
#define PIN_Z_UP_SENSOR     17
#define PIN_Z_DOWN_SENSOR   18

// --- CL57Y ALM inputs (active LOW = fault/alarm) -----------------------------
#define PIN_X_DRIVER_ALM    19
#define PIN_Y_LEFT_ALM      20
#define PIN_Y_RIGHT_ALM     21

// --- Analogue input ----------------------------------------------------------
#define PIN_AIR_PRESSURE    A0  // Teensy 4.1 pin 14 / A0 — ADC input

// =============================================================================
// pins_init — configure all GPIO
// =============================================================================
inline void pins_init() {
  // Step / dir outputs
  pinMode(PIN_X_STEP,    OUTPUT); digitalWrite(PIN_X_STEP,    LOW);
  pinMode(PIN_X_DIR,     OUTPUT); digitalWrite(PIN_X_DIR,     LOW);
  pinMode(PIN_YL_STEP,   OUTPUT); digitalWrite(PIN_YL_STEP,   LOW);
  pinMode(PIN_YL_DIR,    OUTPUT); digitalWrite(PIN_YL_DIR,    LOW);
  pinMode(PIN_YR_STEP,   OUTPUT); digitalWrite(PIN_YR_STEP,   LOW);
  pinMode(PIN_YR_DIR,    OUTPUT); digitalWrite(PIN_YR_DIR,    LOW);

  // Enable — start DISABLED (HIGH = disable) until ENABLE command received
  pinMode(PIN_ALL_ENABLE, OUTPUT); digitalWrite(PIN_ALL_ENABLE, HIGH);

  // Relay outputs — all OFF on boot
  pinMode(PIN_Z_SOLENOID_A,  OUTPUT); digitalWrite(PIN_Z_SOLENOID_A,  LOW);
  pinMode(PIN_LASER_RELAY,   OUTPUT); digitalWrite(PIN_LASER_RELAY,   LOW);
  pinMode(PIN_SPARE_RELAY_1, OUTPUT); digitalWrite(PIN_SPARE_RELAY_1, LOW);
  pinMode(PIN_SPARE_RELAY_2, OUTPUT); digitalWrite(PIN_SPARE_RELAY_2, LOW);

  // Sensor inputs — internal pull-up (opto outputs are open-collector)
  pinMode(PIN_X_HOME,       INPUT_PULLUP);
  pinMode(PIN_Y_LEFT_HOME,  INPUT_PULLUP);
  pinMode(PIN_Y_RIGHT_HOME, INPUT_PULLUP);
  pinMode(PIN_Z_UP_SENSOR,  INPUT_PULLUP);
  pinMode(PIN_Z_DOWN_SENSOR,INPUT_PULLUP);

  // ALM inputs — pull-up (ALM is open-collector active LOW)
  pinMode(PIN_X_DRIVER_ALM,   INPUT_PULLUP);
  pinMode(PIN_Y_LEFT_ALM,     INPUT_PULLUP);
  pinMode(PIN_Y_RIGHT_ALM,    INPUT_PULLUP);

  // ADC — no special setup needed; analogReadResolution set in config
  analogReadResolution(12); // 12-bit ADC on Teensy 4.1
}
