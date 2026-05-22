#pragma once
// =============================================================================
// serial_protocol.h — USB CDC serial command parser for Gillis V2.0
// =============================================================================
// Protocol: plain text, newline-terminated, ASCII
// Pi → Teensy: commands defined in spec Section 4.1
// Teensy → Pi: responses defined in spec Section 4.2
// =============================================================================

#include <Arduino.h>
#include "config.h"
#include "stepper.h"
#include "state_machine.h"
#include "fault_handler.h"
#include "z_control.h"
#include "sensors.h"
#include "settings.h"
#include "homing.h"
#include "pins.h"

// =============================================================================
// Laser fire (blocking for dwell duration)
// Called from FIRE command — only fires if Z is confirmed down
// =============================================================================
inline void laser_fire() {
  if (!sensors.zDown) {
    // Z not confirmed down — refuse to fire
    fault_trigger(FAULT_Z_TIMEOUT_DOWN);
    return;
  }
  if (sensors.airPressureBar < settings.airThresholdBar) {
    fault_trigger(FAULT_LOW_AIR);
    return;
  }
  digitalWrite(PIN_LASER_RELAY, HIGH);
  machineState.laserActive = true;
  delay(settings.dwellMs);
  digitalWrite(PIN_LASER_RELAY, LOW);
  machineState.laserActive = false;
  Serial.println("DONE");
}

// =============================================================================
// STATUS response
// FORMAT: STATUS X<mm> Y<mm> Z<UP|DOWN> AIR<bar> DRIVERS<OK|DISABLED> [FAULT<code>]
// =============================================================================
inline void send_status() {
  float xMm  = stepper_position_mm(axisX);
  float yMm  = stepper_position_mm(axisYLeft);
  float air  = sensors.airPressureBar;
  const char* zStr = sensors.zUp ? "UP" : (sensors.zDown ? "DOWN" : "MID");
  const char* drvStr = machineState.driversEnabled ? "OK" : "DISABLED";

  char buf[128];
  snprintf(buf, sizeof(buf),
           "STATUS X%.2f Y%.2f Z %s AIR %.2f DRIVERS %s",
           xMm, yMm, zStr, air, drvStr);
  Serial.print(buf);

  if (machineState.activeFault != FAULT_NONE) {
    Serial.print(" FAULT ");
    Serial.print(fault_code_str(machineState.activeFault));
  }

  Serial.print(" STATE ");
  switch (machineState.state) {
    case STATE_IDLE:          Serial.print("IDLE");          break;
    case STATE_HOMING:        Serial.print("HOMING");        break;
    case STATE_MOVING:        Serial.print("MOVING");        break;
    case STATE_WELDING:       Serial.print("WELDING");       break;
    case STATE_PAUSED:        Serial.print("PAUSED");        break;
    case STATE_FAULT_LOCKOUT: Serial.print("FAULT_LOCKOUT"); break;
    case STATE_ESTOP:         Serial.print("ESTOP");         break;
    default:                  Serial.print("UNKNOWN");       break;
  }

  Serial.println();
}

// =============================================================================
// Parse MOVE command: MOVE X<mm> Y<mm>
// =============================================================================
inline void parse_move(const char* args) {
  float x = stepper_position_mm(axisX);
  float y = stepper_position_mm(axisYLeft);
  // Parse X and Y tokens (order independent)
  char *p = (char*)args;
  while (*p) {
    while (*p == ' ') p++;
    if (*p == 'X' || *p == 'x') { x = atof(p + 1); }
    if (*p == 'Y' || *p == 'y') { y = atof(p + 1); }
    // Advance past this token
    while (*p && *p != ' ') p++;
  }
  state_request_move(x, y);
}

// =============================================================================
// Parse JOG command: JOG X+1.0 or JOG Y-2.5
// =============================================================================
inline void parse_jog(const char* args) {
  if (machineState.state != STATE_IDLE || !machineState.driversEnabled) {
    Serial.println("BUSY");
    return;
  }
  char *p = (char*)args;
  while (*p == ' ') p++;
  if (*p == 'X' || *p == 'x') {
    float delta = atof(p + 1);
    stepper_jog_mm(axisX, delta);
    Serial.println("OK");
  } else if (*p == 'Y' || *p == 'y') {
    float delta = atof(p + 1);
    stepper_jog_mm(axisYLeft,  delta);
    stepper_jog_mm(axisYRight, delta);
    Serial.println("OK");
  } else {
    Serial.println("ERR UNKNOWN_AXIS");
  }
}

// =============================================================================
// Parse SET_SPEED: SET_SPEED X120 Y120
// =============================================================================
inline void parse_set_speed(const char* args) {
  char *p = (char*)args;
  while (*p) {
    while (*p == ' ') p++;
    if (*p == 'X' || *p == 'x') {
      settings.speedX = atof(p + 1);
      axisX.speedMmS  = settings.speedX;
    }
    if (*p == 'Y' || *p == 'y') {
      settings.speedY     = atof(p + 1);
      axisYLeft.speedMmS  = settings.speedY;
      axisYRight.speedMmS = settings.speedY;
    }
    while (*p && *p != ' ') p++;
  }
  Serial.println("OK");
}

// =============================================================================
// Parse SET_ACCEL: SET_ACCEL X500 Y500
// =============================================================================
inline void parse_set_accel(const char* args) {
  char *p = (char*)args;
  while (*p) {
    while (*p == ' ') p++;
    if (*p == 'X' || *p == 'x') {
      settings.accelX  = atof(p + 1);
      axisX.accelMmS2  = settings.accelX;
    }
    if (*p == 'Y' || *p == 'y') {
      settings.accelY      = atof(p + 1);
      axisYLeft.accelMmS2  = settings.accelY;
      axisYRight.accelMmS2 = settings.accelY;
    }
    while (*p && *p != ' ') p++;
  }
  Serial.println("OK");
}

// =============================================================================
// Serial receive buffer and command dispatcher
// =============================================================================
static char _rxBuf[SERIAL_RX_BUF_SIZE];
static uint8_t _rxIdx = 0;

inline void serial_dispatch(const char* cmd) {
  // Strip leading whitespace
  while (*cmd == ' ') cmd++;

  // ---- PING ----
  if (strcmp(cmd, "PING") == 0) {
    Serial.println("PONG");

  // ---- STATUS ----
  } else if (strcmp(cmd, "STATUS") == 0) {
    send_status();

  // ---- HOME ----
  } else if (strcmp(cmd, "HOME") == 0) {
    if (machineState.state != STATE_IDLE) {
      Serial.println("BUSY");
      return;
    }
    if (!machineState.driversEnabled) {
      drivers_enable();
      machineState.driversEnabled = true;
    }
    homing_start();
    Serial.println("OK");

  // ---- MOVE ----
  } else if (strncmp(cmd, "MOVE ", 5) == 0) {
    parse_move(cmd + 5);

  // ---- JOG ----
  } else if (strncmp(cmd, "JOG ", 4) == 0) {
    parse_jog(cmd + 4);

  // ---- Z_DOWN ----
  } else if (strcmp(cmd, "Z_DOWN") == 0) {
    if (machineState.state == STATE_FAULT_LOCKOUT ||
        machineState.state == STATE_ESTOP) {
      Serial.println("BUSY");
      return;
    }
    if (any_axis_moving()) {
      Serial.println("BUSY");
      return;
    }
    z_down();
    Serial.println("OK");

  // ---- Z_UP ----
  } else if (strcmp(cmd, "Z_UP") == 0) {
    if (machineState.state == STATE_FAULT_LOCKOUT ||
        machineState.state == STATE_ESTOP) {
      Serial.println("BUSY");
      return;
    }
    z_up();
    Serial.println("OK");

  // ---- FIRE ----
  } else if (strcmp(cmd, "FIRE") == 0) {
    if (machineState.state == STATE_FAULT_LOCKOUT ||
        machineState.state == STATE_ESTOP) {
      Serial.println("BUSY");
      return;
    }
    if (any_axis_moving()) {
      Serial.println("BUSY");
      return;
    }
    laser_fire();

  // ---- PAUSE ----
  } else if (strcmp(cmd, "PAUSE") == 0) {
    if (machineState.state == STATE_WELDING ||
        machineState.state == STATE_MOVING) {
      machineState.state = STATE_PAUSED;
      // Note: stepper will complete current move before Pi re-issues command
      Serial.println("OK");
    } else {
      Serial.println("OK"); // No-op if not running
    }

  // ---- RESUME ----
  } else if (strcmp(cmd, "RESUME") == 0) {
    if (machineState.state == STATE_PAUSED) {
      machineState.state = STATE_WELDING;
      Serial.println("OK");
    } else {
      Serial.println("OK");
    }

  // ---- ABORT ----
  } else if (strcmp(cmd, "ABORT") == 0) {
    stepper_stop_all();
    machineState.state = STATE_IDLE;
    fault_trigger(USER_ABORT);
    Serial.println("OK");

  // ---- ENABLE ----
  } else if (strcmp(cmd, "ENABLE") == 0) {
    drivers_enable();
    machineState.driversEnabled = true;
    Serial.println("OK");

  // ---- DISABLE ----
  } else if (strcmp(cmd, "DISABLE") == 0) {
    drivers_disable();
    machineState.driversEnabled = false;
    Serial.println("OK");

  // ---- SET_SPEED ----
  } else if (strncmp(cmd, "SET_SPEED ", 10) == 0) {
    parse_set_speed(cmd + 10);

  // ---- SET_ACCEL ----
  } else if (strncmp(cmd, "SET_ACCEL ", 10) == 0) {
    parse_set_accel(cmd + 10);

  // ---- SET_DWELL ----
  } else if (strncmp(cmd, "SET_DWELL ", 10) == 0) {
    settings.dwellMs = (uint32_t)atol(cmd + 10);
    settings_save();
    Serial.println("OK");

  // ---- SET_TRAM ----
  } else if (strncmp(cmd, "SET_TRAM ", 9) == 0) {
    settings.tramOffset = atof(cmd + 9);
    settings_save();
    Serial.println("OK");

  // ---- SET_AIR_THRESHOLD ----
  } else if (strncmp(cmd, "SET_AIR_THRESHOLD ", 18) == 0) {
    settings.airThresholdBar = atof(cmd + 18);
    settings_save();
    Serial.println("OK");

  // ---- CLEAR_FAULT ----
  } else if (strcmp(cmd, "CLEAR_FAULT") == 0) {
    if (fault_clear()) {
      Serial.println("OK");
    } else {
      Serial.println("FAULT_STILL_ACTIVE");
    }

  // ---- Unknown ----
  } else {
    Serial.print("ERR UNKNOWN_CMD ");
    Serial.println(cmd);
  }
}

// =============================================================================
// serial_process — call every loop() to read and dispatch incoming commands
// =============================================================================
inline void serial_process() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (_rxIdx > 0) {
        _rxBuf[_rxIdx] = '\0';
        serial_dispatch(_rxBuf);
        _rxIdx = 0;
      }
    } else {
      if (_rxIdx < SERIAL_RX_BUF_SIZE - 1) {
        _rxBuf[_rxIdx++] = c;
      }
      // If buffer overrun — silently discard (malformed command)
    }
  }
}
