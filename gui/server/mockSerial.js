// Mock Teensy serial link.
//
// Simulates the real command protocol described in the pendant-to-Teensy spec:
//   HOME                         homing sequence
//   STOP                         immediate abort
//   STATUS                       snapshot
//   MOVE X<n> Y<n> [Z<n>]        coordinated move, emits position@60Hz
//   Z UP | Z DOWN                pneumatic Z command (instant)
//   FIRE                         ~50ms laser pulse
//   SETMOTION <json>             persist motion settings to EEPROM
//   GANTRYOFFSET <mm>            store gantry squaring offset
//   LOADPOS <json>               store loading position
//   RUN_START <json>             begin a program run
//   RUN_PAUSE / RUN_RESUME / RUN_ABORT
//
// Replies: OK / BUSY / DONE / ERROR <msg>
// Events: { type: 'position'|'laser'|'homing'|'run'|'stopped'|'air'|'health', ... }

import { EventEmitter } from 'node:events';

export function createMockSerial() {
  const emitter = new EventEmitter();

  const state = {
    connected: true,
    homed: false,
    busy: false,
    driversEnabled: false,
    position: { x: 120, y: 120, z: 'UP' }, // start mid-travel so sensors read untriggered
    airPressureBar: 6.2,
    laser: 'OFF',
    health: { teensy: 'Connected', drivers: 'Healthy', air: 'OK' },
    runtime: { machineHours: 120.0, sessionHours: 0 },
    // Rev4.3: two motion profiles. Unprefixed tuple = "fast" (non-run
    // motions: pre-move, park, JOG, Test Motion). cell* tuple = the
    // cell-to-cell profile used for in-program MOVEs (tagged P=C on the
    // wire). The mock's simulateMove picks a profile based on whether the
    // active run flag is set so the gantry animation matches real runtime.
    motionSettings: {
      xSpeed: 120, ySpeed: 120, xAccel: 500, yAccel: 500,
      cellXSpeed: 60, cellYSpeed: 60, cellXAccel: 250, cellYAccel: 250,
      // zDownDwell: legacy wire key for the laser-relay energised duration —
      // labelled "Laser On Time" in the UI.
      zDownDwell: 50,
      // Rev4.4 pneumatic holds the orchestrator sleeps on during a run.
      preWeldHoldMs: 0,
      postWeldHoldMs: 0,
    },
    gantryOffsetMm: 0,
    loadingPosition: { x: 305, y: 585, z: 'UP' },
    homeOnBoot: false,
    // Simulated sensor mask — derived from position in the mock, but held
    // here so the Test Motion screen has something live to display.
    sensors: {
      xHome: false, yLeftHome: false, yRightHome: false,
      zUp: true,  zDown: false,
      xAlm: false, yLeftAlm: false, yRightAlm: false,
    },
  };

  // Limit-switch trigger window in the mock (mm from zero)
  const SENSOR_TRIGGER_MM = 5;

  function recomputeSensors() {
    const s = state.sensors;
    const prev = { ...s };
    s.xHome      = state.position.x <= SENSOR_TRIGGER_MM;
    s.yLeftHome  = state.position.y <= SENSOR_TRIGGER_MM;
    s.yRightHome = state.position.y <= SENSOR_TRIGGER_MM;
    s.zUp        = state.position.z === 'UP';
    s.zDown      = state.position.z === 'DOWN';
    // xAlm / yLeftAlm / yRightAlm stay false — no simulated driver faults
    const changed =
      prev.xHome !== s.xHome || prev.yLeftHome !== s.yLeftHome ||
      prev.yRightHome !== s.yRightHome || prev.zUp !== s.zUp ||
      prev.zDown !== s.zDown;
    if (changed) emitter.emit('event', { type: 'sensors', sensors: { ...s } });
  }

  // Slow drift in air pressure so the TopStatusBar has something to show
  setInterval(() => {
    const drift = (Math.random() - 0.5) * 0.05;
    state.airPressureBar = Math.max(5.8, Math.min(6.6, state.airPressureBar + drift));
    emitter.emit('event', { type: 'air', bar: state.airPressureBar });
  }, 1500);

  // Periodic SENSORS heartbeat — keeps the Test Motion screen live even
  // when nothing is changing. 250ms matches firmware SENSORS_EVENT_INTERVAL_MS.
  setInterval(() => {
    emitter.emit('event', { type: 'sensors', sensors: { ...state.sensors } });
  }, 250);

  // Bookkeeping runtime
  setInterval(() => {
    state.runtime.sessionHours += 1 / 3600;
  }, 1000);

  let runToken = null;
  // Promise for the in-flight runProgram. Null when no run is active. The
  // RUN_ABORT handler awaits this before returning OK so a rapid UI
  // abort→restart sequence can't spawn two concurrent runProgram calls that
  // both reach cell 1 FIRE before the older one's token-check bails.
  let runProgramPromise = null;

  function simulateMove(target, opts = {}) {
    return new Promise((resolve) => {
      state.busy = true;
      // Pick the matching profile speed so the simulated timeline tracks
      // what the real machine would do. `opts.profile === 'C'` == cell
      // profile (Pi orchestrator tagged the MOVE with P=C), anything else
      // falls back to the fast profile. Clamped to avoid NaN/zero if the
      // settings were corrupted.
      const profile = opts.profile === 'C' ? 'C' : 'F';
      const SPEED = (profile === 'C'
        ? state.motionSettings.cellXSpeed
        : state.motionSettings.xSpeed) || 120;
      const start = { ...state.position };
      const dx = (target.x ?? start.x) - start.x;
      const dy = (target.y ?? start.y) - start.y;
      const dist = Math.hypot(dx, dy);
      const durationMs = Math.max(40, (dist / SPEED) * 1000);
      const t0 = Date.now();
      const token = runToken;

      const tick = setInterval(() => {
        // Abort if a new run/stop invalidated our token
        if (runToken !== token && token !== null) {
          clearInterval(tick);
          state.busy = false;
          resolve('ABORTED');
          return;
        }
        const t = Math.min(1, (Date.now() - t0) / durationMs);
        state.position = {
          x: Number((start.x + dx * t).toFixed(3)),
          y: Number((start.y + dy * t).toFixed(3)),
          z: state.position.z,
        };
        emitter.emit('event', { type: 'position', position: { ...state.position } });
        recomputeSensors();
        if (t >= 1) {
          clearInterval(tick);
          state.busy = false;
          resolve('DONE');
        }
      }, 1000 / 60);
    });
  }

  async function doFire() {
    const dwell = Math.max(10, state.motionSettings.zDownDwell || 50);
    state.laser = 'FIRING';
    emitter.emit('event', { type: 'laser', state: 'FIRING' });
    await new Promise((r) => setTimeout(r, dwell));
    state.laser = 'OFF';
    emitter.emit('event', { type: 'laser', state: 'OFF' });
  }

  async function runProgram({
    programName,
    coordinates = [],
    mode = 'Positive',
    startPosition,
    preWeldHoldMs,
    postWeldHoldMs,
    loadingPosition,
  }) {
    const token = (runToken = Symbol('run'));
    state.busy = true;
    // Rev4.4 — fall back to the mock's local motionSettings if the UI didn't
    // stamp the holds onto the RUN_START payload (older UI builds). Real
    // installs always stamp them, matching the real runOrchestrator.
    const preHold  = Math.max(0, Number(preWeldHoldMs)  ?? state.motionSettings.preWeldHoldMs  ?? 0);
    const postHold = Math.max(0, Number(postWeldHoldMs) ?? state.motionSettings.postWeldHoldMs ?? 0);
    const parkTarget = loadingPosition || state.loadingPosition || null;
    emitter.emit('event', { type: 'run', phase: 'start', programName, mode, total: coordinates.length });

    // Move to start position first, if provided
    if (startPosition && typeof startPosition.x === 'number') {
      await simulateMove({ x: startPosition.x, y: startPosition.y });
    }

    let paused = false;
    const pauseHandler = (p) => {
      if (runToken !== token) return;
      paused = !!p;
      emitter.emit('event', { type: 'run', phase: paused ? 'paused' : 'resumed' });
    };
    emitter.on('__pause', pauseHandler);

    for (let i = 0; i < coordinates.length; i++) {
      if (runToken !== token) break; // aborted
      while (paused && runToken === token) {
        await new Promise((r) => setTimeout(r, 80));
      }

      const c = coordinates[i];
      emitter.emit('event', { type: 'run', phase: 'cell', index: i + 1, total: coordinates.length });

      // Move XY — same cell-frame → machine-frame inversion as the real
      // orchestrator (see runOrchestrator.js for the full explanation).
      // Cell offsets SUBTRACT from the start position so the simulated
      // X/Y readout evolves the same way a real run would.
      // In-program cell-to-cell moves always run on the "cell" profile —
      // matches what the real Pi orchestrator does by tagging each MOVE
      // with P=C on the wire.
      await simulateMove({
        x: (startPosition?.x || 0) - (c.x || 0),
        y: (startPosition?.y || 0) - (c.y || 0),
      }, { profile: 'C' });
      if (runToken !== token) break;

      // Z DOWN (pneumatic — instant in real life)
      state.position = { ...state.position, z: 'DOWN' };
      emitter.emit('event', { type: 'position', position: { ...state.position } });

      // Pre-weld hold (Rev4.4) — matches the real runOrchestrator sleep
      // between Z_DOWN and FIRE. Lets the operator see the same timing in
      // the mock that they'll see on the machine.
      if (preHold > 0) {
        await new Promise((r) => setTimeout(r, preHold));
        if (runToken !== token) break;
      }

      // Fire
      await doFire();

      // Post-weld hold (Rev4.4).
      if (postHold > 0) {
        await new Promise((r) => setTimeout(r, postHold));
        if (runToken !== token) break;
      }

      // Z UP
      state.position = { ...state.position, z: 'UP' };
      emitter.emit('event', { type: 'position', position: { ...state.position } });
    }

    emitter.off('__pause', pauseHandler);

    // Rev4.4 — post-run park to loading position. Applies to real runs AND
    // test runs (doFire is a no-op on test runs in the mock either way).
    // Emitted BEFORE the move so the UI can switch to its "Moving to
    // loading position" overlay while the table is still sliding.
    if (runToken === token && parkTarget &&
        typeof parkTarget.x === 'number' &&
        typeof parkTarget.y === 'number' &&
        (parkTarget.x !== 0 || parkTarget.y !== 0)) {
      emitter.emit('event', { type: 'run', phase: 'moving_to_load' });
      await simulateMove({ x: parkTarget.x, y: parkTarget.y });
    }

    if (runToken === token) {
      emitter.emit('event', { type: 'run', phase: 'done' });
      runToken = null;
    }
    state.busy = false;
  }

  async function handle(command) {
    if (!command || typeof command !== 'string') return { ok: false, reply: 'ERROR bad command' };
    const trimmed = command.trim();
    const firstSpace = trimmed.indexOf(' ');
    const verb = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toUpperCase();
    const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

    switch (verb) {
      case 'STATUS':
        return { ok: true, reply: 'OK', state: snapshot() };

      case 'HOME': {
        state.busy = true;
        emitter.emit('event', { type: 'homing', phase: 'start' });
        await new Promise((r) => setTimeout(r, 600));
        state.position = { x: 0, y: 0, z: 'UP' };
        state.homed = true;
        state.busy = false;
        emitter.emit('event', { type: 'position', position: { ...state.position } });
        emitter.emit('event', { type: 'homing', phase: 'done' });
        recomputeSensors();
        return { ok: true, reply: 'DONE' };
      }

      case 'ENABLE':
        state.driversEnabled = true;
        return { ok: true, reply: 'OK' };

      case 'DISABLE':
        state.driversEnabled = false;
        return { ok: true, reply: 'OK' };

      case 'SENSORS':
        emitter.emit('event', { type: 'sensors', sensors: { ...state.sensors } });
        return { ok: true, reply: 'OK' };

      case 'SET_HOME_ON_BOOT': {
        const t = rest.trim().toUpperCase();
        const on = t === '1' || t === 'ON' || t === 'TRUE' || t === 'YES' || t === 'Y';
        const off = t === '0' || t === 'OFF' || t === 'FALSE' || t === 'NO' || t === 'N';
        if (!on && !off) return { ok: false, reply: 'ERROR bad home-on-boot' };
        state.homeOnBoot = on;
        return { ok: true, reply: 'OK' };
      }

      case 'JOG': {
        // Accept "JOG X+10" or "JOG Y-5.5" style payloads
        const m = rest.match(/^\s*([XY])\s*([+-]?\d+(?:\.\d+)?)\s*$/i);
        if (!m) return { ok: false, reply: 'ERROR bad jog' };
        const axis = m[1].toUpperCase();
        const delta = parseFloat(m[2]);
        const target = { ...state.position };
        if (axis === 'X') target.x = Math.max(0, (target.x || 0) + delta);
        else              target.y = Math.max(0, (target.y || 0) + delta);
        const reply = await simulateMove(target);
        return { ok: true, reply };
      }

      case 'STOP':
        runToken = null;
        state.busy = false;
        emitter.emit('event', { type: 'stopped' });
        return { ok: true, reply: 'OK' };

      case 'MOVE': {
        const target = {};
        // Extract optional motion-profile tag (P=C or P=F). The Pi
        // orchestrator stamps per-cell MOVEs with P=C; everything else
        // falls through to the fast profile.
        let profile = 'F';
        for (const p of rest.split(/\s+/)) {
          if (!p) continue;
          const axis = p[0].toUpperCase();
          if (axis === 'P' && p[1] === '=') {
            const c = p[2];
            if (c === 'C' || c === 'c') profile = 'C';
            continue;
          }
          const val = parseFloat(p.slice(1));
          if (!Number.isNaN(val) && 'XY'.includes(axis)) target[axis.toLowerCase()] = val;
        }
        const reply = await simulateMove(target, { profile });
        return { ok: true, reply };
      }

      case 'Z': {
        const dir = rest.toUpperCase();
        if (dir !== 'UP' && dir !== 'DOWN') return { ok: false, reply: 'ERROR bad Z' };
        state.position = { ...state.position, z: dir };
        emitter.emit('event', { type: 'position', position: { ...state.position } });
        recomputeSensors();
        return { ok: true, reply: 'DONE' };
      }

      case 'FIRE':
        await doFire();
        return { ok: true, reply: 'DONE' };

      case 'SETMOTION': {
        try {
          const next = JSON.parse(rest || '{}');
          // homeOnBoot travels in the same JSON blob as motion settings when
          // the UI hits "Save". Peel it off before merging the rest.
          if (typeof next.homeOnBoot !== 'undefined') {
            state.homeOnBoot = !!next.homeOnBoot;
            delete next.homeOnBoot;
          }
          // Rev4.3 nested shape: { fast:{xSpeed,ySpeed,xAccel,yAccel},
          //                        cell:{xSpeed,ySpeed,xAccel,yAccel},
          //                        dwellMs|zDownDwell, ... }
          // Flatten it onto the local motionSettings object so downstream
          // code that reads `state.motionSettings.xSpeed` / `.cellXSpeed`
          // continues to work. Legacy flat SETMOTION payloads also fall
          // through the final spread — we only destructure the nested
          // keys if they're actually present.
          const flat = { ...next };
          if (next.fast && typeof next.fast === 'object') {
            if (typeof next.fast.xSpeed === 'number') flat.xSpeed = next.fast.xSpeed;
            if (typeof next.fast.ySpeed === 'number') flat.ySpeed = next.fast.ySpeed;
            if (typeof next.fast.xAccel === 'number') flat.xAccel = next.fast.xAccel;
            if (typeof next.fast.yAccel === 'number') flat.yAccel = next.fast.yAccel;
            delete flat.fast;
          }
          if (next.cell && typeof next.cell === 'object') {
            if (typeof next.cell.xSpeed === 'number') flat.cellXSpeed = next.cell.xSpeed;
            if (typeof next.cell.ySpeed === 'number') flat.cellYSpeed = next.cell.ySpeed;
            if (typeof next.cell.xAccel === 'number') flat.cellXAccel = next.cell.xAccel;
            if (typeof next.cell.yAccel === 'number') flat.cellYAccel = next.cell.yAccel;
            delete flat.cell;
          }
          // `dwellMs` and `zDownDwell` are interchangeable aliases on the
          // wire; the mock's local key is `zDownDwell`.
          if (typeof flat.dwellMs === 'number') {
            flat.zDownDwell = flat.dwellMs;
            delete flat.dwellMs;
          }
          state.motionSettings = { ...state.motionSettings, ...flat };
          return { ok: true, reply: 'DONE' };
        } catch {
          return { ok: false, reply: 'ERROR bad json' };
        }
      }

      case 'GANTRYOFFSET':
      case 'SET_TRAM':
      case 'SETGANTRYOFFSET': {
        // Persistent set — real firmware writes to EEPROM here.
        const v = parseFloat(rest);
        if (!Number.isFinite(v)) return { ok: false, reply: 'ERROR bad offset' };
        state.gantryOffsetMm = v;
        return { ok: true, reply: 'DONE' };
      }

      case 'TRAM_PREVIEW': {
        // Live-preview from the X-Axis Tramming screen — real firmware
        // updates settings.tramOffset in RAM and slews Y_RIGHT alone. The
        // mock has no separate Y_RIGHT position to track, so we just store
        // the value the same way SET_TRAM does and trust the GUI's local
        // SVG visualisation to give the operator visual feedback in dev.
        const v = parseFloat(rest);
        if (!Number.isFinite(v)) return { ok: false, reply: 'ERROR bad offset' };
        state.gantryOffsetMm = v;
        return { ok: true, reply: 'DONE' };
      }

      case 'LOADPOS': {
        try {
          state.loadingPosition = { ...state.loadingPosition, ...JSON.parse(rest || '{}') };
          return { ok: true, reply: 'DONE' };
        } catch {
          return { ok: false, reply: 'ERROR bad json' };
        }
      }

      case 'RUN_START': {
        // Reject concurrent starts AND wind-down races. Before these guards,
        // every RUN_START would spawn a new async runProgram() — and in React
        // 18 StrictMode where the RunScreen mount effect can fire twice on
        // initial mount, the second runLoop would race the first and the
        // first cell could end up firing multiple times before the older
        // loop's token-check bailed. The real-backend path has the same
        // guard in runOrchestrator.js.
        if (runToken !== null || runProgramPromise) {
          return { ok: false, reply: 'BUSY run in progress' };
        }
        try {
          const job = JSON.parse(rest || '{}');
          // Track the promise so RUN_ABORT can await a clean wind-down.
          runProgramPromise = runProgram(job)
            .catch(() => {})
            .finally(() => { runProgramPromise = null; });
          return { ok: true, reply: 'OK' };
        } catch {
          return { ok: false, reply: 'ERROR bad json' };
        }
      }

      case 'RUN_PAUSE':
        emitter.emit('__pause', true);
        return { ok: true, reply: 'OK' };

      case 'RUN_RESUME':
        emitter.emit('__pause', false);
        return { ok: true, reply: 'OK' };

      case 'RUN_ABORT':
        runToken = null;
        state.busy = false;
        emitter.emit('event', { type: 'run', phase: 'aborted' });
        // Wait for the in-flight runProgram's async tail to fully exit before
        // we return OK. Without this, a rapid RUN_ABORT → RUN_START sequence
        // (e.g. StrictMode's setup → cleanup → setup cycle, or a quick
        // operator double-tap) would find runToken=null and runProgramPromise
        // still populated, reject cleanly — or worse, if we didn't set
        // runProgramPromise at all, start a fresh runProgram that races the
        // dying one for cell-1 FIRE. The guard + await combo shuts that
        // whole class of race down.
        try { await runProgramPromise; } catch { /* swallowed */ }
        return { ok: true, reply: 'OK' };

      default:
        return { ok: false, reply: `ERROR unknown ${verb}` };
    }
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  return {
    send: handle,
    snapshot,
    on: (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
  };
}
