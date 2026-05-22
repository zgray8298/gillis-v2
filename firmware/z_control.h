#pragma once
// =============================================================================
// z_control.h — Z axis pneumatic solenoid control with timeout faults
// =============================================================================
// Z_DOWN: energise solenoid — wait Z_DOWN_SENSOR (2s timeout = FAULT_Z_TIMEOUT_DOWN)
// Z_UP:   de-energise solenoid — spring return — wait Z_UP_SENSOR (2s timeout = FAULT_Z_TIMEOUT_UP)
// =============================================================================

#include <Arduino.h>
#include "pins.h"
#include "sensors.h"
#include "fault_handler.h"
#include "config.h"

enum ZState {
  Z_IDLE      = 0,
  Z_GOING_DOWN= 1,
  Z_DOWN_HOLD = 2,
  Z_GOING_UP  = 3,
  Z_UP_HOLD   = 4,
};

static ZState   _zState       = Z_IDLE;
static uint32_t _zCmdTime     = 0;
static bool     _zMoveDone    = false;

// =============================================================================
// Command Z down — non-blocking. Poll z_update() to detect completion.
// =============================================================================
inline void z_down() {
  if (sensors.airPressureBar < settings.airThresholdBar) {
    fault_trigger(FAULT_LOW_AIR);
    return;
  }
  digitalWrite(PIN_Z_SOLENOID_A, HIGH);
  machineState.zDown = true;
  _zState    = Z_GOING_DOWN;
  _zCmdTime  = millis();
  _zMoveDone = false;
}

// =============================================================================
// Command Z up — non-blocking.
// =============================================================================
inline void z_up() {
  digitalWrite(PIN_Z_SOLENOID_A, LOW);
  machineState.zDown = false;
  _zState    = Z_GOING_UP;
  _zCmdTime  = millis();
  _zMoveDone = false;
}

// =============================================================================
// z_move_complete — returns true when the last Z command has completed
// =============================================================================
inline bool z_move_complete() { return _zMoveDone; }

// =============================================================================
// z_update — call every loop()
// =============================================================================
inline void z_update() {
  switch (_zState) {
    case Z_GOING_DOWN:
      if (sensors.zDown) {
        _zState    = Z_DOWN_HOLD;
        _zMoveDone = true;
        Serial.println("DONE");
      } else if ((millis() - _zCmdTime) >= Z_TIMEOUT_DOWN_MS) {
        // Fault — Z didn't extend
        _zState = Z_IDLE;
        fault_trigger(FAULT_Z_TIMEOUT_DOWN);
      }
      break;

    case Z_GOING_UP:
      if (sensors.zUp) {
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
// =============================================================================
inline bool z_safe() {
  return sensors.zUp;
}
