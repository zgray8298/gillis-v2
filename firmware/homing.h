#pragma once
// =============================================================================
// homing.h — Homing sequence for Gillis V2.0
// =============================================================================
// Sequence (per spec Section 4.1 HOME):
//   1. Home Y LEFT at homing speed until Y_LEFT_HOME sensor triggers
//   2. Home Y RIGHT simultaneously, applying tramming offset to Y RIGHT
//   3. Back off both Y axes
//   4. Slow second touch for precision on both Y
//   5. Set Y positions to 0
//   6. Home X at homing speed until X_HOME triggers
//   7. Back off X, slow second touch
//   8. Set X position to 0
//   9. Report HOMED
// =============================================================================

#include <Arduino.h>
#include "stepper.h"
#include "sensors.h"
#include "fault_handler.h"
#include "settings.h"
#include "config.h"

enum HomingStep {
  HOMING_IDLE             = 0,
  HOMING_Y_FAST           = 1,   // Move Y LEFT+RIGHT towards home at speed
  HOMING_Y_BACKOFF        = 2,   // Back off both Y
  HOMING_Y_SLOW           = 3,   // Slow approach
  HOMING_Y_DONE           = 4,
  HOMING_X_FAST           = 5,
  HOMING_X_BACKOFF        = 6,
  HOMING_X_SLOW           = 7,
  HOMING_COMPLETE         = 8,
  HOMING_FAULT            = 9,
};

static HomingStep _homingStep     = HOMING_IDLE;
static uint32_t   _homingTimeout  = 0;
static bool       _yLeftHomed     = false;
static bool       _yRightHomed    = false;

// Homing timeout — if we don't hit the sensor in this many ms, it's a fault
#define HOMING_TIMEOUT_MS 30000

// =============================================================================
// Start homing sequence
// =============================================================================
inline void homing_start() {
  _homingStep    = HOMING_Y_FAST;
  _yLeftHomed    = false;
  _yRightHomed   = false;
  _homingTimeout = millis();

  machineState.state = STATE_HOMING;

  // Drive Y axes in home direction at homing speed
  axisYLeft.speedMmS  = HOMING_SPEED_MM_S;
  axisYLeft.accelMmS2 = DEFAULT_ACCEL_Y_MM_S2;
  axisYRight.speedMmS = HOMING_SPEED_MM_S;
  axisYRight.accelMmS2= DEFAULT_ACCEL_Y_MM_S2;

  // Move a long distance — will be stopped when sensors trigger
  float longMove = HOME_DIR_Y == LOW ? -1000.0f : 1000.0f;
  stepper_jog_mm(axisYLeft,  longMove);
  stepper_jog_mm(axisYRight, longMove);
}

// =============================================================================
// homing_update — call every loop() when homing is active
// =============================================================================
inline bool homing_is_active() { return _homingStep != HOMING_IDLE && _homingStep != HOMING_COMPLETE && _homingStep != HOMING_FAULT; }

inline void homing_update() {
  if (!homing_is_active()) return;

  // Global timeout check
  if ((millis() - _homingTimeout) > HOMING_TIMEOUT_MS) {
    stepper_stop_all();
    machineState.state = STATE_FAULT_LOCKOUT;
    Serial.println("FAULT HOMING_TIMEOUT");
    _homingStep = HOMING_FAULT;
    return;
  }

  switch (_homingStep) {

    // --- Y FAST APPROACH ---
    case HOMING_Y_FAST: {
      // Stop individual axes as their sensors trigger
      if (sensors.yLeftHome && !_yLeftHomed) {
        stepper_stop(axisYLeft);
        stepper_set_position_mm(axisYLeft, 0.0f);
        _yLeftHomed = true;
      }
      if (sensors.yRightHome && !_yRightHomed) {
        stepper_stop(axisYRight);
        stepper_set_position_mm(axisYRight, 0.0f);
        _yRightHomed = true;
      }
      if (_yLeftHomed && _yRightHomed) {
        // Both Y homed — back off
        float backoff = HOME_DIR_Y == LOW ? HOMING_BACKOFF_MM : -HOMING_BACKOFF_MM;
        axisYLeft.speedMmS  = HOMING_SPEED_MM_S;
        axisYRight.speedMmS = HOMING_SPEED_MM_S;
        stepper_jog_mm(axisYLeft,  backoff);
        stepper_jog_mm(axisYRight, backoff);
        _homingStep = HOMING_Y_BACKOFF;
      }
      break;
    }

    // --- Y BACK OFF ---
    case HOMING_Y_BACKOFF: {
      if (!axisYLeft.moving && !axisYRight.moving) {
        // Slow second approach
        axisYLeft.speedMmS  = HOMING_SLOW_SPEED_MM_S;
        axisYRight.speedMmS = HOMING_SLOW_SPEED_MM_S;
        float longMove = HOME_DIR_Y == LOW ? -1000.0f : 1000.0f;
        _yLeftHomed  = false;
        _yRightHomed = false;
        stepper_jog_mm(axisYLeft,  longMove);
        stepper_jog_mm(axisYRight, longMove);
        _homingStep = HOMING_Y_SLOW;
      }
      break;
    }

    // --- Y SLOW APPROACH ---
    case HOMING_Y_SLOW: {
      if (sensors.yLeftHome && !_yLeftHomed) {
        stepper_stop(axisYLeft);
        stepper_set_position_mm(axisYLeft, 0.0f);
        _yLeftHomed = true;
      }
      // Y RIGHT: apply tramming offset — move an extra tramOffset mm past home
      if (sensors.yRightHome && !_yRightHomed) {
        stepper_stop(axisYRight);
        // Apply tram offset: right motor offset from left
        stepper_set_position_mm(axisYRight, 0.0f);
        if (settings.tramOffset != 0.0f) {
          axisYRight.speedMmS = HOMING_SLOW_SPEED_MM_S;
          stepper_move_to_mm(axisYRight, settings.tramOffset);
        }
        _yRightHomed = true;
      }
      if (_yLeftHomed && _yRightHomed && !axisYRight.moving) {
        // Y homed — now home X
        stepper_set_position_mm(axisYRight, settings.tramOffset);
        _homingStep = HOMING_X_FAST;
        axisX.speedMmS  = HOMING_SPEED_MM_S;
        axisX.accelMmS2 = DEFAULT_ACCEL_X_MM_S2;
        float longMove = HOME_DIR_X == LOW ? -1000.0f : 1000.0f;
        stepper_jog_mm(axisX, longMove);
        _homingTimeout = millis(); // reset timeout for X
      }
      break;
    }

    // --- X FAST APPROACH ---
    case HOMING_X_FAST: {
      if (sensors.xHome) {
        stepper_stop(axisX);
        stepper_set_position_mm(axisX, 0.0f);
        float backoff = HOME_DIR_X == LOW ? HOMING_BACKOFF_MM : -HOMING_BACKOFF_MM;
        axisX.speedMmS = HOMING_SPEED_MM_S;
        stepper_jog_mm(axisX, backoff);
        _homingStep = HOMING_X_BACKOFF;
      }
      break;
    }

    // --- X BACK OFF ---
    case HOMING_X_BACKOFF: {
      if (!axisX.moving) {
        axisX.speedMmS = HOMING_SLOW_SPEED_MM_S;
        float longMove = HOME_DIR_X == LOW ? -1000.0f : 1000.0f;
        stepper_jog_mm(axisX, longMove);
        _homingStep = HOMING_X_SLOW;
      }
      break;
    }

    // --- X SLOW APPROACH ---
    case HOMING_X_SLOW: {
      if (sensors.xHome) {
        stepper_stop(axisX);
        stepper_set_position_mm(axisX, 0.0f);
        // Restore normal speeds
        axisX.speedMmS      = settings.speedX;
        axisX.accelMmS2     = settings.accelX;
        axisYLeft.speedMmS  = settings.speedY;
        axisYLeft.accelMmS2 = settings.accelY;
        axisYRight.speedMmS = settings.speedY;
        axisYRight.accelMmS2= settings.accelY;
        _homingStep = HOMING_COMPLETE;
        machineState.state = STATE_IDLE;
        Serial.println("HOMED");
      }
      break;
    }

    default:
      break;
  }
}
