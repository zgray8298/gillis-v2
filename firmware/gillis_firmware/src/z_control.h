#pragma once
// =============================================================================
// z_control.h — Z axis pneumatic solenoid control (Rev4: A/B/C selectable)
// =============================================================================
// settings.activeSolenoid selects which relay channel is driven:
//   0 → PIN_Z_SOLENOID_A (ch1 — head A)
//   1 → PIN_Z_SOLENOID_B (ch3 — head B)
//   2 → PIN_Z_SOLENOID_C (ch4 — head C)
//
// Only one head is ever energised at a time. On every Z command we
// de-energise the two inactive channels explicitly, so a stale output
// from a solenoid-swap can't linger.
//
// Z_DOWN: energise selected solenoid — wait Z_DOWN_SENSOR
//          (2s timeout = FAULT_Z_TIMEOUT_DOWN)
// Z_UP:   de-energise all solenoids — spring return — wait Z_UP_SENSOR
//          (2s timeout = FAULT_Z_TIMEOUT_UP)
// =============================================================================

#include <Arduino.h>
#include "pins.h"
#include "sensors.h"
#include "fault_handler.h"
#include "settings.h"
#include "config.h"

enum ZState {
  Z_IDLE       = 0,
  Z_GOING_DOWN = 1,
  Z_DOWN_HOLD  = 2,
  Z_GOING_UP   = 3,
  Z_UP_HOLD    = 4,
};

static ZState   _zState    = Z_IDLE;
static uint32_t _zCmdTime  = 0;
static bool     _zMoveDone = false;

// =============================================================================
// Which pin is currently selected by settings?
// =============================================================================
inline uint8_t z_active_pin() {
  switch (settings.activeSolenoid) {
    case 1:  return PIN_Z_SOLENOID_B;
    case 2:  return PIN_Z_SOLENOID_C;
    default: return PIN_Z_SOLENOID_A;
  }
}

inline void z_deenergise_all() {
  // SONGLE relay board is active-LOW: HIGH = de-energise (safe).
  digitalWrite(PIN_Z_SOLENOID_A, HIGH);
  digitalWrite(PIN_Z_SOLENOID_B, HIGH);
  digitalWrite(PIN_Z_SOLENOID_C, HIGH);
}

// =============================================================================
// Command Z down — non-blocking. Poll z_move_complete() / z_update() for finish.
// =============================================================================
inline void z_down() {
  // Air-pressure gate — skipped in bench mode so a dry bench without an air
  // sensor wired up doesn't fault on every Z DOWN. Production welding still
  // checks this when benchMode is OFF.
  if (!settings.benchMode &&
      sensors.airPressureBar < settings.airThresholdBar) {
    fault_trigger(FAULT_LOW_AIR);
    return;
  }
  // Make sure no stale channel is energised before we drive the active one
  z_deenergise_all();
  // SONGLE relay board is active-LOW: LOW = energise.
  digitalWrite(z_active_pin(), LOW);
  machineState.zDown = true;
  _zState    = Z_GOING_DOWN;
  _zCmdTime  = millis();
  _zMoveDone = false;
}

// =============================================================================
// Command Z up — non-blocking.
// =============================================================================
inline void z_up() {
  z_deenergise_all();
  machineState.zDown = false;
  _zState    = Z_GOING_UP;
  _zCmdTime  = millis();
  _zMoveDone = false;
}

inline bool z_move_complete() { return _zMoveDone; }

// =============================================================================
// z_update — call every loop()
// Emits DONE on completion. Faults on timeout.
//
// Bench mode (Rev4.2): skips the sensor wait entirely. Operators running
// without air / without Z sensors wired can't hand-short sensors fast enough
// to match program timing, and the Z UP/DOWN timeouts were cascading into
// FAULT_Z_TIMEOUT plus BUSY-rejecting every subsequent MOVE (because
// z_safe() was false). Bench mode treats the Z as instantly settled so the
// rest of the state machine can run exactly like a real cycle — just on a
// dry bench.
// =============================================================================
inline void z_update() {
  switch (_zState) {
    case Z_GOING_DOWN:
      if (sensors.zDown || settings.benchMode) {
        _zState    = Z_DOWN_HOLD;
        _zMoveDone = true;
        Serial.println("DONE");
      } else if ((millis() - _zCmdTime) >= Z_TIMEOUT_DOWN_MS) {
        _zState = Z_IDLE;
        fault_trigger(FAULT_Z_TIMEOUT_DOWN);
      }
      break;

    case Z_GOING_UP:
      if (sensors.zUp || settings.benchMode) {
        _zState    = Z_UP_HOLD;
        _zMoveDone = true;
        Serial.println("DONE");
      } else if ((millis() - _zCmdTime) >= Z_TIMEOUT_UP_MS) {
        _zState = Z_IDLE;
        fault_trigger(FAULT_Z_TIMEOUT_UP);
      }
      break;

    default:
      break;
  }
}

// =============================================================================
// z_safe — returns true if Z is confirmed UP (safe to move XY)
// In bench mode we trust the operator and skip the physical-sensor check,
// otherwise every JOG/MOVE gets rejected with BUSY when the Z-up sensor
// isn't wired up. Production homing/welding is unchanged when bench mode
// is OFF — this is purely a dry-bench convenience flag.
// =============================================================================
inline bool z_safe() { return settings.benchMode || sensors.zUp; }
