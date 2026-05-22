#pragma once
// =============================================================================
// fault_handler.h — Fault detection, codes and handling (Rev4)
// =============================================================================
// Rev4 adds:
//   - `cellIndex=N` trailer on FAULT when a run is active
//   - `FAULT_CLEARED <CODE>` auto-emitted when the sensor condition resolves
//     (Pi drops the lockout banner without operator having to press a button)
//   - `ESTOP` and `ESTOP_CLEARED` events emitted distinct from FAULT
// =============================================================================

#include <Arduino.h>
#include "sensors.h"
#include "stepper.h"
#include "pins.h"
#include "config.h"
#include "settings.h"

// Forward declaration — defined in run_state.h, used here to annotate fault
// emissions with cellIndex when a run is active. Weak default so this header
// compiles even if run_state.h is not yet included.
extern bool  run_is_active();
extern int   run_current_cell_index();

// =============================================================================
// Fault codes — match master plan §3.1
// =============================================================================
enum FaultCode {
  FAULT_NONE             = 0,
  FAULT_LOW_AIR          = 1,
  FAULT_Z_TIMEOUT_DOWN   = 2,
  FAULT_Z_TIMEOUT_UP     = 3,
  FAULT_DRIVER_X         = 4,
  FAULT_DRIVER_YL        = 5,
  FAULT_DRIVER_YR        = 6,
  FAULT_ESTOP            = 7,
  USER_ABORT             = 8,
  // Rev4.1 dead-man watchdog — triggered if Pi stops talking while a run is
  // active. Keeps a crashed Pi from leaving the machine welding into thin air.
  FAULT_LINK_LOST        = 9,
  // Homing cycle didn't see a home sensor within HOMING_TIMEOUT_MS. Tracked
  // as an activeFault so CLEAR_FAULT properly resets STATE_FAULT_LOCKOUT →
  // STATE_IDLE (previously state was locked but activeFault stayed NONE, so
  // fault_clear() early-returned without releasing the state).
  FAULT_HOMING_TIMEOUT   = 10,
  // Dual-Y gantry de-sync during homing — first Y home sensor triggered but
  // the second didn't follow within HOMING_Y_DUAL_TIMEOUT_MS. Indicates one
  // Y motor stalled, one home sensor failed, or the gantry is mechanically
  // racked. Stops motion immediately to prevent damage to the screws/frame.
  FAULT_Y_GANTRY_RACK    = 11,
};

// =============================================================================
// State machine states — match master plan §7.2
// =============================================================================
enum MachineStateEnum {
  STATE_IDLE          = 0,
  STATE_HOMING        = 1,
  STATE_MOVING        = 2,
  STATE_WELDING       = 3,
  STATE_PAUSED        = 4,
  STATE_FAULT_LOCKOUT = 5,
  STATE_ESTOP         = 6,
};

struct MachineState {
  MachineStateEnum state;
  FaultCode        activeFault;
  bool             driversEnabled;
  bool             zDown;       // true = solenoid energised
  bool             laserActive;
};

extern MachineState machineState;
extern SensorState  sensors;

// =============================================================================
// Forward declarations
// =============================================================================
void fault_trigger(FaultCode code);
const char* fault_code_str(FaultCode code);

// =============================================================================
// Post-RUN_ABORT grace window — set by serial_protocol.h's RUN_ABORT handler
// to suppress single-driver ALM fault detection during the brief transient
// caused by stepper_stop_all()'s instant halt. fault_check() reads this and
// short-circuits the per-axis ALM checks while in_abort_grace() is true.
// E-stop detection (all 3 ALMs simultaneous) is NOT suppressed.
// =============================================================================
static uint32_t _abortGraceUntilMs = 0;
inline void fault_set_abort_grace(uint32_t durationMs) {
  _abortGraceUntilMs = millis() + durationMs;
}
inline bool in_abort_grace() {
  return millis() < _abortGraceUntilMs;
}

// =============================================================================
// Emergency stop all outputs — called on any hard fault
// =============================================================================
inline void emergency_stop_outputs() {
  stepper_stop_all();
  drivers_disable();
  // De-energise all Z solenoid channels and laser (safe on fault)
  // SONGLE relay board is active-LOW: HIGH = de-energise (safe).
  digitalWrite(PIN_Z_SOLENOID_A, HIGH);
  digitalWrite(PIN_Z_SOLENOID_B, HIGH);
  digitalWrite(PIN_Z_SOLENOID_C, HIGH);
  digitalWrite(PIN_LASER_RELAY,  HIGH);
  machineState.zDown          = false;
  machineState.laserActive    = false;
  machineState.driversEnabled = false;
}

// =============================================================================
// Emit "FAULT <CODE> [cellIndex=N]" with newline
// =============================================================================
inline void fault_emit(FaultCode code) {
  Serial.print("FAULT ");
  Serial.print(fault_code_str(code));
  if (run_is_active()) {
    Serial.print(" cellIndex=");
    Serial.print(run_current_cell_index());
  }
  Serial.println();
}

// =============================================================================
// Emit "FAULT_CLEARED <CODE>" — automatic recovery notification
// =============================================================================
inline void fault_emit_cleared(FaultCode code) {
  Serial.print("FAULT_CLEARED ");
  Serial.println(fault_code_str(code));
}

// =============================================================================
// Trigger a fault — stops everything, transitions to FAULT_LOCKOUT / ESTOP
// =============================================================================
inline void fault_trigger(FaultCode code) {
  // Only record the first fault — subsequent ones while locked out are swallowed
  if (machineState.activeFault != FAULT_NONE) return;

  // If motion was in flight when the fault fires, the Pi's orchestrator is
  // awaiting DONE for the current MOVE / Z. The transition into STATE_ESTOP /
  // STATE_FAULT_LOCKOUT below bypasses the STATE_MOVING / STATE_WELDING edge
  // detector in state_update() that would normally emit DONE on motion stop,
  // so the Pi's pending send() sits in the realSerial queue until the 60 s
  // MOTION_REPLY_TIMEOUT_MS. That stale queue head swallows every
  // subsequent OK reply (e.g. HOME's sync ack) and leaves the operator
  // unable to home/move after an E-stop until a power cycle. Emit DONE
  // here so the pending entry resolves cleanly before the fault state
  // takes effect — mirroring the fix in serial_protocol.h for RUN_ABORT.
  const bool wasInMotion = (machineState.state == STATE_MOVING ||
                            machineState.state == STATE_WELDING);

  emergency_stop_outputs();

  if (wasInMotion) Serial.println("DONE");

  if (code == FAULT_ESTOP) {
    machineState.state       = STATE_ESTOP;
    machineState.activeFault = FAULT_ESTOP;
    Serial.println("ESTOP");   // distinct event per Rev4 — the GUI uses this
                               // to latch the persistent E-STOP pill.
    // Also emit the standard FAULT line so the GUI's FaultLockoutOverlay
    // (which keys off fault.active in the reducer) opens up with the
    // FAULT_ESTOP code and walks the operator through clear -> home ->
    // resume. Without this, an E-stop hit just flips a status pill silently
    // and the operator gets no prompt that the axes are now lost and need
    // re-homing. The GUI status pill code at App.jsx:814 explicitly notes
    // that estop.active "typically also" comes with fault.active — this
    // line makes that contract true.
    fault_emit(FAULT_ESTOP);
    return;
  }

  machineState.state       = STATE_FAULT_LOCKOUT;
  machineState.activeFault = code;
  fault_emit(code);
}

// =============================================================================
// fault_clear — explicit CLEAR_FAULT command path
// Returns true if cleared, false if condition is still active
// =============================================================================
inline bool fault_clear() {
  if (machineState.activeFault == FAULT_NONE) return true;

  // Non-clearable conditions: air still low, ALMs still tripped
  switch (machineState.activeFault) {
    case FAULT_LOW_AIR:
      if (sensors.airPressureBar < settings.airThresholdBar) return false;
      break;
    case FAULT_DRIVER_X:
      if (sensors.xDriverAlm)  return false;
      break;
    case FAULT_DRIVER_YL:
      if (sensors.yLeftAlm)    return false;
      break;
    case FAULT_DRIVER_YR:
      if (sensors.yRightAlm)   return false;
      break;
    default:
      // Z_TIMEOUT_* and USER_ABORT clear on request
      break;
  }

  FaultCode cleared = machineState.activeFault;
  machineState.activeFault = FAULT_NONE;
  machineState.state       = STATE_IDLE;
  fault_emit_cleared(cleared);
  return true;
}

// =============================================================================
// fault_check — called every loop()
// Triggers new faults and auto-clears self-resolving ones.
// =============================================================================
inline void fault_check() {
  // --- Already in a fault/estop state — watch for auto-recovery ----
  if (machineState.state == STATE_FAULT_LOCKOUT ||
      machineState.state == STATE_ESTOP) {

    // E-stop release: all three ALMs must clear
    if (machineState.activeFault == FAULT_ESTOP) {
      if (!sensors.xDriverAlm && !sensors.yLeftAlm && !sensors.yRightAlm) {
        machineState.activeFault = FAULT_NONE;
        machineState.state       = STATE_IDLE;
        Serial.println("ESTOP_CLEARED");
      }
      return;
    }

    // Air fault self-clears when pressure returns above threshold
    if (machineState.activeFault == FAULT_LOW_AIR &&
        sensors.airPressureBar >= settings.airThresholdBar) {
      FaultCode cleared = machineState.activeFault;
      machineState.activeFault = FAULT_NONE;
      machineState.state       = STATE_IDLE;
      fault_emit_cleared(cleared);
      return;
    }

    // Individual driver faults auto-clear when that driver's ALM clears.
    // (Master plan §3.2 — Pi UI still shows recovery dialog, but the firmware
    //  stops holding the lockout once the physical condition is gone.)
    if (machineState.activeFault == FAULT_DRIVER_X  && !sensors.xDriverAlm) {
      fault_emit_cleared(machineState.activeFault);
      machineState.activeFault = FAULT_NONE;
      machineState.state       = STATE_IDLE;
      return;
    }
    if (machineState.activeFault == FAULT_DRIVER_YL && !sensors.yLeftAlm) {
      fault_emit_cleared(machineState.activeFault);
      machineState.activeFault = FAULT_NONE;
      machineState.state       = STATE_IDLE;
      return;
    }
    if (machineState.activeFault == FAULT_DRIVER_YR && !sensors.yRightAlm) {
      fault_emit_cleared(machineState.activeFault);
      machineState.activeFault = FAULT_NONE;
      machineState.state       = STATE_IDLE;
      return;
    }

    return;
  }

  // --- Healthy — look for new faults ---
  // E-stop detection: all three ALMs fire simultaneously. ALWAYS runs even
  // during the post-abort grace window — a hardware E-stop press during a
  // software abort recovery is still a real E-stop and must lock out.
  if (sensors.xDriverAlm && sensors.yLeftAlm && sensors.yRightAlm) {
    fault_trigger(FAULT_ESTOP);
    return;
  }

  // Single-driver ALM checks. RUN_ABORT does stepper_stop_all() — an instant
  // halt with no decel — which momentarily pulses the CL57Y ALM lines as
  // the motors slam to zero. Without the grace window we'd trip
  // FAULT_DRIVER_X/YL/YR on every deliberate operator abort, force a
  // re-home (because the reducer flags those as requiresHome=true), and
  // leave the operator unable to recover the run without a power cycle.
  // The grace timestamp is set by serial_protocol.h's RUN_ABORT handler
  // for ~300 ms (enough for the ALM transient to subside; brake torque
  // from the still-energised drivers settles long before then).
  if (in_abort_grace()) return;

  if (sensors.xDriverAlm) { fault_trigger(FAULT_DRIVER_X);  return; }
  if (sensors.yLeftAlm)   { fault_trigger(FAULT_DRIVER_YL); return; }
  if (sensors.yRightAlm)  { fault_trigger(FAULT_DRIVER_YR); return; }

  // Low-air fault is only meaningful when the laser is about to fire.
  // laser_fire() already rejects + fault_triggers on low air, which covers
  // welding moves. Continuously faulting at idle / during homing just blocks
  // bench testing (no compressor attached) — and leaves HOME stuck in BUSY
  // because the firmware never leaves STATE_FAULT_LOCKOUT. Gate the
  // continuous trigger on an active run so low air mid-job still aborts
  // cleanly but idle / homing stay usable. Bench mode additionally
  // suppresses it entirely so dry-bench runs don't trip on cell 1.
  if (run_is_active() &&
      !settings.benchMode &&
      sensors.airPressureBar < settings.airThresholdBar) {
    fault_trigger(FAULT_LOW_AIR);
    return;
  }
}

// =============================================================================
// String representations of fault codes
// =============================================================================
inline const char* fault_code_str(FaultCode code) {
  switch (code) {
    case FAULT_NONE:           return "FAULT_NONE";
    case FAULT_LOW_AIR:        return "FAULT_LOW_AIR";
    case FAULT_Z_TIMEOUT_DOWN: return "FAULT_Z_TIMEOUT_DOWN";
    case FAULT_Z_TIMEOUT_UP:   return "FAULT_Z_TIMEOUT_UP";
    case FAULT_DRIVER_X:       return "FAULT_DRIVER_X";
    case FAULT_DRIVER_YL:      return "FAULT_DRIVER_YL";
    case FAULT_DRIVER_YR:      return "FAULT_DRIVER_YR";
    case FAULT_ESTOP:          return "FAULT_ESTOP";
    case USER_ABORT:           return "USER_ABORT";
    case FAULT_LINK_LOST:      return "FAULT_LINK_LOST";
    case FAULT_HOMING_TIMEOUT: return "FAULT_HOMING_TIMEOUT";
    case FAULT_Y_GANTRY_RACK:  return "FAULT_Y_GANTRY_RACK";
    default:                   return "FAULT_UNKNOWN";
  }
}

inline void fault_init() {
  machineState.activeFault    = FAULT_NONE;
  machineState.state          = STATE_IDLE;
  machineState.driversEnabled = false;
  machineState.zDown          = false;
  machineState.laserActive    = false;
}
