#pragma once
// =============================================================================
// settings.h — Persistent settings (stored in Teensy 4.1 EEPROM)
// =============================================================================

#include <EEPROM.h>
#include "config.h"

struct Settings {
  float speedX;          // mm/s
  float speedY;          // mm/s
  float accelX;          // mm/s²
  float accelY;          // mm/s²
  float tramOffset;      // mm — Y right offset for gantry tramming
  float airThresholdBar; // bar — below this = FAULT_LOW_AIR
  uint32_t dwellMs;      // laser dwell time ms
};

extern Settings settings;

inline void settings_defaults() {
  settings.speedX          = DEFAULT_SPEED_X_MM_S;
  settings.speedY          = DEFAULT_SPEED_Y_MM_S;
  settings.accelX          = DEFAULT_ACCEL_X_MM_S2;
  settings.accelY          = DEFAULT_ACCEL_Y_MM_S2;
  settings.tramOffset      = 0.0f;
  settings.airThresholdBar = DEFAULT_AIR_THRESHOLD_BAR;
  settings.dwellMs         = DEFAULT_DWELL_MS;
}

inline void settings_load() {
  uint32_t magic;
  EEPROM.get(EEPROM_MAGIC_ADDR, magic);
  if (magic != EEPROM_MAGIC_VALUE) {
    // First boot — write defaults
    settings_defaults();
    EEPROM.put(EEPROM_MAGIC_ADDR, (uint32_t)EEPROM_MAGIC_VALUE);
    EEPROM.put(EEPROM_SETTINGS_ADDR, settings);
  } else {
    EEPROM.get(EEPROM_SETTINGS_ADDR, settings);
  }
}

inline void settings_save() {
  EEPROM.put(EEPROM_SETTINGS_ADDR, settings);
}
