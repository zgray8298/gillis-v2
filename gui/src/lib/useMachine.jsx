// React context that owns one MachineClient for the whole app.
// Components subscribe to only the slice of state they care about
// to avoid needless re-renders.

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createMachineClient } from './machine.js';

const MachineContext = createContext(null);

const INITIAL_STATE = {
  connected: false,
  homed: false,
  busy: false,
  // Single source of truth for "a homing cycle is currently in progress".
  // Driven by the firmware's homing:start / homing:done events (synthesised
  // in realSerial.js) and consumed by the various Home buttons / overlays.
  // Centralising this here removes the race conditions we hit when each
  // screen kept its own local `homing` useState.
  homing: false,
  position: { x: 0, y: 0, z: 'UP' },
  airPressureBar: 6.0,
  airThresholdBar: 4.1,       // §3.4 default (≈ 60 PSI)
  travelLimits: { maxX: 340, maxY: 590 }, // soft envelope, EEPROM-backed — matches firmware config.h DEFAULT_AXIS_*_MAX_MM
  laser: 'OFF',
  health: { teensy: 'Disconnected', drivers: 'Unknown', air: 'Unknown' },
  runtime: { machineHours: 0, sessionHours: 0 },
  // Rev4.3: two motion profiles. Unprefixed tuple = "fast" (every motion
  // outside a RUN — pre-move to start, park to loading, JOG, Test Motion).
  // cell* tuple = "cell-to-cell" profile, used only during a running
  // program. Both persist in Teensy EEPROM via SETMOTION.
  motionSettings: {
    xSpeed: 120, ySpeed: 120, xAccel: 500, yAccel: 500,
    cellXSpeed: 60, cellYSpeed: 60, cellXAccel: 250, cellYAccel: 250,
    // zDownDwell is the legacy key for the laser-relay energised duration.
    // The UI now calls this "Laser On Time (ms)" but the wire key stays so
    // the firmware SETMOTION handler's `zDownDwell` / `dwellMs` aliases keep
    // working across mixed firmware versions.
    zDownDwell: 50,
    // Rev4.4 — pneumatic hold durations bracketing the FIRE pulse.
    // preWeldHoldMs runs between Z_DOWN and FIRE (lets the solenoid fully
    // compress the head); postWeldHoldMs runs between FIRE and Z_UP (lets
    // the weld settle under clamp pressure). The Pi runOrchestrator reads
    // these from the RUN_START payload and sleeps accordingly.
    preWeldHoldMs: 0,
    postWeldHoldMs: 0,
  },
  gantryOffsetMm: 0,
  run: { active: false, paused: false, programName: null, index: 0, total: 0, phase: 'idle', reason: null },
  // Fault lockout — set when the firmware reports a FAULT code. The UI uses
  // this to show the full-screen Fault Lockout overlay. `cleared` flips true
  // once the underlying condition has resolved (e.g. air pressure back above
  // threshold) so the Clear Fault button can light up.
  fault: {
    active: false,
    code: null,
    message: null,
    cellIndex: null,
    programId: null,
    programName: null,
    mode: null,
    cleared: false,
    requiresHome: false,
  },
  // E-stop — the NC loop is broken. `clearedPrompt` is flipped by the
  // ESTOP_CLEARED event so the "Home now?" prompt can appear exactly once.
  estop: { active: false, clearedPrompt: false },
  // Incomplete-state file detected at boot (master plan §3.2). If the Pi is
  // power-cycled mid-run, the backend writes a small resume record to
  // /var/lib/gillis/state.json. On the next boot it ships that record with
  // the initial snapshot so the operator can re-run the interrupted cell,
  // continue from the next one, or discard the record and start over.
  incompleteState: null,
  // Home-on-boot preference. Mirrors the firmware flag (EEPROM-backed). The
  // boot splash reads this: false → show "Ready to home axis?" prompt,
  // true → auto-send HOME after splash completes.
  homeOnBoot: false,
  // Bench mode (Rev4.2) — when ON the firmware's homing cycle completes each
  // axis on the first sensor trigger and skips the back-off + slow re-touch.
  // Intended for bench testing with manually-actuated switches where one tap
  // per sensor is easier than staging a fast-hit/back-off/slow-touch cycle.
  // EEPROM-backed. Production homing is unchanged when this is OFF.
  benchMode: false,
  // Drivers enable state — surfaced so the Test Motion screen can show
  // whether steppers are energised before attempting a jog.
  driversEnabled: false,
  // Live limit-switch & driver-ALM state. Updated from the firmware's
  // SENSORS telemetry event (~4 Hz + on edge change). Used by Test Motion.
  sensors: {
    xHome: false, yLeftHome: false, yRightHome: false,
    zUp: false,  zDown: false,
    xAlm: false, yLeftAlm: false, yRightAlm: false,
  },
};

export function MachineProvider({ children }) {
  const [state, setState] = useState(INITIAL_STATE);

  // The MachineClient (a WebSocket wrapper around the backend) lives in
  // useState — not a useRef — so the api useMemo below recomputes when a
  // fresh client is mounted. This matters because React.StrictMode
  // double-mounts effects in dev: previously the client was created during
  // render and shared via useRef, the first mount's cleanup closed it (the
  // client has a sticky `closed = true` flag), and the second mount reused
  // the closed instance — leaving the GUI stuck on "OFFLINE" forever in
  // dev. Creating the client *inside* useEffect means each mount gets a
  // fresh client, so StrictMode's double-mount is benign. Production is
  // unaffected either way (StrictMode is a no-op when bundled).
  const [client, setClient] = useState(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const c = createMachineClient();
    setClient(c);

    const off = c.subscribe((evt) => {
      setState((prev) => reduce(prev, evt));
    });

    return () => {
      off();
      c.close();
      setClient(null);
    };
  }, []);

  // Local dispatch lets the UI synthesise reducer events (e.g. dismiss the
  // fault overlay) without needing a round-trip through the firmware.
  const dispatch = (evt) => setState((prev) => reduce(prev, evt));

  const api = useMemo(() => {
    const c = client;
    // Fallback no-op shim if WebSocket isn't available (SSR / tests) or the
    // useEffect hasn't run yet (initial render before mount).
    if (!c) {
      const noop = async () => ({ ok: false, reply: 'ERROR no client' });
      return {
        state,
        home: noop, stop: noop, moveTo: noop, moveToCal: noop, setZ: noop, fire: noop,
        setMotionSettings: noop, setGantryOffset: noop, setTram: noop, tramPreview: noop, shutdown: noop,
        setTravelLimits: noop, setAirThreshold: noop, setLoadingPosition: noop,
        runProgram: noop, pauseRun: noop, resumeRun: noop, abortRun: noop,
        clearFault: noop,
        resumeIncomplete: noop, discardIncomplete: noop,
        listUsbPrograms: noop, importUsbProgram: noop, exportUsbProgram: noop,
        loadPrograms: noop, savePrograms: noop,
        loadSettings: noop, saveSettings: noop,
        setHomeOnBoot: noop, setBenchMode: noop, requestSensors: noop,
        enableDrivers: noop, disableDrivers: noop,
        jogX: noop, jogY: noop,
        dispatch,
        jog: noop,
        subscribe: () => () => {},
      };
    }
    return {
      state,
      home: c.home,
      stop: c.stop,
      moveTo: c.moveTo,
      // Calibration-only MOVE — bypasses the firmware's Z-up gate. Used by
      // Calibrate Start Position / Loading Position screens. Everywhere else
      // stays on moveTo so the Z-up interlock holds.
      moveToCal: c.moveToCal,
      setZ: c.setZ,
      fire: c.fire,
      setMotionSettings: c.setMotionSettings,
      setGantryOffset: c.setGantryOffset,
      setTram: c.setTram,
      tramPreview: c.tramPreview,
      shutdown: c.shutdown,
      setTravelLimits: c.setTravelLimits,
      setAirThreshold: c.setAirThreshold,
      setLoadingPosition: c.setLoadingPosition,
      runProgram: c.runProgram,
      pauseRun: c.pauseRun,
      resumeRun: c.resumeRun,
      abortRun: c.abortRun,
      clearFault: c.clearFault,
      resumeIncomplete: c.resumeIncomplete,
      discardIncomplete: c.discardIncomplete,
      listUsbPrograms: c.listUsbPrograms,
      importUsbProgram: c.importUsbProgram,
      exportUsbProgram: c.exportUsbProgram,
      loadPrograms: c.loadPrograms,
      savePrograms: c.savePrograms,
      loadSettings: c.loadSettings,
      saveSettings: c.saveSettings,
      setHomeOnBoot: c.setHomeOnBoot,
      setBenchMode: c.setBenchMode,
      requestSensors: c.requestSensors,
      // Wrap ENABLE/DISABLE so the UI's driversEnabled flag flips the moment
      // the firmware ACKs. Without this the indicator / toggle button would
      // stay out of sync until the next periodic SNAPSHOT arrived.
      enableDrivers: async () => {
        const res = await c.enableDrivers();
        if (res && res.ok) dispatch({ type: 'drivers', enabled: true });
        return res;
      },
      disableDrivers: async () => {
        const res = await c.disableDrivers();
        if (res && res.ok) dispatch({ type: 'drivers', enabled: false });
        return res;
      },
      jogX: c.jogX,
      jogY: c.jogY,
      // Synthesise a local reducer event (used by the fault/e-stop overlays
      // to dismiss themselves after the operator has picked a resume option).
      dispatch,
      // Raw event stream — components can subscribe for animations/pulses
      subscribe: c.subscribe,
      // Convenience: jog is "move current + step on one axis"
      jog: (axis, dir, step) => {
        const cur = state.position;
        const x = axis === 'x' ? Number((cur.x + dir * step).toFixed(3)) : cur.x;
        const y = axis === 'y' ? Number((cur.y + dir * step).toFixed(3)) : cur.y;
        return c.moveTo(x, y);
      },
    };
  }, [state, client]);

  return <MachineContext.Provider value={api}>{children}</MachineContext.Provider>;
}

export function useMachine() {
  const ctx = useContext(MachineContext);
  if (!ctx) throw new Error('useMachine must be used inside <MachineProvider>');
  return ctx;
}

// Pure reducer — keeps the transitions obvious.
function reduce(prev, evt) {
  switch (evt.type) {
    case 'snapshot': {
      // Persistent settings (envelope / motion / loading position / air
      // threshold) are managed Pi-side because the firmware's EEPROM
      // round-trip for SET_TRAVEL / SET_AIR_THRESHOLD / SETMOTION / LOADPOS
      // isn't reliable across builds — the operator would type a value, save
      // it, and the very next SNAPSHOT (carrying the firmware's stale
      // default) would clobber the just-saved value in the UI. Drop these
      // fields from firmware-sourced snapshots so Pi-side settings are
      // authoritative. The Pi hydrate effect dispatches these separately via
      // the 'settings_hydrate' action below.
      const incoming = evt.state || {};
      const {
        travelLimits: _drop1,
        motionSettings: _drop2,
        loadingPosition: _drop3,
        airThresholdBar: _drop4,
        ...firmwareState
      } = incoming;
      return { ...prev, ...firmwareState, connected: true };
    }
    case 'settings_hydrate':
      // Explicit Pi-side settings push (from the hydrate effect on connect
      // or from a successful Save on the Settings / Loading Position
      // screen). Distinct from 'snapshot' so it can update fields that
      // 'snapshot' is now explicitly forbidden from touching. Patch shape
      // mirrors the snapshot patch: each top-level key is replaced
      // wholesale if present, so {travelLimits:{maxX,maxY}} must include
      // both axes — callers always pass full objects.
      return { ...prev, ...(evt.state || {}) };
    case 'connection':
      return {
        ...prev,
        connected: evt.connected,
        health: {
          ...prev.health,
          teensy: evt.connected ? (prev.health.teensy === 'Disconnected' ? 'Connected' : prev.health.teensy) : 'Disconnected',
        },
      };
    case 'position':
      return { ...prev, position: { ...prev.position, ...evt.position } };
    case 'sensors':
      return { ...prev, sensors: { ...prev.sensors, ...evt.sensors } };
    case 'drivers':
      // Synthesised locally when ENABLE/DISABLE is ACKed, or could be emitted
      // by the backend if the firmware ever gains an async drivers-state event.
      return { ...prev, driversEnabled: !!evt.enabled };
    case 'home_on_boot':
      return { ...prev, homeOnBoot: !!evt.value };
    case 'bench_mode':
      // Synthesised locally when the UI toggles bench mode via SET_BENCH_MODE
      // so the switch reflects immediately, ahead of the next SNAPSHOT arriving.
      return { ...prev, benchMode: !!evt.value };
    case 'laser':
      return { ...prev, laser: evt.state };
    case 'homing':
      // Centralised homing-in-progress flag. start → true, done → false,
      // fault/aborted → false. The various Home buttons read
      // machine.state.homing directly instead of each carrying a local
      // useState that could get out of sync with the WS event stream.
      //
      // Earlier revisions added a 400 ms "ignore early done" guard against
      // a phantom flash; in practice it left `homing` stuck at true on
      // bench-mode cycles where HOMED legitimately arrived sub-400 ms,
      // which then made the Home tile do nothing on the next press
      // (SetupMenuScreen.startHome guards on machine.state.homing). The
      // guard is gone — the centralised flag plus the disconnect cleanup
      // in realSerial is enough.
      return {
        ...prev,
        homing: evt.phase === 'start',
        busy: evt.phase === 'start' ? true : (evt.phase === 'done' ? false : prev.busy),
        homed: evt.phase === 'done' ? true : prev.homed,
      };
    case 'stopped':
      return { ...prev, busy: false, homing: false, run: { ...prev.run, active: false, paused: false, phase: 'idle' } };
    case 'air':
      return { ...prev, airPressureBar: evt.bar };
    case 'fault': {
      // Driver faults and the E-stop require a fresh home before the operator
      // can continue, per master plan §3.2. Everything else just needs the
      // condition cleared and a resume-prompt.
      const code = String(evt.code || '').toUpperCase();
      const requiresHome =
        code === 'FAULT_DRIVER_X' ||
        code === 'FAULT_DRIVER_YL' ||
        code === 'FAULT_DRIVER_YR' ||
        code === 'FAULT_ESTOP';
      return {
        ...prev,
        fault: {
          active: true,
          code,
          message: evt.message || null,
          cellIndex: typeof evt.cellIndex === 'number' ? evt.cellIndex : prev.run.index,
          programId: evt.programId || prev.run.programId || null,
          programName: evt.programName || prev.run.programName || null,
          mode: evt.mode || null,
          cleared: false,
          requiresHome,
        },
        // Driver faults need the machine forgotten so a home is required.
        homed: requiresHome ? false : prev.homed,
        busy: false,
        homing: false,
        run: { ...prev.run, active: false, paused: true, phase: 'faulted' },
      };
    }
    case 'fault_cleared':
      // Condition resolved (e.g. air pressure back above threshold). We don't
      // drop the overlay yet — the operator still has to hit "Clear Fault" and
      // pick a resume option. Just flip the button-enable flag.
      return prev.fault.active ? { ...prev, fault: { ...prev.fault, cleared: true } } : prev;
    case 'fault_dismiss':
      // Local-only event (not from firmware) — fired by the UI once the
      // operator has confirmed they want to continue (or scrap the run).
      return { ...prev, fault: { ...INITIAL_STATE.fault } };
    case 'run_reason_dismiss':
      // Local-only event fired when the operator dismisses the run-aborted
      // overlay. Clears the reason but leaves run.phase='aborted' so the
      // RunScreen's resume flow (cellIndex / "resume from cell N") still works.
      return { ...prev, run: { ...prev.run, reason: null } };
    case 'abort_fault_dismiss': {
      // Local-only event fired by the abort flow's safety net. A driver ALM
      // pulse triggered by the abrupt stop at RUN_ABORT can briefly trip
      // FAULT_DRIVER_X/YL/YR, which the generic 'fault' reducer above has
      // already stamped with requiresHome=true AND zeroed the top-level
      // `homed` flag. For a deliberate operator abort the position counters
      // are still trustworthy — the steppers were halted under firmware
      // control, not from a commanded motion running off the rails — so we
      // restore `homed` along with clearing the fault. Leaving homed=false
      // was the reason operators kept getting bounced to the "Gillis is
      // lost" re-home gate after every abort.
      //
      // Also drop run.phase from 'faulted' → 'idle' so the run screen isn't
      // still presenting terminal state when the operator comes back.
      if (!prev.fault.active && prev.run.phase !== 'faulted') return prev;
      return {
        ...prev,
        fault: { ...INITIAL_STATE.fault },
        homed: true,
        busy: false,
        run: { ...prev.run, active: false, paused: false, phase: 'idle' },
      };
    }
    case 'estop':
      // NC loop broke. Hardware has already cut 48V; the firmware has opened
      // the solenoid + laser relays. Drop us into a hard-locked state.
      return {
        ...prev,
        estop: { active: true, clearedPrompt: false },
        homed: false,
        busy: false,
        homing: false,
        run: { ...prev.run, active: false, paused: true, phase: 'faulted' },
      };
    case 'estop_cleared':
      // E-stop released. Show the "home now?" prompt. If the matching FAULT
      // is still active, flip its `cleared` flag so the Clear-Fault button on
      // the lockout overlay lights up too.
      return {
        ...prev,
        estop: { active: false, clearedPrompt: true },
        fault:
          prev.fault.active && prev.fault.code === 'FAULT_ESTOP'
            ? { ...prev.fault, cleared: true }
            : prev.fault,
      };
    case 'estop_dismiss':
      // Local-only — fired by the UI after the operator dismisses the prompt.
      return { ...prev, estop: { active: false, clearedPrompt: false } };
    case 'incomplete_state':
      // Backend has a resumable record on disk. Shape per master plan §3.2:
      // { programName, programId, mode, index, total, ts, cause }.
      return {
        ...prev,
        incompleteState: evt.record
          ? { ...evt.record }
          : {
              programName: evt.programName || null,
              programId: evt.programId || null,
              mode: evt.mode || null,
              index: typeof evt.index === 'number' ? evt.index : 0,
              total: typeof evt.total === 'number' ? evt.total : 0,
              cause: evt.cause || null,
              ts: evt.ts || null,
            },
      };
    case 'incomplete_state_cleared':
      // Operator has picked an option (resume / continue / discard) and the
      // backend has deleted the state file.
      return { ...prev, incompleteState: null };
    case 'run_reset':
      // Local-only reset. The RunScreen dispatches this on mount so the
      // reducer's `run.phase` doesn't linger at 'aborted' or 'complete' from a
      // previous run. Without this the new run briefly renders as "Aborted"
      // until the backend's run:start event arrives.
      return { ...prev, run: { ...INITIAL_STATE.run } };
    case 'run': {
      switch (evt.phase) {
        case 'moving':
          // Pre-move to start position is in flight. Run is "active" from the
          // firmware's point of view but the per-cell loop hasn't begun, so
          // the UI's loading overlay can stay up until 'start' arrives.
          //
          // Clear run.reason here so the abort overlay from a previous run
          // doesn't haunt the new one (in case the operator pressed Run again
          // without dismissing it).
          return {
            ...prev,
            run: { active: true, paused: false, programName: evt.programName, index: 0, total: evt.total, phase: 'moving', reason: null },
            busy: true,
          };
        case 'start':
          return {
            ...prev,
            run: { active: true, paused: false, programName: evt.programName, index: 0, total: evt.total, phase: 'running', reason: null },
            busy: true,
          };
        case 'cell':
          // `total` is only sent on the first cell of each run by the
          // orchestrator — keep the existing value if this event didn't
          // include one (otherwise the "Cell N / T" readout would briefly
          // show "Cell N / undefined" whenever a bare {index} event lands).
          return {
            ...prev,
            run: {
              ...prev.run,
              index: evt.index,
              total: typeof evt.total === 'number' ? evt.total : prev.run.total,
              phase: 'running',
            },
          };
        case 'paused':
          return { ...prev, run: { ...prev.run, paused: true, phase: 'paused' } };
        case 'resumed':
          return { ...prev, run: { ...prev.run, paused: false, phase: 'running' } };
        case 'moving_to_load':
          // Rev4.4 — the last cell's Z_UP has completed and the orchestrator
          // is now parking the table back at the loading position before
          // declaring the run complete. Keeps the UI's "Program Complete"
          // overlay behind a "Moving to loading position" loading screen
          // until the gantry actually arrives, so the operator sees the
          // table move before they're invited to unload.
          return { ...prev, run: { ...prev.run, phase: 'moving_to_load' }, busy: true };
        case 'done':
          return { ...prev, run: { ...prev.run, active: false, phase: 'complete' }, busy: false };
        case 'aborted':
          // The orchestrator stamps programId / cellIndex / total on the abort
          // event so the UI can persist a resume point per program and offer
          // "resume from cell N" on the next launch of the same program.
          //
          // `evt.reason` (added in runOrchestrator.js) carries a short
          // human-readable string explaining why the loop bailed — e.g.
          // "move cell 1 failed: BUSY" or "z-down cell 0 failed: ERROR timeout".
          // Stashed on run.reason so the UI can surface it in a fault-style
          // overlay instead of leaving the operator with a silent "aborted"
          // status pill. Cleared by the user-abort path (which knows it was
          // deliberate and doesn't need to shout about it).
          return {
            ...prev,
            run: {
              ...prev.run,
              active: false,
              phase: 'aborted',
              programName: evt.programName || prev.run.programName,
              programId: evt.programId || prev.run.programId || null,
              cellIndex: typeof evt.cellIndex === 'number' ? evt.cellIndex : (prev.run.index ? prev.run.index - 1 : 0),
              total: typeof evt.total === 'number' ? evt.total : prev.run.total,
              reason: evt.reason && evt.reason !== 'user abort' ? String(evt.reason) : null,
            },
            busy: false,
          };
        default:
          return prev;
      }
    }
    default:
      return prev;
  }
}
