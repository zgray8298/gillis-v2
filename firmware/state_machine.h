#pragma once
// =============================================================================
// state_machine.h — Main machine state machine for Gillis V2.0
// =============================================================================

#include <Arduino.h>
#include "fault_handler.h"
#include "homing.h"
#include "z_control.h"
#include "stepper.h"
#include "sensors.h"

// Pending move target (set by MOVE command)
static float _pendingMoveX = 0.0f;
static float _pendingMoveY = 0.0f;
static bool  _pendingMove  = false;

// =============================================================================
// state_init
// =============================================================================
inline void state_init() {
  machineState.state          = STATE_IDLE;
  machineState.activeFault    = FAULT_NONE;
  machineState.driversEnabled = false;
  machineState.zDown          = false;
  machineState.laserActive    = false;
  _homingStep = HOMING_IDLE;
}

// =============================================================================
// state_request_move — called by serial command MOVE
// =============================================================================
inline void state_request_move(float x, float y) {
  if (machineState.state != STATE_IDLE) {
    Serial.println("BUSY");
    return;
  }
  if (!machineState.driversEnabled) {
    Serial.println("BUSY");
    return;
  }
  if (!z_safe()) {
    Serial.println("BUSY"); // Z not confirmed up — refuse move
    return;
  }
  machineState.state = STATE_MOVING;
  stepper_move_to_mm(axisX,      x);
  stepper_move_to_mm(axisYLeft,  y);
  stepper_move_to_mm(axisYRight, y + settings.tramOffset);
  Serial.println("OK");
}

// =============================================================================
// state_update — call every loop()
// =============================================================================
inline void state_update() {
  // Always run homing update (it self-gates)
  homing_update();

  // Always run Z update
  z_update();

  switch (machineState.state) {

    case STATE_IDLE:
      // Nothing — waiting for commands
      break;

    case STATE_HOMING:
      // homing_update() handles this state transition to IDLE on completion
      break;

    case STATE_MOVING:
      if (!any_axis_moving()) {
        machineState.state = STATE_IDLE;
        Serial.println("DONE");
      }
      break;

    case STATE_WELDING:
      // Weld sequencing is driven by Pi command sequence (MOVE→Z_DOWN→FIRE→Z_UP)
      // State transitions happen on command receipt
      break;

    case STATE_PAUSED:
      // Waiting for RESUME or ABORT command
      break;

    case STATE_FAULT_LOCKOUT:
    case STATE_ESTOP:
      // Handled in fault_handler
      break;
  }
}
