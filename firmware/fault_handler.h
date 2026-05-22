#pragma once
// =============================================================================
// fault_handler.h — Fault detection, codes and handling for Gillis V2.0
// =============================================================================

#include <Arduino.h>
#include "sensors.h"
#include "stepper.h"
#include "pins.h"
#include "config.h"
#include "settings.h"

// =============================================================================
// Fault codes — match spec Section 3.1
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
};

// =============================================================================
// State machine states — match spec Section 7.2
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
// Emergency stop all outputs — called on any hard fault
// =============================================================================
inline void emergency_stop_outputs() {
  stepper_stop_all();
  drivers_disable();
  digitalWrite(PIN_Z_SOLENOID_A, LOW);   // Z UP (spring return)
  digitalWrite(PIN_LASER_RELAY,  LOW);   // Laser OFF
  machineState.zDown       = false;
  machineState.laserActive = false;
  machineState.driversEnabled = false;
}

// =============================================================================
// Trigger a fault — stops everything, transitions to FAULT_LOCKOUT / ESTOP
// =============================================================================
inline void fault_trigger(FaultCode code) {
  // Only upgrade if no fault currently active (preserve first fault)
  if (machineState.activeFault != FAULT_NONE) return;

  // E-stop gets its own state
  if (code == FAULT_ESTOP) {
    emergency_stop_outputs();
    machineState.state       = STATE_ESTOP;
    machineState.activeFault = FAULT_ESTOP;
    Serial.print("FAULT ");
    Serial.println(fault_code_str(FAULT_ESTOP));
    return;
  }

  // All other faults: immediate stop
  emergency_stop_outputs();
  machineState.state       = STATE_FAULT_LOCKOUT;
  machineState.activeFault = code;

  Serial.print("FAULT ");
  Serial.println(fault_code_str(code));
}

// =============================================================================
// Clear a fault — only if fault condition no longer present
// Returns true if cleared successfully
// =============================================================================
inline bool fault_clear() {
  if (machineState.activeFault == FAULT_NONE) return true;

  // Check air fault is actually resolved
  if (machineState.activeFault == FAULT_LOW_AIR) {
    if (sensors.airPressureBar < settings.airThresholdBar) return false;
  }

  machineState.activeFault = FAULT_NONE;
  machineState.state       = STATE_IDLE;
  return true;
}

// =============================================================================
// fault_check — called every loop()
// Monitors sensor conditions and triggers faults as needed
// =============================================================================
inline void fault_check() {
  // Skip fault checking if already in a fault/estop state
  if (machineState.state == STATE_FAULT_LOCKOUT ||
      machineState.state == STATE_ESTOP) {
    // Watch for E-stop release: all three ALMs must clear
    if (machineState.activeFault == FAULT_ESTOP) {
      if (!sensors.xDriverAlm && !sensors.yLeftAlm && !sensors.yRightAlm) {
        machineState.activeFault = FAULT_NONE;
        machineState.state       = STATE_IDLE;
        Serial.println("ESTOP_CLEARED");
      }
    }
    return;
  }

  // --- E-stop detection: all three ALMs fire simultaneously ---
  if (sensors.xDriverAlm && sensors.yLeftAlm && sensors.yRightAlm) {
    fault_trigger(FAULT_ESTOP);
    return;
  }

  // --- Individual driver ALM (non-E-stop) ---
  if (sensors.xDriverAlm)   { fault_trigger(FAULT_DRIVER_X);   return; }
  if (sensors.yLeftAlm)     { fault_trigger(FAULT_DRIVER_YL);  return; }
  if (sensors.yRightAlm)    { fault_trigger(FAULT_DRIVER_YR);  return; }

  // --- Air pressure ---
  if (sensors.airPressureBar < settings.airThresholdBar) {
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
