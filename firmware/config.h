#pragma once
// =============================================================================
// config.h — Machine configuration constants for Gillis V2.0
// =============================================================================

// --- Stepper mechanics -------------------------------------------------------
// Motor: 23HS40-5004D  1.8°/step = 200 full steps/rev
// CL57Y driver microstepping — set DIP switches on driver.
// Default: 16 microsteps → 3200 steps/rev
#define MICROSTEPS              16
#define FULL_STEPS_PER_REV      200
#define STEPS_PER_REV           (FULL_STEPS_PER_REV * MICROSTEPS)  // 3200

// Lead screw / belt pitch (mm per revolution) — update to match hardware
// Placeholder: 8mm/rev (common T8 lead screw). Measure and confirm.
#define MM_PER_REV_X            8.0f
#define MM_PER_REV_Y            8.0f

#define STEPS_PER_MM_X          ((float)STEPS_PER_REV / MM_PER_REV_X)   // 400
#define STEPS_PER_MM_Y          ((float)STEPS_PER_REV / MM_PER_REV_Y)   // 400

// --- Travel limits (mm) ------------------------------------------------------
#define AXIS_X_MAX_MM           400.0f   // Update to measured travel
#define AXIS_Y_MAX_MM           300.0f   // Update to measured travel

// --- Homing ------------------------------------------------------------------
// Homing search speed (mm/s) and backoff distance (mm)
#define HOMING_SPEED_MM_S       20.0f
#define HOMING_BACKOFF_MM       5.0f
#define HOMING_SLOW_SPEED_MM_S  5.0f

// Homing direction: LOW = move towards home sensor (negative direction)
// Set HIGH if your home sensor is at the positive end of travel
#define HOME_DIR_X              LOW
#define HOME_DIR_Y              LOW

// --- Default motion parameters -----------------------------------------------
#define DEFAULT_SPEED_X_MM_S    120.0f
#define DEFAULT_SPEED_Y_MM_S    120.0f
#define DEFAULT_ACCEL_X_MM_S2   500.0f
#define DEFAULT_ACCEL_Y_MM_S2   500.0f

// --- Z solenoid timeouts (ms) ------------------------------------------------
#define Z_TIMEOUT_DOWN_MS       2000
#define Z_TIMEOUT_UP_MS         2000

// --- Laser -------------------------------------------------------------------
#define DEFAULT_DWELL_MS        50

// --- Air pressure ------------------------------------------------------------
// ADC: 12-bit (0–4095), Vref = 3.3V
// Sensor: 5V → voltage divider 10kΩ/20kΩ → 3.3V max at full scale
// Sensor range: 0–10 bar (typical), 0–5V output → map to bar
// ADC counts per bar: depends on sensor — adjust SENSOR_BAR_PER_VOLT
#define AIR_ADC_VREF            3.3f
#define AIR_ADC_MAX             4095
#define AIR_SENSOR_MAX_VOLT     5.0f    // Sensor full-scale output voltage
#define AIR_DIVIDER_RATIO       (20.0f / (10.0f + 20.0f))  // 0.6667 (10k/20k divider)
#define AIR_SENSOR_RANGE_BAR    10.0f   // Sensor full-scale range in bar
// Converted ADC reading to bar:
//   measured_V = (adc / 4095) * 3.3
//   sensor_V   = measured_V / DIVIDER_RATIO
//   bar        = (sensor_V / AIR_SENSOR_MAX_VOLT) * AIR_SENSOR_RANGE_BAR
#define DEFAULT_AIR_THRESHOLD_BAR  4.1f  // ~60 PSI

// --- Air pressure polling interval ------------------------------------------
#define AIR_POLL_INTERVAL_MS    500

// --- ALM debounce ------------------------------------------------------------
#define ALM_DEBOUNCE_MS         20

// --- Step pulse width (µs) ---------------------------------------------------
// CL57Y requires min ~2.5µs — use 5µs for safety
#define STEP_PULSE_US           5

// --- EEPROM addresses --------------------------------------------------------
#define EEPROM_MAGIC_ADDR       0       // 4 bytes
#define EEPROM_MAGIC_VALUE      0xCA1ACED  // Signature to detect valid data
#define EEPROM_SETTINGS_ADDR    4       // Settings struct starts here

// --- Serial ------------------------------------------------------------------
#define SERIAL_BAUD             115200
#define SERIAL_RX_BUF_SIZE      128
