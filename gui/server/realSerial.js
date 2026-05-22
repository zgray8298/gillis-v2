// Real USB-CDC serial link to the Teensy 4.1.
//
// Exposes the SAME shape as mockSerial.js — { send, snapshot, on, off } — so
// server/index.js doesn't care which driver is behind it. Activate with:
//
//     GILLIS_SERIAL=real npm run dev
//     GILLIS_PORT=/dev/ttyACM0   (optional, that's the default)
//     GILLIS_BAUD=115200         (optional, that's the default)
//
// Wire format (see teensy firmware/gillis_firmware/src/serial_protocol.h and
// telemetry.h). Lines are '\n'-terminated ASCII.
//
//   Replies (synchronous, one per command):
//     OK | DONE | BUSY | PONG | FAULT_STILL_ACTIVE
//     ERR <code> [message]
//     SNAPSHOT X<f> Y<f> Z<UP|DOWN|MID> AIR<f> DRIVERS<OK|DISABLED>
//              STATE<name> [FAULT<code>] SOLENOID<A|B|C>
//              MAXX<f> MAXY<f> TRAM<f> DWELL<i> HOMEBOOT<0|1>
//              RUN <inactive | active|paused cell=i/n programId=u>
//
//   Async events (periodic + edge-driven):
//     POSITION X<f> Y<f>            ~60 Hz while moving
//     AIR <f>                       every AIR_EVENT_INTERVAL_MS
//     SENSORS XH<01> YLH<01> YRH<01> ZU<01> ZD<01> XA<01> YLA<01> YRA<01>
//     LASER ON | LASER OFF
//     HOMED                         homing completed
//     ESTOP | ESTOP_CLEARED
//     FAULT <code> [cellIndex=N]
//     FAULT_CLEARED <code>
//     RUN phase=<started|cell|paused|resumed|aborted|done> [idx=N] [totalCells=N] ...
//
// A couple of firmware quirks handled below:
//   * MOVE / JOG reply "OK" synchronously and later emit a stand-alone "DONE"
//     when motion finishes. We resolve the send() promise on OK and drop the
//     orphan DONE on the floor (it has no command to attach to).
//   * SENSORS is a command that emits *only* a SENSORS event — no reply line.
//     We write it and resolve immediately.
//   * HOME sends "OK", then later "HOMED". We synthesise a {homing,phase:'start'}
//     event on the OK so the UI's busy flag flips in real time.

import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

const DEFAULT_PATH = process.env.GILLIS_PORT || '/dev/ttyACM0';
const DEFAULT_BAUD = Number(process.env.GILLIS_BAUD || 115200);
const RECONNECT_MS = 1500;
const REPLY_TIMEOUT_MS = 12_000;
// Pi→Teensy heartbeat (Rev4.1). Firmware's link watchdog trips at 2000 ms of
// rx silence *while a run is active*; 500 ms gives us 4x headroom against a
// one-off write stall. Raw PING reply (PONG) is handled silently — we only
// care that *some bytes* reach the Teensy and reset its dead-man timer.
const HEARTBEAT_MS = 500;
// Longer timeout for MOVE / JOG — a full-travel move can take several seconds
// and we don't want to prematurely give up on the cell loop.
const MOTION_REPLY_TIMEOUT_MS = 60_000;
// Z DOWN / Z UP timeout. Pneumatic solenoid + sensor confirmation; physical
// stroke is well under 2 s even with aggressive flow restrictors. Firmware's
// own Z_TIMEOUT_*_MS is 2000 ms — anything beyond ~3 s on the Pi side is dead
// time waiting for a DONE that's never coming (the firmware will have raised
// FAULT_Z_TIMEOUT_* already). 3500 ms gives 500 ms of slack past the firmware
// timeout, so the firmware fault arrives first and we resolve via that path
// rather than the JS-side timeout. Critical for abort responsiveness — using
// MOTION_REPLY_TIMEOUT_MS here would mean a 60 s wait after a USER_ABORT mid-Z.
const Z_REPLY_TIMEOUT_MS = 3_500;

// Commands that never elicit a reply line — just fire-and-forget.
const NO_REPLY_COMMANDS = new Set(['SENSORS']);

// Commands that reply "OK" synchronously (motion accepted) and emit a later
// "DONE" when the motion actually completes. For these, we swallow the OK
// and resolve the send() promise on DONE. This lets the orchestrator issue
// MOVE→Z→FIRE→Z in strict sequence without racing the motion planner.
// Commands where the firmware sends OK as a *sync ack* and then a later DONE
// when the physical motion completes. send() must wait for DONE to resolve so
// the orchestrator doesn't race ahead while motion is in flight.
//
// - MOVE / JOG: stepper trapezoidal move. OK on accept, DONE when steps done.
// - Z (covers "Z DOWN" / "Z UP" — verb-tokenizer takes the first whitespace
//   field so both map to 'Z'): solenoid kicks immediately and replies OK,
//   then DONE is emitted from z_update() only after sensors.zDown/zUp asserts
//   (firmware/src/z_control.h:110/121). Without Z in this set send() resolves
//   on the OK while the actuator is still travelling — fine for fast pneumatic
//   Z (DOWN is air-driven and quick), but Z UP is spring-return and can take
//   ~1 s with flow restrictors fitted. The next iteration's MOVE then fires
//   into a Z that isn't confirmed UP, so z_safe() is false and the MOVE gets
//   BUSY-rejected → the run aborts on cell 2 with "move cell 1 failed: BUSY".
//   Adding 'Z' here makes Z DOWN / Z UP behave like MOVE / JOG and waits for
//   the DONE that fires when the sensor actually asserts.
const MOTION_COMMANDS = new Set(['MOVE', 'JOG', 'Z']);

// Recognised event-line prefixes. Any line matching one of these is dispatched
// as an event, *not* used to resolve the pending send() promise.
const EVENT_PREFIXES = [
  'POSITION ', 'AIR ', 'SENSORS ', 'LASER ',
  'FAULT_CLEARED ', 'FAULT ',
  'RUN ',
];
const EVENT_EXACT = new Set(['HOMED', 'ESTOP', 'ESTOP_CLEARED']);

// ---------------------------------------------------------------------------
// Line parsers — each returns a patch object applied to state + a UI event
// ---------------------------------------------------------------------------
function parsePosition(line) {
  // "POSITION X120.50 Y85.25"
  const m = line.match(/^POSITION\s+X(-?\d+(?:\.\d+)?)\s+Y(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

function parseAir(line) {
  const m = line.match(/^AIR\s+(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function parseSensors(line) {
  // "SENSORS XH1 YLH0 YRH0 ZU1 ZD0 XA0 YLA0 YRA0"
  const pick = (tag) => {
    const re = new RegExp(`\\b${tag}([01])\\b`);
    const m = line.match(re);
    return m ? m[1] === '1' : undefined;
  };
  const out = {};
  const map = [
    ['xHome',      'XH' ],
    ['yLeftHome',  'YLH'],
    ['yRightHome', 'YRH'],
    ['zUp',        'ZU' ],
    ['zDown',      'ZD' ],
    ['xAlm',       'XA' ],
    ['yLeftAlm',   'YLA'],
    ['yRightAlm',  'YRA'],
  ];
  for (const [k, tag] of map) {
    const v = pick(tag);
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function parseRun(line) {
  // "RUN phase=cell idx=3" or "RUN phase=started programId=7 totalCells=40 startIndex=0 mode=SPOT"
  const rest = line.slice(4);
  const get = (key) => {
    const m = rest.match(new RegExp(`\\b${key}=([^\\s]+)`));
    return m ? m[1] : undefined;
  };
  const phaseRaw = get('phase');
  if (!phaseRaw) return null;
  // Firmware's phase names vs the UI reducer's phase names:
  const phaseMap = {
    started: 'start',
    cell:    'cell',
    paused:  'paused',
    resumed: 'resumed',
    aborted: 'aborted',
    done:    'done',
  };
  const phase = phaseMap[phaseRaw] || phaseRaw;
  const out = { phase };
  const idx = get('idx');
  const tot = get('totalCells');
  const mode = get('mode');
  const pid  = get('programId');
  if (idx !== undefined)  out.index = Number(idx);
  if (tot !== undefined)  out.total = Number(tot);
  if (mode !== undefined) out.mode = mode;
  if (pid !== undefined)  out.programId = Number(pid);
  return out;
}

function parseSnapshot(line) {
  // "SNAPSHOT X0.00 Y0.00 ZUP AIR6.12 DRIVERSOK STATEIDLE SOLENOIDA
  //  MAXX910.0 MAXY1170.0 TRAM0.000 DWELL50 HOMEBOOT0 RUN inactive"
  const get = (pattern) => {
    const m = line.match(pattern);
    return m ? m[1] : undefined;
  };
  const patch = {};
  const x = get(/\bX(-?\d+(?:\.\d+)?)/);
  const y = get(/\bY(-?\d+(?:\.\d+)?)/);
  // Z comes as ZUP / ZDOWN / ZMID — anchor to a word boundary so we don't
  // collide with "STATEWELDING" or the like.
  const zm = line.match(/\bZ(UP|DOWN|MID)\b/);
  // AIR matches the live pressure reading. AIRTHRESH (more specific) must be
  // tested FIRST so the generic AIR regex doesn't gobble the threshold field
  // by accident — both happen to share the same `AIR` prefix on the wire.
  const airthresh = get(/\bAIRTHRESH(-?\d+(?:\.\d+)?)/);
  const air = get(/\bAIR(?!THRESH)(-?\d+(?:\.\d+)?)/);
  const drivers = get(/\bDRIVERS(OK|DISABLED)/);
  const state = get(/\bSTATE([A-Z_]+)/);
  const maxX = get(/\bMAXX(-?\d+(?:\.\d+)?)/);
  const maxY = get(/\bMAXY(-?\d+(?:\.\d+)?)/);
  const tram = get(/\bTRAM(-?\d+(?:\.\d+)?)/);
  const dwell = get(/\bDWELL(\d+)/);
  const preWeld  = get(/\bPREWELD(\d+)/);
  const postWeld = get(/\bPOSTWELD(\d+)/);
  const homeboot = get(/\bHOMEBOOT([01])/);
  const benchmode = get(/\bBENCHMODE([01])/);
  const fault = get(/\bFAULT([A-Z_]+)/);

  if (x !== undefined || y !== undefined || zm) {
    patch.position = {};
    if (x !== undefined) patch.position.x = parseFloat(x);
    if (y !== undefined) patch.position.y = parseFloat(y);
    if (zm) patch.position.z = zm[1];
  }
  if (air !== undefined) patch.airPressureBar = parseFloat(air);
  // The low-air threshold (EEPROM-backed via SET_AIR_THRESHOLD) is reported
  // as AIRTHRESH<bar>. Without surfacing it here the UI's airThresholdDraft
  // would always re-initialise to the compile-time default (~4.1 bar) on
  // reload even after a successful Save, which is what the operator sees as
  // "air threshold doesn't save". Older firmware that doesn't emit this
  // field just leaves the value at the local default — same as before.
  if (airthresh !== undefined) patch.airThresholdBar = parseFloat(airthresh);
  if (drivers) patch.driversEnabled = drivers === 'OK';
  if (state) {
    patch.busy = state !== 'IDLE';
    patch._state = state; // internal — useful for debugging
  }
  if (maxX !== undefined || maxY !== undefined) {
    patch.travelLimits = {};
    if (maxX !== undefined) patch.travelLimits.maxX = parseFloat(maxX);
    if (maxY !== undefined) patch.travelLimits.maxY = parseFloat(maxY);
  }
  if (tram !== undefined)  patch.gantryOffsetMm = parseFloat(tram);
  if (dwell !== undefined || preWeld !== undefined || postWeld !== undefined) {
    patch.motionSettings = {};
    if (dwell    !== undefined) patch.motionSettings.zDownDwell     = parseInt(dwell, 10);
    if (preWeld  !== undefined) patch.motionSettings.preWeldHoldMs  = parseInt(preWeld, 10);
    if (postWeld !== undefined) patch.motionSettings.postWeldHoldMs = parseInt(postWeld, 10);
  }
  if (homeboot !== undefined) patch.homeOnBoot = homeboot === '1';
  if (benchmode !== undefined) patch.benchMode = benchmode === '1';
  if (fault) patch._fault = fault;

  return patch;
}

// ---------------------------------------------------------------------------
// Driver factory
// ---------------------------------------------------------------------------
export function createRealSerial({ path = DEFAULT_PATH, baudRate = DEFAULT_BAUD } = {}) {
  const emitter = new EventEmitter();

  // Cached state — mirrors mockSerial's snapshot shape so the UI can rehydrate
  // straight from it.
  const state = {
    connected: false,
    homed: false,
    busy: false,
    driversEnabled: false,
    position: { x: 0, y: 0, z: 'UP' },
    airPressureBar: 6.0,
    laser: 'OFF',
    health: { teensy: 'Disconnected', drivers: 'Unknown', air: 'Unknown' },
    runtime: { machineHours: 0, sessionHours: 0 },
    motionSettings: {
      xSpeed: 120, ySpeed: 120, xAccel: 500, yAccel: 500,
      cellXSpeed: 60, cellYSpeed: 60, cellXAccel: 250, cellYAccel: 250,
      zDownDwell: 50, preWeldHoldMs: 0, postWeldHoldMs: 0,
    },
    gantryOffsetMm: 0,
    loadingPosition: { x: 305, y: 585, z: 'UP' },
    homeOnBoot: false,
    benchMode: false,
    travelLimits: { maxX: 910, maxY: 1170 },
    sensors: {
      xHome: false, yLeftHome: false, yRightHome: false,
      zUp: false,  zDown: false,
      xAlm: false, yLeftAlm: false, yRightAlm: false,
    },
  };

  // Runtime bookkeeping — matches the mock so session-hours ticks on the UI.
  setInterval(() => { state.runtime.sessionHours += 1 / 3600; }, 1000);

  // Pending sends, in FIFO order. Each entry: { resolve, timer, command }.
  const pending = [];
  let port = null;
  let reconnectTimer = null;
  // Rev4.1 — periodic PING while the port is open so the firmware's link
  // watchdog sees continuous rx activity and doesn't trip mid-RUN.
  let heartbeatTimer = null;
  // Track the verb of the most recently-sent command so we can synthesise
  // {homing, phase:'start'} on a HOME → OK round-trip.
  let lastVerb = null;

  function snapshot() {
    // Deep clone so callers can't mutate our cache.
    return JSON.parse(JSON.stringify(state));
  }

  function emit(evt) {
    emitter.emit('event', evt);
  }

  function setTeensyHealth(v) {
    if (state.health.teensy === v) return;
    state.health.teensy = v;
    state.connected = v === 'Connected';
    // On disconnect we can't trust position or homing status — the operator
    // may have re-plugged, the Teensy may have rebooted, the gantry may have
    // been pushed by hand. Clear `homed` and `busy` so the UI shows
    // "NOT HOMED" everywhere and the operator is forced through a fresh
    // homing cycle before any motion is permitted.
    if (v === 'Disconnected') {
      state.homed = false;
      state.busy = false;
    }
    // Nudge the UI — it will merge health from the snapshot payload.
    emit({ type: 'snapshot', state: snapshot() });
  }

  function resolveReply(result) {
    if (pending.length === 0) return false;
    const entry = pending.shift();
    clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  }

  // Peek the head of the pending queue without removing it — used by the OK
  // handler to decide whether we're looking at a sync ack for a motion
  // command (keep pending, wait for DONE) or a terminal reply (resolve now).
  function peekPending() {
    return pending.length ? pending[0] : null;
  }

  // -------------------------------------------------------------------------
  // Line dispatch
  // -------------------------------------------------------------------------
  function handleLine(raw) {
    const line = String(raw).replace(/\r$/, '').trim();
    if (!line) return;

    // TEMP DIAGNOSTIC for the homing-flash regression (#66) — logs every
    // serial line with a millisecond timestamp so we can see ordering of
    // OK / HOMED / SNAPSHOT / FAULT around a homing cycle.
    // eslint-disable-next-line no-console
    console.log('[SERIAL]', Date.now(), '<<', line);

    // ---- EVENTS (no reply resolution) ----
    if (EVENT_EXACT.has(line)) {
      if (line === 'HOMED') {
        state.homed = true;
        state.busy = false;
        emit({ type: 'homing', phase: 'done' });
      } else if (line === 'ESTOP') {
        emit({ type: 'estop' });
      } else if (line === 'ESTOP_CLEARED') {
        emit({ type: 'estop_cleared' });
      }
      return;
    }

    for (const prefix of EVENT_PREFIXES) {
      if (line.startsWith(prefix)) {
        switch (prefix) {
          case 'POSITION ': {
            const pos = parsePosition(line);
            if (pos) {
              state.position = { ...state.position, ...pos };
              emit({ type: 'position', position: pos });
            }
            return;
          }
          case 'AIR ': {
            const bar = parseAir(line);
            if (Number.isFinite(bar)) {
              state.airPressureBar = bar;
              // Roughly match the mock's health threshold so the TopStatusBar's
              // air pill stays green when pressure is sane.
              state.health.air = bar >= 4.0 ? 'OK' : 'Low';
              emit({ type: 'air', bar });
            }
            return;
          }
          case 'SENSORS ': {
            const sensors = parseSensors(line);
            const prevZ = state.position.z;
            Object.assign(state.sensors, sensors);
            // Firmware doesn't emit POSITION events for Z — it lives on the
            // sensors event. Derive position.z so TopStatusBar and Loading
            // Position screens reflect Z_UP/Z_DOWN in real time.
            let nextZ = prevZ;
            if (state.sensors.zUp)        nextZ = 'UP';
            else if (state.sensors.zDown) nextZ = 'DOWN';
            else                          nextZ = 'MID';
            if (nextZ !== prevZ) {
              state.position.z = nextZ;
              emit({ type: 'position', position: { z: nextZ } });
            }
            emit({ type: 'sensors', sensors });
            return;
          }
          case 'LASER ': {
            const on = line.endsWith('ON');
            state.laser = on ? 'FIRING' : 'OFF';
            emit({ type: 'laser', state: state.laser });
            return;
          }
          case 'FAULT_CLEARED ': {
            const code = line.slice('FAULT_CLEARED '.length).trim();
            emit({ type: 'fault_cleared', code });
            return;
          }
          case 'FAULT ': {
            // "FAULT <code> [cellIndex=N]" — but beware, HOMING_TIMEOUT ships
            // as a bare "FAULT HOMING_TIMEOUT" from homing.h.
            const rest = line.slice('FAULT '.length).trim();
            const parts = rest.split(/\s+/);
            const code = parts[0];
            const ci = rest.match(/cellIndex=(-?\d+)/);
            const evt = { type: 'fault', code };
            if (ci) evt.cellIndex = Number(ci[1]);
            emit(evt);
            state.busy = false;
            return;
          }
          case 'RUN ': {
            const r = parseRun(line);
            // The Pi-side runOrchestrator is the authoritative source of
            // per-cell progress events (it knows the 1-based UI index plus
            // the total count). The firmware also emits `RUN phase=cell
            // idx=N` in response to our RUN_CELL_DONE, but that idx is
            // 0-based and arrives AFTER the orchestrator has already
            // advanced — for the LAST cell it arrives after `phase=done`,
            // which would drop the reticle back onto cell (total-1),
            // flip run.phase from 'complete' back to 'running', and make
            // the UI look like the machine just re-fired the second-to-last
            // cell. For every OTHER cell it briefly shows the PREVIOUS
            // cell between iterations. Drop firmware phase=cell events on
            // the floor — the orchestrator already covers this.
            if (r && r.phase !== 'cell') emit({ type: 'run', ...r });
            return;
          }
        }
      }
    }

    // ---- SNAPSHOT (update state; if a STATUS is pending, resolve it) ----
    if (line.startsWith('SNAPSHOT')) {
      const patch = parseSnapshot(line);
      if (patch.position)       state.position        = { ...state.position, ...patch.position };
      if ('airPressureBar' in patch) state.airPressureBar = patch.airPressureBar;
      if ('driversEnabled' in patch) state.driversEnabled = patch.driversEnabled;
      if ('busy' in patch)           state.busy            = patch.busy;
      if (patch.travelLimits)   state.travelLimits    = { ...state.travelLimits, ...patch.travelLimits };
      if ('gantryOffsetMm' in patch) state.gantryOffsetMm = patch.gantryOffsetMm;
      if (patch.motionSettings) state.motionSettings  = { ...state.motionSettings, ...patch.motionSettings };
      if ('homeOnBoot' in patch) state.homeOnBoot      = patch.homeOnBoot;
      if ('benchMode' in patch)  state.benchMode        = patch.benchMode;

      // Rebroadcast the snapshot — cheap, keeps the UI coherent even if the
      // STATUS wasn't in response to an explicit user request.
      emit({ type: 'snapshot', state: snapshot() });

      if (!resolveReply({ ok: true, reply: line, state: snapshot() })) {
        // Orphan snapshot (unsolicited). Already re-broadcast above.
      }
      return;
    }

    // ---- REPLIES (resolve pending) ----
    if (line === 'OK') {
      const head = peekPending();
      // MOVE / JOG: "OK" is a sync ack ("accepted, motion starting"). We
      // DON'T resolve yet — we wait for DONE so the caller knows motion has
      // actually finished before issuing the next step in the cell loop.
      if (head && head.awaitingDone) {
        state.busy = true;
        return;
      }
      // HOME: still resolves on OK (matches the historical contract — the
      // UI tracks completion via the HOMED event, not the send() promise).
      // But we synthesise a 'homing,start' event so busy flips immediately.
      if (lastVerb === 'HOME' && !state.busy) {
        state.busy = true;
        emit({ type: 'homing', phase: 'start' });
      }
      resolveReply({ ok: true, reply: 'OK' });
      return;
    }
    if (line === 'DONE') {
      // DONE can be either a sync reply (FIRE, Z UP/DOWN, SETMOTION, ...)
      // or an async motion-complete for a previously-OK'd MOVE / JOG.
      // Either way, if something is pending, DONE resolves it.
      //
      // Clear `busy` here too — without this it's set true by motion-OK
      // (awaitingDone path above) and then never falls back to false,
      // because nothing else in the line dispatch resets it. That left the
      // top-bar busy spinner stuck on after any move and made
      // `if (lastVerb==='HOME' && !state.busy)` synthesise nothing on the
      // next HOME, which broke the UI's homing-overlay flow on the very
      // next button press. Periodic SNAPSHOTs would eventually correct it,
      // but we don't poll STATUS; the UI does.
      state.busy = false;
      if (!resolveReply({ ok: true, reply: 'DONE' })) {
        // Orphan — no pending. Drop it.
      }
      return;
    }
    if (line === 'PONG') {
      // Heartbeat PONGs bypass the pending queue (see open()) so the default
      // is to drop them. If a caller ever did send('PING') explicitly, the
      // head of the queue would be a PING — only then do we resolve.
      const head = peekPending();
      if (head && head.verb === 'PING') {
        resolveReply({ ok: true, reply: 'PONG' });
      }
      return;
    }
    if (line === 'BUSY') {
      resolveReply({ ok: false, reply: 'BUSY' });
      return;
    }
    if (line === 'FAULT_STILL_ACTIVE') {
      resolveReply({ ok: false, reply: 'FAULT_STILL_ACTIVE' });
      return;
    }
    if (line.startsWith('ERR ')) {
      resolveReply({ ok: false, reply: line });
      return;
    }

    // Anything else — probably a version string from VERSION, or a diagnostic
    // the firmware spits out. If a send is pending, use it as the reply; else
    // log and discard.
    if (!resolveReply({ ok: true, reply: line })) {
      // eslint-disable-next-line no-console
      console.log('[gillis serial] unhandled line:', line);
    }
  }

  // -------------------------------------------------------------------------
  // Port lifecycle
  // -------------------------------------------------------------------------
  function rejectAllPending(reason) {
    while (pending.length) {
      const entry = pending.shift();
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, reply: reason });
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(open, RECONNECT_MS);
  }

  function open() {
    clearTimeout(reconnectTimer);
    let p;
    try {
      p = new SerialPort({ path, baudRate, autoOpen: false });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[gillis serial] failed to construct SerialPort(${path}): ${e.message}`);
      scheduleReconnect();
      return;
    }
    port = p;

    const parser = p.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (line) => handleLine(line));

    p.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[gillis serial] error:', err.message);
    });

    p.on('close', () => {
      // eslint-disable-next-line no-console
      console.log('[gillis serial] closed');
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      rejectAllPending('ERROR disconnected');
      setTeensyHealth('Disconnected');
      port = null;
      scheduleReconnect();
    });

    p.open((err) => {
      if (err) {
        // Common on the Pi when the Teensy isn't plugged in yet — retry silently.
        // eslint-disable-next-line no-console
        console.log(`[gillis serial] ${path} not available (${err.code || err.message}), retrying in ${RECONNECT_MS}ms`);
        port = null;
        scheduleReconnect();
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`[gillis serial] opened ${path} @ ${baudRate}`);
      setTeensyHealth('Connected');
      // Give the Teensy a moment to settle after USB enumeration, then ask
      // for a fresh snapshot so the UI rehydrates immediately.
      setTimeout(() => {
        send('STATUS').catch(() => {});
        send('SENSORS').catch(() => {});
      }, 250);
      // Rev4.1 heartbeat: keep the Teensy's link watchdog happy. We write raw
      // PING bytes directly rather than going through send() — we don't want
      // to queue 2 pending entries/second with 12s timeouts, and we don't
      // care about the PONG reply (handleLine's resolveReply silently drops
      // it when nothing's pending). Firmware timeout is 2000 ms during RUN;
      // 500 ms gives us 4x headroom against a one-off write stall.
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (port && port.isOpen && port.writable) {
          port.write('PING\n', (err) => {
            // Ignore — a failed write means the port is about to close,
            // which the 'close' handler will deal with.
            void err;
          });
        }
      }, HEARTBEAT_MS);
    });
  }

  // -------------------------------------------------------------------------
  // send() — queues the command, resolves on the matching reply line
  // -------------------------------------------------------------------------
  function send(command) {
    return new Promise((resolve) => {
      const cmd = String(command || '').trim();
      if (!cmd) return resolve({ ok: false, reply: 'ERROR empty command' });

      // Remember the verb for post-reply side effects (HOME → emit homing start)
      const verb = cmd.split(/\s+/, 1)[0].toUpperCase();
      lastVerb = verb;

      // TEMP DIAGNOSTIC (#66) — every command going down to the Teensy.
      // eslint-disable-next-line no-console
      console.log('[SERIAL]', Date.now(), '>>', cmd);

      if (!port || !port.isOpen) {
        return resolve({ ok: false, reply: 'ERROR not connected' });
      }

      // SENSORS only emits the SENSORS event — no reply line to wait for.
      if (NO_REPLY_COMMANDS.has(verb)) {
        port.write(cmd + '\n');
        return resolve({ ok: true, reply: 'OK' });
      }

      const awaitingDone = MOTION_COMMANDS.has(verb);
      // MOVE/JOG can take many seconds; Z is bounded by the firmware's 2 s
      // sensor timeout; everything else falls back to the generic 12 s.
      let timeoutMs;
      if (verb === 'Z') timeoutMs = Z_REPLY_TIMEOUT_MS;
      else if (awaitingDone) timeoutMs = MOTION_REPLY_TIMEOUT_MS;
      else timeoutMs = REPLY_TIMEOUT_MS;
      const timer = setTimeout(() => {
        const idx = pending.findIndex((p) => p.timer === timer);
        if (idx !== -1) {
          pending.splice(idx, 1);
          resolve({ ok: false, reply: 'ERROR timeout' });
        }
      }, timeoutMs);

      pending.push({ resolve, timer, command: cmd, verb, awaitingDone });
      port.write(cmd + '\n', (err) => {
        if (err) {
          const idx = pending.findIndex((p) => p.timer === timer);
          if (idx !== -1) {
            pending.splice(idx, 1);
            clearTimeout(timer);
            resolve({ ok: false, reply: `ERROR write ${err.message}` });
          }
        }
      });
    });
  }

  // First attempt — will quietly retry if the Teensy isn't plugged in yet.
  // (Rev4.1 heartbeat installed in open() — see above.)
  open();

  return {
    send,
    snapshot,
    on:  (ev, fn) => emitter.on(ev, fn),
    off: (ev, fn) => emitter.off(ev, fn),
    // Let higher-level pieces (the RUN orchestrator) inject events into the
    // same stream the UI subscribes to. Keeps run-lifecycle telemetry
    // indistinguishable from firmware-sourced events on the wire.
    emitEvent: emit,
  };
}
