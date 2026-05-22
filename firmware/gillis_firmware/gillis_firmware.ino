// =============================================================================
// GILLIS V2.0 — Teensy 4.1 Motion Controller Firmware (Rev4)
// =============================================================================
// Revision: 2.0.0-rev4  |  April 2026
//
// Hardware:
//   - Teensy 4.1 (600MHz ARM Cortex-M7)
//   - 3x CL57Y closed-loop stepper drivers (X, Y_LEFT, Y_RIGHT)
//   - 5x RS PRO optical PNP 24V sensors (X_HOME, Y_LEFT_HOME, Y_RIGHT_HOME, Z_UP, Z_DOWN)
//   - 3x CL57Y ALM outputs (fault / E-stop detection)
//   - 4-channel relay board (Z A, laser, Z B, Z C)
//   - 5V analogue air pressure sensor (voltage-divided to 3.3V)
//   - USB CDC to Raspberry Pi 4 (no extra pins — native USB)
//
// Communication:
//   - USB CDC Serial @ 115200 baud
//   - Plain text command/response protocol (newline terminated)
//   - JSON payloads for SETMOTION / SET_TRAVEL / LOADPOS / RUN_START
//
// Library dependency:
//   - ArduinoJson v7 (Library Manager → "ArduinoJson" by Benoit Blanchon)
//
// Build:
//   - Arduino IDE with Teensyduino addon
//   - Board: Teensy 4.1
//   - USB Type: Serial
//   - CPU Speed: 600MHz
//   - Optimize: Faster (O2)
// =============================================================================

#include <Arduino.h>
#include <EEPROM.h>
#include <ArduinoJson.h>

// Include order matters — dependencies first
#include "src/config.h"
#include "src/pins.h"
#include "src/settings.h"
#include "src/sensors.h"
#include "src/stepper.h"
#include "src/fault_handler.h"
#include "src/run_state.h"
#include "src/homing.h"
#include "src/z_control.h"
#include "src/state_machine.h"
#include "src/telemetry.h"
#include "src/serial_protocol.h"

// =============================================================================
// Global definitions — all extern'd in headers
// =============================================================================
MachineState machineState;
StepperAxis  axisX;
StepperAxis  axisYLeft;
StepperAxis  axisYRight;
Settings     settings;
SensorState  sensors;

// =============================================================================
// setup()
// =============================================================================
void setup() {
  // USB CDC serial — Pi connection
  Serial.begin(SERIAL_BAUD);

  // Brief wait for USB enumeration on host side
  delay(500);

  // Configure all GPIO
  pins_init();

  // Load settings from EEPROM (defaults on first boot or layout change)
  settings_load();

  // Initialise stepper axes with loaded settings
  stepper_init_all();

  // Initialise sensor state and take initial ADC reading
  sensors_init();

  // Initialise state machine and fault handler
  state_init();
  fault_init();

  // Prime the Pi↔Teensy link watchdog (Rev4.1) — so the dead-man timer
  // doesn't fire on the first loop() before any real rx has happened.
  link_init();

  // Ready
  Serial.println("GILLIS_READY");
  Serial.println(FW_VERSION_STR);
}

// =============================================================================
// loop()
// =============================================================================
void loop() {
  // 1. Read and dispatch incoming serial commands from Pi
  serial_process();

  // 2. Run software step-generation engine (all three axes)
  stepper_run_all();

  // 3. Update sensor readings (digital + ADC)
  sensors_update();

  // 4. Check fault conditions (ALMs, air pressure) — emits auto-clear events
  fault_check();

  // 4b. Pi↔Teensy link watchdog (Rev4.1) — fault if Pi goes silent mid-RUN.
  //     Must run AFTER fault_check so a pre-existing fault takes priority.
  link_check_tick();

  // 5. Update Z solenoid state machine (timeout detection)
  z_update();

  // 6. Update homing state machine (self-gates if idle)
  homing_update();

  // 7. Update main machine state machine
  state_update();

  // 8. Emit periodic POSITION / AIR telemetry (Rev4)
  telemetry_update();

  // 9. Heartbeat — toggle the on-board LED (pin 13) at 1 Hz so the firmware
  //    has a visible "I'm alive" indicator. If this LED stops blinking, the
  //    firmware has hung or reset; the orange power LED on the same board
  //    indicates only that the 3.3 V rail is up, not that code is running.
  //    Added 2026-05-13 (Rev4.16) after the back-EMF + strand-bridge incident
  //    where having a heartbeat would have made damage diagnosis much faster.
  static uint32_t lastHeartbeat = 0;
  if (millis() - lastHeartbeat >= 500) {
    lastHeartbeat = millis();
    digitalToggleFast(LED_BUILTIN);
  }
}
