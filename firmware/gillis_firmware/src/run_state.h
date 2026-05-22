#pragma once
// =============================================================================
// run_state.h — RUN lifecycle tracking (Rev4, Pi-driven cell loop)
// =============================================================================
// Per master plan §8 phase 12 + firmware conventions:
//   the Raspberry Pi backend drives the per-cell MOVE→Z_DOWN→FIRE→Z_UP loop.
//   The Teensy is told "a run has started" so it can:
//     * Tag fault emissions with `cellIndex=N`
//     * Emit `RUN phase=cell idx=N` telemetry when the Pi reports cell completion
//     * Know whether PAUSE/RESUME should affect a run vs a one-off motion
// We do NOT store per-cell coordinates here — they live in Pi-side JSON.
// =============================================================================

#include <Arduino.h>

struct RunState {
  bool     active;            // run in progress (includes paused)
  bool     paused;            // RUN_PAUSE received, waiting for RUN_RESUME
  int      currentCellIndex;  // 0-based index of cell Pi is currently executing
  int      totalCells;        // reported by Pi at RUN_START (for phase=done calc)
  uint32_t programId;         // opaque id echoed in RUN phase events
  char     mode[8];           // e.g. "SPOT", "SEAM" — echoed but not interpreted
};

static RunState _run = { false, false, -1, 0, 0, "" };

// =============================================================================
// Public helpers used by fault_handler (declared extern there)
// =============================================================================
inline bool run_is_active()            { return _run.active; }
inline int  run_current_cell_index()   { return _run.currentCellIndex; }
inline bool run_is_paused()            { return _run.active && _run.paused; }

// =============================================================================
// Start a run — called from RUN_START handler
// =============================================================================
inline void run_start(int totalCells, int startIndex, uint32_t programId, const char* mode) {
  _run.active           = true;
  _run.paused           = false;
  _run.currentCellIndex = startIndex;
  _run.totalCells       = totalCells;
  _run.programId        = programId;
  strncpy(_run.mode, mode ? mode : "", sizeof(_run.mode) - 1);
  _run.mode[sizeof(_run.mode) - 1] = '\0';

  Serial.print("RUN phase=started programId=");
  Serial.print(_run.programId);
  Serial.print(" totalCells=");
  Serial.print(_run.totalCells);
  Serial.print(" startIndex=");
  Serial.print(_run.currentCellIndex);
  if (_run.mode[0]) {
    Serial.print(" mode=");
    Serial.print(_run.mode);
  }
  Serial.println();
}

// =============================================================================
// RUN_CELL_DONE <n> — Pi notifies that cell n has completed its weld cycle.
// Emit a phase=cell event and advance the index for the next one.
// =============================================================================
inline void run_cell_done(int idx) {
  if (!_run.active) return;
  _run.currentCellIndex = idx;
  Serial.print("RUN phase=cell idx=");
  Serial.println(idx);
}

// =============================================================================
// Pause / resume
// =============================================================================
inline void run_pause() {
  if (!_run.active) return;
  _run.paused = true;
  Serial.println("RUN phase=paused");
}

inline void run_resume() {
  if (!_run.active) return;
  _run.paused = false;
  Serial.println("RUN phase=resumed");
}

// =============================================================================
// Abort — immediate stop, clear run state (lets Pi drop out of WELDING)
// =============================================================================
inline void run_abort() {
  if (!_run.active) return;
  Serial.print("RUN phase=aborted idx=");
  Serial.println(_run.currentCellIndex);
  _run.active           = false;
  _run.paused           = false;
  _run.currentCellIndex = -1;
  _run.totalCells       = 0;
  _run.programId        = 0;
  _run.mode[0]          = '\0';
}

// =============================================================================
// Normal completion — called when Pi sends RUN_COMPLETE (all cells done)
// =============================================================================
inline void run_complete() {
  if (!_run.active) return;
  Serial.print("RUN phase=done totalCells=");
  Serial.println(_run.totalCells);
  _run.active           = false;
  _run.paused           = false;
  _run.currentCellIndex = -1;
  _run.totalCells       = 0;
  _run.programId        = 0;
  _run.mode[0]          = '\0';
}

// =============================================================================
// Snapshot of the run context (used by SNAPSHOT response)
// =============================================================================
inline void run_print_status_fragment() {
  Serial.print(" RUN ");
  if (!_run.active) {
    Serial.print("inactive");
    return;
  }
  Serial.print(_run.paused ? "paused" : "active");
  Serial.print(" cell=");
  Serial.print(_run.currentCellIndex);
  Serial.print("/");
  Serial.print(_run.totalCells);
  Serial.print(" programId=");
  Serial.print(_run.programId);
}
