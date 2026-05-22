// Browser-side WebSocket client for the Gillis backend.
// Exposes a small command API + EventTarget-style subscription.
// Auto-reconnects on disconnect. Safe to import in tests (graceful if no server).

const DEFAULT_WS_URL = (() => {
  // Same-origin WebSocket: Vite proxies /ws -> backend :8787 in dev (with
  // both bound to IPv4 via vite.config.js). In production on the Pi, the
  // browser is served from the backend so same-origin also works there.
  if (typeof window === 'undefined') return 'ws://127.0.0.1:8787/ws';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
})();

export function createMachineClient({ url = DEFAULT_WS_URL, autoReconnect = true } = {}) {
  const listeners = new Set();
  const pending = new Map(); // id -> { resolve }
  let nextId = 1;
  let ws = null;
  let reconnectDelay = 500;
  let closed = false;

  function emit(evt) {
    for (const fn of listeners) {
      try { fn(evt); } catch { /* swallow handler errors */ }
    }
  }

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch {
      emit({ type: 'connection', connected: false });
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      reconnectDelay = 500;
      emit({ type: 'connection', connected: true });
    });

    ws.addEventListener('close', () => {
      emit({ type: 'connection', connected: false });
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'close' will fire too
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'reply' && msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
        return;
      }
      emit(msg);
    });
  }

  function scheduleReconnect() {
    if (!autoReconnect || closed) return;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  }

  function send(command) {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, reply: 'ERROR not connected' });
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve });
      ws.send(JSON.stringify({ type: 'command', id, command }));
      // Safety timeout so we don't leak pending entries
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ ok: false, reply: 'ERROR timeout' });
        }
      }, 15000);
    });
  }

  connect();

  return {
    // Subscribe to events: snapshot, position, laser, homing, run, stopped, air, connection
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    close() {
      closed = true;
      if (ws) ws.close();
    },

    // ------- Command helpers -------
    raw: send,
    status: () => send('STATUS'),
    home: () => send('HOME'),
    stop: () => send('STOP'),
    moveTo: (x, y) => send(`MOVE X${x} Y${y}`),
    // Calibration-only absolute move that bypasses the firmware's Z-up safety
    // gate. Used by Calibrate Start Position and Loading Position screens so
    // the operator can jog the table while teaching positions with Z down.
    // Every OTHER caller stays on `moveTo` so the Z-up interlock holds.
    moveToCal: (x, y) => send(`MOVE_CAL X${x} Y${y}`),
    // Relative single-axis jog (mm). Used by the manual Test Motion screen
    // to inch the gantry toward each limit switch.
    jogX: (mm) => send(`JOG X${mm >= 0 ? '+' : ''}${mm}`),
    jogY: (mm) => send(`JOG Y${mm >= 0 ? '+' : ''}${mm}`),
    setZ: (dir /* 'UP' | 'DOWN' */) => send(`Z ${dir}`),
    fire: () => send('FIRE'),
    // Force an immediate SENSORS event — useful on Test Motion screen entry
    // so the UI isn't blank while waiting for the periodic tick.
    requestSensors: () => send('SENSORS'),
    // Home-on-boot toggle. Teensy stores it; Pi-side reads via SNAPSHOT.
    setHomeOnBoot: (on) => send(`SET_HOME_ON_BOOT ${on ? 1 : 0}`),
    // Bench mode toggle (Rev4.2). When on, homing completes each axis on
    // the first sensor trigger and skips the back-off + slow re-touch.
    // Intended for bench testing with manually-actuated switches.
    setBenchMode: (on) => send(`SET_BENCH_MODE ${on ? 1 : 0}`),
    // Enable / disable stepper drivers. Used by Test Motion screen so the
    // operator can manually push the gantry to exercise sensors if desired.
    enableDrivers:  () => send('ENABLE'),
    disableDrivers: () => send('DISABLE'),
    setMotionSettings: (obj) => send(`SETMOTION ${JSON.stringify(obj)}`),
    // §4.1 of the master plan calls this SET_TRAM. Keep `setGantryOffset`
    // as an alias so callers don't have to rename immediately.
    setTram: (mm) => send(`SET_TRAM ${mm}`),
    setGantryOffset: (mm) => send(`SET_TRAM ${mm}`),
    // Live-preview the tramming offset — moves Y_RIGHT alone to (Y_LEFT + mm)
    // and updates the firmware's RAM-side tramOffset, but does NOT write to
    // EEPROM. The X-Axis Tramming screen fires this on every ↑/↓ tap so the
    // operator sees the gantry square in real time; setTram is fired only on
    // the Save button to persist the final value.
    tramPreview: (mm) => send(`TRAM_PREVIEW ${mm}`),
    // Soft axis travel limits saved to Teensy EEPROM. New command — firmware
    // side will clamp moves to these values on top of the homing envelope.
    setTravelLimits: (limits) => send(`SET_TRAVEL ${JSON.stringify(limits)}`),
    // Low-air threshold in bar, saved to EEPROM.
    setAirThreshold: (bar) => send(`SET_AIR_THRESHOLD ${bar}`),
    setLoadingPosition: (pos) => send(`LOADPOS ${JSON.stringify(pos)}`),
    runProgram: (job) => send(`RUN_START ${JSON.stringify(job)}`),
    pauseRun: () => send('RUN_PAUSE'),
    resumeRun: () => send('RUN_RESUME'),
    abortRun: () => send('RUN_ABORT'),
    // Fault acknowledgement — tells the firmware the operator has resolved
    // the condition and the UI is ready to transition back to IDLE.
    clearFault: () => send('CLEAR_FAULT'),

    // Resume / discard an incomplete-state record on disk (master plan §3.2).
    // `choice` is one of "rerun" (redo the interrupted cell), "continue"
    // (skip to N+1), or "restart" (redo from cell 0). The backend kicks off
    // the run and deletes the state file once the operator confirms.
    resumeIncomplete: (choice) => send(`RESUME_INCOMPLETE ${choice}`),
    discardIncomplete: () => send('DISCARD_INCOMPLETE'),

    // USB program library (master plan §7.3). The backend scans the FAT32
    // stick mounted at /mnt/usb for *.gillis.json files and returns the
    // list; import pulls one back as JSON, export writes the named program
    // out.
    listUsbPrograms: () => send('USB_LIST'),
    importUsbProgram: (filename) => send(`USB_IMPORT ${filename}`),
    exportUsbProgram: (program) => send(`USB_EXPORT ${JSON.stringify(program)}`),

    // Persistent program library stored on the Pi (~/.gillis/programs.json).
    // Load on boot, save whenever the programs list changes. The backend
    // intercepts these — they never reach the Teensy.
    loadPrograms: () => send('PROGRAMS_LOAD'),
    savePrograms: (programs) => send(`PROGRAMS_SAVE ${JSON.stringify(programs)}`),
    // Persistent settings stored on the Pi (~/.gillis/settings.json). Mirrors
    // PROGRAMS_LOAD / PROGRAMS_SAVE — added because the firmware's EEPROM
    // round-trip for SET_TRAVEL / SET_AIR_THRESHOLD doesn't reliably echo
    // back, so the UI now treats the Pi as the source of truth across reboots.
    // SETMOTION / SET_TRAVEL / SET_AIR_THRESHOLD still fire in parallel so any
    // firmware build that DOES persist them stays in sync.
    loadSettings: () => send('SETTINGS_LOAD'),
    saveSettings: (settings) => send(`SETTINGS_SAVE ${JSON.stringify(settings)}`),
  };
}
