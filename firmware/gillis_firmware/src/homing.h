#pragma once
// =============================================================================
// homing.h — Homing sequence for Gillis V2.0 (Rev4)
// =============================================================================
// Y is ALWAYS homed before X. After Y completes its fine-touch + tramming the
// gantry advances HOMING_Y_ADVANCE_MM (+Y) to clear the X-home region before
// the X axis begins its seek. HOMED is emitted only after the optional
// post-home LOADPOS move completes.
//
// Sequence:
//   1. Drive Y_LEFT + Y_RIGHT simultaneously towards Y home sensors  (Y_FAST)
//   2. Back off both Y axes                                          (Y_BACKOFF)
//   3. Slow re-touch for precision; zero Y_LEFT, apply tramOffset    (Y_SLOW)
//   4. Advance Y +HOMING_Y_ADVANCE_MM for X-homing clearance         (Y_ADVANCE)
//   5. Drive X towards home sensor                                   (X_FAST)
//   6. Back off X                                                    (X_BACKOFF)
//   7. Slow re-touch X; zero X                                       (X_SLOW)
//   8. If LOADPOS (loadPosX / loadPosY) is non-zero, move there      (TO_LOADPOS)
//   9. Emit HOMED
// =============================================================================

#include <Arduino.h>
#include "stepper.h"
#include "sensors.h"
#include "fault_handler.h"
#include "settings.h"
#include "config.h"

enum HomingStep {
  HOMING_IDLE             = 0,
  HOMING_Y_FAST           = 1,
  HOMING_Y_BACKOFF        = 2,
  HOMING_Y_SLOW           = 3,
  HOMING_Y_ADVANCE        = 4,   // Rev4: advance +Y before X seeks (clearance)
  HOMING_X_FAST           = 5,
  HOMING_X_BACKOFF        = 6,
  HOMING_X_SLOW           = 7,
  HOMING_TO_LOADPOS       = 8,   // Rev4: post-home park move
  HOMING_COMPLETE         = 9,
  HOMING_FAULT            = 10,
};

static HomingStep _homingStep         = HOMING_IDLE;
static uint32_t   _homingTimeout      = 0;
static bool       _yLeftHomed         = false;
static bool       _yRightHomed        = false;
// Tracks the millis() timestamp of whichever Y home sensor triggered first,
// during either HOMING_Y_FAST or HOMING_Y_SLOW. If the OTHER Y sensor doesn't
// trigger within HOMING_Y_DUAL_TIMEOUT_MS, the gantry has racked (one motor
// stalled, one sensor failed, etc.) — fault out before we damage the frame.
// 0 = no sensor has fired yet on this pass.
static uint32_t   _yFirstTriggerMs    = 0;

// Homing timeout — if we don't hit the sensor in this many ms, it's a fault.
// Sized for the 590 mm Y envelope (full travel) at HOMING_SPEED_MM_S = 20 mm/s:
//   590 mm / 20 mm/s = 29.5 s of constant-speed motion, plus acceleration,
//   plus the dual-Y sync wait, plus the slow re-touch after backoff. 30 s
//   was on the cliff edge for that travel and routinely tipped over into
//   FAULT_HOMING_TIMEOUT. 60 s gives 2x headroom at worst-case starting
//   position (gantry parked at maxY) without delaying a real sensor stall
//   detection by an unreasonable amount.
#define HOMING_TIMEOUT_MS         60000

// Dual-Y sync timeout — once one Y sensor triggers, the other must trigger
// within this window or we fault. At HOMING_SPEED_MM_S = 20 mm/s, 500 ms = 10 mm
// gantry rack — far beyond any expected mechanical out-of-square. Tighten to
// 200–300 ms in production once typical inter-sensor delay is measured.
#define HOMING_Y_DUAL_TIMEOUT_MS  500

// =============================================================================
// Start homing sequence
// =============================================================================
inline void homing_start() {
  _homingStep        = HOMING_Y_FAST;
  _yLeftHomed        = false;
  _yRightHomed       = false;
  _yFirstTriggerMs   = 0;
  _homingTimeout     = millis();

  machineState.state = STATE_HOMING;

  // Drive Y axes in home direction at homing speed
  axisYLeft.speedMmS   = HOMING_SPEED_MM_S;
  axisYLeft.accelMmS2  = DEFAULT_ACCEL_Y_MM_S2;
  axisYRight.speedMmS  = HOMING_SPEED_MM_S;
  axisYRight.accelMmS2 = DEFAULT_ACCEL_Y_MM_S2;

  // Move a long distance — will be stopped when sensors trigger
  float longMove = (HOME_DIR_Y == LOW) ? -1000.0f : 1000.0f;
  stepper_jog_mm(axisYLeft,  longMove);
  stepper_jog_mm(axisYRight, longMove);
}

inline bool homing_is_active() {
  return _homingStep != HOMING_IDLE &&
         _homingStep != HOMING_COMPLETE &&
         _homingStep != HOMING_FAULT;
}

// =============================================================================
// homing_update — call every loop() when homing is active
// =============================================================================
inline void homing_update() {
  if (!homing_is_active()) return;

  // Global timeout check
  if ((millis() - _homingTimeout) > HOMING_TIMEOUT_MS) {
    stepper_stop_all();
    // Route through fault_trigger() so activeFault is set AND the standard
    // "FAULT <code>" line is emitted — otherwise fault_clear() early-returns
    // (activeFault==NONE) without releasing STATE_FAULT_LOCKOUT, and
    // subsequent HOME commands silently come back BUSY.
    _homingStep = HOMING_FAULT;
    fault_trigger(FAULT_HOMING_TIMEOUT);
    return;
  }

  switch (_homingStep) {

    // --- Y FAST APPROACH ---
    case HOMING_Y_FAST: {
      if (sensors.yLeftHome && !_yLeftHomed) {
        stepper_stop(axisYLeft);
        stepper_set_position_mm(axisYLeft, 0.0f);
        _yLeftHomed = true;
        if (_yFirstTriggerMs == 0) _yFirstTriggerMs = millis();
      }
      if (sensors.yRightHome && !_yRightHomed) {
        stepper_stop(axisYRight);
        stepper_set_position_mm(axisYRight, 0.0f);
        _yRightHomed = true;
        if (_yFirstTriggerMs == 0) _yFirstTriggerMs = millis();
      }
      // Dual-Y sync check: once one side has triggered, the other must follow
      // within HOMING_Y_DUAL_TIMEOUT_MS or the gantry has racked.
      if (_yFirstTriggerMs != 0 && !(_yLeftHomed && _yRightHomed) &&
          (millis() - _yFirstTriggerMs) > HOMING_Y_DUAL_TIMEOUT_MS) {
        stepper_stop_all();
        _homingStep = HOMING_FAULT;
        fault_trigger(FAULT_Y_GANTRY_RACK);
        return;
      }
      if (_yLeftHomed && _yRightHomed) {
        // Reset for the slow re-touch pass — same sync check applies there.
        _yFirstTriggerMs = 0;
        // Bench mode: skip back-off + slow re-touch entirely. Also apply
        // tram offset here since we're not going through HOMING_Y_SLOW.
        if (settings.benchMode) {
          if (settings.tramOffset != 0.0f) {
            stepper_set_position_mm(axisYRight, settings.tramOffset);
          }
          // Straight into the Y advance clearance move.
          axisYLeft.speedMmS   = HOMING_SPEED_MM_S;
          axisYLeft.accelMmS2  = DEFAULT_ACCEL_Y_MM_S2;
          axisYRight.speedMmS  = HOMING_SPEED_MM_S;
          axisYRight.accelMmS2 = DEFAULT_ACCEL_Y_MM_S2;
          stepper_move_to_mm(axisYLeft,  HOMING_Y_ADVANCE_MM);
          stepper_move_to_mm(axisYRight, HOMING_Y_ADVANCE_MM + settings.tramOffset);
          _homingStep   = HOMING_Y_ADVANCE;
          _homingTimeout = millis();
          break;
        }

        float backoff = (HOME_DIR_Y == LOW) ? HOMING_BACKOFF_MM : -HOMING_BACKOFF_MM;
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
        axisYLeft.speedMmS  = HOMING_SLOW_SPEED_MM_S;
        axisYRight.speedMmS = HOMING_SLOW_SPEED_MM_S;
        float longMove = (HOME_DIR_Y == LOW) ? -1000.0f : 1000.0f;
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
        if (_yFirstTriggerMs == 0) _yFirstTriggerMs = millis();
      }
      // Y RIGHT: apply tramming offset — the right motor finishes tramOffset mm
      // beyond Y_LEFT=0 so that the gantry is square.
      if (sensors.yRightHome && !_yRightHomed) {
        stepper_stop(axisYRight);
        stepper_set_position_mm(axisYRight, 0.0f);
        if (settings.tramOffset != 0.0f) {
          axisYRight.speedMmS = HOMING_SLOW_SPEED_MM_S;
          stepper_move_to_mm(axisYRight, settings.tramOffset);
        }
        _yRightHomed = true;
        if (_yFirstTriggerMs == 0) _yFirstTriggerMs = millis();
      }
      // Dual-Y sync check on the slow pass too. At HOMING_SLOW_SPEED_MM_S = 5 mm/s,
      // 500 ms = 2.5 mm of rack — even tighter tolerance than the fast pass.
      if (_yFirstTriggerMs != 0 && !(_yLeftHomed && _yRightHomed) &&
          (millis() - _yFirstTriggerMs) > HOMING_Y_DUAL_TIMEOUT_MS) {
        stepper_stop_all();
        _homingStep = HOMING_FAULT;
        fault_trigger(FAULT_Y_GANTRY_RACK);
        return;
      }
      if (_yLeftHomed && _yRightHomed && !axisYRight.moving) {
        // After tram, tell the axis its current position IS the tram offset
        stepper_set_position_mm(axisYRight, settings.tramOffset);

        // --- Rev4: advance Y by HOMING_Y_ADVANCE_MM (+Y) for X-home clearance ---
        // Use homing speed (still in a homing phase — deliberate, repeatable).
        axisYLeft.speedMmS   = HOMING_SPEED_MM_S;
        axisYLeft.accelMmS2  = DEFAULT_ACCEL_Y_MM_S2;
        axisYRight.speedMmS  = HOMING_SPEED_MM_S;
        axisYRight.accelMmS2 = DEFAULT_ACCEL_Y_MM_S2;
        stepper_move_to_mm(axisYLeft,  HOMING_Y_ADVANCE_MM);
        stepper_move_to_mm(axisYRight, HOMING_Y_ADVANCE_MM + settings.tramOffset);
        _homingStep   = HOMING_Y_ADVANCE;
        _homingTimeout = millis();
      }
      break;
    }

    // --- Y ADVANCE (Rev4) — clearance move before X homes ---
    case HOMING_Y_ADVANCE: {
      if (!axisYLeft.moving && !axisYRight.moving) {
        // Kick off X fast approach
        axisX.speedMmS  = HOMING_SPEED_MM_S;
        axisX.accelMmS2 = DEFAULT_ACCEL_X_MM_S2;
        float longMove = (HOME_DIR_X == LOW) ? -1000.0f : 1000.0f;
        stepper_jog_mm(axisX, longMove);
        _homingStep   = HOMING_X_FAST;
        _homingTimeout = millis(); // reset timeout for X
      }
      break;
    }

    // --- X FAST APPROACH ---
    case HOMING_X_FAST: {
      if (sensors.xHome) {
        stepper_stop(axisX);
        stepper_set_position_mm(axisX, 0.0f);

        // Bench mode: skip X back-off + slow re-touch. Fall straight through
        // the same completion logic as HOMING_X_SLOW (restore runtime
        // speeds/accels, then optionally move to LOADPOS).
        if (settings.benchMode) {
          axisX.speedMmS       = settings.speedX;
          axisX.accelMmS2      = settings.accelX;
          axisYLeft.speedMmS   = settings.speedY;
          axisYLeft.accelMmS2  = settings.accelY;
          axisYRight.speedMmS  = settings.speedY;
          axisYRight.accelMmS2 = settings.accelY;

          float lx = settings.loadPosX;
          float ly = settings.loadPosY;
          clamp_x_to_limits(lx);
          clamp_y_to_limits(ly);

          if (lx != 0.0f || ly != 0.0f) {
            stepper_move_to_mm(axisX,      lx);
            stepper_move_to_mm(axisYLeft,  ly);
            stepper_move_to_mm(axisYRight, ly + settings.tramOffset);
            _homingStep    = HOMING_TO_LOADPOS;
            _homingTimeout = millis();
          } else {
            _homingStep = HOMING_COMPLETE;
            machineState.state = STATE_IDLE;
            Serial.println("HOMED");
          }
          break;
        }

        float backoff = (HOME_DIR_X == LOW) ? HOMING_BACKOFF_MM : -HOMING_BACKOFF_MM;
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
        float longMove = (HOME_DIR_X == LOW) ? -1000.0f : 1000.0f;
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
        // Restore normal runtime speeds/accels
        axisX.speedMmS       = settings.speedX;
        axisX.accelMmS2      = settings.accelX;
        axisYLeft.speedMmS   = settings.speedY;
        axisYLeft.accelMmS2  = settings.accelY;
        axisYRight.speedMmS  = settings.speedY;
        axisYRight.accelMmS2 = settings.accelY;

        // --- Rev4: auto-move to LOADPOS if configured ---
        float lx = settings.loadPosX;
        float ly = settings.loadPosY;
        // Clamp defensively — LOADPOS should have been validated at SET time
        clamp_x_to_limits(lx);
        clamp_y_to_limits(ly);

        if (lx != 0.0f || ly != 0.0f) {
          stepper_move_to_mm(axisX,      lx);
          stepper_move_to_mm(axisYLeft,  ly);
          stepper_move_to_mm(axisYRight, ly + settings.tramOffset);
          _homingStep    = HOMING_TO_LOADPOS;
          _homingTimeout = millis();
        } else {
          _homingStep = HOMING_COMPLETE;
          machineState.state = STATE_IDLE;
          Serial.println("HOMED");
        }
      }
      break;
    }

    // --- LOAD POSITION MOVE (Rev4) ---
    case HOMING_TO_LOADPOS: {
      if (!any_axis_moving()) {
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
