#pragma once
// =============================================================================
// sensors.h — Sensor reading for Gillis V2.0
// =============================================================================

#include <Arduino.h>
#include "config.h"
#include "pins.h"
#include "settings.h"

// =============================================================================
// Sensor state (polled values)
// =============================================================================
struct SensorState {
  bool  xHome;
  bool  yLeftHome;
  bool  yRightHome;
  bool  zUp;
  bool  zDown;
  bool  xDriverAlm;
  bool  yLeftAlm;
  bool  yRightAlm;
  float airPressureBar;
};

extern SensorState sensors;

// Debounce state for ALM signals (file-scope because this header is included
// exactly once — via gillis_firmware.ino)
//
// Three vars per channel:
//   _almXStable        — last value that has been steady for ≥ ALM_DEBOUNCE_MS.
//                        This is what callers see via sensors.xDriverAlm.
//   _almXRaw           — most recently observed raw reading.
//   _almXDebounceStart — millis() when raw last *changed*. Used to measure how
//                        long the raw reading has held.
static bool     _almXStable           = false;
static bool     _almYLStable          = false;
static bool     _almYRStable          = false;
static bool     _almXRaw              = false;
static bool     _almYLRaw             = false;
static bool     _almYRRaw             = false;
static uint32_t _almXDebounceStart    = 0;
static uint32_t _almYLDebounceStart   = 0;
static uint32_t _almYRDebounceStart   = 0;

static uint32_t _lastAirPollMs        = 0;

// =============================================================================
// Read a digital sensor (active LOW via opto — invert for logical state)
// =============================================================================
inline bool read_sensor(uint8_t pin) {
  return (digitalRead(pin) == LOW); // LOW = triggered (opto output pulled down)
}

// =============================================================================
// Read ALM with debounce
//
// 2026-05-05 fix: previous version returned `!rawState` during the debounce
// window, intending it as "old stable state" — but `!rawState` is just the
// inverse of the *new* raw reading, not a memory of the prior stable value.
// A microsecond EMI glitch on a clean pin would therefore latch a *false*
// TRUE return for the entire next ALM_DEBOUNCE_MS window (because the pin
// returning to its actual stable level updates rawState, then `!rawState`
// inverts it during the debounce). This was the root cause of the random
// driver-fault-on-Z-actuation issue (Heschen solenoids, no flyback diode).
// Fix: track stableState separately and only promote rawState into it after
// the raw reading has held for ≥ ALM_DEBOUNCE_MS.
// =============================================================================
inline bool debounce_alm(uint8_t pin,
                         bool     &stableState,
                         bool     &rawState,
                         uint32_t &debounceStart) {
  bool current = (digitalRead(pin) == LOW); // Active LOW
  if (current != rawState) {
    rawState      = current;
    debounceStart = millis();
  }
  if ((millis() - debounceStart) >= ALM_DEBOUNCE_MS) {
    stableState = rawState;
  }
  return stableState;
}

// =============================================================================
// Read air pressure sensor — returns pressure in bar
// =============================================================================
inline float read_air_pressure_bar() {
  int adcRaw = analogRead(PIN_AIR_PRESSURE);
  float measuredV   = ((float)adcRaw / (float)AIR_ADC_MAX) * AIR_ADC_VREF;
  float sensorV     = measuredV / AIR_DIVIDER_RATIO;
  if (sensorV < 0.0f) sensorV = 0.0f;
  if (sensorV > AIR_SENSOR_MAX_VOLT) sensorV = AIR_SENSOR_MAX_VOLT;
  float pressureBar = (sensorV / AIR_SENSOR_MAX_VOLT) * AIR_SENSOR_RANGE_BAR;
  return pressureBar;
}

// =============================================================================
// sensors_update — called every loop()
// =============================================================================
inline void sensors_update() {
  sensors.xHome       = read_sensor(PIN_X_HOME);
  sensors.yLeftHome   = read_sensor(PIN_Y_LEFT_HOME);
  sensors.yRightHome  = read_sensor(PIN_Y_RIGHT_HOME);
  sensors.zUp         = read_sensor(PIN_Z_UP_SENSOR);
  sensors.zDown       = read_sensor(PIN_Z_DOWN_SENSOR);

  sensors.xDriverAlm  = debounce_alm(PIN_X_DRIVER_ALM, _almXStable,  _almXRaw,  _almXDebounceStart);
  sensors.yLeftAlm    = debounce_alm(PIN_Y_LEFT_ALM,   _almYLStable, _almYLRaw, _almYLDebounceStart);
  sensors.yRightAlm   = debounce_alm(PIN_Y_RIGHT_ALM,  _almYRStable, _almYRRaw, _almYRDebounceStart);

  uint32_t now = millis();
  if (now - _lastAirPollMs >= AIR_POLL_INTERVAL_MS) {
    sensors.airPressureBar = read_air_pressure_bar();
    _lastAirPollMs = now;
  }
}

// =============================================================================
// Initialise sensors struct
// =============================================================================
inline void sensors_init() {
  sensors.airPressureBar = read_air_pressure_bar();
  _lastAirPollMs = millis();
}
