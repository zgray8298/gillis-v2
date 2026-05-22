#pragma once
// =============================================================================
// config.h — Machine configuration constants for Gillis V2.0 (Rev4 firmware)
// =============================================================================

// --- Firmware version --------------------------------------------------------
#define FW_VERSION_STR           "gillis-teensy-fw 2.0.0-rev4.4"

// --- Stepper mechanics -------------------------------------------------------
// Motor: 23HS40-5004D  1.8°/step = 200 full steps/rev
// CL57Y driver microstepping — set DIP switches on driver.
// Default: 16 microsteps → 3200 steps/rev
#define MICROSTEPS              16
#define FULL_STEPS_PER_REV      200
#define STEPS_PER_REV           (FULL_STEPS_PER_REV * MICROSTEPS)  // 3200

// Lead screw pitch (mm per revolution) — matches installed hardware.
// Gillis V2 uses 5mm-pitch ballscrews on both X and Y.
// 200 full steps/rev × 16 microsteps = 3200 steps/rev
// 3200 steps/rev ÷ 5 mm/rev = 640 steps/mm
#define MM_PER_REV_X            5.0f
#define MM_PER_REV_Y            5.0f

#define STEPS_PER_MM_X          ((float)STEPS_PER_REV / MM_PER_REV_X)   // 640
#define STEPS_PER_MM_Y          ((float)STEPS_PER_REV / MM_PER_REV_Y)   // 640

// --- Travel limits (mm) — DEFAULTS; live values kept in Settings --------------
// These are the factory defaults used on first boot. Live values are
// persisted in Settings.maxX / Settings.maxY and are updated by SET_TRAVEL.
#define DEFAULT_AXIS_X_MAX_MM   340.0f   // Measured X travel (Rev4 onsite, May 2026)
#define DEFAULT_AXIS_Y_MAX_MM   590.0f   // Measured Y travel (Rev4 onsite, May 2026)

// --- Homing ------------------------------------------------------------------
// Initial-touch homing speed. Optical (U-style) home sensors have no impact
// concern, but the backoff reversal still loads the frame momentarily —
// operator-tuned to 40 mm/s for a calmer feel (60 was still uncomfortable
// on reversal). Original 20 mm/s was too slow to be useful. Slow re-touch
// (HOMING_SLOW_SPEED_MM_S below) stays at 5 mm/s so final position
// accuracy is untouched.
#define HOMING_SPEED_MM_S       40.0f
#define HOMING_BACKOFF_MM       5.0f
// Slow re-touch speed after backoff — DO NOT raise. Final home accuracy
// depends on this being slow enough that the sensor edge is sampled cleanly.
#define HOMING_SLOW_SPEED_MM_S  5.0f

// Homing direction: LOW = move towards home sensor (negative direction)
// Set HIGH if your home sensor is at the positive end of travel
#define HOME_DIR_X              LOW
#define HOME_DIR_Y              LOW

// After Y homes, gantry advances this far in +Y before X begins homing.
// This was a mechanical clearance step to keep the Y carriage clear of the
// X-home hardstop / sensor region. Set to 0 onsite (May 2026) — tested in
// place and confirmed there's no collision risk between Y-home position
// and X-homing travel on the assembled machine. The HOMING_Y_ADVANCE state
// will still run, but stepper_jog_mm(axis, 0) short-circuits immediately
// so the state transitions straight through to HOMING_X_FAST.
// Sequence:  Y fast → Y back-off → Y slow → (Y ADVANCE 0mm, no-op) → X fast → ...
#define HOMING_Y_ADVANCE_MM     0.0f

// --- Default motion parameters -----------------------------------------------
// Two profiles persisted independently (Rev4.3):
//   - "fast"  = every non-run motion: pre-move to start position, post-run
//               park to loading position, JOG, Test Motion screen moves,
//               and anywhere else in the codebase that doesn't explicitly
//               tag the command with P=C. Tuned for operator convenience —
//               crosses the table quickly.
//   - "cell"  = cell-to-cell motion DURING a run. Tagged with `P=C` by the
//               Pi orchestrator on each per-cell MOVE. Typically slower /
//               lower-accel than the fast profile so that the table settles
//               precisely over the next weld point without overshoot.
#define DEFAULT_SPEED_X_MM_S    120.0f
#define DEFAULT_SPEED_Y_MM_S    120.0f
#define DEFAULT_ACCEL_X_MM_S2   500.0f
#define DEFAULT_ACCEL_Y_MM_S2   500.0f
#define DEFAULT_CELL_SPEED_X_MM_S   60.0f
#define DEFAULT_CELL_SPEED_Y_MM_S   60.0f
#define DEFAULT_CELL_ACCEL_X_MM_S2  250.0f
#define DEFAULT_CELL_ACCEL_Y_MM_S2  250.0f

// --- Z solenoid timeouts (ms) ------------------------------------------------
#define Z_TIMEOUT_DOWN_MS       2000
#define Z_TIMEOUT_UP_MS         2000

// --- Laser -------------------------------------------------------------------
// DEFAULT_DWELL_MS = how long the laser relay stays energised during FIRE
// (a.k.a. "Laser On Time" in the UI).
#define DEFAULT_DWELL_MS        50

// --- Weld-cycle pneumatic holds (Rev4.4) ------------------------------------
// The Pi orchestrator's per-cell sequence is:
//   MOVE → Z_DOWN → (preWeldHoldMs) → FIRE → (postWeldHoldMs) → Z_UP
// These two holds give the pneumatic Z solenoid time to fully compress
// before the laser fires, and give the weld a brief settle / clamp-pressure
// period after firing before Z retracts. Default both to 0 so existing
// installations see no behaviour change until the operator tunes them.
#define DEFAULT_PRE_WELD_HOLD_MS    0
#define DEFAULT_POST_WELD_HOLD_MS   0

// --- Active weld head / solenoid channel -------------------------------------
// 0 = Head A (ch1), 1 = Head B (ch3), 2 = Head C (ch4). Persisted in Settings.
#define DEFAULT_ACTIVE_SOLENOID 0

// --- Air pressure ------------------------------------------------------------
// ADC: 12-bit (0–4095), Vref = 3.3V
// Sensor: 5V → voltage divider 10kΩ/20kΩ → 3.3V max at full scale
#define AIR_ADC_VREF            3.3f
#define AIR_ADC_MAX             4095
#define AIR_SENSOR_MAX_VOLT     5.0f
#define AIR_DIVIDER_RATIO       (20.0f / (10.0f + 20.0f))  // 0.6667
#define AIR_SENSOR_RANGE_BAR    10.0f
#define DEFAULT_AIR_THRESHOLD_BAR  4.1f  // ~60 PSI

// --- Air pressure polling interval ------------------------------------------
#define AIR_POLL_INTERVAL_MS    500

// --- ALM debounce ------------------------------------------------------------
// Bumped 20 → 100 (2026-05-05) as a temporary EMI mitigation while flyback
// diodes are being installed across the Heschen Z solenoids. The DIN 43650
// connectors on the current solenoids are LED-only (no integrated flyback
// diode), so coil collapse spits a fast transient that couples directly into
// the Teensy chip and trips a random per-driver ALM even with the opto-board
// inputs disconnected. The transient is microseconds wide, so a 100 ms
// debounce filters it without making a real driver fault feel sluggish (a
// stalled motor has no chance of doing damage in 100 ms). Drop back to 20
// once 1N4007s are fitted across each coil.
#define ALM_DEBOUNCE_MS         100

// --- Step pulse width (µs) ---------------------------------------------------
// CL57Y requires min ~2.5µs — use 5µs for safety
#define STEP_PULSE_US           5

// --- Telemetry cadence (ms) --------------------------------------------------
// POSITION events emitted at this rate while any axis is moving OR state≠IDLE.
#define POSITION_EVENT_INTERVAL_MS   100
// AIR events emitted always at this rate — lets UI gauge react to compressor dropouts.
#define AIR_EVENT_INTERVAL_MS        500
// SENSORS events emitted at this rate AND immediately on any edge-change.
// Used by the "Test Motion" screen to verify limit switches before homing.
#define SENSORS_EVENT_INTERVAL_MS    250

// --- EEPROM addresses --------------------------------------------------------
#define EEPROM_MAGIC_ADDR       0       // 4 bytes
// MAGIC VALUE — bump whenever the Settings struct layout changes so the Teensy
// re-initialises to defaults rather than reading stale bytes of wrong size.
#define EEPROM_MAGIC_VALUE      0xCA1AC4D5  // Rev4.4 — Settings gained preWeldHoldMs + postWeldHoldMs (was 0xCA1AC4D4)
#define EEPROM_SETTINGS_ADDR    4       // Settings struct starts here

// --- Serial ------------------------------------------------------------------
#define SERIAL_BAUD             115200
#define SERIAL_RX_BUF_SIZE      512     // Bumped from 128 — Rev4 JSON payloads are larger

// --- Pi↔Teensy link watchdog (Rev4.1) ---------------------------------------
// Dead-man timer. The Pi backend sends PING every ~LINK_HEARTBEAT_PI_MS; if
// the Teensy sees no rx activity for LINK_TIMEOUT_MS *while a run is active*,
// it triggers FAULT_LINK_LOST and drops into emergency_stop_outputs(). Gate is
// `run_is_active()` only — homing and idle do not need the watchdog because
// the Pi isn't driving the machine step-by-step in those states.
#define LINK_WATCHDOG_ENABLED   1
#define LINK_TIMEOUT_MS         2000    // Fault if no rx byte for this long during RUN
// Informational — the Pi aims to send a PING every ~500ms while the port is open.
#define LINK_HEARTBEAT_PI_MS    500
