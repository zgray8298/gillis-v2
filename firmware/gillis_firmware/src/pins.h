#pragma once
// =============================================================================
// pins.h — Teensy 4.1 pin assignments for Gillis V2.0 (Rev4)
// =============================================================================
//
//  Power architecture:
//    24V main supply feeds the electronics box and pendant.
//    Electronics box: 24V→5V DC-DC powers the relay board, sensor opto
//      boards' 5V logic side, the air-pressure sensor, AND the Teensy 4.1
//      (fed into Teensy VIN). The USB VBUS pad on the Teensy MUST be cut so
//      the Pi's USB 5V does not back-feed this rail or fight it on boot.
//    Pendant: local 24V→5V buck for the Pi 4 and 7" touchscreen only.
//    Teensy↔Pi is USB CDC data-only — no VBUS power from the Pi.
//
//  Digital Outputs — Stepper drivers (via 3.3V→24V opto isolation)
//    Teensy 3.3V drives the opto LED; opto output switches the 24V logic
//    rail into each CL57Y driver's step/dir/enable input (CL57Y accepts
//    5-24V control via its own internal opto).
//    Step pulses: active HIGH, min 1µs width
//    Direction: HIGH = positive direction
//    ALL_ENABLE: active LOW to enable all three CL57Y drivers (shared opto)
//
//  Digital Outputs — Relay board (3.3V direct trigger, built-in opto)
//    Active LOW to energise relay (SONGLE 4-ch board with opto inputs wired
//    such that pulling IN to GND lights the opto LED). HIGH = relay coil
//    de-energised, contacts open. Relay board powered from the 5V rail in
//    the electronics box.
//    Ch1 = Z solenoid head A
//    Ch2 = Laser trigger
//    Ch3 = Z solenoid head B (firmware ready, wiring optional)
//    Ch4 = Z solenoid head C (firmware ready, wiring optional)
//
//  Digital Inputs — Sensors via 24V opto boards
//    Sensor 24V PNP output drives the opto LED; opto output pulls the
//    Teensy pin to GND when the sensor is triggered (ACTIVE LOW).
//
//  Analogue Input — Air pressure sensor
//    Stainless 0-150 PSI transducer, 5V supply, 0.5–4.5V ratiometric output.
//    Wiring: RED=+5V (from electronics-box 5V DC-DC), BLACK=GND, GREEN=signal.
//    Divider: 10kΩ (top, signal→A0) + 22kΩ (bottom, A0→GND) → ratio 0.6875,
//    giving 0.34V at 0 PSI and ~3.09V at 150 PSI (well within 3.3V ADC).
//    12-bit ADC with analogReadResolution(12); scaling lives in config.h.
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
#define PIN_Z_SOLENOID_A    9   // Ch1 — Head A  (Energise = DOWN, spring return UP)
#define PIN_LASER_RELAY     10  // Ch2 — Laser trigger
#define PIN_Z_SOLENOID_B    11  // Ch3 — Head B  (Rev4 — firmware ready)
#define PIN_Z_SOLENOID_C    12  // Ch4 — Head C  (Rev4 — firmware ready)

// --- Sensor digital inputs (active LOW via opto board) -----------------------
// NB: pin 14 is A0 on Teensy 4.1 and is reserved for PIN_AIR_PRESSURE. X-home
// was originally assigned to 14 and collided with the analog read — moved to
// pin 22 in Rev4 bench testing (2026-04). Update harness wiring accordingly.
#define PIN_X_HOME          22
#define PIN_Y_LEFT_HOME     15
#define PIN_Y_RIGHT_HOME    16
#define PIN_Z_UP_SENSOR     17
#define PIN_Z_DOWN_SENSOR   18

// --- CL57Y ALM inputs (active LOW = fault/alarm) -----------------------------
#define PIN_X_DRIVER_ALM    19
#define PIN_Y_LEFT_ALM      20
#define PIN_Y_RIGHT_ALM     21

// --- Analogue input ----------------------------------------------------------
#define PIN_AIR_PRESSURE    A0

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

  // Relay outputs — all OFF on boot.
  // SONGLE 4-ch relay board is ACTIVE-LOW input: HIGH = de-energised (safe).
  // Verified empirically 2026-05-05; fixing this prevents a boot-time hazard
  // where all Z heads would extend DOWN simultaneously before firmware took over.
  pinMode(PIN_Z_SOLENOID_A, OUTPUT); digitalWrite(PIN_Z_SOLENOID_A, HIGH);
  pinMode(PIN_Z_SOLENOID_B, OUTPUT); digitalWrite(PIN_Z_SOLENOID_B, HIGH);
  pinMode(PIN_Z_SOLENOID_C, OUTPUT); digitalWrite(PIN_Z_SOLENOID_C, HIGH);
  pinMode(PIN_LASER_RELAY,  OUTPUT); digitalWrite(PIN_LASER_RELAY,  HIGH);

  // Sensor inputs — internal pull-up (opto outputs are open-collector)
  pinMode(PIN_X_HOME,        INPUT_PULLUP);
  pinMode(PIN_Y_LEFT_HOME,   INPUT_PULLUP);
  pinMode(PIN_Y_RIGHT_HOME,  INPUT_PULLUP);
  pinMode(PIN_Z_UP_SENSOR,   INPUT_PULLUP);
  pinMode(PIN_Z_DOWN_SENSOR, INPUT_PULLUP);

  // ALM inputs — pull-up (ALM is open-collector active LOW)
  pinMode(PIN_X_DRIVER_ALM, INPUT_PULLUP);
  pinMode(PIN_Y_LEFT_ALM,   INPUT_PULLUP);
  pinMode(PIN_Y_RIGHT_ALM,  INPUT_PULLUP);

  // ADC — 12-bit resolution on Teensy 4.1
  analogReadResolution(12);

  // On-board user LED (pin 13). Used by the loop() heartbeat in
  // gillis_firmware.ino as a visible "firmware is alive" indicator —
  // 1 Hz blink under normal operation, frozen if firmware hangs.
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
}
