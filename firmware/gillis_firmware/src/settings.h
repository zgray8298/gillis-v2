#pragma once
// =============================================================================
// settings.h — Persistent settings (stored in Teensy 4.1 EEPROM)
// =============================================================================
// Rev4 adds:
//   - maxX, maxY (soft travel limits, overrides config.h defaults)
//   - loadPosX, loadPosY (parking / load position after HOME)
//   - activeSolenoid (0=A, 1=B, 2=C — per-program weld head)
//   - homeOnBoot (0=prompt operator on boot, 1=auto-home after boot splash)
//     NOTE: firmware only stores/reports this flag. The Pi reads it via
//     SNAPSHOT after boot and decides whether to send HOME automatically.
// Rev4.3 adds:
//   - cellSpeedX / cellSpeedY / cellAccelX / cellAccelY — cell-to-cell motion
//     profile used during a RUN, selected by `P=C` suffix on MOVE/JOG.
//     speedX/speedY/accelX/accelY remain the "fast" profile used for every
//     non-run motion (pre-move, park, JOG, Test Motion screen).
// Rev4.4 adds:
//   - preWeldHoldMs  — Pi orchestrator sleep after Z_DOWN and before FIRE,
//                      giving the pneumatic solenoid time to fully compress
//                      the weld head against the cell. Firmware just stores
//                      and reports the value; the actual sleep happens in
//                      the Pi runOrchestrator between `Z DOWN` and `FIRE`.
//   - postWeldHoldMs — Pi orchestrator sleep after FIRE and before Z_UP.
//                      Lets the weld settle under clamp pressure before Z
//                      retracts. Same Pi-side implementation.
//   dwellMs is unchanged — the laser relay's energised time during FIRE
//   (renamed to "Laser On Time" in the UI).
// EEPROM magic bumped to force defaults on Rev4 / Rev4.3 / Rev4.4 upgrade.
// =============================================================================

#include <EEPROM.h>
#include "config.h"

struct Settings {
  // Motion — "fast" profile: pre-move to start, park to loading position,
  // JOG, Test Motion screen. Every MOVE/JOG with no `P=` tag OR with `P=F`
  // runs at these settings.
  float    speedX;          // mm/s
  float    speedY;          // mm/s
  float    accelX;          // mm/s²
  float    accelY;          // mm/s²

  // Motion — "cell" profile: cell-to-cell travel DURING a run. Selected
  // when the Pi orchestrator tags a MOVE with `P=C`. Typically tuned
  // slower / lower-accel for repeatable positioning over the weld point.
  float    cellSpeedX;      // mm/s
  float    cellSpeedY;      // mm/s
  float    cellAccelX;      // mm/s²
  float    cellAccelY;      // mm/s²

  // Gantry tramming — Y right offset relative to Y left after home
  float    tramOffset;      // mm

  // Safety thresholds
  float    airThresholdBar; // bar — below this = FAULT_LOW_AIR

  // Weld
  uint32_t dwellMs;         // laser dwell time ms ("Laser On Time" in UI)

  // Weld-cycle pneumatic holds (Rev4.4). The Pi runOrchestrator reads these
  // via SNAPSHOT and sleeps for the configured interval between Z_DOWN→FIRE
  // and FIRE→Z_UP respectively. Firmware keeps them in EEPROM so the values
  // survive power cycles and are authoritative across every headless link.
  uint32_t preWeldHoldMs;   // ms between Z_DOWN DONE and FIRE
  uint32_t postWeldHoldMs;  // ms between FIRE DONE and Z_UP

  // Soft travel limits (Rev4)
  float    maxX;            // mm — maximum X absolute position
  float    maxY;            // mm — maximum Y absolute position

  // Parking / load position (Rev4)
  // Machine moves here automatically at the end of HOME and at the end of a run.
  float    loadPosX;        // mm
  float    loadPosY;        // mm

  // Active weld head (Rev4)
  // 0 = A (PIN_Z_SOLENOID_A), 1 = B (PIN_Z_SOLENOID_B), 2 = C (PIN_Z_SOLENOID_C)
  uint8_t  activeSolenoid;

  // Home on boot (Rev4)
  // 0 = Pi should prompt operator after boot splash ("Ready to home axis?")
  // 1 = Pi should issue HOME automatically once link is established.
  // Default 0 (safe — always prompts) so first-time users don't home an
  // uncommissioned machine. Toggled from the Settings screen after the
  // limit switches have been verified via the Test Motion screen.
  uint8_t  homeOnBoot;

  // Bench mode (Rev4.2) — when 1, homing skips the back-off + slow re-touch
  // phase and completes on the FIRST sensor trigger for each axis. Intended
  // for bench testing with manually-actuated switches (no motors). Has no
  // effect on production runs; real homing cycles reset this during
  // commissioning. One byte stolen from _reserved[] so EEPROM_MAGIC_VALUE
  // does NOT need to be bumped on upgrade.
  uint8_t  benchMode;

  // Reserved — keeps struct layout stable for minor additions without bumping
  // EEPROM_MAGIC_VALUE. Bump magic if you consume these.
  uint8_t  _reserved[5];
};

extern Settings settings;

inline void settings_defaults() {
  settings.speedX          = DEFAULT_SPEED_X_MM_S;
  settings.speedY          = DEFAULT_SPEED_Y_MM_S;
  settings.accelX          = DEFAULT_ACCEL_X_MM_S2;
  settings.accelY          = DEFAULT_ACCEL_Y_MM_S2;
  settings.cellSpeedX      = DEFAULT_CELL_SPEED_X_MM_S;
  settings.cellSpeedY      = DEFAULT_CELL_SPEED_Y_MM_S;
  settings.cellAccelX      = DEFAULT_CELL_ACCEL_X_MM_S2;
  settings.cellAccelY      = DEFAULT_CELL_ACCEL_Y_MM_S2;
  settings.tramOffset      = 0.0f;
  settings.airThresholdBar = DEFAULT_AIR_THRESHOLD_BAR;
  settings.dwellMs         = DEFAULT_DWELL_MS;
  settings.preWeldHoldMs   = DEFAULT_PRE_WELD_HOLD_MS;
  settings.postWeldHoldMs  = DEFAULT_POST_WELD_HOLD_MS;
  settings.maxX            = DEFAULT_AXIS_X_MAX_MM;
  settings.maxY            = DEFAULT_AXIS_Y_MAX_MM;
  // Default loading position = centre of the measured travel. Keeps the
  // gantry well clear of the home sensors and limits after a fresh homing
  // cycle, and gives the operator a sensible place to dock the table before
  // they customise it from the Loading Position screen.
  // Must be NON-ZERO so homing.h triggers the post-home TO_LOADPOS move
  // (the zero-check there is a safety gate to skip parking when unset).
  settings.loadPosX        = DEFAULT_AXIS_X_MAX_MM * 0.5f;
  settings.loadPosY        = DEFAULT_AXIS_Y_MAX_MM * 0.5f;
  settings.activeSolenoid  = DEFAULT_ACTIVE_SOLENOID;
  settings.homeOnBoot      = 0;  // default OFF — operator is prompted
  settings.benchMode       = 0;  // default OFF — real homing cycle with slow re-touch
  for (uint8_t i = 0; i < sizeof(settings._reserved); ++i) settings._reserved[i] = 0;
}

inline void settings_load() {
  uint32_t magic;
  EEPROM.get(EEPROM_MAGIC_ADDR, magic);
  if (magic != EEPROM_MAGIC_VALUE) {
    // First boot or layout change — write defaults
    settings_defaults();
    EEPROM.put(EEPROM_MAGIC_ADDR, (uint32_t)EEPROM_MAGIC_VALUE);
    EEPROM.put(EEPROM_SETTINGS_ADDR, settings);
  } else {
    EEPROM.get(EEPROM_SETTINGS_ADDR, settings);
  }
}

inline void settings_save() {
  // EEPROM.put uses update() semantics internally (only writes changed bytes)
  EEPROM.put(EEPROM_SETTINGS_ADDR, settings);
}
