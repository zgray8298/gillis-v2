#pragma once
// =============================================================================
// state_machine.h — Main machine state machine (Rev4)
// =============================================================================
// Because the Pi drives the per-cell weld loop, WELDING is largely a label
// state here — transitions in/out happen when the Pi sends RUN_START / RUN_ABORT
// / RUN_COMPLETE. Motion primitives (MOVE / JOG / Z / FIRE) still flow through
// this module so soft-limit checks and Z interlocks are consistent.
// =============================================================================

#include <Arduino.h>
#include "fault_handler.h"
#include "homing.h"
#include "z_control.h"
#include "stepper.h"
#include "sensors.h"
#include "run_state.h"

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
// Move-request guards shared across commands
//
// `requireZSafe` controls the Z-up gate. Defaults to true so every existing
// caller (MOVE, JOG, TRAM_PREVIEW, etc.) keeps the safety interlock. The
// calibration-only MOVE_CAL command passes false so the operator can jog the
// table while teaching start positions with the weld head down (e.g. lining
// up the head's contact point on a fixture). All other safety gates
// (FAULT_LOCKOUT, ESTOP, driver enable, machine state) still apply.
// =============================================================================
inline bool state_motion_allowed(const char* cmdName, bool requireZSafe = true) {
  (void)cmdName;
  if (machineState.state == STATE_FAULT_LOCKOUT ||
      machineState.state == STATE_ESTOP) {
    Serial.println("BUSY");
    return false;
  }
  if (machineState.state != STATE_IDLE &&
      machineState.state != STATE_WELDING) {
    Serial.println("BUSY");
    return false;
  }
  if (!machineState.driversEnabled) {
    Serial.println("BUSY");
    return false;
  }
  if (requireZSafe && !z_safe()) {
    Serial.println("BUSY");  // Z not confirmed up
    return false;
  }
  return true;
}

// =============================================================================
// state_request_move — MOVE command entry point (absolute mm)
// Applies soft-limit clamping. If values get clamped we emit OK still — the
// Pi planner is trusted to respect limits, and the clamp is belt-and-braces.
// =============================================================================
inline void state_request_move(float x, float y) {
  if (!state_motion_allowed("MOVE")) return;

  clamp_x_to_limits(x);
  clamp_y_to_limits(y);

  // If we're in WELDING, keep it; otherwise flip to MOVING until the move
  // completes (state_update will emit DONE and return to IDLE).
  bool wasIdle = (machineState.state == STATE_IDLE);
  if (wasIdle) {
    machineState.state = STATE_MOVING;
  }

  stepper_move_to_mm(axisX,      x);
  stepper_move_to_mm(axisYLeft,  y);
  stepper_move_to_mm(axisYRight, y + settings.tramOffset);
  Serial.println("OK");

  // Zero-motion MOVE: if the gantry is already AT the target, stepper_move_to_mm
  // early-returns on delta==0 and never flips ax.moving=true. In that case the
  // STATE_MOVING / STATE_WELDING edge-detectors in state_update() never see a
  // true→false transition and never emit DONE — the Pi's awaitingDone promise
  // for this MOVE hangs until MOTION_REPLY_TIMEOUT_MS (60 s) then aborts the
  // run. This is exactly the "pre-move lands on cell 1's coordinates" case that
  // caused runs to immediate-abort (timer ticking, no motion).
  // If no axis actually needed to move, emit DONE right here so the Pi resolves
  // instantly.
  if (!any_axis_moving()) {
    if (wasIdle) {
      machineState.state = STATE_IDLE;
    }
    Serial.println("DONE");
  }
}

// =============================================================================
// state_request_move_cal — calibration MOVE that bypasses the Z-up gate
//
// Identical to state_request_move EXCEPT z_safe() is skipped. Used by the
// Calibrate Start Position / Loading Position screens so the operator can
// nudge the table with Z either UP or DOWN — useful for visually aligning
// the weld head against a fixture. All other safety gates still apply
// (FAULT_LOCKOUT, ESTOP, driver enable, soft limits).
// =============================================================================
inline void state_request_move_cal(float x, float y) {
  if (!state_motion_allowed("MOVE_CAL", /*requireZSafe=*/false)) return;

  clamp_x_to_limits(x);
  clamp_y_to_limits(y);

  bool wasIdle = (machineState.state == STATE_IDLE);
  if (wasIdle) machineState.state = STATE_MOVING;

  stepper_move_to_mm(axisX,      x);
  stepper_move_to_mm(axisYLeft,  y);
  stepper_move_to_mm(axisYRight, y + settings.tramOffset);
  Serial.println("OK");

  // Mirror state_request_move's zero-motion shortcut so the orchestrator's
  // awaitingDone promise resolves immediately when the target equals current.
  if (!any_axis_moving()) {
    if (wasIdle) machineState.state = STATE_IDLE;
    Serial.println("DONE");
  }
}

// =============================================================================
// state_request_jog — JOG command entry point (relative mm on one axis)
// =============================================================================
inline void state_request_jog_x(float deltaMm) {
  if (!state_motion_allowed("JOG")) return;
  float target = stepper_position_mm(axisX) + deltaMm;
  clamp_x_to_limits(target);
  // Recompute delta after clamping so the clamp is authoritative
  float clampedDelta = target - stepper_position_mm(axisX);
  if (clampedDelta == 0.0f) { Serial.println("OK"); Serial.println("DONE"); return; }
  // Flip to MOVING so telemetry.h emits live POSITION events during the jog
  // and state_update() fires the closing DONE once the steppers halt. Without
  // this: POSITION only ticks while moving is detected AND state != IDLE (the
  // AIR/SENSORS-safe gate), which skipped the JOG motion entirely; the top-bar
  // coordinate readout and the Pi's JOG-promise resolution both depended on
  // it. WELDING jogs aren't used today, but keep WELDING untouched for safety.
  bool wasIdle = (machineState.state == STATE_IDLE);
  if (wasIdle) {
    machineState.state = STATE_MOVING;
  }
  stepper_jog_mm(axisX, clampedDelta);
  Serial.println("OK");
  // Zero-motion safety (see state_request_move comment above).
  if (!any_axis_moving()) {
    if (wasIdle) machineState.state = STATE_IDLE;
    Serial.println("DONE");
  }
}

inline void state_request_jog_y(float deltaMm) {
  if (!state_motion_allowed("JOG")) return;
  float target = stepper_position_mm(axisYLeft) + deltaMm;
  clamp_y_to_limits(target);
  float clampedDelta = target - stepper_position_mm(axisYLeft);
  if (clampedDelta == 0.0f) { Serial.println("OK"); Serial.println("DONE"); return; }
  // See comment in state_request_jog_x for why we flip to MOVING here.
  bool wasIdle = (machineState.state == STATE_IDLE);
  if (wasIdle) {
    machineState.state = STATE_MOVING;
  }
  stepper_jog_mm(axisYLeft,  clampedDelta);
  stepper_jog_mm(axisYRight, clampedDelta);
  Serial.println("OK");
  if (!any_axis_moving()) {
    if (wasIdle) machineState.state = STATE_IDLE;
    Serial.println("DONE");
  }
}

// =============================================================================
// state_request_tram_preview — TRAM_PREVIEW command entry point
// =============================================================================
// Live-preview the gantry-square offset without writing to EEPROM. Updates
// settings.tramOffset in RAM and slews Y_RIGHT alone to put it at
// (Y_LEFT pos + newOffset). Y_LEFT does NOT move — only Y_RIGHT racks by the
// delta, so the gantry visibly squares in real time as the operator taps
// ↑/↓ on the X-Axis Tramming screen. The Save button on that screen still
// calls SET_TRAM to commit the value to EEPROM.
//
// Tramming offsets are typically sub-mm so racking the gantry by the delta
// per tap is mechanically fine. The Pi-side adjustOffset step is 0.01 mm.
// =============================================================================
inline void state_request_tram_preview(float newOffsetMm) {
  if (!state_motion_allowed("TRAM_PREVIEW")) return;

  float delta = newOffsetMm - settings.tramOffset;
  if (delta == 0.0f) { Serial.println("OK"); Serial.println("DONE"); return; }

  // Update RAM offset so subsequent MOVE / JOG commands use the new value.
  // EEPROM is NOT touched — only SET_TRAM persists. If the operator leaves
  // the tramming screen without saving, the Pi-side cleanup effect calls
  // TRAM_PREVIEW with the saved value to revert both this RAM offset and
  // Y_RIGHT's physical position.
  settings.tramOffset = newOffsetMm;

  bool wasIdle = (machineState.state == STATE_IDLE);
  if (wasIdle) {
    machineState.state = STATE_MOVING;
  }
  stepper_jog_mm(axisYRight, delta);
  Serial.println("OK");
  if (!any_axis_moving()) {
    if (wasIdle) machineState.state = STATE_IDLE;
    Serial.println("DONE");
  }
}

// =============================================================================
// state_update — call every loop()
// =============================================================================
inline void state_update() {
  // Always run the homing FSM (it self-gates on HOMING_IDLE)
  homing_update();
  // Always run Z FSM (self-gates on Z_IDLE)
  z_update();

  switch (machineState.state) {

    case STATE_IDLE:
      // idle
      break;

    case STATE_HOMING:
      // homing_update() transitions back to IDLE on completion
      break;

    case STATE_MOVING:
      if (!any_axis_moving()) {
        machineState.state = STATE_IDLE;
        Serial.println("DONE");
      }
      break;

    case STATE_WELDING: {
      // Pi drives MOVE / Z / FIRE; run_state_t tracks cell index.
      // Stay here until RUN_COMPLETE or RUN_ABORT transitions us out.
      // A MOVE while WELDING stays in WELDING (doesn't fall through to IDLE).
      //
      // Motion-complete detection: the STATE_MOVING case above emits DONE
      // when the steppers settle, but a MOVE issued *during* WELDING never
      // flips us out of WELDING — so without this block the Pi's
      // awaitingDone promise for every per-cell MOVE in the runLoop would
      // hang until the 60 s MOTION_REPLY_TIMEOUT_MS fired, which the Pi
      // interprets as a failed pre-move and aborts the run (cue the
      // loading-gif flash the operator was seeing). Edge-detect
      // moving → stopped and emit DONE, mirroring STATE_MOVING.
      static bool weldingWasMoving = false;
      bool weldingMoving = any_axis_moving();
      if (weldingWasMoving && !weldingMoving) {
        Serial.println("DONE");
      }
      weldingWasMoving = weldingMoving;
      if (!run_is_active()) {
        machineState.state = STATE_IDLE;
      }
      break;
    }

    case STATE_PAUSED:
      // Waiting for RESUME / RUN_RESUME. Motion is stopped.
      break;

    case STATE_FAULT_LOCKOUT:
    case STATE_ESTOP:
      // Handled in fault_handler
      break;
  }
}

// =============================================================================
// state_pause / state_resume — called from PAUSE/RESUME and RUN_PAUSE/RUN_RESUME
// =============================================================================
inline void state_pause() {
  if (machineState.state == STATE_MOVING ||
      machineState.state == STATE_WELDING) {
    // Finish the currently-queued stepper move before parking in PAUSED.
    // A mid-move abort is left to the ABORT command.
    machineState.state = STATE_PAUSED;
  }
}

inline void state_resume() {
  if (machineState.state != STATE_PAUSED) return;
  // If a run is active, go back to WELDING; otherwise IDLE.
  machineState.state = run_is_active() ? STATE_WELDING : STATE_IDLE;
}
