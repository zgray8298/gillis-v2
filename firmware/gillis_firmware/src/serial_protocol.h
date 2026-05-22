#pragma once
// =============================================================================
// serial_protocol.h — USB CDC serial command parser for Gillis V2.0 (Rev4)
// =============================================================================
// Protocol: plain text, newline-terminated, ASCII. JSON payloads allowed for
// SETMOTION / SET_TRAVEL / LOADPOS / RUN_START (delimited by newline at the end).
//
// Dependency: ArduinoJson v7 (install via Library Manager).
//   - In Arduino IDE: Tools → Manage Libraries → "ArduinoJson" by Benoit Blanchon
// =============================================================================

#include <Arduino.h>
#include <ArduinoJson.h>
#include "config.h"
#include "stepper.h"
#include "state_machine.h"
#include "fault_handler.h"
#include "z_control.h"
#include "sensors.h"
#include "settings.h"
#include "homing.h"
#include "pins.h"
#include "run_state.h"
#include "telemetry.h"

// =============================================================================
// Laser fire — blocks for dwell duration. Emits LASER ON/OFF and DONE.
// =============================================================================
inline void laser_fire() {
  // Bench mode skips the Z-down and air interlocks so dry-bench runs can
  // cycle through FIRE without actually welding anything. In bench mode
  // the Pi-side test-run flag should already be suppressing FIRE, but be
  // defensive — if a real program is started in bench mode we still want
  // it to complete instead of cascading into a Z-timeout fault on cell 1.
  const bool bench = settings.benchMode;
  if (!bench && !sensors.zDown) {
    // Refuse to fire if Z isn't confirmed down (safety interlock)
    fault_trigger(FAULT_Z_TIMEOUT_DOWN);
    return;
  }
  if (!bench && sensors.airPressureBar < settings.airThresholdBar) {
    fault_trigger(FAULT_LOW_AIR);
    return;
  }
  // SONGLE relay board is active-LOW: LOW = energise (fire), HIGH = de-energise.
  digitalWrite(PIN_LASER_RELAY, LOW);
  machineState.laserActive = true;
  emit_laser_on();
  // For short dwells (<100 ms) this blocks the loop — acceptable.
  // Longer dwells would warrant a non-blocking timer; not required by spec.
  delay(settings.dwellMs);
  digitalWrite(PIN_LASER_RELAY, HIGH);
  machineState.laserActive = false;
  emit_laser_off();
  Serial.println("DONE");
}

// =============================================================================
// STATUS response (legacy single-line)
// =============================================================================
inline void send_status() {
  snapshot_emit();
}

// =============================================================================
// Parse legacy "K VALUE" pairs (e.g. "X120 Y120") — used by SET_SPEED/ACCEL/JOG
// Calls handler(char axis, float value) for each recognised token.
// =============================================================================
template <typename F>
inline void parse_axis_value_pairs(const char* args, F handler) {
  const char* p = args;
  while (*p) {
    while (*p == ' ') p++;
    if (*p == '\0') break;
    char axis = *p;
    if (axis >= 'a' && axis <= 'z') axis -= 32; // to upper
    float value = atof(p + 1);
    handler(axis, value);
    while (*p && *p != ' ') p++;
  }
}

// =============================================================================
// JSON parsing helpers
// =============================================================================
// Parse a JSON payload that starts somewhere in `args` (leading whitespace OK).
// Emits "ERR BAD_JSON" and returns false on parse failure.
inline bool parse_json_args(const char* args, JsonDocument& doc) {
  while (*args == ' ') args++;
  DeserializationError err = deserializeJson(doc, args);
  if (err) {
    Serial.print("ERR BAD_JSON ");
    Serial.println(err.c_str());
    return false;
  }
  return true;
}

// =============================================================================
// SETMOTION — atomic motion update
//
// Rev4.4 payload shape (preferred):
//   {
//     "fast": {"xSpeed":120, "ySpeed":120, "xAccel":500, "yAccel":500},
//     "cell": {"xSpeed":60,  "ySpeed":60,  "xAccel":250, "yAccel":250},
//     "dwellMs": 50,            // "Laser On Time" in the UI
//     "preWeldHoldMs": 0,       // Pi sleep after Z_DOWN, before FIRE
//     "postWeldHoldMs": 0,      // Pi sleep after FIRE, before Z_UP
//     "homeOnBoot": false
//   }
//
// Legacy flat shape (Rev4.2 and earlier) is still accepted for back-compat:
//   {"xSpeed":..., "ySpeed":..., "xAccel":..., "yAccel":..., "zDownDwell":..., "homeOnBoot":...}
// — flat values write to the fast profile only; cell profile is unchanged.
// =============================================================================
inline void cmd_setmotion(const char* args) {
  JsonDocument doc;
  if (!parse_json_args(args, doc)) return;

  bool any = false;

  // Nested fast profile
  JsonVariantConst fast = doc["fast"];
  if (!fast.isNull()) {
    if (fast["xSpeed"].is<float>()) { settings.speedX = fast["xSpeed"].as<float>(); axisX.speedMmS = settings.speedX; any = true; }
    if (fast["ySpeed"].is<float>()) { settings.speedY = fast["ySpeed"].as<float>(); axisYLeft.speedMmS = settings.speedY; axisYRight.speedMmS = settings.speedY; any = true; }
    if (fast["xAccel"].is<float>()) { settings.accelX = fast["xAccel"].as<float>(); axisX.accelMmS2 = settings.accelX; any = true; }
    if (fast["yAccel"].is<float>()) { settings.accelY = fast["yAccel"].as<float>(); axisYLeft.accelMmS2 = settings.accelY; axisYRight.accelMmS2 = settings.accelY; any = true; }
  }

  // Nested cell profile — not live-applied to axes because the active axis
  // speed/accel at any moment is whichever profile the last MOVE/JOG tagged.
  JsonVariantConst cell = doc["cell"];
  if (!cell.isNull()) {
    if (cell["xSpeed"].is<float>()) { settings.cellSpeedX = cell["xSpeed"].as<float>(); any = true; }
    if (cell["ySpeed"].is<float>()) { settings.cellSpeedY = cell["ySpeed"].as<float>(); any = true; }
    if (cell["xAccel"].is<float>()) { settings.cellAccelX = cell["xAccel"].as<float>(); any = true; }
    if (cell["yAccel"].is<float>()) { settings.cellAccelY = cell["yAccel"].as<float>(); any = true; }
  }

  // Legacy flat shape — maps onto the fast profile.
  if (doc["xSpeed"].is<float>())    { settings.speedX  = doc["xSpeed"].as<float>();  axisX.speedMmS  = settings.speedX; any = true; }
  if (doc["ySpeed"].is<float>())    { settings.speedY  = doc["ySpeed"].as<float>();  axisYLeft.speedMmS  = settings.speedY; axisYRight.speedMmS = settings.speedY; any = true; }
  if (doc["xAccel"].is<float>())    { settings.accelX  = doc["xAccel"].as<float>();  axisX.accelMmS2 = settings.accelX; any = true; }
  if (doc["yAccel"].is<float>())    { settings.accelY  = doc["yAccel"].as<float>();  axisYLeft.accelMmS2 = settings.accelY; axisYRight.accelMmS2 = settings.accelY; any = true; }

  if (doc["zDownDwell"].is<int>())  { settings.dwellMs = (uint32_t)doc["zDownDwell"].as<int>(); any = true; }
  // Also accept "dwellMs" alias
  if (doc["dwellMs"].is<int>())     { settings.dwellMs = (uint32_t)doc["dwellMs"].as<int>();    any = true; }
  // Rev4.4 — pneumatic hold durations the Pi orchestrator sleeps on. Firmware
  // just persists the values; the actual waits happen Pi-side between Z_DOWN
  // and FIRE (preWeldHoldMs) and between FIRE and Z_UP (postWeldHoldMs).
  if (doc["preWeldHoldMs"].is<int>())  { settings.preWeldHoldMs  = (uint32_t)doc["preWeldHoldMs"].as<int>();  any = true; }
  if (doc["postWeldHoldMs"].is<int>()) { settings.postWeldHoldMs = (uint32_t)doc["postWeldHoldMs"].as<int>(); any = true; }
  // homeOnBoot — bundled with other motion settings on the "Save" button
  if (doc["homeOnBoot"].is<bool>()) { settings.homeOnBoot = doc["homeOnBoot"].as<bool>() ? 1 : 0; any = true; }
  else if (doc["homeOnBoot"].is<int>()) { settings.homeOnBoot = doc["homeOnBoot"].as<int>() ? 1 : 0; any = true; }

  if (any) {
    settings_save();
    Serial.println("OK");
  } else {
    Serial.println("ERR NO_FIELDS");
  }
}

// =============================================================================
// Motion-profile helpers (Rev4.3)
//
// P=C switches the active axis speed/accel to the cell profile before a
// MOVE/JOG; P=F (or no P=) stays on the fast profile. The profile swap is
// sticky — the next MOVE/JOG will re-assert whichever profile it tags —
// so there's no post-command restore. The trapezoidal planner samples
// ax.speedMmS / ax.accelMmS2 at move-start, so switching BEFORE calling
// state_request_move/jog is sufficient.
// =============================================================================
inline void apply_fast_profile() {
  axisX.speedMmS       = settings.speedX;
  axisYLeft.speedMmS   = settings.speedY;
  axisYRight.speedMmS  = settings.speedY;
  axisX.accelMmS2      = settings.accelX;
  axisYLeft.accelMmS2  = settings.accelY;
  axisYRight.accelMmS2 = settings.accelY;
}

inline void apply_cell_profile() {
  axisX.speedMmS       = settings.cellSpeedX;
  axisYLeft.speedMmS   = settings.cellSpeedY;
  axisYRight.speedMmS  = settings.cellSpeedY;
  axisX.accelMmS2      = settings.cellAccelX;
  axisYLeft.accelMmS2  = settings.cellAccelY;
  axisYRight.accelMmS2 = settings.cellAccelY;
}

// Returns 'C' for cell, 'F' for fast (default). Consumes nothing — caller
// scans the command body for a P= token via this helper.
inline char parse_motion_profile(const char* args) {
  // Scan space-delimited tokens looking for P=<letter>
  const char* p = args;
  while (*p) {
    while (*p == ' ') p++;
    if (!*p) break;
    if ((p[0] == 'P' || p[0] == 'p') && p[1] == '=') {
      char c = p[2];
      if (c >= 'a' && c <= 'z') c -= 32;
      if (c == 'C') return 'C';
      return 'F';
    }
    // Skip this token
    while (*p && *p != ' ') p++;
  }
  return 'F';
}

// =============================================================================
// SET_TRAVEL {maxX, maxY} — soft limits (persisted)
// =============================================================================
inline void cmd_set_travel(const char* args) {
  JsonDocument doc;
  if (!parse_json_args(args, doc)) return;

  bool any = false;
  if (doc["maxX"].is<float>()) { settings.maxX = doc["maxX"].as<float>(); any = true; }
  if (doc["maxY"].is<float>()) { settings.maxY = doc["maxY"].as<float>(); any = true; }

  // Basic sanity — refuse non-positive limits
  if (settings.maxX <= 0.0f || settings.maxY <= 0.0f) {
    Serial.println("ERR BAD_LIMITS");
    // Don't persist nonsense
    return;
  }

  if (any) {
    settings_save();
    Serial.println("OK");
  } else {
    Serial.println("ERR NO_FIELDS");
  }
}

// =============================================================================
// LOADPOS {x, y} — parking position after HOME / between jobs (persisted)
// =============================================================================
inline void cmd_loadpos(const char* args) {
  JsonDocument doc;
  if (!parse_json_args(args, doc)) return;

  float x = doc["x"].is<float>() ? doc["x"].as<float>() : settings.loadPosX;
  float y = doc["y"].is<float>() ? doc["y"].as<float>() : settings.loadPosY;

  // Validate against current soft limits
  if (x < 0.0f || x > settings.maxX || y < 0.0f || y > settings.maxY) {
    Serial.println("ERR OUT_OF_RANGE");
    return;
  }

  settings.loadPosX = x;
  settings.loadPosY = y;
  settings_save();
  Serial.println("OK");
}

// =============================================================================
// RUN_START {totalCells, startIndex, programId, mode}
// =============================================================================
inline void cmd_run_start(const char* args) {
  if (machineState.state != STATE_IDLE) {
    Serial.println("BUSY");
    return;
  }
  if (!machineState.driversEnabled) {
    Serial.println("ERR DRIVERS_DISABLED");
    return;
  }

  JsonDocument doc;
  if (!parse_json_args(args, doc)) return;

  int      totalCells = doc["totalCells"].is<int>()       ? doc["totalCells"].as<int>()       : 0;
  int      startIndex = doc["startIndex"].is<int>()       ? doc["startIndex"].as<int>()       : 0;
  uint32_t programId  = doc["programId"].is<uint32_t>()   ? doc["programId"].as<uint32_t>()   : 0;
  const char* mode    = doc["mode"].is<const char*>()     ? doc["mode"].as<const char*>()     : "";

  if (totalCells <= 0) {
    Serial.println("ERR BAD_RUN");
    return;
  }

  machineState.state = STATE_WELDING;
  run_start(totalCells, startIndex, programId, mode);
  Serial.println("OK");
}

// =============================================================================
// RUN_CELL_DONE <idx> — Pi notifies us that a cell's MOVE→Z→FIRE→Z completed
// =============================================================================
inline void cmd_run_cell_done(const char* args) {
  int idx = atoi(args);
  run_cell_done(idx);
  Serial.println("OK");
}

// =============================================================================
// Dispatcher state
// =============================================================================
static char    _rxBuf[SERIAL_RX_BUF_SIZE];
static size_t  _rxIdx = 0;

// =============================================================================
// Case-insensitive string equality / prefix match
// =============================================================================
inline bool ci_equals(const char* a, const char* b) {
  while (*a && *b) {
    char ca = (*a >= 'a' && *a <= 'z') ? *a - 32 : *a;
    char cb = (*b >= 'a' && *b <= 'z') ? *b - 32 : *b;
    if (ca != cb) return false;
    a++; b++;
  }
  return *a == '\0' && *b == '\0';
}

inline bool ci_prefix(const char* s, const char* prefix) {
  while (*prefix) {
    char cs = (*s >= 'a' && *s <= 'z') ? *s - 32 : *s;
    char cp = (*prefix >= 'a' && *prefix <= 'z') ? *prefix - 32 : *prefix;
    if (cs != cp) return false;
    if (!*s) return false;
    s++; prefix++;
  }
  return true;
}

// =============================================================================
// Command dispatch
// =============================================================================
inline void serial_dispatch(const char* cmd) {
  // Strip leading whitespace
  while (*cmd == ' ') cmd++;
  if (!*cmd) return;

  // ---- PING / VERSION ----
  if (ci_equals(cmd, "PING")) {
    Serial.println("PONG");
    return;
  }
  if (ci_equals(cmd, "VERSION")) {
    Serial.println(FW_VERSION_STR);
    return;
  }

  // ---- STATUS / SNAPSHOT ----
  if (ci_equals(cmd, "STATUS") || ci_equals(cmd, "SNAPSHOT")) {
    send_status();
    return;
  }

  // ---- HOME ----
  if (ci_equals(cmd, "HOME")) {
    // Auto-clear a stale homing-timeout fault. Pressing HOME is the operator's
    // "try again" signal, so forcing them to hit CLEAR_FAULT first (and then
    // HOME) is pointless ceremony — and was the root cause of the "overlay
    // flashes then does nothing" bug after a first-attempt timeout.
    // Only this one fault code is auto-cleared; driver faults, E-stop, low-air
    // etc. still require the matching condition to resolve + an explicit
    // CLEAR_FAULT before HOME is re-armed.
    if (machineState.state == STATE_FAULT_LOCKOUT &&
        machineState.activeFault == FAULT_HOMING_TIMEOUT) {
      fault_clear();
    }
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
    return;
  }

  // ---- MOVE_CAL X<n> Y<n> ----
  // Calibration-only absolute MOVE that bypasses the z_safe() gate so the
  // Calibrate Start Position / Loading Position screens can jog the table
  // with Z either UP or DOWN. Always uses the fast motion profile — the
  // operator is nudging by hand, no cell-pattern semantics apply. Must be
  // matched BEFORE the "MOVE " prefix below, otherwise ci_prefix("MOVE ")
  // would swallow "MOVE_CAL " (the underscore isn't a space, but the
  // dispatcher walks command prefixes in order so getting this wrong would
  // route MOVE_CAL through the gated path).
  if (ci_prefix(cmd, "MOVE_CAL ")) {
    apply_fast_profile();
    float x = stepper_position_mm(axisX);
    float y = stepper_position_mm(axisYLeft);
    parse_axis_value_pairs(cmd + 9, [&](char ax, float v){
      if (ax == 'X') x = v;
      else if (ax == 'Y') y = v;
    });
    state_request_move_cal(x, y);
    return;
  }

  // ---- MOVE X<n> Y<n> [P=C|P=F] ----
  // P=C routes through the cell-to-cell motion profile (persisted as
  // cellSpeed*/cellAccel*). P=F or omitted uses the fast profile
  // (speed*/accel*). The Pi orchestrator tags every per-cell MOVE during a
  // RUN with P=C; all other MOVE commands (pre-move, park to loading
  // position, Test Motion screen, etc.) are implicitly fast.
  if (ci_prefix(cmd, "MOVE ")) {
    const char profile = parse_motion_profile(cmd + 5);
    if (profile == 'C') apply_cell_profile(); else apply_fast_profile();
    float x = stepper_position_mm(axisX);
    float y = stepper_position_mm(axisYLeft);
    parse_axis_value_pairs(cmd + 5, [&](char ax, float v){
      if (ax == 'X') x = v;
      else if (ax == 'Y') y = v;
    });
    state_request_move(x, y);
    return;
  }

  // ---- JOG X+1.0 / JOG Y-2.5 [P=C|P=F] ----
  // Same profile-select rules as MOVE — JOG is almost always fast in
  // practice, but honouring the tag here keeps MOVE and JOG behaviour
  // symmetrical and gives the UI one less place to drift out of sync.
  if (ci_prefix(cmd, "JOG ")) {
    const char* p = cmd + 4;
    const char profile = parse_motion_profile(p);
    if (profile == 'C') apply_cell_profile(); else apply_fast_profile();
    while (*p == ' ') p++;
    if (*p == 'X' || *p == 'x') {
      state_request_jog_x(atof(p + 1));
    } else if (*p == 'Y' || *p == 'y') {
      state_request_jog_y(atof(p + 1));
    } else {
      Serial.println("ERR UNKNOWN_AXIS");
    }
    return;
  }

  // ---- Z DOWN / Z_DOWN ----
  if (ci_equals(cmd, "Z_DOWN") || ci_equals(cmd, "Z DOWN")) {
    if (machineState.state == STATE_FAULT_LOCKOUT ||
        machineState.state == STATE_ESTOP ||
        machineState.state == STATE_PAUSED) {
      Serial.println("BUSY");
      return;
    }
    if (any_axis_moving()) { Serial.println("BUSY"); return; }
    z_down();
    Serial.println("OK");
    return;
  }

  // ---- Z UP / Z_UP ----
  if (ci_equals(cmd, "Z_UP") || ci_equals(cmd, "Z UP")) {
    if (machineState.state == STATE_FAULT_LOCKOUT ||
        machineState.state == STATE_ESTOP) {
      Serial.println("BUSY");
      return;
    }
    z_up();
    Serial.println("OK");
    return;
  }

  // ---- FIRE ----
  if (ci_equals(cmd, "FIRE")) {
    if (machineState.state == STATE_FAULT_LOCKOUT ||
        machineState.state == STATE_ESTOP ||
        machineState.state == STATE_PAUSED) {
      Serial.println("BUSY");
      return;
    }
    if (any_axis_moving()) { Serial.println("BUSY"); return; }
    laser_fire();
    return;
  }

  // ---- PAUSE / RESUME / ABORT / STOP ----
  if (ci_equals(cmd, "PAUSE")) {
    state_pause();
    Serial.println("OK");
    return;
  }
  if (ci_equals(cmd, "RESUME")) {
    state_resume();
    Serial.println("OK");
    return;
  }
  if (ci_equals(cmd, "ABORT") || ci_equals(cmd, "STOP")) {
    stepper_stop_all();
    // If we have a run going, wind it down before the USER_ABORT fault
    if (run_is_active()) run_abort();
    fault_trigger(USER_ABORT);
    Serial.println("OK");
    return;
  }

  // ---- RUN_* lifecycle ----
  if (ci_prefix(cmd, "RUN_START ") || ci_prefix(cmd, "RUN_START{")) {
    cmd_run_start(cmd + 9);
    return;
  }
  if (ci_equals(cmd, "RUN_PAUSE")) {
    run_pause();
    state_pause();
    Serial.println("OK");
    return;
  }
  if (ci_equals(cmd, "RUN_RESUME")) {
    run_resume();
    state_resume();
    Serial.println("OK");
    return;
  }
  if (ci_equals(cmd, "RUN_ABORT")) {
    // Capture whether motion was in flight BEFORE we slam state to IDLE.
    // If we were MOVING / WELDING, the orchestrator on the Pi is awaiting a
    // DONE for the current MOVE / Z. Forcing STATE_IDLE skips the edge
    // detector in state_update that would normally emit that DONE, so the
    // Pi's pending send() sits in the realSerial queue until the 60 s
    // MOTION_REPLY_TIMEOUT_MS. While that entry is stuck at the head of
    // the queue, every later OK reply (e.g. HOME's sync ack) gets swallowed
    // as if it were the in-flight MOVE's ack — leaving the operator with
    // an apparently-dead UI: motion stopped, can't move, can't home, until
    // a full reboot. Emit DONE here to resolve the pending entry cleanly.
    const bool wasInMotion = (machineState.state == STATE_MOVING ||
                              machineState.state == STATE_WELDING);
    // Suppress single-driver ALM faults for the next 300 ms. stepper_stop_all()
    // is an instant halt — the motors slam to zero and the CL57Y ALM lines
    // pulse for a few ms as their internal current loop saturates. Without
    // this grace window fault_check() picks the pulse up as
    // FAULT_DRIVER_X/YL/YR, the GUI reducer flags those as requiresHome=true
    // and zeroes `homed`, and the operator can't get the table back without
    // a re-home (or, in the worst case, a power cycle). The grace is set
    // BEFORE stepper_stop_all() so the very first fault_check() pass after
    // the stop sees an active grace window. E-stop detection (all 3 ALMs
    // simultaneously) is NOT suppressed — a real hardware E-stop during
    // the abort recovery still locks out properly.
    fault_set_abort_grace(300);
    stepper_stop_all();
    run_abort();
    machineState.state = STATE_IDLE;
    if (wasInMotion) Serial.println("DONE");
    Serial.println("OK");
    return;
  }
  if (ci_equals(cmd, "RUN_COMPLETE")) {
    run_complete();
    machineState.state = STATE_IDLE;
    Serial.println("OK");
    return;
  }
  if (ci_prefix(cmd, "RUN_CELL_DONE ")) {
    cmd_run_cell_done(cmd + 14);
    return;
  }

  // ---- RESUME_INCOMPLETE / DISCARD_INCOMPLETE (Pi-side persistence ack) ----
  // Firmware has no state.json — these are acknowledged for protocol symmetry.
  // The Pi has already made its decision; we just return OK so the backend
  // test harness can round-trip.
  if (ci_prefix(cmd, "RESUME_INCOMPLETE ")) {
    // Payload: rerun | continue | restart  — not acted on by firmware
    Serial.println("OK");
    return;
  }
  if (ci_equals(cmd, "DISCARD_INCOMPLETE")) {
    Serial.println("OK");
    return;
  }

  // ---- USB_LIST / USB_IMPORT / USB_EXPORT — Pi filesystem, Teensy no-op ----
  if (ci_equals(cmd, "USB_LIST") ||
      ci_prefix(cmd, "USB_IMPORT ") ||
      ci_prefix(cmd, "USB_EXPORT ")) {
    Serial.println("OK");
    return;
  }

  // ---- ENABLE / DISABLE ----
  if (ci_equals(cmd, "ENABLE")) {
    drivers_enable();
    machineState.driversEnabled = true;
    Serial.println("OK");
    return;
  }
  if (ci_equals(cmd, "DISABLE")) {
    drivers_disable();
    machineState.driversEnabled = false;
    Serial.println("OK");
    return;
  }

  // ---- SETMOTION {json} / SET_MOTION {json} (alias) ----
  if (ci_prefix(cmd, "SETMOTION ")  || ci_prefix(cmd, "SETMOTION{")  ||
      ci_prefix(cmd, "SET_MOTION ") || ci_prefix(cmd, "SET_MOTION{")) {
    const char* args = cmd + (strncmp(cmd, "SET_MOTION", 10) == 0 ? 10 : 9);
    cmd_setmotion(args);
    return;
  }

  // ---- SET_TRAVEL {json} ----
  if (ci_prefix(cmd, "SET_TRAVEL ") || ci_prefix(cmd, "SET_TRAVEL{")) {
    cmd_set_travel(cmd + 10);
    return;
  }

  // ---- LOADPOS {json} / SET_LOADPOS ----
  if (ci_prefix(cmd, "LOADPOS ")     || ci_prefix(cmd, "LOADPOS{") ||
      ci_prefix(cmd, "SET_LOADPOS ") || ci_prefix(cmd, "SET_LOADPOS{")) {
    const char* args = ci_prefix(cmd, "SET_LOADPOS") ? cmd + 11 : cmd + 7;
    cmd_loadpos(args);
    return;
  }

  // ---- Legacy SET_SPEED / SET_ACCEL (still supported) ----
  if (ci_prefix(cmd, "SET_SPEED ")) {
    parse_axis_value_pairs(cmd + 10, [](char ax, float v){
      if (ax == 'X') { settings.speedX = v; axisX.speedMmS = v; }
      else if (ax == 'Y') { settings.speedY = v; axisYLeft.speedMmS = v; axisYRight.speedMmS = v; }
    });
    settings_save();
    Serial.println("OK");
    return;
  }
  if (ci_prefix(cmd, "SET_ACCEL ")) {
    parse_axis_value_pairs(cmd + 10, [](char ax, float v){
      if (ax == 'X') { settings.accelX = v; axisX.accelMmS2 = v; }
      else if (ax == 'Y') { settings.accelY = v; axisYLeft.accelMmS2 = v; axisYRight.accelMmS2 = v; }
    });
    settings_save();
    Serial.println("OK");
    return;
  }

  // ---- SET_DWELL <ms> ----
  if (ci_prefix(cmd, "SET_DWELL ")) {
    settings.dwellMs = (uint32_t)atol(cmd + 10);
    settings_save();
    Serial.println("OK");
    return;
  }

  // ---- TRAM_PREVIEW <mm> ----
  // Live-preview the tramming offset: updates settings.tramOffset in RAM only
  // (no EEPROM write) and slews Y_RIGHT alone so the gantry visibly squares as
  // the operator taps ↑/↓ on the X-Axis Tramming screen. The Save button on
  // that screen calls SET_TRAM (below) to persist the final value. See
  // state_request_tram_preview() in state_machine.h.
  if (ci_prefix(cmd, "TRAM_PREVIEW ")) {
    float v = atof(cmd + 13);
    state_request_tram_preview(v);
    return;
  }

  // ---- SET_TRAM <mm> (legacy alias for gantry offset) ----
  if (ci_prefix(cmd, "SET_TRAM ") || ci_prefix(cmd, "SETGANTRYOFFSET ")) {
    const char* args = ci_prefix(cmd, "SETGANTRYOFFSET") ? cmd + 16 : cmd + 9;
    settings.tramOffset = atof(args);
    settings_save();
    Serial.println("OK");
    return;
  }

  // ---- SET_AIR_THRESHOLD <bar> ----
  if (ci_prefix(cmd, "SET_AIR_THRESHOLD ")) {
    settings.airThresholdBar = atof(cmd + 18);
    settings_save();
    Serial.println("OK");
    return;
  }

  // ---- SET_SOLENOID A|B|C  or  0|1|2 ----
  if (ci_prefix(cmd, "SET_SOLENOID ")) {
    const char* p = cmd + 13;
    while (*p == ' ') p++;
    uint8_t sel = 0xFF;
    if      (*p == 'A' || *p == 'a' || *p == '0') sel = 0;
    else if (*p == 'B' || *p == 'b' || *p == '1') sel = 1;
    else if (*p == 'C' || *p == 'c' || *p == '2') sel = 2;
    if (sel == 0xFF) {
      Serial.println("ERR BAD_SOLENOID");
      return;
    }
    settings.activeSolenoid = sel;
    settings_save();
    Serial.println("OK");
    return;
  }

  // ---- SET_HOME_ON_BOOT 0|1  (also accepts ON/OFF, TRUE/FALSE) ----
  // Firmware only stores / reports this flag. The Pi reads it via SNAPSHOT
  // after boot and decides whether to prompt or auto-HOME.
  if (ci_prefix(cmd, "SET_HOME_ON_BOOT ")) {
    const char* p = cmd + 17;
    while (*p == ' ') p++;
    uint8_t v = 0xFF;
    if      (*p == '1' || *p == 'T' || *p == 't' || *p == 'Y' || *p == 'y')   v = 1;
    else if (*p == '0' || *p == 'F' || *p == 'f' || *p == 'N' || *p == 'n')   v = 0;
    else if (ci_prefix(p, "ON"))  v = 1;
    else if (ci_prefix(p, "OFF")) v = 0;
    if (v == 0xFF) {
      Serial.println("ERR BAD_HOME_ON_BOOT");
      return;
    }
    settings.homeOnBoot = v;
    settings_save();
    Serial.println("OK");
    return;
  }

  // ---- SET_BENCH_MODE 0|1  (persisted) ----
  // When 1, homing completes each axis on the first sensor trigger and skips
  // the back-off + slow re-touch phase. Intended for bench testing with
  // manually actuated switches (no motors). Does not affect real homing when
  // disabled. Emitted in SNAPSHOT as BENCHMODE<0|1>.
  if (ci_prefix(cmd, "SET_BENCH_MODE ")) {
    const char* p = cmd + 15;
    while (*p == ' ') p++;
    uint8_t v = 0xFF;
    if      (*p == '1' || *p == 'T' || *p == 't' || *p == 'Y' || *p == 'y') v = 1;
    else if (*p == '0' || *p == 'F' || *p == 'f' || *p == 'N' || *p == 'n') v = 0;
    else if (ci_prefix(p, "ON"))  v = 1;
    else if (ci_prefix(p, "OFF")) v = 0;
    if (v == 0xFF) {
      Serial.println("ERR BAD_BENCH_MODE");
      return;
    }
    settings.benchMode = v;
    settings_save();
    Serial.println("OK");
    return;
  }

  // ---- SENSORS  (force immediate SENSORS event — useful for UI sync) ----
  if (ci_equals(cmd, "SENSORS")) {
    emit_sensors();
    return;
  }

  // ---- CLEAR_FAULT ----
  if (ci_equals(cmd, "CLEAR_FAULT")) {
    if (fault_clear()) Serial.println("OK");
    else               Serial.println("FAULT_STILL_ACTIVE");
    return;
  }

  // ---- Unknown command ----
  Serial.print("ERR UNKNOWN_CMD ");
  Serial.println(cmd);
}

// =============================================================================
// Pi↔Teensy link watchdog (Rev4.1)
// =============================================================================
// Dead-man timer. The Pi backend sends PING every ~LINK_HEARTBEAT_PI_MS; if
// the Teensy sees NO rx activity for LINK_TIMEOUT_MS while a run is active,
// we assume the Pi has crashed / been unplugged / gone out to lunch and
// trigger FAULT_LINK_LOST — which drops into the existing emergency_stop
// path, disabling drivers, cutting the laser, and de-energising Z solenoids.
//
// Gated on `run_is_active()` only. Homing / idle don't need the watchdog
// because the firmware is driving those phases autonomously — the Pi going
// silent during homing is harmless.
static uint32_t g_lastSerialRxMs = 0;

// Call once from setup() after Serial.begin(), so the watchdog doesn't fire
// on the first loop() pass before any real rx has happened.
inline void link_init() {
  g_lastSerialRxMs = millis();
}

// Call every loop() — after fault_check(), before state_update().
inline void link_check_tick() {
#if LINK_WATCHDOG_ENABLED
  if (!run_is_active()) return;
  if (machineState.activeFault != FAULT_NONE) return;  // already in a fault
  if ((uint32_t)(millis() - g_lastSerialRxMs) > LINK_TIMEOUT_MS) {
    fault_trigger(FAULT_LINK_LOST);
  }
#endif
}

// =============================================================================
// serial_process — call every loop() to read and dispatch incoming commands
// =============================================================================
inline void serial_process() {
  while (Serial.available()) {
    char c = Serial.read();
    g_lastSerialRxMs = millis();   // Any rx byte feeds the watchdog — PING,
                                   // partial command, noise, all count as
                                   // "Pi is still alive and talking to us".
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
      // If buffer overrun — silently discard up to next newline
    }
  }
}
