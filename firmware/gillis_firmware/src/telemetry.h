#pragma once
// =============================================================================
// telemetry.h — Periodic POSITION / AIR / SENSORS events (Rev4)
// =============================================================================
// Called from loop() via telemetry_update().
//
//  POSITION X<mm> Y<mm>          every POSITION_EVENT_INTERVAL_MS
//                                 while state ≠ IDLE or any axis is moving
//  AIR <bar>                     every AIR_EVENT_INTERVAL_MS (always)
//  SENSORS XH<0|1> YLH<0|1> YRH<0|1>
//          ZU<0|1> ZD<0|1>
//          XA<0|1> YLA<0|1> YRA<0|1>
//                                 every SENSORS_EVENT_INTERVAL_MS AND on any
//                                 edge-change. Feeds the Test Motion screen.
//                                 1 = sensor triggered (for XH/YLH/YRH/ZU/ZD)
//                                 1 = driver alarm asserted (for XA/YLA/YRA)
//
// LASER ON / LASER OFF events are emitted synchronously from the FIRE
// handler in serial_protocol.h — not from here.
//
// SNAPSHOT is produced by snapshot_emit() on demand (STATUS command).
// =============================================================================

#include <Arduino.h>
#include "config.h"
#include "stepper.h"
#include "sensors.h"
#include "fault_handler.h"
#include "run_state.h"

static uint32_t _lastPositionMs = 0;
static uint32_t _lastAirMs      = 0;
static uint32_t _lastSensorsMs  = 0;
static float    _lastAirPrinted = -9999.0f;

// Tracks the last emitted sensor byte so we can fire on edge-change
// without waiting for the periodic tick.
//   bit 0 xHome   bit 1 yLeftHome  bit 2 yRightHome
//   bit 3 zUp     bit 4 zDown
//   bit 5 xAlm    bit 6 yLeftAlm   bit 7 yRightAlm
static uint8_t _lastSensorsMask = 0xFF;  // force first emit

// =============================================================================
// state name (shared by send_status in serial_protocol)
// =============================================================================
inline const char* state_name(MachineStateEnum s) {
  switch (s) {
    case STATE_IDLE:          return "IDLE";
    case STATE_HOMING:        return "HOMING";
    case STATE_MOVING:        return "MOVING";
    case STATE_WELDING:       return "WELDING";
    case STATE_PAUSED:        return "PAUSED";
    case STATE_FAULT_LOCKOUT: return "FAULT_LOCKOUT";
    case STATE_ESTOP:         return "ESTOP";
    default:                  return "UNKNOWN";
  }
}

// =============================================================================
// Emit POSITION event
// =============================================================================
inline void emit_position() {
  char buf[64];
  snprintf(buf, sizeof(buf), "POSITION X%.2f Y%.2f",
           stepper_position_mm(axisX),
           stepper_position_mm(axisYLeft));
  Serial.println(buf);
}

// =============================================================================
// Emit AIR event — only when pressure has changed meaningfully or on timer
// =============================================================================
inline void emit_air() {
  char buf[32];
  snprintf(buf, sizeof(buf), "AIR %.2f", sensors.airPressureBar);
  Serial.println(buf);
  _lastAirPrinted = sensors.airPressureBar;
}

// =============================================================================
// Laser events — called by FIRE handler in serial_protocol
// =============================================================================
inline void emit_laser_on()  { Serial.println("LASER ON");  }
inline void emit_laser_off() { Serial.println("LASER OFF"); }

// =============================================================================
// Pack the current sensor state into a single byte (see _lastSensorsMask).
// =============================================================================
inline uint8_t _sensors_mask() {
  uint8_t m = 0;
  if (sensors.xHome)       m |= (1 << 0);
  if (sensors.yLeftHome)   m |= (1 << 1);
  if (sensors.yRightHome)  m |= (1 << 2);
  if (sensors.zUp)         m |= (1 << 3);
  if (sensors.zDown)       m |= (1 << 4);
  if (sensors.xDriverAlm)  m |= (1 << 5);
  if (sensors.yLeftAlm)    m |= (1 << 6);
  if (sensors.yRightAlm)   m |= (1 << 7);
  return m;
}

// =============================================================================
// Emit SENSORS event — compact single line, parsed by UI Test Motion screen.
// =============================================================================
inline void emit_sensors() {
  char buf[96];
  snprintf(buf, sizeof(buf),
           "SENSORS XH%d YLH%d YRH%d ZU%d ZD%d XA%d YLA%d YRA%d",
           sensors.xHome       ? 1 : 0,
           sensors.yLeftHome   ? 1 : 0,
           sensors.yRightHome  ? 1 : 0,
           sensors.zUp         ? 1 : 0,
           sensors.zDown       ? 1 : 0,
           sensors.xDriverAlm  ? 1 : 0,
           sensors.yLeftAlm    ? 1 : 0,
           sensors.yRightAlm   ? 1 : 0);
  Serial.println(buf);
  _lastSensorsMask = _sensors_mask();
  _lastSensorsMs   = millis();
}

// =============================================================================
// SNAPSHOT — a single-line summary of everything the Pi needs to rehydrate UI.
// =============================================================================
inline void snapshot_emit() {
  char buf[160];
  const char* zStr   = sensors.zUp   ? "UP" :
                       sensors.zDown ? "DOWN" : "MID";
  const char* drvStr = machineState.driversEnabled ? "OK" : "DISABLED";

  snprintf(buf, sizeof(buf),
           "SNAPSHOT X%.2f Y%.2f Z%s AIR%.2f DRIVERS%s STATE%s",
           stepper_position_mm(axisX),
           stepper_position_mm(axisYLeft),
           zStr, sensors.airPressureBar, drvStr,
           state_name(machineState.state));
  Serial.print(buf);

  if (machineState.activeFault != FAULT_NONE) {
    Serial.print(" FAULT");
    Serial.print(fault_code_str(machineState.activeFault));
  }
  Serial.print(" SOLENOID");
  Serial.print((char)('A' + settings.activeSolenoid));
  Serial.print(" MAXX");  Serial.print(settings.maxX, 1);
  Serial.print(" MAXY");  Serial.print(settings.maxY, 1);
  Serial.print(" TRAM");  Serial.print(settings.tramOffset, 3);
  Serial.print(" DWELL"); Serial.print(settings.dwellMs);
  Serial.print(" PREWELD");  Serial.print(settings.preWeldHoldMs);
  Serial.print(" POSTWELD"); Serial.print(settings.postWeldHoldMs);
  Serial.print(" HOMEBOOT"); Serial.print(settings.homeOnBoot ? 1 : 0);
  Serial.print(" BENCHMODE"); Serial.print(settings.benchMode ? 1 : 0);
  run_print_status_fragment();
  Serial.println();
}

// =============================================================================
// telemetry_update — call every loop()
// =============================================================================
inline void telemetry_update() {
  uint32_t now = millis();

  // POSITION — tick rate depends on activity
  bool moving = any_axis_moving();
  bool busy   = machineState.state != STATE_IDLE;
  if ((moving || busy) &&
      (now - _lastPositionMs) >= POSITION_EVENT_INTERVAL_MS) {
    emit_position();
    _lastPositionMs = now;
  }

  // AIR — always ticks so the UI gauge stays alive
  if ((now - _lastAirMs) >= AIR_EVENT_INTERVAL_MS) {
    emit_air();
    _lastAirMs = now;
  }

  // SENSORS — fire on any edge-change OR on the periodic tick, whichever
  // comes first. Edge firing gives Test Motion a near-instant reaction to a
  // limit switch flipping; the periodic tick keeps the UI synced even when
  // nothing changes.
  uint8_t mask = _sensors_mask();
  if (mask != _lastSensorsMask ||
      (now - _lastSensorsMs) >= SENSORS_EVENT_INTERVAL_MS) {
    emit_sensors();
  }
}
