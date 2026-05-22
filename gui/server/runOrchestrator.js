// Pi-side RUN orchestrator.
//
// The Teensy firmware was rewritten (Rev4, master plan §8 phase 12) to hand
// the per-cell cell loop back to the Pi. The firmware no longer stores
// coordinates; it only tracks run lifecycle so it can tag faults with the
// current cellIndex. This module owns the actual "for each cell: MOVE →
// Z_DOWN → FIRE → Z_UP" loop.
//
// Contract with server/realSerial.js:
//   - The serial driver intercepts RUN_START / RUN_PAUSE / RUN_RESUME /
//     RUN_ABORT from the UI and hands them to this orchestrator.
//   - This module uses the driver's `send()` to issue MOVE / Z / FIRE
//     commands down to the Teensy, and the driver's `emit()` to surface
//     {type:'run', phase:...} events back to the UI.
//   - Non-run commands (STATUS, HOME, individual MOVE, etc.) bypass us
//     entirely.
//
// Events emitted to the UI (match the shape the mockSerial uses so the
// reducer in useMachine.jsx needs no changes):
//   {type:'run', phase:'start',   programName, mode, total}
//   {type:'run', phase:'cell',    index, total}
//   {type:'run', phase:'paused'}
//   {type:'run', phase:'resumed'}
//   {type:'run', phase:'moving_to_load'}   // post-run park to loadPos
//   {type:'run', phase:'done'}
//   {type:'run', phase:'aborted'}
//
// Firmware notifications:
//   - We send `RUN_START {totalCells, startIndex, programId, mode}` to the
//     Teensy so it can stamp faults with the right cell.
//   - After each completed cell we send `RUN_CELL_DONE <idx>` so the
//     firmware's run_state.h can advance its index (used for fault
//     tagging). The firmware ALSO echoes a `RUN phase=cell idx=N` event
//     when it receives RUN_CELL_DONE — realSerial.js drops those on the
//     floor because the orchestrator is the authoritative source of
//     per-cell progress for the UI and the firmware's 0-based idx in a
//     1-based UI world caused reticle-jump glitches.
//   - On normal finish: `RUN_COMPLETE`. On abort: `RUN_ABORT`.
//
// Safety: the orchestrator bails immediately if the driver disconnects
// mid-run, and ignores any RUN_* commands that arrive while a run is
// already active (apart from RUN_PAUSE / RUN_RESUME / RUN_ABORT, which
// target the current run).

const DEFAULT_START_POSITION = { x: 0, y: 0, z: 'UP' };

// =============================================================================
// PATTERN_ROTATION (Rev4.15, 2026-05-11)
// =============================================================================
// The physical cell module is mounted rotated 90° clockwise on the table
// relative to the pattern-editor's logical layout. The pattern editor still
// authors cells in the natural "cell 1 top-left, +X right, +Y away" frame
// — which keeps the visualisation, reticle, and operator's mental model
// straightforward — but the table motion has to drive in the rotated frame.
//
// The transform that takes a logical cell offset (cx, cy) to a physical
// machine offset (px, py) is a 90° CCW rotation of the coordinates (which
// is the inverse / passive-frame equivalent of an active 90° CW rotation
// of the module):
//
//   px = -cy
//   py =  cx
//
// Applied INSIDE the existing moving-table frame inversion, the cell
// position used to compute the MOVE target becomes:
//
//   tx = start.x - px = start.x - (-cy) = start.x + cy
//   ty = start.y - py = start.y -  cx   = start.y - cx
//
// Net behaviour verified by trace:
//   - cell 1 (0,0) → cell 2 (xSpacing,0): tx unchanged, ty drops by
//     xSpacing → machine Y- → table moves AWAY from operator ✓
//   - end of row 1 → first cell of row 2 (..., ySpacing): tx grows by
//     ySpacing → machine X+ → table moves RIGHT ✓
//   - reticle position in the UI follows the logical (cx, cy) — pattern
//     graphic stays as drawn, cell 1 top-left, no rotation visible to the
//     operator in the editor or run preview.
//
// To revert (un-rotate the module mounting): change rotateCellOffset()
// below to `({ x, y })`. To rotate the other way (180° / 270°): adjust
// the same function in isolation; this is the single source of truth.
//
// Operator implication: pick the program's startPosition such that, after
// rotation, the full grid fits in travel. With logical pattern coords
// ranging cx ∈ [0..(xCount-1)*xSpacing] and cy ∈ [0..(yCount-1)*ySpacing]:
//   tx sweeps [start.x, start.x + (yCount-1)*ySpacing]   → needs X headroom up
//   ty sweeps [start.y - (xCount-1)*xSpacing, start.y]   → needs Y headroom down
// Place the start such that the rotated grid sits inside the soft limits.
// =============================================================================
const rotateCellOffset = ({ x, y }) => ({ x: -y, y: x });

// Small helper: sleep(ms) that yields to the event loop.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// True when a per-cell command was rejected because the firmware was in
// STATE_PAUSED — i.e. an inflight pause raced our send. This happens on the
// abort path: handleAbort() in the UI sends RUN_PAUSE *first* (to freeze the
// run while the confirm dialog is up), and then RUN_ABORT when the operator
// confirms. If the WS message for RUN_PAUSE is processed by Node's macrotask
// queue *before* the readline data event carrying the previous step's DONE,
// RUN_PAUSE reaches the firmware before our next command (FIRE / Z UP / next
// MOVE), the firmware enters STATE_PAUSED, and our next command lands in a
// paused state machine which replies BUSY. That's not a fault — it's just a
// pause race — and surfacing it as the abort reason ("fire cell N failed:
// BUSY") confuses operators into thinking the laser misfired. Swallow BUSY
// during shutdown so the explicit RUN_ABORT's "user abort" reason wins.
const isPauseInducedBusy = (res) => /\bBUSY\b/i.test(res?.reply || '');

export function createRunOrchestrator({ send, emit }) {
  // State of the current run. `active` is true from the moment RUN_START
  // accepts until the runLoop has FULLY TERMINATED (not just until finish()
  // emits its terminal event). `token` is the symbol we use to detect when
  // an abort has been issued — every tight loop rechecks it so we can bail
  // without a shared flag.
  //
  // Why active stays true through wind-down (triple-fire fix):
  //   Previously `finish()` reset active=false synchronously, so a RUN_ABORT
  //   followed by an immediate RUN_START (exactly what React 18 StrictMode
  //   does on initial mount, plus any retry/refresh races on the UI side)
  //   would spawn a SECOND concurrent runLoop while the first was still
  //   awaiting its pre-move send() reply. Both loops would then march into
  //   cell 1 and issue FIRE — two fires on the first cell, not one.
  //
  //   We now track the runLoop's lifetime with `runLoopPromise`. `active`
  //   is cleared ONLY by the runLoop's finally block when it has truly
  //   exited. RUN_ABORT awaits that promise before returning, so by the
  //   time the UI's RUN_START retry lands, the prior runLoop is guaranteed
  //   done.
  let active = false;
  let paused = false;
  let token = null;
  let current = null; // { programId, programName, mode, startIndex, total }
  // Promise for the in-flight runLoop. Null when no run is active. Used by
  // RUN_ABORT to wait for the prior loop to fully exit before returning OK.
  let runLoopPromise = null;
  // Latch set by finish() so the runLoop's finally block knows the terminal
  // event has already been emitted and it mustn't emit a second one.
  let finishEmitted = false;
  // Track the last cell we announced so the abort phase can stamp it. The UI
  // persists this as the program's "resume point" — next run of the same
  // program offers "resume from cell N" vs "start over". Two stamp points:
  //   - TOP of iteration i: lastCellIndex = i  ("we're working on cell i+1")
  //   - BOTTOM of iteration i (after Z UP ok): lastCellIndex = i + 1
  //     ("we've finished through cell i+1; next cell to do is i+1")
  // The more recent stamp wins. An abort DURING a cell re-welds that cell
  // on resume; an abort BETWEEN cells resumes at the next one (skipping
  // completed work). Without the bottom stamp, aborts that landed in the
  // brief window between Z UP and the next iteration's top-stamp would
  // re-weld a cell that had already fully completed.
  let lastCellIndex = 0;

  function resetRunState() {
    active = false;
    paused = false;
    token = null;
    current = null;
    lastCellIndex = 0;
    finishEmitted = false;
  }

  async function waitWhilePaused() {
    while (paused && token !== null) {
      await sleep(120);
    }
  }

  async function runLoop(job) {
    const myToken = token;
    const coords = Array.isArray(job.coordinates) ? job.coordinates : [];
    const start = job.startPosition || DEFAULT_START_POSITION;
    const startIndex = Math.max(0, Number(job.resumeIndex) || 0);
    const total = coords.length;
    // Test runs drive the gantry + Z through the exact same cycle as a real
    // run, but skip the FIRE command entirely. This lets the operator rehearse
    // the full path on parts without welding anything.
    const testRun = !!job.testRun;

    // Rev4.4 — pneumatic hold durations. The UI stamps these onto the
    // RUN_START payload from the live motionSettings snapshot so the timing
    // a run uses is whatever was saved at the moment Start was tapped, even
    // if the operator later edits Settings. Default to 0 if missing (e.g.
    // older UI build) so existing deployments see no behaviour change.
    const preWeldHoldMs  = Math.max(0, Number(job.preWeldHoldMs)  || 0);
    const postWeldHoldMs = Math.max(0, Number(job.postWeldHoldMs) || 0);

    // Rev4.4 — end-of-run parking target. After the last cell's Z UP we move
    // the table back to the operator's loading position before flipping
    // the UI into "Program Complete". Skipped if the UI didn't send one
    // (or sent {0,0}, which homing.h also treats as "unset").
    const loadingPos = job.loadingPosition || null;

    // Bench-mode flag — when on, the very last cell's Z UP is sent fire-and-
    // forget instead of awaited. On a bench rig the Z-up sensor isn't always
    // wired, so the firmware never emits its DONE reply and the run would
    // otherwise hang at the last cell waiting for a confirmation that's
    // never coming. Every other cell's Z UP still waits — only the final
    // one is sent without confirmation because by then the next operation
    // is the post-run park-to-load (XY only, no Z) and the operator's
    // "Program Complete" overlay, neither of which needs Z UP to have
    // physically settled.
    const benchMode = !!job.benchMode;

    // Announce the run has begun, but flag it as 'moving' so the UI can hold
    // its "Moving to start position" loading overlay until the pre-move
    // actually completes. Only after the gantry arrives do we transition to
    // the real 'start' phase (which flips run.phase to 'running').
    emit({
      type: 'run',
      phase: 'moving',
      programName: job.programName || null,
      mode: job.mode || null,
      total,
    });

    // Park at the start position before the first cell so the tool is
    // parked over the expected origin for coord (0, 0). Uses the driver's
    // MOVE — which now resolves on DONE (see realSerial.js motion fix).
    if (typeof start.x === 'number' && typeof start.y === 'number') {
      const res = await send(`MOVE X${start.x} Y${start.y}`);
      if (token !== myToken) return finish('aborted');
      if (!res?.ok) return finish('aborted', `pre-move failed: ${res?.reply}`);
    }

    emit({
      type: 'run',
      phase: 'start',
      programName: job.programName || null,
      mode: job.mode || null,
      total,
    });

    for (let i = startIndex; i < total; i++) {
      if (token !== myToken) return finish('aborted');

      // TOP-of-iteration stamp: we're about to start work on cell (i+1).
      // An abort landing inside this iteration (mid-MOVE, mid-FIRE, etc.)
      // will resume at cell (i+1) — the one the operator stopped on.
      //
      // Stamped BEFORE waitWhilePaused() so a pause+abort that lands
      // between the previous cell's Z UP and this iteration's pause-point
      // still carries the correct "cell we were about to do" index.
      // Previously the stamp happened AFTER the pause gate, so a mid-gap
      // abort kept lastCellIndex at the PREVIOUS cell's number and resume
      // re-fired it first before reaching the aborted cell.
      lastCellIndex = i;
      emit({ type: 'run', phase: 'cell', index: i + 1, total });

      await waitWhilePaused();
      if (token !== myToken) return finish('aborted');

      const c = coords[i] || {};
      // Moving-table / fixed-gantry frame inversion, plus the 90° CW
      // physical-mounting rotation (see PATTERN_ROTATION at the top of
      // this file).
      //
      // The pattern editor authors cells in "logical cell-frame": cell 1
      // at (0,0), +X to the right of cell 1 in the UI, +Y away from cell 1
      // in the UI. That stays as-is for the visualisation and reticle.
      //
      // Before we apply the moving-table frame inversion, we rotate the
      // logical cell offset into the physical machine frame
      // (rotateCellOffset). Then on the physical machine the gantry is
      // fixed and the *table* moves under it — so bringing a cell that's
      // +X in the physical frame under the gantry requires the table to
      // move LEFT (machine X decreases, towards the X home switch at 0).
      // Likewise, +Y in the physical frame requires the table to move
      // AWAY from the operator (machine Y decreases, towards Y home at 0).
      //
      // Motor axis directions stay exactly as wired — jog X+ still moves
      // the table right, jog Y+ still moves it towards the operator. The
      // rotation only re-shapes how logical cell offsets map to physical
      // ones; the moving-table inversion is unchanged.
      const cLogical = {
        x: Number(c.x) || 0,
        y: Number(c.y) || 0,
      };
      const cPhysical = rotateCellOffset(cLogical);
      const tx = (Number(start.x) || 0) - cPhysical.x;
      const ty = (Number(start.y) || 0) - cPhysical.y;

      // 1) Move XY to the cell coordinate. Tagged with P=C so the firmware
      //    uses the cell-to-cell motion profile (slower / tuned for precision
      //    between welds). All other MOVE/JOG commands issued anywhere in
      //    the codebase default to the "fast" profile.
      //
      // waitWhilePaused() before each step (not just the top of the
      // iteration) so a RUN_PAUSE landing mid-cell — e.g. the UI's Abort
      // button auto-pauses before showing its confirm dialog — actually
      // pauses the firmware-facing send dispatch. Without this, the
      // orchestrator would charge through MOVE→Z→FIRE→Z UP even after
      // pause, and any of those commands could land at the firmware while
      // it's transitioned to STATE_PAUSED, replying BUSY. See
      // isPauseInducedBusy at the top of this file.
      await waitWhilePaused();
      if (token !== myToken) return finish('aborted');
      const mv = await send(`MOVE X${tx} Y${ty} P=C`);
      if (token !== myToken) return finish('aborted');
      if (!mv?.ok) {
        if (isPauseInducedBusy(mv)) return finish('aborted');
        return finish('aborted', `move cell ${i} failed: ${mv?.reply}`);
      }

      // 2) Z DOWN (pneumatic — near-instant, but the firmware still replies
      //    DONE once the ZD sensor asserts, so we do wait).
      await waitWhilePaused();
      if (token !== myToken) return finish('aborted');
      const zd = await send('Z DOWN');
      if (token !== myToken) return finish('aborted');
      if (!zd?.ok) {
        if (isPauseInducedBusy(zd)) return finish('aborted');
        return finish('aborted', `z-down cell ${i} failed: ${zd?.reply}`);
      }

      // 2a) PRE-WELD HOLD (Rev4.4). Give the pneumatic solenoid extra time to
      //     fully compress the weld head against the cell before the laser
      //     fires. Zero by default; tuned per-customer from the Settings
      //     screen. The job payload carries the value that was live at
      //     RUN_START so in-flight edits don't drift mid-run.
      if (preWeldHoldMs > 0) {
        await sleep(preWeldHoldMs);
        if (token !== myToken) return finish('aborted');
      }

      // 3) Fire the laser. FIRE blocks on the firmware side for dwell_ms
      //    ("Laser On Time") and replies DONE when the pulse is complete.
      //    Skipped on test runs — we still do the rest of the cycle so
      //    timing and motion match a real production run as closely as
      //    possible.
      //
      // This is the canonical pause point in the cycle — Z is fully down,
      // gantry is parked, the next thing that physically happens is the
      // laser pulse. Pause the orchestrator HERE before firing so a UI
      // Abort doesn't end up sending FIRE to a paused firmware.
      await waitWhilePaused();
      if (token !== myToken) return finish('aborted');
      if (!testRun) {
        const fr = await send('FIRE');
        if (token !== myToken) return finish('aborted');
        if (!fr?.ok) {
          if (isPauseInducedBusy(fr)) return finish('aborted');
          return finish('aborted', `fire cell ${i} failed: ${fr?.reply}`);
        }
      } else {
        // Brief dwell so Z_DOWN and Z_UP aren't back-to-back — mirrors the
        // rough shape of a weld cycle so the operator can gauge timing.
        await sleep(150);
        if (token !== myToken) return finish('aborted');
      }

      // 3a) POST-WELD HOLD (Rev4.4). Let the weld settle under clamp pressure
      //     before Z retracts. Zero by default.
      if (postWeldHoldMs > 0) {
        await sleep(postWeldHoldMs);
        if (token !== myToken) return finish('aborted');
      }

      // 4) Z UP — ready for the next cell or for unloading.
      //
      // NOTE: we DON'T waitWhilePaused() before Z UP. If the operator just
      // paused / aborted, the safest thing is to retract Z immediately so
      // the head isn't left pressed against the workpiece while the confirm
      // dialog is up. The firmware's Z UP handler doesn't gate on PAUSED
      // (only on FAULT_LOCKOUT / ESTOP), so this send will succeed even
      // while paused.
      //
      // Bench-mode shortcut: on the FINAL cell only, when bench mode is on,
      // issue Z UP without awaiting the firmware's DONE reply. The bench rig
      // typically lacks a wired Z-up sensor so the DONE never arrives and
      // the run would otherwise hang here forever. Every prior cell still
      // waits because the next iteration's MOVE assumes Z is physically
      // out of the way — only the last cell is safe to skip, because after
      // it the only remaining step is the XY park to loading position.
      const isLastCell = i === total - 1;
      if (benchMode && isLastCell) {
        // Fire-and-forget. If the reply does happen to arrive we just discard
        // it. We still issue the command so the firmware advances its own
        // state machine cleanly.
        send('Z UP').catch(() => {});
      } else {
        const zu = await send('Z UP');
        if (token !== myToken) return finish('aborted');
        if (!zu?.ok) {
          if (isPauseInducedBusy(zu)) return finish('aborted');
          return finish('aborted', `z-up cell ${i} failed: ${zu?.reply}`);
        }
      }

      // BOTTOM-of-iteration stamp: cell i has now FULLY completed (MOVE +
      // Z DOWN + FIRE + Z UP all OK). Advance lastCellIndex to i+1 so that
      // if RUN_ABORT lands in the brief window between this line and the
      // next iteration's top-of-loop stamp, the saved resumeIndex points
      // at the NEXT cell to do — not the one we just finished. Without
      // this stamp, an abort arriving right after Z UP would re-weld the
      // completed cell on resume (lastCellIndex still i from the top-of-
      // iteration stamp). Top-of-iter says "what we're working on"; here
      // we say "what we've finished through", and the more recent stamp
      // wins for the resume calculation.
      lastCellIndex = i + 1;

      // Tell the firmware that cell i is done so it can advance its index
      // (used by fault tagging). We no longer forward firmware's resulting
      // "RUN phase=cell" back to the UI — realSerial.js drops it, because
      // the orchestrator is the authoritative source of per-cell progress
      // events and the firmware's 0-based idx in a 1-based UI world caused
      // reticle-jump glitches (most visibly at the last cell, where it
      // landed AFTER phase=done and looked like a second-to-last re-fire).
      send(`RUN_CELL_DONE ${i}`).catch(() => {});
    }

    if (token !== myToken) return finish('aborted');

    // Rev4.4 — post-run park to loading position. Real runs AND test runs
    // both end here so the operator always gets the table back in front of
    // them for unload. The UI holds its "Moving to loading position" overlay
    // through this phase and only flips to "Program Complete" after the MOVE
    // resolves. We emit the phase BEFORE issuing the send so the reducer can
    // react immediately — the MOVE itself will take as long as the fast
    // profile + travel distance dictate.
    if (loadingPos &&
        typeof loadingPos.x === 'number' &&
        typeof loadingPos.y === 'number' &&
        (loadingPos.x !== 0 || loadingPos.y !== 0)) {
      emit({ type: 'run', phase: 'moving_to_load' });
      const park = await send(`MOVE X${loadingPos.x} Y${loadingPos.y}`);
      if (token !== myToken) return finish('aborted');
      // A failed park-to-load isn't fatal — the run itself completed cleanly.
      // Log it and move on so the UI still sees 'done' and the operator can
      // drive the table manually.
      if (!park?.ok) {
        // eslint-disable-next-line no-console
        console.warn('[run orchestrator] post-run park failed:', park?.reply);
      }
    }

    return finish('done');
  }

  // finish() emits the terminal run event. It does NOT reset active/token
  // any more — the runLoop's finally block owns that (so we can keep active
  // true until the loop has actually exited, blocking concurrent starts).
  // Safe to call multiple times; the finishEmitted latch suppresses dupes.
  function finish(phase, reason) {
    if (!active || finishEmitted) return;
    finishEmitted = true;
    if (phase === 'done') {
      send('RUN_COMPLETE').catch(() => {});
    }
    // Stamp the abort event with the last cell we announced plus the program
    // identity so the UI can offer "resume from cell N" on the next run.
    const payload = { type: 'run', phase };
    if (phase === 'aborted' && current) {
      payload.programId = current.programId;
      payload.programName = current.programName;
      payload.cellIndex = lastCellIndex; // 0-based, matches RUN_START.resumeIndex
      payload.total = current.total;
    }
    // Carry the abort reason through to the UI so operators see *why* a run
    // ended without having to SSH for /tmp/gillis-server.log. Examples:
    //   "move cell 1 failed: BUSY"     (Z not confirmed UP — see realSerial.js
    //                                   MOTION_COMMANDS note about Z race)
    //   "z-down cell 0 failed: ERROR timeout"
    //   "user abort"
    //   "loop threw: <message>"
    // Stamped on both 'aborted' and 'done' so an unexpected internal abort
    // never silently looks like a clean finish.
    if (reason) payload.reason = reason;
    emit(payload);
    // Invalidate the token so any await still pending inside runLoop bails
    // on its next `token !== myToken` check. active stays true until the
    // loop's finally block resets everything.
    token = null;
    // eslint-disable-next-line no-console
    if (reason) console.log('[run orchestrator]', phase, reason);
  }

  // -------------------------------------------------------------------
  // Public command handler
  // -------------------------------------------------------------------
  async function handle(verb, rest) {
    if (verb === 'RUN_START') {
      // Reject if a run is still active OR if the prior runLoop hasn't
      // finished winding down yet. The second check is what prevents the
      // "abort then immediately re-start" race (observed via React 18
      // StrictMode double-invoking the RunScreen mount effect) from spawning
      // two concurrent runLoops that would each FIRE at cell 1.
      if (active || runLoopPromise) {
        return { ok: false, reply: 'BUSY run in progress' };
      }
      let job;
      try {
        job = JSON.parse(rest || '{}');
      } catch (err) {
        return { ok: false, reply: `ERROR bad json (${err.message})` };
      }
      if (!Array.isArray(job.coordinates) || job.coordinates.length === 0) {
        return { ok: false, reply: 'ERROR no coordinates' };
      }

      const startIndex = Math.max(0, Number(job.resumeIndex) || 0);
      const total = job.coordinates.length;
      const programId = Number(job.programId) || Date.now() & 0x7fffffff;
      const modeToken = (job.mode || '').toString().toUpperCase().includes('POSITIVE')
        ? 'POSITIVE' : (job.mode || 'SPOT').toString().toUpperCase();

      // Tell the firmware a run is starting so it can tag faults. We don't
      // block on this — even if it fails (e.g. disconnected), the UI will
      // still see meaningful events from us.
      send(
        `RUN_START ${JSON.stringify({
          totalCells: total,
          startIndex,
          programId,
          mode: modeToken.slice(0, 7),
        })}`
      ).catch(() => {});

      active = true;
      paused = false;
      finishEmitted = false;
      token = Symbol('run');
      current = {
        programId,
        programName: job.programName || null,
        mode: job.mode || null,
        startIndex,
        total,
        testRun: !!job.testRun,
      };

      // Kick off the loop — events are emitted as it runs. runLoopPromise
      // tracks the lifetime so RUN_ABORT can await true termination and
      // RUN_START can reject while winding down.
      runLoopPromise = runLoop(job)
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[run orchestrator] loop error:', err);
          finish('aborted', err?.message || 'loop threw');
        })
        .finally(() => {
          resetRunState();
          runLoopPromise = null;
        });

      return { ok: true, reply: 'OK' };
    }

    if (verb === 'RUN_PAUSE') {
      if (!active) return { ok: false, reply: 'ERROR no run' };
      paused = true;
      emit({ type: 'run', phase: 'paused' });
      // Forward to firmware so its run_state knows we're paused (fault
      // tagging + SNAPSHOT reporting).
      send('RUN_PAUSE').catch(() => {});
      return { ok: true, reply: 'OK' };
    }

    if (verb === 'RUN_RESUME') {
      if (!active) return { ok: false, reply: 'ERROR no run' };
      paused = false;
      emit({ type: 'run', phase: 'resumed' });
      send('RUN_RESUME').catch(() => {});
      return { ok: true, reply: 'OK' };
    }

    if (verb === 'RUN_ABORT') {
      if (!active) return { ok: false, reply: 'ERROR no run' };
      // Forward the abort to firmware. RUN_ABORT already does stepper_stop_all()
      // on the firmware side and drops the machine cleanly to STATE_IDLE — it
      // does NOT raise a fault. Previously we also sent STOP here as a
      // belt-and-braces motion cut, but STOP maps to fault_trigger(USER_ABORT)
      // which slammed the firmware into STATE_FAULT_LOCKOUT. That in turn
      // caused the follow-up `setZ("UP")` + `moveTo(loadingPosition)` from
      // the UI's abort flow to be rejected (BUSY / ignored), leaving the
      // operator with frozen axes that only unstuck on a re-home. Aborting a
      // run is a planned operator action, not a fault — drop STOP entirely.
      send('RUN_ABORT').catch(() => {});
      finish('aborted', 'user abort');
      // Wait for the runLoop to exit, but cap the wait. The UI's abort flow
      // (Z UP + park to loading position) is gated on this return — without
      // a cap, an abort landing during `await send('FIRE')` (laser dwell)
      // or a postWeldHold sleep makes the "Aborting…" overlay sit for the
      // remainder of that step plus any other waits the loop accumulates,
      // which operators saw as a ~20 s freeze on production runs.
      //
      // The race protection against a rapid abort→restart still holds: the
      // RUN_START handler checks `if (active || runLoopPromise)` and active
      // stays true until the runLoop's finally block runs. So even if we
      // return OK here while the loop is still winding down, a new
      // RUN_START will be rejected with BUSY until the loop truly exits.
      // 1 s is enough headroom for the common case (in-flight MOVE / Z UP
      // resolving via the firmware's RUN_ABORT DONE emit) without ever
      // making the operator wait on a sleep or laser dwell.
      try {
        await Promise.race([
          runLoopPromise.catch(() => {}),
          new Promise((r) => setTimeout(r, 1000)),
        ]);
      } catch { /* already logged */ }
      return { ok: true, reply: 'OK' };
    }

    return null; // not a run command
  }

  function isRunCommand(verb) {
    return verb === 'RUN_START' || verb === 'RUN_PAUSE' ||
           verb === 'RUN_RESUME' || verb === 'RUN_ABORT';
  }

  function snapshot() {
    return {
      active,
      paused,
      current: current ? { ...current } : null,
    };
  }

  return { handle, isRunCommand, snapshot };
}
