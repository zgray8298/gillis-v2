#pragma once
// =============================================================================
// stepper.h — Software step-generation with trapezoidal acceleration profile
// =============================================================================
// Each axis has an independent StepperAxis struct.
// stepper_run_all() is called every loop() iteration — no ISR needed on
// Teensy 4.1 at these speeds (<=200mm/s, 400 steps/mm = 80,000 steps/s max).
// At 600MHz CPU that's 7500 cycles per step — comfortably handled in loop().
// =============================================================================

#include <Arduino.h>
#include "config.h"
#include "pins.h"
#include "settings.h"

// =============================================================================
// StepperAxis struct
// =============================================================================
struct StepperAxis {
  // Hardware pins
  uint8_t pinStep;
  uint8_t pinDir;

  // Steps/mm conversion
  float stepsPerMm;

  // Current absolute position in steps
  long positionSteps;

  // Target position in steps
  long targetSteps;

  // Motion parameters
  float speedMmS;       // cruise speed mm/s
  float accelMmS2;      // acceleration mm/s²

  // Internal step-generation state
  float currentSpeedStepsS;  // current speed in steps/s
  float maxSpeedStepsS;      // cruise speed in steps/s
  float accelStepsS2;        // accel in steps/s²
  long  stepsToTarget;       // total steps remaining
  long  stepsAccel;          // steps spent accelerating
  long  stepsDone;           // steps completed this move

  uint32_t lastStepUs;       // micros() at last step
  uint32_t stepIntervalUs;   // current interval between steps in µs

  bool  moving;
  bool  dirPositive;
  bool  homingActive;
};

extern StepperAxis axisX;
extern StepperAxis axisYLeft;
extern StepperAxis axisYRight;

// =============================================================================
// Initialise axis structs
// =============================================================================
inline void stepper_init_axis(StepperAxis &ax, uint8_t stepPin, uint8_t dirPin, float stepsPerMm) {
  ax.pinStep       = stepPin;
  ax.pinDir        = dirPin;
  ax.stepsPerMm    = stepsPerMm;
  ax.positionSteps = 0;
  ax.targetSteps   = 0;
  ax.moving        = false;
  ax.homingActive  = false;
  ax.currentSpeedStepsS = 0;
  ax.stepIntervalUs     = 0;
  ax.lastStepUs         = 0;
  ax.stepsDone          = 0;
  ax.stepsAccel         = 0;
}

inline void stepper_init_all() {
  stepper_init_axis(axisX,      PIN_X_STEP,  PIN_X_DIR,  STEPS_PER_MM_X);
  stepper_init_axis(axisYLeft,  PIN_YL_STEP, PIN_YL_DIR, STEPS_PER_MM_Y);
  stepper_init_axis(axisYRight, PIN_YR_STEP, PIN_YR_DIR, STEPS_PER_MM_Y);

  axisX.speedMmS      = settings.speedX;
  axisX.accelMmS2     = settings.accelX;
  axisYLeft.speedMmS  = settings.speedY;
  axisYLeft.accelMmS2 = settings.accelY;
  axisYRight.speedMmS = settings.speedY;
  axisYRight.accelMmS2= settings.accelY;
}

// =============================================================================
// Begin a move: set target in mm (absolute)
// =============================================================================
inline void stepper_move_to_mm(StepperAxis &ax, float targetMm) {
  long targetSteps = (long)(targetMm * ax.stepsPerMm);
  long delta = targetSteps - ax.positionSteps;
  if (delta == 0) return;

  ax.targetSteps         = targetSteps;
  ax.dirPositive         = (delta > 0);
  ax.stepsToTarget       = abs(delta);
  ax.stepsDone           = 0;
  ax.currentSpeedStepsS  = 100.0f; // start speed (steps/s) — avoids divide-by-zero
  ax.maxSpeedStepsS      = ax.speedMmS * ax.stepsPerMm;
  ax.accelStepsS2        = ax.accelMmS2 * ax.stepsPerMm;
  // Steps needed to reach full speed: v²/(2a)
  ax.stepsAccel          = (long)((ax.maxSpeedStepsS * ax.maxSpeedStepsS) / (2.0f * ax.accelStepsS2));
  ax.stepIntervalUs      = (uint32_t)(1000000.0f / ax.currentSpeedStepsS);
  ax.lastStepUs          = micros();
  ax.moving              = true;

  // Set direction pin
  digitalWrite(ax.pinDir, ax.dirPositive ? HIGH : LOW);
  delayMicroseconds(2); // direction setup time
}

// =============================================================================
// Begin a relative jog move (mm)
// =============================================================================
inline void stepper_jog_mm(StepperAxis &ax, float deltaMm) {
  float currentMm = (float)ax.positionSteps / ax.stepsPerMm;
  stepper_move_to_mm(ax, currentMm + deltaMm);
}

// =============================================================================
// Immediate stop — hold position
// =============================================================================
inline void stepper_stop(StepperAxis &ax) {
  ax.moving            = false;
  ax.homingActive      = false;
  ax.currentSpeedStepsS = 0;
}

inline void stepper_stop_all() {
  stepper_stop(axisX);
  stepper_stop(axisYLeft);
  stepper_stop(axisYRight);
}

// =============================================================================
// Enable / disable all drivers (shared pin)
// =============================================================================
inline void drivers_enable()  { digitalWrite(PIN_ALL_ENABLE, LOW);  }
inline void drivers_disable() { digitalWrite(PIN_ALL_ENABLE, HIGH); }

// =============================================================================
// Run one axis — call every loop()
// Trapezoidal profile: accelerate → cruise → decelerate
// =============================================================================
inline void stepper_run_axis(StepperAxis &ax) {
  if (!ax.moving) return;

  uint32_t now = micros();
  uint32_t elapsed = now - ax.lastStepUs;
  if (elapsed < ax.stepIntervalUs) return;

  // Check if done
  long remaining = ax.stepsToTarget - ax.stepsDone;
  if (remaining <= 0) {
    ax.positionSteps = ax.targetSteps;
    ax.moving        = false;
    ax.currentSpeedStepsS = 0;
    return;
  }

  // Trapezoidal speed control
  float dt = (float)elapsed / 1000000.0f;

  // Determine if we should decelerate: remaining steps ≤ steps needed to stop
  long stepsToStop = (long)(ax.currentSpeedStepsS * ax.currentSpeedStepsS / (2.0f * ax.accelStepsS2));

  if (remaining <= stepsToStop) {
    // Decelerate
    ax.currentSpeedStepsS -= ax.accelStepsS2 * dt;
    if (ax.currentSpeedStepsS < 100.0f) ax.currentSpeedStepsS = 100.0f;
  } else if (ax.currentSpeedStepsS < ax.maxSpeedStepsS) {
    // Accelerate
    ax.currentSpeedStepsS += ax.accelStepsS2 * dt;
    if (ax.currentSpeedStepsS > ax.maxSpeedStepsS)
      ax.currentSpeedStepsS = ax.maxSpeedStepsS;
  }

  ax.stepIntervalUs = (uint32_t)(1000000.0f / ax.currentSpeedStepsS);

  // Fire step pulse
  digitalWrite(ax.pinStep, HIGH);
  delayMicroseconds(STEP_PULSE_US);
  digitalWrite(ax.pinStep, LOW);

  // Update position
  ax.positionSteps += ax.dirPositive ? 1 : -1;
  ax.stepsDone++;
  ax.lastStepUs = now;
}

inline void stepper_run_all() {
  stepper_run_axis(axisX);
  stepper_run_axis(axisYLeft);
  stepper_run_axis(axisYRight);
}

// =============================================================================
// Utility
// =============================================================================
inline bool stepper_is_moving(StepperAxis &ax) { return ax.moving; }

inline bool any_axis_moving() {
  return axisX.moving || axisYLeft.moving || axisYRight.moving;
}

inline float stepper_position_mm(StepperAxis &ax) {
  return (float)ax.positionSteps / ax.stepsPerMm;
}

inline void stepper_set_position_mm(StepperAxis &ax, float mm) {
  ax.positionSteps = (long)(mm * ax.stepsPerMm);
  ax.targetSteps   = ax.positionSteps;
}
