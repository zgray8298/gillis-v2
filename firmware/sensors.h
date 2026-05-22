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
  bool xHome;
  bool yLeftHome;
  bool yRightHome;
  bool zUp;
  bool zDown;
  bool xDriverAlm;
  bool yLeftAlm;
  bool yRightAlm;
  float airPressureBar;
};

extern SensorState sensors;

// Debounce state for ALM signals
static uint32_t _almXDebounceStart    = 0;
static uint32_t _almYLDebounceStart   = 0;
static uint32_t _almYRDebounceStart   = 0;
static bool     _almXRaw              = false;
static bool     _almYLRaw             = false;
static bool     _almYRRaw             = false;

static uint32_t _lastAirPollMs        = 0;

// =============================================================================
// Read a digital sensor (active LOW via opto — invert for logical state)
// =============================================================================
inline bool read_sensor(uint8_t pin) {
  return (digitalRead(pin) == LOW); // LOW = triggered (opto output pulled down)
}

// =============================================================================
// Read ALM with debounce
// =============================================================================
inline bool debounce_alm(uint8_t pin, bool &rawState, uint32_t &debounceStart) {
  bool current = (digitalRead(pin) == LOW); // Active LOW
  if (current != rawState) {
    rawState = current;
    debounceStart = millis();
  }
  if ((millis() - debounceStart) >= ALM_DEBOUNCE_MS) {
    return rawState;
  }
  return !rawState; // Still within debounce — return old stable state
}

// =============================================================================
// Read air pressure sensor — returns pressure in bar
// =============================================================================
inline float read_air_pressure_bar() {
  int adcRaw = analogRead(PIN_AIR_PRESSURE);
  float measuredV   = ((float)adcRaw / (float)AIR_ADC_MAX) * AIR_ADC_VREF;
  float sensorV     = measuredV / AIR_DIVIDER_RATIO;
  // Clamp sensor voltage to valid range
  if (sensorV < 0.0f) sensorV = 0.0f;
  if (sensorV > AIR_SENSOR_MAX_VOLT) sensorV = AIR_SENSOR_MAX_VOLT;
  float pressureBar = (sensorV / AIR_SENSOR_MAX_VOLT) * AIR_SENSOR_RANGE_BAR;
  return pressureBar;
}

// =============================================================================
// sensors_update — called every loop()
// =============================================================================
inline void sensors_update() {
  // Digital sensors
  sensors.xHome     = read_sensor(PIN_X_HOME);
  sensors.yLeftHome = read_sensor(PIN_Y_LEFT_HOME);
  sensors.yRightHome= read_sensor(PIN_Y_RIGHT_HOME);
  sensors.zUp       = read_sensor(PIN_Z_UP_SENSOR);
  sensors.zDown     = read_sensor(PIN_Z_DOWN_SENSOR);

  // ALM signals — debounced
  sensors.xDriverAlm  = debounce_alm(PIN_X_DRIVER_ALM,   _almXRaw,  _almXDebounceStart);
  sensors.yLeftAlm    = debounce_alm(PIN_Y_LEFT_ALM,      _almYLRaw, _almYLDebounceStart);
  sensors.yRightAlm   = debounce_alm(PIN_Y_RIGHT_ALM,     _almYRRaw, _almYRDebounceStart);

  // Air pressure — poll at lower rate
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
  // Take initial air reading immediately
  sensors.airPressureBar = read_air_pressure_bar();
  _lastAirPollMs = millis();
}
