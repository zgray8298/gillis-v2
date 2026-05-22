import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MachineProvider, useMachine } from "./lib/useMachine.jsx";
import { Loading, LoadingOverlay } from "./components/Loading.jsx";
import RingSpinner from "./components/RingSpinner.jsx";
import SignalPulse from "./components/SignalPulse.jsx";
import ElectronField from "./components/ElectronField.jsx";

/* ---------------------- ABORT-POINT PERSISTENCE --------------------------- */
/*
 * A run that the operator aborts mid-way saves its last-completed cell under
 * the program's name in localStorage. The next time the same program is
 * launched, the RunScreen surfaces a "Resume from cell N / Start from
 * beginning" prompt so the operator doesn't have to re-weld earlier cells.
 *
 * Keyed by programName because `activeRun` doesn't carry a stable programId in
 * the Production/Programs launch paths — but names are unique in the program
 * library so this is safe in practice. Entries are cleared when the matching
 * program completes cleanly, or when the operator chooses "Start over".
 */
const ABORT_POINTS_KEY = "gillis.abortPoints.v1";
const readAbortStore = () => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ABORT_POINTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
};
const writeAbortStore = (obj) => {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(ABORT_POINTS_KEY, JSON.stringify(obj)); }
  catch { /* quota / security — ignore */ }
};
export const getAbortPoint = (programName) => {
  if (!programName) return null;
  const obj = readAbortStore();
  return obj[programName] || null;
};
export const saveAbortPoint = (programName, entry) => {
  if (!programName) return;
  const obj = readAbortStore();
  obj[programName] = { ...entry, ts: Date.now() };
  writeAbortStore(obj);
};
export const clearAbortPoint = (programName) => {
  if (!programName) return;
  const obj = readAbortStore();
  if (!(programName in obj)) return;
  delete obj[programName];
  writeAbortStore(obj);
};

/* ---------------------- TOUCHSCREEN DRAG-SCROLL HOOK ---------------------- */
/*
 * useDragScroll returns a CALLBACK REF you can attach to any scrollable
 * element. Dragging anywhere inside that element — touch or mouse — scrolls
 * it. Clicks on buttons still work because we only start scrolling once a
 * small per-axis movement threshold has been crossed; descendants with
 * `data-no-drag` opt out entirely (e.g. sliders, jog pads, keypad-trigger
 * boxes on Settings).
 *
 * Why a callback ref and not the more familiar useRef + useEffect:
 *   The Settings screen renders the embedded keypad CONDITIONALLY in place
 *   of its scrolling cards. Opening the keypad unmounts the cards; closing
 *   it remounts them. With a useRef + useEffect pattern, the effect ran
 *   ONCE at mount with the original DOM element, attached listeners to
 *   that element, and then never re-attached when the element was replaced.
 *   The "phantom" listeners stayed bound to the now-detached node and the
 *   live cards had no listeners — so drag-scroll worked on first load and
 *   silently died after the first edit. Callback refs are invoked by React
 *   on every mount/unmount, which lets us re-attach listeners cleanly.
 *
 * Designed for the Pi touchscreen where the native scrollbar is hidden.
 */
function useDragScroll({ axis = "y" } = {}) {
  // Holds the cleanup fn for whichever element is currently bound.
  const cleanupRef = useRef(null);

  const setRef = useCallback((el) => {
    // Detach from the previous element (if any) before binding the new one.
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (!el) return;

    let active = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;
    let pointerId = null;

    // px before we consider it a drag (not a tap). The Pi's capacitive
    // touchscreen registers significant wobble during a "stationary" finger
    // tap (12 px wasn't enough — operators still couldn't open keypad boxes).
    // We bumped to 20 AND restricted the threshold check to movement along
    // the scroll axis only (a Y-scroller doesn't care if the finger wobbles
    // horizontally; that's never going to scroll the card and shouldn't
    // suppress a tap). Real swipes are well above this — the program-list
    // drag-scroll case from #61 typically moves 50+ px in the scroll axis.
    const THRESHOLD = 20;

    const shouldIgnore = (target) => {
      if (!target || !(target instanceof Element)) return false;
      // Form inputs, sliders, and explicit opt-out subtrees handle their own
      // pointer gestures and must NOT be hijacked by drag-scroll.
      //
      // Buttons are intentionally NOT in this list. The Pi touchscreen has
      // dense lists of program buttons (Production / Programs screens)
      // where the operator's only way to scroll the list is to drag from
      // a button surface — there's no scrollbar and no margin. The 20 px
      // movement threshold below distinguishes a tap (no movement → click
      // fires normally) from a drag (movement → click suppressed by
      // onClickCapture so the underlying button doesn't activate). Net
      // effect: tap to select, drag to scroll, both work even on a list
      // that's 100% buttons.
      return !!target.closest(
        "[data-no-drag], input, textarea, select, [role='slider']"
      );
    };

    const onDown = (e) => {
      if (shouldIgnore(e.target)) return;
      active = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      startScrollLeft = el.scrollLeft;
      startScrollTop = el.scrollTop;
      // Stash the pointerId for later — DON'T call setPointerCapture yet.
      // Capturing the pointer at pointerdown breaks the synthesised click on
      // some touchscreen browsers (Chromium on the Pi for sure) because the
      // capture target is the scroll container, not the button under the
      // finger. We only want the capture if the gesture turns into a real
      // drag, in which case it's safe — by then we've already decided to
      // scroll, not click. See onMove below.
      pointerId = e.pointerId;
    };

    const onMove = (e) => {
      if (!active) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Only count movement along the scroll axis as drag intent. Wobble
      // perpendicular to the scroll direction will never produce visible
      // scroll, so it shouldn't tip the gesture into "drag" and suppress the
      // tap. axis="y" → only |dy| matters; axis="x" → only |dx| matters.
      // Falls back to euclidean distance if axis is unknown.
      const relevant =
        axis === "y" ? Math.abs(dy) :
        axis === "x" ? Math.abs(dx) :
        Math.hypot(dx, dy);
      if (!moved && relevant < THRESHOLD) return;
      // First crossing of the drag threshold — *now* it's safe to claim the
      // pointer (the user has clearly started a drag, not a tap). Capturing
      // here lets us keep tracking the gesture if the finger leaves the
      // scroll container, without sabotaging any tap that was just a wobbly
      // stationary press.
      if (!moved && pointerId != null) {
        try { el.setPointerCapture(pointerId); } catch {}
      }
      moved = true;
      if (axis !== "x") el.scrollTop = startScrollTop - dy;
      if (axis !== "y") el.scrollLeft = startScrollLeft - dx;
    };

    const finish = () => {
      if (pointerId != null) {
        try { el.releasePointerCapture(pointerId); } catch {}
        pointerId = null;
      }
      active = false;
    };

    // If we actually dragged, swallow the synthesized click so we don't
    // accidentally trigger a button we slid off of.
    const onClickCapture = (e) => {
      if (moved) {
        e.stopPropagation();
        e.preventDefault();
        moved = false;
      }
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
    el.addEventListener("click", onClickCapture, true);

    cleanupRef.current = () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", finish);
      el.removeEventListener("pointercancel", finish);
      el.removeEventListener("click", onClickCapture, true);
    };
  }, [axis]);

  return setRef;
}

/*
 * DragScroll wraps children in a div that uses useDragScroll. Useful when you
 * just need a scrolling container without wiring refs manually.
 */
function DragScroll({ as: Tag = "div", axis = "y", className = "", children, ...rest }) {
  const ref = useDragScroll({ axis });
  return (
    <Tag ref={ref} className={className} {...rest}>
      {children}
    </Tag>
  );
}

/* ----------------------------- DATA / HELPERS ----------------------------- */

const TABLE_WIDTH_MM = 280;
const TABLE_HEIGHT_MM = 580;
const ALLOWABLE_TRAVEL_X_MM = 330;
const ALLOWABLE_TRAVEL_Y_MM = 590;
const AXIS_LENGTH_X_MM = TABLE_WIDTH_MM + ALLOWABLE_TRAVEL_X_MM;
const AXIS_LENGTH_Y_MM = TABLE_HEIGHT_MM + ALLOWABLE_TRAVEL_Y_MM;

// Default start = centre of allowable travel. The machine-X coordinate is
// "how far the table has moved from X home" (moving-table, fixed-gantry), so
// travel/2 lands the table visually centred under the gantry — both for the
// loading-position default and for brand-new programs without a saved start.
// Default program start positions sit at the middle of the full axis travel —
// matching the default loading position (AXIS_LENGTH_X/2, AXIS_LENGTH_Y/2) so
// new programs spawn in a sane, centered spot rather than offset toward one
// corner of the work envelope. Operator can still drag/edit per-program.
const DEFAULT_START_X = AXIS_LENGTH_X_MM / 2;
const DEFAULT_START_Y = AXIS_LENGTH_Y_MM / 2;
const DEFAULT_START_Z = "UP";

const DEFAULT_OFFSET_DIRECTION = "Offset Left";

function makeXYZ() {
  return {
    x: DEFAULT_START_X,
    y: DEFAULT_START_Y,
    z: DEFAULT_START_Z,
  };
}

function generatePatternCoordinates({
  cellXSpacing,
  cellYSpacing,
  cellsX,
  cellsY,
  offsetDirection = DEFAULT_OFFSET_DIRECTION,
}) {
  const xCount = Number(cellsX);
  const yCount = Number(cellsY);
  const xSpacing = Number(cellXSpacing);
  const ySpacing = Number(cellYSpacing);

  if (
    !Number.isFinite(xCount) ||
    !Number.isFinite(yCount) ||
    !Number.isFinite(xSpacing) ||
    !Number.isFinite(ySpacing) ||
    xCount <= 0 ||
    yCount <= 0 ||
    xSpacing <= 0 ||
    ySpacing <= 0
  ) {
    return [];
  }

  // Cells are generated in "logical module frame" — cell 1 at (0, 0), +X
  // to the right of cell 1 in the visualisation, +Y away from cell 1 in
  // the visualisation. The pattern-editor preview, reticle, and any other
  // UI surface that reads these coordinates renders them as-is, which
  // gives the operator the natural top-down view of the module regardless
  // of how the module is physically mounted on the table.
  //
  // The 90° CW physical-mounting rotation is applied LATER, in the run
  // orchestrator (server/runOrchestrator.js), at the point where these
  // coordinates are converted into MOVE targets for the firmware. That
  // way the visualisation stays unrotated but the table motion matches
  // the rotated physical layout. See PATTERN_ROTATION there for details.

  const generated = [];
  let id = 1;
  const halfOffset = xSpacing / 2;
  const oddRowOffset = offsetDirection === "Offset Right" ? halfOffset : -halfOffset;

  for (let row = 0; row < yCount; row++) {
    const rowOffset = row % 2 === 1 ? oddRowOffset : 0;
    const rowY = Number((row * ySpacing).toFixed(3));

    const cols =
      row % 2 === 0
        ? Array.from({ length: xCount }, (_, i) => i)
        : Array.from({ length: xCount }, (_, i) => xCount - 1 - i);

    for (const col of cols) {
      const x = Number((col * xSpacing + rowOffset).toFixed(3));
      generated.push({
        id: id++,
        x,
        y: rowY,
      });
    }
  }

  return generated;
}

// Default per-program laser dwell time in ms. Per master plan §7.3 the
// dwellTime lives on the pattern so each weld program can tune the laser
// relay closure duration for its stock.
const DEFAULT_DWELL_MS = 50;

// Gillis V2 has three pneumatic solenoids on the manifold (§2.2 SPARE_1/2 +
// the primary Z_SOLENOID_A). Today only A is wired to a head, but the GUI
// already lets the operator pick B or C so future heads drop in with zero
// firmware work — just a pattern re-save.
const SOLENOID_OPTIONS = ["A", "B", "C"];
const DEFAULT_SOLENOID = "A";

function makePattern(
  cellXSpacing,
  cellYSpacing,
  cellsX,
  cellsY,
  offsetDirection = DEFAULT_OFFSET_DIRECTION,
  dwellTime = DEFAULT_DWELL_MS,
  solenoid = DEFAULT_SOLENOID
) {
  return {
    cellXSpacing: String(cellXSpacing),
    cellYSpacing: String(cellYSpacing),
    cellsX: String(cellsX),
    cellsY: String(cellsY),
    offsetDirection,
    dwellTime: Number(dwellTime) || DEFAULT_DWELL_MS,
    solenoid: SOLENOID_OPTIONS.includes(solenoid) ? solenoid : DEFAULT_SOLENOID,
  };
}

function makeProgram(name, pattern = null) {
  const resolvedPattern = pattern || makePattern(21.35, 19.065, 7, 4, DEFAULT_OFFSET_DIRECTION);
  const coordinates = generatePatternCoordinates(resolvedPattern);

  return {
    name,
    cells: coordinates.length,
    measured: null,
    pattern: { ...resolvedPattern },
    coordinates,
    startPositions: {
      positive: makeXYZ(),
      negative: makeXYZ(),
    },
  };
}

const initialPrograms = [
  makeProgram("4x4 Module", makePattern(20.35, 10.75, 4, 4, "Offset Left")),
  makeProgram("5x6 Module", makePattern(20.35, 10.75, 5, 6, "Offset Left")),
];

// Motion settings are held flat for ease of binding to individual keypad
// inputs. The unprefixed (xSpeed/ySpeed/xAccel/yAccel) tuple is the "fast"
// profile used for every non-run motion — pre-move to start position,
// park to loading position, JOG, Test Motion screen. The cell* tuple is
// the cell-to-cell profile used only during a running program (tagged
// with `P=C` by the Pi orchestrator). On Save they're bundled into a
// nested SETMOTION payload.
const initialMotionSettings = {
  xSpeed: 120,
  ySpeed: 120,
  xAccel: 500,
  yAccel: 500,
  cellXSpeed: 60,
  cellYSpeed: 60,
  cellXAccel: 250,
  cellYAccel: 250,
  // "Laser On Time" — the legacy wire key stays `zDownDwell` so mixed-version
  // firmware keeps working. UI label was corrected from "Z Down Settle" in
  // Rev4.4 because this value has always driven the laser relay's energised
  // duration during FIRE, not any kind of Z settle.
  zDownDwell: 50,
  // Rev4.4 — pneumatic holds that bracket FIRE in the orchestrator's per-cell
  // loop. preWeldHoldMs runs between Z DOWN and FIRE; postWeldHoldMs runs
  // between FIRE and Z UP. Both default 0 so nothing changes until an
  // operator tunes them.
  preWeldHoldMs: 0,
  postWeldHoldMs: 0,
};

// Soft axis travel limits — the firmware clamps every MOVE/JOG to these
// values before handing them to the motion planner, on top of the hardware
// homing envelope. Stored in Teensy EEPROM via SET_TRAVEL. Defaults match
// the mechanical envelope declared in the build geometry constants above.
const initialTravelLimits = {
  maxX: AXIS_LENGTH_X_MM,
  maxY: AXIS_LENGTH_Y_MM,
};

const initialDiagnostics = {
  machineRuntimeHours: 120,
  sessionRuntimeHours: 2,
  teensy: "Connected",
  drivers: "Healthy",
  air: "OK",
  lastService: "Lubrication at 100h",
};

// Human-readable descriptions for the fault codes defined in master plan §3.1
// plus Rev4 additions (FAULT_HOMING_TIMEOUT, FAULT_LINK_LOST) and the Rev4.7
// dual-Y safety check (FAULT_Y_GANTRY_RACK). The Fault Lockout overlay renders
// these directly; codes without an entry fall back to the raw firmware string.
const FAULT_DESCRIPTIONS = {
  FAULT_LOW_AIR: {
    title: "Low Air Pressure",
    body: "Air pressure has dropped below the configured threshold. Restore supply pressure, then press Clear Fault to continue.",
    eStop: false,
  },
  FAULT_Z_TIMEOUT_DOWN: {
    title: "Z Down Timeout",
    body: "The Z stage did not reach the DOWN sensor within 2s. Check the pneumatics and Z hardware before continuing.",
    eStop: false,
  },
  FAULT_Z_TIMEOUT_UP: {
    title: "Z Up Timeout",
    body: "The Z stage did not retract to the UP sensor within 2s. Critical — verify the Z head is physically clear before homing.",
    eStop: false,
  },
  FAULT_DRIVER_X: {
    title: "X Driver Fault",
    body: "The X-axis stepper driver reported an alarm. All drivers have been disabled. Investigate and reset the driver before continuing.",
    eStop: false,
  },
  FAULT_DRIVER_YL: {
    title: "Y Left Driver Fault",
    body: "The Y-left stepper driver reported an alarm. All drivers have been disabled. Investigate and reset the driver before continuing.",
    eStop: false,
  },
  FAULT_DRIVER_YR: {
    title: "Y Right Driver Fault",
    body: "The Y-right stepper driver reported an alarm. All drivers have been disabled. Investigate and reset the driver before continuing.",
    eStop: false,
  },
  FAULT_ESTOP: {
    title: "E-Stop Active",
    body: "The emergency-stop loop is broken. Motor and laser power have been cut. Resolve the hazard and release the E-stop button to continue.",
    eStop: true,
  },
  USER_ABORT: {
    title: "Program Aborted",
    body: "The run was aborted by the operator.",
    eStop: false,
  },
  FAULT_LINK_LOST: {
    title: "Pi Communication Lost",
    body: "The Teensy stopped receiving heartbeats from the Pi for more than 2 seconds while a run was active. Motion has been halted as a safety measure. Check the USB pendant cable and Pi-side process before continuing.",
    eStop: false,
  },
  FAULT_HOMING_TIMEOUT: {
    title: "Homing Timeout",
    body: "Homing did not complete within 30 seconds — a home sensor was never triggered. Check that the gantry is travelling toward home (not into a hard stop in the wrong direction), that the X / Y home sensors are wired correctly, and that no obstruction is blocking travel.",
    eStop: false,
  },
  FAULT_Y_GANTRY_RACK: {
    title: "Y Gantry De-Sync",
    body: "During homing, one Y home sensor triggered but the other did not follow within 500 ms. Likely cause: one Y motor stalled, one home sensor failed, or the gantry has racked mechanically. DO NOT re-home until you have visually confirmed the gantry is square and free to move — re-homing a racked gantry can damage the ballscrew couplings.",
    eStop: false,
  },
};

function modeKey(mode) {
  return mode.toLowerCase();
}

/* ------------------------------- HUD THEME ------------------------------- */
// Shared visual language for every top-level screen. The HomeScreen was
// already styled in this language (chamfered HUD panels, accent rails, soft
// gradient interiors, subtle sheen on hover). These helpers make it cheap to
// apply the same treatment to the rest of the app without copy-pasting the
// clip-path / gradient / border incantation everywhere.

// Mode → accent mapping keeps color semantics consistent across the app:
//   production / run  → green  (live / weld)
//   programs          → blue   (editorial)
//   setup             → cyan   (calibration / motion)
//   diagnostics       → amber  (sensors / warnings)
//   settings / home   → slate  (neutral)
const MODE_ACCENTS = {
  home:        { color: "#94a3b8", rgb: "148,163,184" },
  production:  { color: "#22c55e", rgb: "34,197,94"   },
  run:         { color: "#22c55e", rgb: "34,197,94"   },
  programs:    { color: "#60a5fa", rgb: "96,165,250"  },
  setup:       { color: "#22d3ee", rgb: "34,211,238"  },
  diagnostics: { color: "#f59e0b", rgb: "245,158,11"  },
  settings:    { color: "#94a3b8", rgb: "148,163,184" },
};
function accentFor(mode) {
  return MODE_ACCENTS[mode] || MODE_ACCENTS.home;
}

// Global HUD stylesheet. Mounted once at app root so any child can use the
// .hud-card / .hud-accent-btn utility classes. Class names are namespaced so
// they don't collide with the existing HomeScreen-local .hud-btn styles.
function HudStyles() {
  return (
    <style>{`
      @keyframes hud-card-sheen {
        0%   { transform: translateX(-120%); }
        100% { transform: translateX(220%);  }
      }
      .hud-card {
        position: relative;
        isolation: isolate;
        clip-path: polygon(
          12px 0,
          100% 0,
          100% calc(100% - 12px),
          calc(100% - 12px) 100%,
          0 100%,
          0 12px
        );
      }
      .hud-card::after {
        content: "";
        position: absolute; inset: 0;
        background: linear-gradient(
          110deg,
          transparent 35%,
          rgba(255,255,255,0.035) 50%,
          transparent 65%
        );
        transform: translateX(-120%);
        pointer-events: none;
        z-index: 0;
      }
      .hud-card:hover::after { animation: hud-card-sheen 1.4s ease forwards; }

      .hud-rail {
        position: absolute;
        left: 0; top: 10px; bottom: 10px;
        width: 2px;
        border-radius: 0 2px 2px 0;
        pointer-events: none;
        z-index: 1;
      }

      .hud-accent-btn {
        position: relative;
        isolation: isolate;
        clip-path: polygon(
          10px 0,
          100% 0,
          100% calc(100% - 10px),
          calc(100% - 10px) 100%,
          0 100%,
          0 10px
        );
        transition: transform .15s ease, filter .2s ease, box-shadow .2s ease;
      }
      .hud-accent-btn:hover { transform: translateY(-1px); filter: brightness(1.08); }
      .hud-accent-btn:disabled { opacity: 0.55; transform: none; filter: none; }

      .hud-tile {
        position: relative;
        isolation: isolate;
        clip-path: polygon(
          14px 0,
          100% 0,
          100% calc(100% - 14px),
          calc(100% - 14px) 100%,
          0 100%,
          0 14px
        );
        transition: transform .2s ease, box-shadow .25s ease, border-color .25s ease;
      }
      .hud-tile:hover { transform: translateY(-2px); }
    `}</style>
  );
}

// Chamfered HUD panel with a soft accent gradient interior and a thin left rail.
// Use as a drop-in replacement for generic rounded cards on non-home screens.
const HudCard = React.forwardRef(function HudCard(
  {
    accent = "#94a3b8",
    accentRgb = "148,163,184",
    rail = true,
    className = "",
    style = {},
    children,
    ...rest
  },
  ref,
) {
  return (
    <div
      ref={ref}
      className={`hud-card border ${className}`}
      style={{
        background: `linear-gradient(135deg, rgba(${accentRgb},0.055) 0%, rgba(${accentRgb},0.022) 55%, rgba(15,23,42,0.55) 100%)`,
        borderColor: `rgba(${accentRgb},0.22)`,
        boxShadow: `inset 0 0 14px rgba(${accentRgb},0.045)`,
        ...style,
      }}
      {...rest}
    >
      {rail && (
        <span
          className="hud-rail"
          style={{ background: accent, opacity: 0.7, boxShadow: `0 0 6px ${accent}55` }}
        />
      )}
      {children}
    </div>
  );
});

/* --------------------------------- SHELL --------------------------------- */

function HealthDot({ label, ok = true }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-full ${ok ? "bg-green-400" : "bg-red-400"}`} />
      <span>{label}</span>
    </div>
  );
}

// Label-less variant used in the top status bar -- the text labels were eating
// roughly 250px of horizontal width across four health items, which on a
// narrow viewport pushed the right cluster into the program-name truncation
// zone and made the row visually overlap with the axis readout. The `title`
// attribute carries the human-readable name for hover/long-press inspection.
function HealthDotCompact({ title, ok = true }) {
  return (
    <span
      title={title}
      aria-label={title}
      className={`w-2.5 h-2.5 rounded-full shrink-0 ${ok ? "bg-green-400" : "bg-red-400"}`}
    />
  );
}

// Live X/Y coordinate readout rendered below the spinner on homing overlays.
// Reads straight from the machine state so it ticks every time the firmware
// emits a POSITION event (~every 50ms while any axis is moving). The value
// shown is the Teensy's position-in-steps-from-power-on, not a machine-frame
// coordinate — which is exactly what we want here: it gives the operator
// proof-of-motion during homing even though we're not yet HOMED. Rendered as
// a monospace tile so the digits don't jitter as they tick.
function HomingAxisTicker() {
  const { state } = useMachine();
  const f = (n) => (Number.isFinite(n) ? n.toFixed(2).padStart(8, ' ') : '  —   ');
  return (
    <div className="flex items-center gap-3 font-mono text-slate-200">
      <div className="px-3 py-1.5 rounded-md border border-white/10 bg-white/5 min-w-[112px] text-center">
        <span className="text-[10px] tracking-[0.22em] text-slate-400 uppercase mr-2">X</span>
        <span className="text-base tabular-nums whitespace-pre">{f(state.position?.x)}</span>
      </div>
      <div className="px-3 py-1.5 rounded-md border border-white/10 bg-white/5 min-w-[112px] text-center">
        <span className="text-[10px] tracking-[0.22em] text-slate-400 uppercase mr-2">Y</span>
        <span className="text-base tabular-nums whitespace-pre">{f(state.position?.y)}</span>
      </div>
    </div>
  );
}

function TopStatusBar({
  mode = "home",
  running = false,
  progress = 38,
  pulse = false,
  activeRun = null,
}) {
  const { state } = useMachine();
  const modeBg =
    mode === "production" || mode === "run"
      ? "from-green-950 via-slate-900 to-slate-900"
      : mode === "programs" || mode === "settings" || mode === "setup" || mode === "diagnostics"
        ? "from-blue-950 via-slate-900 to-slate-900"
        : "from-slate-900 via-slate-900 to-slate-900";

  const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : "—");
  const teensyOk = state.connected && state.health.teensy !== "Disconnected";
  // Treat an active fault or an active E-STOP as "system unhealthy" so the
  // System pill flips red the same way it does for driver trouble. Without
  // this the System dot stayed green during fault lockout even though
  // everything motion-related was refusing to move. estop.clearedPrompt is
  // excluded — that's the post-release "home now?" prompt, the hardware
  // is already recovered.
  const faultActive = !!state.fault?.active;
  const estopActive = !!state.estop?.active;
  const systemOk =
    teensyOk &&
    !state.health.drivers?.toLowerCase?.().includes("fault") &&
    !faultActive &&
    !estopActive;
  // Air OK = live pressure clears the operator's low-air threshold. Earlier
  // we just trusted state.health.air, but that's the firmware's "ok"/"low"
  // verdict which uses the firmware's *compile-time* threshold (the SET_AIR_
  // THRESHOLD round-trip isn't persisted by the current firmware build).
  // Result: the operator drops the threshold to 1.5 bar in Settings, live
  // pressure is 2.35 bar, the math agrees it's fine, but the firmware still
  // compares against 4.1 and reports "low" -> red dot in the top bar.
  // Compute it Pi-side from the persisted threshold and the live reading so
  // the indicator matches the operator's setting. Fall back to the firmware
  // verdict if either value is unknown (early boot / offline demo).
  const thresh = Number(state.airThresholdBar);
  const livePressure = Number(state.airPressureBar);
  const airOk =
    Number.isFinite(thresh) && Number.isFinite(livePressure)
      ? livePressure >= thresh
      : (state.health.air || "").toLowerCase() === "ok";

  // Pretty-print a FAULT_* code for the top-bar pill. Strip the FAULT_ prefix
  // and swap underscores for spaces so "FAULT_Z_TIMEOUT_UP" reads as
  // "Z TIMEOUT UP" in the tiny 10px font.
  const humaniseFaultCode = (code) => {
    if (!code) return "FAULT";
    const raw = String(code).toUpperCase();
    const trimmed = raw.startsWith("FAULT_") ? raw.slice(6) : raw;
    return trimmed.replace(/_/g, " ");
  };

  return (
    <div className={`h-12 shrink-0 border-b border-white/10 bg-gradient-to-r ${modeBg} relative overflow-hidden`}>
      {running && (
        <div
          className={`absolute inset-y-0 left-0 bg-white/10 ${pulse ? "animate-pulse" : ""}`}
          style={{ width: `${progress}%` }}
        />
      )}

      {/* Single-row layout (back from a brief 2-row experiment per operator
          preference). The Pi Screen 2 swap exposed an overlap symptom because
          the original flex-wrap was letting the X/Y axis readouts wrap onto
          a second invisible line that the bar's overflow-hidden then clipped
          -- visually reading as "axis values overlap the mode pill".
          Solutions stack: (1) drop flex-wrap so items stay on one row,
          (2) min-w-0 + truncate on the program name so a long program
          title shrinks instead of pushing other items off-screen,
          (3) shrink-0 on every fixed-width pill so nothing else collapses,
          (4) reduce gaps slightly to fit on the narrower Pi Screen 2
          effective width when no kiosk zoom is applied. */}
      <div className="relative z-10 h-full px-2 flex items-center justify-between gap-3 text-[16px] text-white whitespace-nowrap">
        {/* Left cluster splits into two: identity (mode/NOT HOMED/program) and
            the live readout (X/Y/Z/Air). Identity is min-w-0 so the program
            name can truncate; readout is shrink-0 so its digits are never
            crushed. A visible vertical divider sits between them so the
            mode pill and the axis values never visually collide on the
            narrower Pi Screen 2 effective viewport. */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0 shrink">
            <span className="px-2 py-0.5 rounded-full bg-white/10 border border-white/10 font-semibold tracking-wide inline-flex items-center gap-1.5 shrink-0">
              {state.busy && <RingSpinner size={10} stroke={3} speed={1.0} />}
              {running ? "RUNNING" : mode.toUpperCase()}
            </span>
            {!state.homed && !state.estop?.active && (
              <span
                className="px-1.5 py-0.5 rounded-full bg-amber-500/20 border border-amber-400/60 text-amber-200 font-semibold tracking-wide shrink-0"
                title="Axes have not been homed. Use Settings → Test Motion to verify limit switches, then run Home."
              >
                NOT HOMED
              </span>
            )}
            <span className="truncate min-w-0 shrink">
              Program: {activeRun?.programName || state.run?.programName || "—"}
            </span>
          </div>

          {/* Vertical divider — keeps the live readout visually distinct from
              the identity cluster on the left so they never visually merge. */}
          <span className="shrink-0 h-4 w-px bg-white/15" aria-hidden="true" />

          {/* Live machine readout. shrink-0 on each item so digits stay legible. */}
          <div className="flex items-center gap-2 shrink-0 font-mono tabular-nums">
            <span>X {(state.homed || state.busy) ? fmt(state.position.x) : "?"}</span>
            <span>Y {(state.homed || state.busy) ? fmt(state.position.y) : "?"}</span>
            <span>Z {state.position.z}</span>
            <span>Air {fmt(state.airPressureBar)} bar</span>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {!state.connected && (
            <span
              className="px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-400/60 text-amber-100 font-semibold tracking-wide inline-flex items-center gap-1.5"
              title="Backend not reachable from the browser. Check that the gillis server process is running on port 8787."
            >
              <span className="relative inline-flex w-1.5 h-1.5">
                <span className="absolute inset-0 rounded-full bg-amber-300 animate-ping opacity-70" />
                <span className="absolute inset-0 rounded-full bg-amber-300" />
              </span>
              OFFLINE
            </span>
          )}
          {state.connected && state.health.teensy === "Disconnected" && (
            <span
              className="px-2 py-0.5 rounded-full bg-red-500/20 border border-red-400/70 text-red-100 font-semibold tracking-wide inline-flex items-center gap-1.5"
              title="Backend is up but the Teensy motion controller is not responding. Check the USB cable and that the controller is powered. If a run was in progress, the firmware's link watchdog will have already triggered an emergency stop."
            >
              <span className="relative inline-flex w-1.5 h-1.5">
                <span className="absolute inset-0 rounded-full bg-red-300 animate-ping opacity-70" />
                <span className="absolute inset-0 rounded-full bg-red-300" />
              </span>
              TEENSY OFFLINE
            </span>
          )}
          {/* Active E-STOP has priority over a generic fault pill — the
              reducer flips estop.active and typically also fault.active
              (code FAULT_ESTOP), so show just one compact red pill. */}
          {estopActive && (
            <span
              className="px-2 py-0.5 rounded-full bg-red-600/30 border border-red-400/80 text-red-50 font-semibold tracking-wide inline-flex items-center gap-1.5"
              title="E-STOP is latched. Release the hardware button, clear the overlay, then re-home."
            >
              <span className="relative inline-flex w-1.5 h-1.5">
                <span className="absolute inset-0 rounded-full bg-red-300 animate-ping opacity-80" />
                <span className="absolute inset-0 rounded-full bg-red-300" />
              </span>
              E-STOP
            </span>
          )}
          {!estopActive && faultActive && (
            <span
              className="px-2 py-0.5 rounded-full bg-red-500/20 border border-red-400/70 text-red-100 font-semibold tracking-wide inline-flex items-center gap-1.5"
              title={
                state.fault?.message
                  ? `${state.fault.code || "FAULT"} — ${state.fault.message}`
                  : `Machine is in fault lockout: ${state.fault?.code || "unknown"}. Motion is blocked until the fault is cleared.`
              }
            >
              <span className="relative inline-flex w-1.5 h-1.5">
                <span className="absolute inset-0 rounded-full bg-red-300 animate-ping opacity-70" />
                <span className="absolute inset-0 rounded-full bg-red-300" />
              </span>
              {humaniseFaultCode(state.fault?.code)}
            </span>
          )}
          <div className="flex items-center gap-1.5" title="Backend link">
            <SignalPulse />
            <span className="text-slate-300">Link</span>
          </div>
          <HealthDot label="Teensy" ok={teensyOk} />
          <HealthDot label="System" ok={systemOk} />
          <HealthDot
            label={state.driversEnabled ? "Drivers ON" : "Drivers OFF"}
            ok={!!state.driversEnabled}
          />
          <HealthDot label="Air" ok={airOk} />
        </div>
      </div>
    </div>
  );
}

function BottomNav({ onHome, onBack }) {
  return (
    <div className="h-10 shrink-0 border-t border-white/10 bg-slate-900/95 px-2 grid grid-cols-3 items-center text-white">
      <div className="justify-self-start">
        <button
          onClick={onBack}
          className="rounded-xl bg-white/5 border border-white/10 w-9 h-8 hover:bg-white/10 text-lg leading-none"
        >
          ←
        </button>
      </div>
      <div className="justify-self-center">
        <button
          onClick={onHome}
          className="rounded-xl bg-white/5 border border-white/10 w-9 h-8 hover:bg-white/10 text-lg leading-none"
        >
          ⌂
        </button>
      </div>
      <div />
    </div>
  );
}

function ScreenShell({
  children,
  mode,
  running = false,
  progress = 38,
  pulse = false,
  onHome,
  onBack,
  activeRun = null,
}) {
  const bg =
    mode === "production" || mode === "run"
      ? "from-green-950 via-slate-950 to-slate-950"
      : mode === "programs" || mode === "settings" || mode === "setup" || mode === "diagnostics"
        ? "from-blue-950 via-slate-950 to-slate-950"
        : "from-slate-950 via-slate-950 to-slate-950";

  return (
    <div className={`h-full flex flex-col bg-gradient-to-br ${bg} text-white`}>
      <TopStatusBar mode={mode} running={running} progress={progress} pulse={pulse} activeRun={activeRun} />
      <div className="flex-1 min-h-0 px-2 py-1.5 overflow-hidden relative">{children}</div>
      <BottomNav onHome={onHome} onBack={onBack} />
    </div>
  );
}

/* --------------------- LOST SCREEN (not-homed gate) ---------------------- */
// Shown in place of Production / Programs / Loading Position / X-Axis Tramming
// when the machine hasn't been homed yet. Any screen that relies on accurate
// machine coordinates is meaningless pre-home — the step counters are just
// whatever they were at power-on. Instead of letting the operator poke at
// stale UI, we replace the whole body with a clear "home me first" prompt
// that routes straight to the Setup screen's Homing tile.
function LostScreen({ mode = "home", onHome, onBack, onGoHoming, onContinueAnyway = null }) {
  const machine = useMachine();
  const accent = accentFor("setup");

  // Single source of truth: the reducer flips this on homing:start /
  // homing:done (synthesised in realSerial.js from the HOME→OK→HOMED round
  // trip). No local state means no race between this component, the WS
  // event, and snapshot rebroadcasts.
  const homing = machine.state.homing;

  const homeNow = async () => {
    if (homing) return;
    // Don't pre-latch a local flag here — homing:start arrives within ~5 ms
    // of the OK ack and flips machine.state.homing for us.
    await machine.home();
  };

  return (
    <ScreenShell mode={mode} onHome={onHome} onBack={onBack}>
      <div className="h-full flex items-center justify-center">
        <HudCard
          accent={accent.color}
          accentRgb={accent.rgb}
          className="p-6 w-[min(620px,92vw)] text-center"
        >
          <div className="text-[10px] tracking-[0.32em] uppercase text-slate-300 mb-2">
            Axes Not Homed
          </div>
          <div
            className="text-2xl font-bold mb-3"
            style={{ color: accent.color }}
          >
            Gillis is lost, please home first
          </div>
          <div className="text-sm text-slate-200 mb-5 leading-relaxed">
            Machine coordinates aren't reliable until the table has seeked its
            home switches. Home the axes before running programs, editing
            patterns, or setting the loading position.
          </div>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <button
              onClick={onGoHoming}
              className="h-11 px-5 text-xs font-semibold tracking-[0.15em] uppercase rounded-lg border border-white/10 bg-white/5 hover:bg-white/10"
            >
              Open Machine Setup
            </button>
            <button
              onClick={homeNow}
              disabled={homing}
              className="hud-accent-btn h-11 px-5 text-xs font-bold tracking-[0.18em] uppercase border inline-flex items-center gap-2"
              style={{
                background: `linear-gradient(135deg, rgba(${accent.rgb},0.85), rgba(${accent.rgb},0.5))`,
                borderColor: `rgba(${accent.rgb},0.5)`,
                boxShadow: `0 0 18px rgba(${accent.rgb},0.3)`,
                color: "#f0f9ff",
              }}
            >
              {homing && <RingSpinner size={12} stroke={3} speed={1.0} />}
              {homing ? "Homing…" : "Home Now"}
            </button>
          </div>
          {/* Bench-mode / unattended-rig escape hatch. AppInner passes a
              callback for every gated screen — when clicked, homingBypassed
              flips true and the gate re-checks render the real screen on the
              next render. The bypass clears the moment the firmware reports a
              real home (or E-stop), so the operator can't accidentally carry
              an override into a real run on a properly-homed machine. Kept
              visually distinct (amber, separated by a divider) so it doesn't
              read as the recommended action — homing is still the primary
              call-to-action above. */}
          {onContinueAnyway && (
            <div className="mt-4 pt-4 border-t border-white/10 text-center">
              <div className="text-[10px] text-amber-300/80 tracking-[0.18em] uppercase mb-2">
                Bench Mode Active
              </div>
              <button
                onClick={onContinueAnyway}
                className="h-10 px-5 text-[11px] font-semibold tracking-[0.18em] uppercase rounded-lg border border-amber-400/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-100"
                title="Skip the not-homed check and open this screen anyway. Coordinates shown will be unreliable — use at your own risk."
              >
                Continue Anyway
              </button>
            </div>
          )}
        </HudCard>
      </div>
      <LoadingOverlay
        visible={homing}
        title="Homing axes"
        subtext="Seeking home switches on X and Y. Keep the workspace clear."
      >
        <HomingAxisTicker />
      </LoadingOverlay>
    </ScreenShell>
  );
}

function ModeSwitch({
  mode,
  setMode,
  leftLabel = "Positive",
  rightLabel = "Negative",
  width = "w-56",
}) {
  return (
    <div className={`rounded-2xl bg-white/10 border border-white/10 p-1 flex ${width}`}>
      <button
        onClick={() => setMode(leftLabel)}
        className={`flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition ${
          mode === leftLabel ? "bg-white text-slate-900" : "text-white/80"
        }`}
      >
        {leftLabel}
      </button>
      <button
        onClick={() => setMode(rightLabel)}
        className={`flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition ${
          mode === rightLabel ? "bg-white text-slate-900" : "text-white/80"
        }`}
      >
        {rightLabel}
      </button>
    </div>
  );
}

function TouchSlider({ value, onChange, min, max, step = 1 }) {
  return (
    <>
      <style>{`
        .touch-slider {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 10px;
          border-radius: 9999px;
          background: rgba(255,255,255,0.14);
          outline: none;
        }
        .touch-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 26px;
          height: 26px;
          border-radius: 9999px;
          background: white;
          border: 2px solid rgba(59,130,246,0.9);
          box-shadow: 0 0 0 4px rgba(59,130,246,0.18);
          cursor: pointer;
        }
        .touch-slider::-moz-range-thumb {
          width: 26px;
          height: 26px;
          border-radius: 9999px;
          background: white;
          border: 2px solid rgba(59,130,246,0.9);
          box-shadow: 0 0 0 4px rgba(59,130,246,0.18);
          cursor: pointer;
        }
      `}</style>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
        className="touch-slider"
      />
    </>
  );
}

/* ----------------------------- KEYBOARD HELPERS --------------------------- */

function KeyboardValueBar({ title, value, subtitle = "" }) {
  return (
    <div className="mb-2 shrink-0">
      <div className="text-base font-semibold leading-tight">{title}</div>
      {subtitle ? <div className="text-slate-400 text-[11px] mt-0.5">{subtitle}</div> : null}
      <div className="mt-2 rounded-xl bg-black/35 border border-white/10 px-3 py-2.5 min-h-[46px] flex items-center text-lg font-semibold tracking-wide overflow-hidden">
        <span className="truncate w-full">{String(value ?? "") || " "}</span>
      </div>
    </div>
  );
}

function keyButtonClass(extra = "") {
  return `rounded-xl bg-white/10 border border-white/10 hover:bg-white/15 font-semibold ${extra}`;
}

/* ------------------------------- NUMERIC KEYPAD --------------------------- */

function EmbeddedNumericKeypad({
  title = "Enter Value",
  value,
  onChange,
  onCancel,
  onConfirm,
  allowNegative = false,
  allowDecimal = true,
}) {
  const append = (char) => {
    const current = String(value ?? "");
    if (char === "." && (!allowDecimal || current.includes("."))) return;
    if (char === "-" && (!allowNegative || current.includes("-") || current.length > 0)) return;
    onChange(`${current}${char}`);
  };

  const backspace = () => {
    onChange(String(value ?? "").slice(0, -1));
  };

  const clear = () => {
    onChange("");
  };

  const keys = [
    "7", "8", "9",
    "4", "5", "6",
    "1", "2", "3",
    allowDecimal ? "." : "", "0", allowNegative ? "-" : "",
  ];

  return (
    <div className="h-full rounded-[1.25rem] border border-white/10 bg-slate-950/80 p-2 flex flex-col overflow-hidden">
      <KeyboardValueBar title={title} value={value} subtitle="Touch to enter value" />

      <div className="grid grid-cols-3 gap-2 flex-1 min-h-0">
        {keys.map((key, idx) =>
          key ? (
            <button
              key={`${key}-${idx}`}
              onClick={() => append(key)}
              className={keyButtonClass("h-full text-base")}
            >
              {key}
            </button>
          ) : (
            <div key={`blank-${idx}`} />
          )
        )}
      </div>

      <div className="grid grid-cols-4 gap-2 mt-2 shrink-0">
        <button onClick={clear} className={keyButtonClass("h-10 text-xs")}>
          Clear
        </button>
        <button onClick={backspace} className={keyButtonClass("h-10 text-sm")}>
          ⌫
        </button>
        <button onClick={onConfirm} className="h-10 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-bold">
          Enter
        </button>
        <button onClick={onCancel} className={keyButtonClass("h-10 text-xs")}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ------------------------------- QWERTY KEYBOARD -------------------------- */

function EmbeddedQwertyKeyboard({
  title = "Enter Text",
  value,
  onChange,
  onCancel,
  onConfirm,
}) {
  const rows = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
    ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
    ["Z", "X", "C", "V", "B", "N", "M"],
  ];

  const append = (char) => onChange(`${String(value ?? "")}${char}`);
  const backspace = () => onChange(String(value ?? "").slice(0, -1));
  const addSpace = () => onChange(`${String(value ?? "")} `);

  return (
    <div className="h-full w-full rounded-[1.25rem] border border-white/10 bg-slate-950/90 p-2 flex flex-col overflow-hidden">
      <KeyboardValueBar title={title} value={value} subtitle="Program name entry" />

      <div className="flex-1 min-h-0 flex flex-col gap-2">
        <div className="grid grid-cols-10 gap-1.5">
          {rows[0].map((key) => (
            <button key={key} onClick={() => append(key)} className={keyButtonClass("h-10 text-sm")}>
              {key}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-10 gap-1.5">
          {rows[1].map((key) => (
            <button key={key} onClick={() => append(key)} className={keyButtonClass("h-10 text-sm")}>
              {key}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-9 gap-1.5 px-6">
          {rows[2].map((key) => (
            <button key={key} onClick={() => append(key)} className={keyButtonClass("h-10 text-sm")}>
              {key}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-9 gap-1.5">
          <button onClick={backspace} className={keyButtonClass("h-10 text-xs col-span-2")}>
            ⌫ Back
          </button>
          {rows[3].map((key) => (
            <button key={key} onClick={() => append(key)} className={keyButtonClass("h-10 text-sm")}>
              {key}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-12 gap-1.5 mt-auto">
          <button onClick={onCancel} className={keyButtonClass("h-11 text-xs col-span-2")}>
            Cancel
          </button>
          <button onClick={() => append("-")} className={keyButtonClass("h-11 text-sm col-span-1")}>
            -
          </button>
          <button onClick={() => append("_")} className={keyButtonClass("h-11 text-sm col-span-1")}>
            _
          </button>
          <button onClick={addSpace} className={keyButtonClass("h-11 text-xs col-span-4")}>
            Space
          </button>
          <button onClick={() => onChange("")} className={keyButtonClass("h-11 text-xs col-span-2")}>
            Clear
          </button>
          <button onClick={onConfirm} className="h-11 rounded-xl bg-blue-600 hover:bg-blue-500 text-xs font-bold col-span-2">
            Enter
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ GRAPHICS --------------------------------- */

function ProgramGraphic({
  selectable = false,
  selectedCell = null,
  setSelectedCell = null,
  running = false,
  activeCell = 12,
  progressCount = 11,
  reweldedCells = [],
  laserFiring = false,
  previewAllGrey = false,
  coordinates = null,
}) {
  const orderedCoords = useMemo(() => {
    const source = Array.isArray(coordinates) ? coordinates : [];
    return [...source]
      .filter((c) => typeof c?.id === "number")
      .sort((a, b) => a.id - b.id);
  }, [coordinates]);

  const layout = useMemo(() => {
    if (!orderedCoords.length) {
      return { points: [], currentPos: { x: 350, y: 215 }, baseR: 17, fontR: 13, strokeR: 5 };
    }

    const xs = orderedCoords.map((p) => p.x);
    const ys = orderedCoords.map((p) => p.y);

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const width = maxX - minX || 1;
    const height = maxY - minY || 1;

    // Margins in mm around the pattern so cells at the edge don't sit right
    // against the SVG border. Trimmed down from the previous 8%/12% — for a
    // tall narrow module those numbers cost ~20% of the available drawing
    // height to whitespace. The Start label uses clamped fallback positions
    // (see <text> below) so a tiny margin is safe.
    const marginX = Math.max(2, width * 0.04);
    const marginY = Math.max(2, height * 0.04);

    const envMinX = minX - marginX;
    const envMinY = minY - marginY;
    const envWidth = width + marginX * 2;
    const envHeight = height + marginY * 2;

    // Shrunk from 16 to 8 so the rendered pattern fills more of its box on
    // the run screen / pattern preview. Coupled with the smaller mm margins
    // above this gives noticeably bigger graphics for dense modules.
    const pad = 8;
    const drawWidth = 700 - pad * 2;
    const drawHeight = 430 - pad * 2;

    const scale = Math.min(drawWidth / envWidth, drawHeight / envHeight);

    const offsetX = pad + (drawWidth - envWidth * scale) / 2;
    const offsetY = pad + (drawHeight - envHeight * scale) / 2;

    const toPx = (x) => offsetX + (x - envMinX) * scale;
    const toPy = (y) => offsetY + (y - envMinY) * scale;

    const points = orderedCoords.map((p) => ({
      ...p,
      px: toPx(p.x),
      py: toPy(p.y),
    }));

    // Cell radius derivation. Previously the radius was hard-coded at 17 SVG
    // units regardless of how close the cells were drawn — fine for a small
    // module like a 5x5, but a dense module (e.g. 20 cells across at 15 mm
    // pitch) ends up with cell-to-cell spacing of ~19 px which means the
    // 17 r circles butt into each other and the IDs become unreadable.
    //
    // Fix: find the minimum pairwise distance between any two cells in pixel
    // space, and cap the base radius at 42% of that so adjacent circles
    // always leave a small visible gap. The cap is clamped between 4 (so a
    // huge module's cells stay clickable) and 17 (the legacy size, so small
    // modules look exactly as they did before).
    let minDistPx = Infinity;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dx = points[i].px - points[j].px;
        const dy = points[i].py - points[j].py;
        const d = Math.hypot(dx, dy);
        if (d > 0 && d < minDistPx) minDistPx = d;
      }
    }
    const baseR =
      points.length < 2 || !Number.isFinite(minDistPx)
        ? 17
        : Math.max(4, Math.min(17, minDistPx * 0.42));
    // Font and polyline stroke scale with the cell radius — at the legacy
    // r=17 these resolve to the previous 13/5 values, so small modules are
    // unchanged. At smaller radii everything stays in proportion.
    const fontR = Math.max(6, baseR * (13 / 17));
    const strokeR = Math.max(1.5, baseR * (5 / 17));

    const idx = Math.max(0, Math.min(points.length - 1, activeCell - 1));
    const a = points[idx];
    const b = points[Math.min(idx + 1, points.length - 1)];

    return {
      points,
      currentPos: { x: (a.px + b.px) / 2, y: (a.py + b.py) / 2 },
      baseR,
      fontR,
      strokeR,
    };
  }, [orderedCoords, activeCell]);

  const { points, currentPos, baseR, fontR, strokeR } = layout;
  const reweldedSet = new Set(reweldedCells);

  // Active cell position (for crosshair target)
  const activePoint = useMemo(() => {
    if (!points.length) return null;
    return points.find((p) => p.id === activeCell) || points[Math.max(0, Math.min(points.length - 1, activeCell - 1))];
  }, [points, activeCell]);

  // Track previous laserFiring to trigger a single-shot flash on rising edge
  const [flashKey, setFlashKey] = useState(0);
  const prevFiringRef = useRef(false);
  useEffect(() => {
    if (laserFiring && !prevFiringRef.current) {
      setFlashKey((k) => k + 1);
    }
    prevFiringRef.current = laserFiring;
  }, [laserFiring]);

  // Weld-complete ping: detect the run transitioning from running → complete
  const machineCtx = useMachine();
  const runPhase = machineCtx.state.run?.phase;
  const [completePing, setCompletePing] = useState(0);
  const prevPhaseRef = useRef(runPhase);
  useEffect(() => {
    if (prevPhaseRef.current === "running" && runPhase === "complete") {
      setCompletePing((k) => k + 1);
    }
    prevPhaseRef.current = runPhase;
  }, [runPhase]);

  // Real-time reticle speed — compute the CSS transition duration for the
  // cell-to-cell jump from the actual motion settings (mm/s) and the physical
  // distance between cells. Without this the reticle animated over a fixed
  // 140 ms regardless of travel distance, which was much faster than the real
  // table — the graphic looked like it was teleporting between cells while
  // the operator watched a slow, deliberate move on the machine. Each axis
  // moves independently in firmware, so wall-clock travel time is the max of
  // the per-axis requirements (constant-velocity approximation — we ignore
  // accel/decel ramps since they're small at typical distances).
  const motionSettings = machineCtx.state.motionSettings || {};
  const prevActiveCellRef = useRef(activeCell);
  const prevActiveCell = prevActiveCellRef.current;
  useEffect(() => { prevActiveCellRef.current = activeCell; }, [activeCell]);

  const reticleTransitionMs = useMemo(() => {
    if (!points.length) return 140;
    const prevIdx = Math.max(0, Math.min(points.length - 1, prevActiveCell - 1));
    const currIdx = Math.max(0, Math.min(points.length - 1, activeCell - 1));
    if (prevIdx === currIdx) return 140; // no change — tiny default so the first render doesn't snap jarringly
    const prevPt = points[prevIdx];
    const currPt = points[currIdx];
    const dxMm = Math.abs((currPt?.x ?? 0) - (prevPt?.x ?? 0));
    const dyMm = Math.abs((currPt?.y ?? 0) - (prevPt?.y ?? 0));
    const xSp = Math.max(1, Number(motionSettings.xSpeed) || 120); // mm/s
    const ySp = Math.max(1, Number(motionSettings.ySpeed) || 120);
    const timeS = Math.max(dxMm / xSp, dyMm / ySp);
    // Clamp to a sensible range: at least 60 ms so the browser actually
    // animates rather than snapping; at most 10 s as a safety cap in case
    // the speed settings are corrupted (e.g. zeroed out via a bad sync).
    return Math.max(60, Math.min(10000, Math.round(timeS * 1000)));
  }, [points, prevActiveCell, activeCell, motionSettings.xSpeed, motionSettings.ySpeed]);

  return (
    <div className="h-full w-full rounded-[1.25rem] border border-white/10 bg-slate-950/70 p-1 overflow-hidden">
      <svg viewBox="0 0 700 430" className="w-full h-full">
        <defs>
          <radialGradient id="pm-firing-glow">
            <stop offset="0%" stopColor="rgba(248,113,113,0.55)" />
            <stop offset="60%" stopColor="rgba(248,113,113,0.10)" />
            <stop offset="100%" stopColor="rgba(248,113,113,0)" />
          </radialGradient>
          <style>{`
            @keyframes pm-reticle-pulse {
              0%, 100% { opacity: 0.45; }
              50%      { opacity: 0.75; }
            }
            @keyframes pm-firing-flash {
              0%   { r: 18; opacity: 0.0; }
              20%  { r: 38; opacity: 0.95; }
              100% { r: 90; opacity: 0.0; }
            }
            @keyframes pm-complete-ping {
              0%   { r: 18; opacity: 0.0; stroke-width: 3; }
              25%  { opacity: 0.85; }
              100% { r: 140; opacity: 0.0; stroke-width: 1; }
            }
            .pm-reticle { animation: pm-reticle-pulse 1.6s ease-in-out infinite; }
            .pm-firing-flash { animation: pm-firing-flash 520ms ease-out forwards; }
            .pm-complete-ping { animation: pm-complete-ping 1500ms ease-out forwards; }
          `}</style>
        </defs>

        <polyline
          points={points.map((p) => `${p.px},${p.py}`).join(" ")}
          fill="none"
          stroke="#38bdf8"
          strokeWidth={strokeR}
          strokeLinecap="round"
        />

        {points.length > 0 && (
          <text
            x={Math.max(12, points[0].px - baseR * 1.8)}
            y={Math.max(18, points[0].py - baseR * 1.2)}
            fill="white"
            fontSize={Math.max(10, baseR * 1.05)}
          >
            Start
          </text>
        )}

        {points.map((p, i) => {
          const isActive = p.id === activeCell;
          const isSelected = p.id === selectedCell;
          const rewelded = reweldedSet.has(p.id);

          const fill = previewAllGrey
            ? rewelded
              ? "#22c55e"
              : "#64748b"
            : rewelded
              ? "#22c55e"
              : i < progressCount
                ? "#22c55e"
                : isActive
                  ? "#eab308"
                  : "#64748b";

          // Active / selected / firing rings scale with the base radius so
          // the visual hierarchy holds at any module density. Ratios match
          // the legacy fixed values (24/20/17) so small modules look identical.
          const r = laserFiring && isActive
            ? baseR * (24 / 17)
            : isSelected
              ? baseR * (20 / 17)
              : baseR;

          return (
            <g
              key={p.id}
              onClick={() => selectable && setSelectedCell?.(p.id)}
              style={{ cursor: selectable ? "pointer" : "default" }}
            >
              <circle cx={p.px} cy={p.py} r={r} fill={isSelected ? "#f59e0b" : fill} />
              <text x={p.px} y={p.py + fontR * 0.38} textAnchor="middle" fontSize={fontR} fill="white">
                {p.id}
              </text>
            </g>
          );
        })}

        {/* Laser crosshair reticle — minimal, pinned to the active cell.
            Pulse animation only engages while the laser is actually firing;
            otherwise it sits steady at the target. Ring/tick geometry scales
            with baseR so a dense module's reticle doesn't swamp the cells. */}
        {running && activePoint && (
          <g
            className={laserFiring ? "pm-reticle" : ""}
            style={{
              transform: `translate(${activePoint.px}px, ${activePoint.py}px)`,
              // Duration derived from motion settings so the reticle tracks
              // the real table speed (see reticleTransitionMs above).
              transition: `transform ${reticleTransitionMs}ms linear`,
              opacity: laserFiring ? 1 : 0.55,
            }}
          >
            {/* Single thin ring */}
            <circle r={baseR * (22 / 17)} fill="none" stroke="#fca5a5" strokeWidth="0.8" opacity="0.55" />
            {/* Short tick lines */}
            <line x1={-baseR * (30 / 17)} y1="0" x2={-baseR * (22 / 17)} y2="0" stroke="#fca5a5" strokeWidth="0.9" opacity="0.75" />
            <line x1={baseR * (22 / 17)}  y1="0" x2={baseR * (30 / 17)}  y2="0" stroke="#fca5a5" strokeWidth="0.9" opacity="0.75" />
            <line x1="0" y1={-baseR * (30 / 17)} x2="0" y2={-baseR * (22 / 17)} stroke="#fca5a5" strokeWidth="0.9" opacity="0.75" />
            <line x1="0" y1={baseR * (22 / 17)}  x2="0" y2={baseR * (30 / 17)}  stroke="#fca5a5" strokeWidth="0.9" opacity="0.75" />
            {/* Center pinprick */}
            <circle r="1.3" fill="#fca5a5" opacity="0.85" />
          </g>
        )}

        {/* FIRING flash — single-shot ring that expands out from the active cell */}
        {activePoint && flashKey > 0 && (
          <circle
            key={`flash-${flashKey}`}
            cx={activePoint.px}
            cy={activePoint.py}
            r={baseR * (18 / 17)}
            fill="url(#pm-firing-glow)"
            stroke="#f87171"
            strokeWidth="2"
            className="pm-firing-flash"
          />
        )}

        {/* Weld-complete radial ping — single-shot on run completion */}
        {activePoint && completePing > 0 && (
          <circle
            key={`ping-${completePing}`}
            cx={activePoint.px}
            cy={activePoint.py}
            r={baseR * (18 / 17)}
            fill="none"
            stroke="#22c55e"
            strokeWidth="2.5"
            className="pm-complete-ping"
          />
        )}

        {!points.length && (
          <text x="350" y="215" textAnchor="middle" fill="rgba(255,255,255,0.55)" fontSize="20">
            No coordinates loaded
          </text>
        )}
      </svg>
    </div>
  );
}

function MachineTravelGraphic({
  position,
  travelX = ALLOWABLE_TRAVEL_X_MM,
  travelY = ALLOWABLE_TRAVEL_Y_MM,
  tableX = TABLE_WIDTH_MM,
  tableY = TABLE_HEIGHT_MM,
}) {
  const safeX = Math.max(0, Math.min(travelX, Number(position?.x) || 0));
  const safeY = Math.max(0, Math.min(travelY, Number(position?.y) || 0));

  const axisX = tableX + travelX;
  const axisY = tableY + travelY;

  // Tight padding so the envelope fills its box. Was 18 on every side; the
  // legacy values left a noticeable gap on the new 1280x720 screen where the
  // graphic already has more pixels to play with.
  const padLeft = 8;
  const padRight = 8;
  const padTop = 8;
  const padBottom = 8;
  const drawWidth = 700 - padLeft - padRight;
  const drawHeight = 430 - padTop - padBottom;

  const scale = Math.min(drawWidth / Math.max(axisX, 1), drawHeight / Math.max(axisY, 1));
  const envWidth = axisX * scale;
  const envHeight = axisY * scale;
  // Centering: envWidth/envHeight are already in SVG units (axis * scale).
  // The original code multiplied by `scale` a second time, which pushed the
  // envelope off-centre on non-square machines. Drop the extra factor.
  const offsetX = padLeft + (drawWidth - envWidth) / 2;
  const offsetY = padTop + (drawHeight - envHeight) / 2;

  const tablePx = tableX * scale;
  const tablePy = tableY * scale;
  const tableLeft = offsetX + safeX * scale;
  const tableTop = offsetY + safeY * scale;

  return (
    <div className="h-full rounded-[1.25rem] border border-white/10 bg-slate-950/70 p-1 overflow-hidden">
      <svg viewBox="0 0 700 430" className="w-full h-full">
        <rect
          x={offsetX}
          y={offsetY}
          width={envWidth}
          height={envHeight}
          rx="24"
          fill="rgba(255,255,255,0.03)"
          stroke="rgba(255,255,255,0.15)"
        />
        <rect
          x={tableLeft}
          y={tableTop}
          width={tablePx}
          height={tablePy}
          rx="18"
          fill="rgba(34,197,94,0.18)"
          stroke="#22c55e"
          strokeWidth="3"
        />
        <text
          x={tableLeft + tablePx / 2}
          y={tableTop + tablePy / 2}
          textAnchor="middle"
          fill="white"
          fontSize="20"
        >
          Work table
        </text>
      </svg>
    </div>
  );
}

/* --------------------------------- HOME ---------------------------------- */

function HomeScreen({ setScreen, onHome, onBack }) {
  const machine = useMachine();

  // Easter egg — five taps on the Ionetic logo within 1.5s of each other
  // opens the hidden System Info screen (Pi temp, CPU/RAM usage, GUI version).
  // Counter resets if the operator pauses too long between taps.
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef(null);
  const handleLogoTap = () => {
    tapCountRef.current += 1;
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    if (tapCountRef.current >= 5) {
      tapCountRef.current = 0;
      setScreen("systemInfo");
      return;
    }
    tapTimerRef.current = setTimeout(() => {
      tapCountRef.current = 0;
    }, 1500);
  };
  useEffect(() => () => { if (tapTimerRef.current) clearTimeout(tapTimerRef.current); }, []);

  // Each button carries its own accent — color-coded HUD panels.
  // Production is the "primary action", rendered taller and with a stronger
  // glow so it reads first.
  const buttons = [
    {
      label: "Production",
      sub: "Run a welding program",
      action: () => setScreen("production"),
      accent: "#22c55e",   // green-500
      accentRgb: "34,197,94",
      primary: true,
      icon: (
        <path d="M8 5v14l11-7z" />
      ),
    },
    {
      label: "Programs",
      sub: "Edit & manage programs",
      action: () => setScreen("programs"),
      accent: "#60a5fa",   // blue-400
      accentRgb: "96,165,250",
      icon: (
        <>
          <rect x="4" y="5" width="16" height="3" rx="0.5" />
          <rect x="4" y="10.5" width="16" height="3" rx="0.5" />
          <rect x="4" y="16" width="10" height="3" rx="0.5" />
        </>
      ),
    },
    {
      label: "Machine Setup",
      sub: "Motion, offsets, loading",
      action: () => setScreen("setup"),
      accent: "#22d3ee",   // cyan-400
      accentRgb: "34,211,238",
      icon: (
        <path d="M12 2.5l2.1 3.6 4.1.5-3 2.9.8 4.1L12 11.7 7.9 13.6l.8-4.1-3-2.9 4.1-.5L12 2.5zM4 17h16v2H4zM4 20h16v1.5H4z" />
      ),
    },
    {
      label: "Diagnostics",
      sub: "Health & live sensors",
      action: () => setScreen("diagnostics"),
      accent: "#f59e0b",   // amber-500
      accentRgb: "245,158,11",
      icon: (
        <path d="M3 12h3l2-5 4 10 2-5h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      ),
    },
  ];

  const run = machine.state.run || {};
  const runActive = run.active;
  const runPct = run.total > 0 ? Math.max(0, Math.min(1, (run.index || 0) / run.total)) : 0;

  return (
    <ScreenShell mode="home" onHome={onHome} onBack={onBack}>
      <style>{`
        @keyframes logohalo {
          0%, 100% {
            filter:
              drop-shadow(0 0 22px rgba(226,232,240,0.38))
              drop-shadow(0 0 46px rgba(96,165,250,0.32))
              drop-shadow(0 0 72px rgba(59,130,246,0.22));
          }
          50% {
            filter:
              drop-shadow(0 0 34px rgba(226,232,240,0.55))
              drop-shadow(0 0 68px rgba(96,165,250,0.48))
              drop-shadow(0 0 110px rgba(59,130,246,0.34));
          }
        }
        .logo-halo { animation: logohalo 2.8s ease-in-out infinite; }

        @keyframes scanring {
          0%   { transform: rotate(0deg);   opacity: 0.35; }
          50%  { opacity: 0.7; }
          100% { transform: rotate(360deg); opacity: 0.35; }
        }
        .scan-ring { animation: scanring 9s linear infinite; }

        @keyframes scanring-rev {
          0%   { transform: rotate(360deg); opacity: 0.25; }
          100% { transform: rotate(0deg);   opacity: 0.25; }
        }
        .scan-ring-rev { animation: scanring-rev 14s linear infinite; }

        /* High-tech button treatments for the home panel */
        @keyframes hud-sheen {
          0%   { transform: translateX(-120%); }
          100% { transform: translateX(220%);  }
        }
        .hud-btn {
          position: relative;
          overflow: hidden;
          isolation: isolate;
          transition: transform .18s ease, box-shadow .25s ease, border-color .25s ease;
          clip-path: polygon(
            14px 0,
            100% 0,
            100% calc(100% - 14px),
            calc(100% - 14px) 100%,
            0 100%,
            0 14px
          );
        }
        .hud-btn:hover { transform: translateY(-1px); }
        .hud-btn .hud-sheen {
          position: absolute; inset: 0;
          background: linear-gradient(110deg, transparent 35%, rgba(255,255,255,0.06) 50%, transparent 65%);
          transform: translateX(-120%);
          pointer-events: none;
        }
        .hud-btn:hover .hud-sheen { animation: hud-sheen 1.1s ease forwards; }

        @keyframes hud-pulse {
          0%, 100% { box-shadow: 0 0 0 1px rgba(34,197,94,0.22), 0 0 10px rgba(34,197,94,0.14), inset 0 0 14px rgba(34,197,94,0.06); }
          50%      { box-shadow: 0 0 0 1px rgba(34,197,94,0.32), 0 0 16px rgba(34,197,94,0.22), inset 0 0 18px rgba(34,197,94,0.10); }
        }
        .hud-primary { animation: hud-pulse 3.2s ease-in-out infinite; }
      `}</style>

      {/* Ambient electron-path background */}
      <div className="absolute inset-0 pointer-events-none opacity-90">
        <ElectronField accent="#60a5fa" />
      </div>

      <div className="relative h-full flex gap-3 z-10">
        <div className="flex-1 flex items-center justify-center relative min-w-0">
          <button
            onClick={() => setScreen("settings")}
            className="absolute left-1 top-1 rounded-2xl bg-white/5 border border-white/10 p-2 hover:bg-white/10 text-base"
            title="Settings"
          >
            ⚙
          </button>

          <div className="relative w-[78%] aspect-square flex items-center justify-center">
            {/* Outer rotating scan rings — decorative when idle, live progress during a run */}
            {!runActive && (
              <>
                <div
                  className="absolute inset-0 rounded-full pointer-events-none scan-ring"
                  style={{
                    border: "1px dashed rgba(148,163,184,0.25)",
                    maskImage:
                      "conic-gradient(from 0deg, transparent 0deg, black 90deg, transparent 180deg, black 270deg, transparent 360deg)",
                    WebkitMaskImage:
                      "conic-gradient(from 0deg, transparent 0deg, black 90deg, transparent 180deg, black 270deg, transparent 360deg)",
                  }}
                />
                <div
                  className="absolute inset-3 rounded-full pointer-events-none scan-ring-rev"
                  style={{
                    border: "1px solid rgba(96,165,250,0.18)",
                    maskImage:
                      "conic-gradient(from 45deg, transparent 0deg, black 60deg, transparent 140deg, black 220deg, transparent 320deg)",
                    WebkitMaskImage:
                      "conic-gradient(from 45deg, transparent 0deg, black 60deg, transparent 140deg, black 220deg, transparent 320deg)",
                  }}
                />
              </>
            )}

            {/* Live progress arc during a run */}
            {runActive && (
              <svg
                className="absolute inset-0 pointer-events-none"
                viewBox="0 0 100 100"
                style={{ transform: "rotate(-90deg)" }}
              >
                {/* Track */}
                <circle
                  cx="50" cy="50" r="48"
                  fill="none"
                  stroke="rgba(148,163,184,0.15)"
                  strokeWidth="0.8"
                />
                {/* Progress */}
                <circle
                  cx="50" cy="50" r="48"
                  fill="none"
                  stroke={run.paused ? "#fbbf24" : "#22c55e"}
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeDasharray={`${(runPct * 2 * Math.PI * 48).toFixed(2)} ${(2 * Math.PI * 48).toFixed(2)}`}
                  style={{
                    filter: `drop-shadow(0 0 2px ${run.paused ? "#fbbf24" : "#22c55e"})`,
                    transition: "stroke-dasharray 400ms linear",
                  }}
                />
              </svg>
            )}

            {/* Logo — floats freely inside the scan-ring frame; glow is
                carried by a pulsing drop-shadow rather than a card.
                Wrapped in a button so we can detect the 5-tap easter egg —
                the inner img keeps pointer-events-none so the click target
                is the wrapper, not the img itself (avoids dragstart fights). */}
            <div className="relative w-[92%] aspect-square flex items-center justify-center">
              <div className="flex flex-col items-center w-full">
                <button
                  type="button"
                  onClick={handleLogoTap}
                  aria-label="Ionetic"
                  className="w-full max-w-[640px] bg-transparent border-0 p-0 m-0 cursor-default focus:outline-none"
                >
                  <img
                    src="/brand/ionetic-logo.png"
                    alt="Ionetic"
                    className="logo-halo w-full object-contain select-none pointer-events-none"
                    draggable={false}
                  />
                </button>
                <div className="mt-4 text-[11px] tracking-[0.35em] text-slate-400 uppercase whitespace-nowrap">
                  Gillis Weld-bot V2.0
                </div>

                {runActive && (
                  <div className="mt-2 text-[10px] tracking-[0.3em] text-green-300/90 uppercase whitespace-nowrap">
                    {run.paused ? "Paused" : "Welding"} · {run.index}/{run.total}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="w-[38%] flex items-stretch min-w-0">
          <div className="w-full h-full flex flex-col justify-center gap-2.5 pr-1 py-2">
            {buttons.map((btn) => {
              const isPrimary = !!btn.primary;

              return (
                <button
                  key={btn.label}
                  onClick={btn.action}
                  className={`hud-btn ${isPrimary ? "hud-primary flex-[1.4]" : "flex-1"} group relative w-full text-left`}
                  style={{
                    background:
                      `linear-gradient(135deg, rgba(${btn.accentRgb},0.07) 0%, rgba(${btn.accentRgb},0.025) 50%, rgba(15,23,42,0.45) 100%)`,
                    border: `1px solid rgba(${btn.accentRgb}, ${isPrimary ? 0.25 : 0.16})`,
                    boxShadow: isPrimary
                      ? undefined
                      : `inset 0 0 14px rgba(${btn.accentRgb}, 0.03)`,
                  }}
                >
                  {/* Left accent rail — thinner, softer halo */}
                  <span
                    className="absolute left-0 top-3 bottom-3 w-[2px] rounded-r"
                    style={{
                      background: btn.accent,
                      opacity: 0.75,
                      boxShadow: `0 0 6px ${btn.accent}66`,
                    }}
                  />

                  {/* Hover sheen */}
                  <span className="hud-sheen" />

                  {/* Body */}
                  <div className={`relative flex items-center gap-3 h-full ${isPrimary ? "pl-5 pr-4 py-3" : "pl-4 pr-3 py-2.5"}`}>
                    {/* Icon tile */}
                    <div
                      className={`shrink-0 grid place-items-center rounded-lg border ${isPrimary ? "w-11 h-11" : "w-9 h-9"}`}
                      style={{
                        background: `rgba(${btn.accentRgb}, 0.06)`,
                        borderColor: `rgba(${btn.accentRgb}, 0.22)`,
                        color: btn.accent,
                      }}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width={isPrimary ? 22 : 18}
                        height={isPrimary ? 22 : 18}
                        fill="currentColor"
                      >
                        {btn.icon}
                      </svg>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div
                        className={`font-semibold leading-tight ${isPrimary ? "text-[28px]" : "text-[19px]"} truncate text-slate-100`}
                      >
                        {btn.label}
                      </div>
                      <div
                        className="mt-0.5 text-[13px] tracking-[0.18em] uppercase truncate text-slate-400"
                      >
                        {btn.sub}
                      </div>
                    </div>

                    {/* Chevron — quiet slate */}
                    <div className="shrink-0 text-slate-500">

                      <svg viewBox="0 0 24 24" width={isPrimary ? 22 : 18} height={isPrimary ? 22 : 18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </ScreenShell>
  );
}

/* ------------------------------- PRODUCTION ------------------------------- */

function ProductionScreen({ setScreen, programs, onHome, onBack, setActiveRun }) {
  const [selectedProgramName, setSelectedProgramName] = useState(programs[0]?.name || "");
  const [mode, setMode] = useState("Positive");

  const selectedProgram =
    programs.find((p) => p.name === selectedProgramName) ||
    (programs.length > 0 ? programs[0] : null);

  const accent = accentFor("production");

  return (
    <ScreenShell mode="production" onHome={onHome} onBack={onBack}>
      <div className="h-full min-h-0 grid grid-cols-12 gap-2">
        <HudCard
          accent={accent.color}
          accentRgb={accent.rgb}
          className="col-span-2 p-2 flex flex-col min-h-0"
        >
          <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1 pl-1">Programs</div>
          <div className="h-px bg-white/5 mb-2" />
          <DragScroll className="flex-1 space-y-1.5 overflow-auto pr-1">
            {programs.length > 0 ? (
              programs.map((p) => {
                const isSelected = selectedProgramName === p.name;
                return (
                  <button
                    key={p.name}
                    onClick={() => setSelectedProgramName(p.name)}
                    className="w-full rounded-lg p-2 text-left border transition"
                    style={
                      isSelected
                        ? {
                            background: `rgba(${accent.rgb},0.14)`,
                            borderColor: `rgba(${accent.rgb},0.5)`,
                            boxShadow: `inset 0 0 10px rgba(${accent.rgb},0.1), 0 0 0 1px rgba(${accent.rgb},0.12)`,
                          }
                        : {
                            background: "rgba(255,255,255,0.03)",
                            borderColor: "rgba(255,255,255,0.08)",
                          }
                    }
                  >
                    <div className={`text-sm font-medium ${isSelected ? "text-white" : ""}`}>{p.name}</div>
                    <div className="text-[11px] text-slate-400 mt-1">{p.cells} cells</div>
                  </button>
                );
              })
            ) : (
              <div className="text-xs text-slate-400 pl-1">No programs loaded</div>
            )}
          </DragScroll>
        </HudCard>

        <HudCard
          accent={accent.color}
          accentRgb={accent.rgb}
          className="col-span-10 p-2 flex flex-col min-h-0"
        >
          <div className="flex items-center justify-between mb-2 pl-1">
            <div>
              <div className="text-base font-semibold tracking-wide">{selectedProgram?.name || "No Program Selected"}</div>
              <div className="text-slate-400 text-[10px] tracking-[0.2em] uppercase mt-0.5">Production Preview</div>
            </div>
            <ModeSwitch mode={mode} setMode={setMode} width="w-48" />
          </div>
          <div className="h-px bg-white/5 mb-2" />

          {!selectedProgram ? (
            <div className="flex-1 min-h-0 flex items-center justify-center text-slate-400 text-sm">
              No programs available. Create one in Programs.
            </div>
          ) : (
            <div className="grid grid-cols-12 gap-2 flex-1 min-h-0">
              <div className="col-span-9 h-full min-h-0 overflow-hidden">
                <ProgramGraphic previewAllGrey coordinates={selectedProgram.coordinates} />
              </div>

              <div className="col-span-3 flex flex-col gap-2 min-h-0 overflow-hidden">
                <div
                  className="rounded-xl border p-2.5"
                  style={{
                    background: `linear-gradient(135deg, rgba(${accent.rgb},0.06), rgba(0,0,0,0.35))`,
                    borderColor: `rgba(${accent.rgb},0.2)`,
                  }}
                >
                  <div className="text-[10px] tracking-[0.25em] uppercase text-slate-400 mb-2">Program Info</div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between"><span className="text-slate-400">Mode</span><span>{mode}</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">Cells</span><span>{selectedProgram.cells}</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">Last Cycle</span><span>{selectedProgram.measured || "—"}</span></div>
                  </div>
                </div>

                <div className="mt-auto grid gap-2 shrink-0">
                  <button
                    onClick={() => {
                      setActiveRun({
                        programName: selectedProgram.name,
                        mode,
                        cells: selectedProgram.cells,
                        measured: selectedProgram.measured,
                        coordinates: selectedProgram.coordinates,
                        startPosition: selectedProgram.startPositions?.[modeKey(mode)] || null,
                      });
                      setScreen("run");
                    }}
                    className="hud-accent-btn h-11 px-4 text-sm font-semibold tracking-[0.18em] uppercase border"
                    style={{
                      background: `linear-gradient(135deg, rgba(${accent.rgb},0.9), rgba(${accent.rgb},0.7))`,
                      borderColor: `rgba(${accent.rgb},0.55)`,
                      boxShadow: `0 0 0 1px rgba(${accent.rgb},0.35), 0 0 22px rgba(${accent.rgb},0.3)`,
                      color: "#f0fdf4",
                    }}
                  >
                    ▶ Begin
                  </button>
                </div>
              </div>
            </div>
          )}
        </HudCard>
      </div>
    </ScreenShell>
  );
}

/* --------------------------- PROGRAMS: CALIBRATE -------------------------- */

function CalibrationScreen({ program, mode, onBack, onHome, updateProgramStartPosition }) {
  const machine = useMachine();
  const currentStart =
    program.startPositions?.[modeKey(mode)] || {
      x: DEFAULT_START_X,
      y: DEFAULT_START_Y,
      z: DEFAULT_START_Z,
    };

  const [step, setStep] = useState(1.0);
  const [pos, setPos] = useState(currentStart);
  // On entry, prompt the operator before driving the gantry to the saved start
  // position (or machine centre for a brand new program). Never move silently —
  // fixturing and parts may be on the table.
  const [moveConfirm, setMoveConfirm] = useState({
    open: true,
    target: currentStart,
  });
  // Pre-save confirmation. The operator clicks Save Start Position — instead
  // of immediately overwriting the stored value, we show an "Okay to save?"
  // modal so they can back out if they hit Save by mistake or want to nudge
  // a touch further first. Once they confirm, the actual persist + park-to-
  // loading prompt run as before.
  const [saveConfirm, setSaveConfirm] = useState({ open: false });
  // Post-save prompt: after the operator confirms the save we ask before
  // parking to loading. Never move the table without the operator explicitly
  // OK'ing it.
  const [savedPrompt, setSavedPrompt] = useState({ open: false });
  // Tracks the post-save park-to-loading travel so we can throw up the same
  // ionetic gif + live axis ticker the homing / loading-position overlays use.
  // The operator was leaving the table mid-travel after calibrating, which
  // confused the next program-launch's pre-move (it's expected to start from
  // the loading position).
  const [movingToLoad, setMovingToLoad] = useState(false);
  const [keypadState, setKeypadState] = useState({
    open: false,
    title: "",
    value: "",
    apply: () => {},
    allowNegative: false,
    allowDecimal: true,
  });

  const confirmMoveToStart = () => {
    const t = moveConfirm.target || currentStart;
    machine.setZ("UP");
    machine.moveTo(t.x, t.y);
    setPos(t);
    setMoveConfirm({ open: false, target: null });
  };
  const cancelMoveToStart = () =>
    setMoveConfirm({ open: false, target: null });

  const jog = (axis, dir) => {
    setPos((p) => {
      const next = { ...p, [axis]: Number((p[axis] + dir * step).toFixed(2)) };
      // Calibration jog — bypasses the firmware Z-up safety gate so the
      // operator can nudge the table with Z down (head touching the work)
      // to line up the start position visually. Every non-calibration MOVE
      // still uses moveTo() and gets the standard z_safe() check.
      machine.moveToCal(next.x, next.y);
      return next;
    });
  };

  const setZ = (dir) => {
    setPos((p) => ({ ...p, z: dir }));
    machine.setZ(dir);
  };

  // Step 1 of the save flow: operator clicks Save Start Position. Don't
  // persist yet — just open the confirmation modal. They confirm in the
  // modal to actually save.
  const saveStart = () => {
    setSaveConfirm({ open: true });
  };

  // Step 2 of the save flow: operator confirmed the save in the modal.
  // Persist the start position, then show the post-save / park-to-loading
  // prompt as before. Park is no longer automatic — operators were sometimes
  // mid-fixturing when the table launched, and the "okay to move table"
  // pattern from the entry prompt and other screens is the consistent way
  // to gate any gantry motion.
  const confirmSaveStart = () => {
    updateProgramStartPosition(program.name, modeKey(mode), pos);
    setSaveConfirm({ open: false });
    setSavedPrompt({ open: true });
  };
  const cancelSaveStart = () => setSaveConfirm({ open: false });

  // Every exit path from this screen MUST leave Z raised — operators were
  // jogging with Z DOWN to line the cell up against the presser foot, then
  // tapping Back / Skip without remembering to retract. The follow-up park
  // motion (or the next program's pre-move from this screen's entry on a
  // re-enter) would then try to translate XY with Z still pressed against
  // the workpiece. setZ('UP') is idempotent (already-up = no-op) and we
  // swallow rejections so a transient fault never strands the operator on
  // the screen with no way out.
  const raiseZThen = async (next) => {
    try { await machine.setZ('UP'); } catch { /* non-fatal */ }
    next();
  };
  const handleBack = () => { raiseZThen(onBack); };
  const handleHome = () => { raiseZThen(onHome); };

  // Operator confirmed the post-save park. Z UP → XY-to-loading sequence.
  // Best-effort — if either step fails (motion rejected, no loading
  // position configured, demo mode) we still drop the overlay and navigate
  // back so the operator isn't stranded on the spinner.
  const confirmParkAfterSave = async () => {
    setSavedPrompt({ open: false });
    setMovingToLoad(true);
    try { await machine.setZ('UP'); } catch { /* non-fatal */ }
    const lp = machine.state.loadingPosition;
    if (lp &&
        Number.isFinite(Number(lp.x)) &&
        Number.isFinite(Number(lp.y)) &&
        (Number(lp.x) !== 0 || Number(lp.y) !== 0)) {
      try { await machine.moveTo(Number(lp.x), Number(lp.y)); } catch { /* non-fatal */ }
    }
    setMovingToLoad(false);
    onBack();
  };

  // Operator chose not to park. Save already landed (confirmSaveStart ran
  // updateProgramStartPosition) — we just leave the gantry where it is and
  // pop back. Still raise Z first so the previous-cell calibration nudges
  // don't leave the head pressed against the workpiece during whatever the
  // next screen does.
  const skipParkAfterSave = async () => {
    setSavedPrompt({ open: false });
    try { await machine.setZ('UP'); } catch { /* non-fatal */ }
    onBack();
  };

  const cAccent = accentFor("programs");

  return (
    <ScreenShell mode="programs" onHome={handleHome} onBack={handleBack}>
      <div className="h-full min-h-0 grid grid-cols-12 gap-2">
        <HudCard
          accent={cAccent.color}
          accentRgb={cAccent.rgb}
          className="col-span-8 p-2 flex flex-col min-h-0"
        >
          <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1 shrink-0 pl-1">Calibrate Start Position</div>
          <div className="h-px bg-white/5 mb-2 shrink-0" />
          <div className="text-slate-400 text-xs mb-4 shrink-0 pl-1">
            {program.name} · {mode}
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4 max-w-xl mx-auto w-full shrink-0">
            <div />
            <button
              onClick={() => jog("y", 1)}
              className="rounded-[1rem] bg-white/10 border border-white/10 px-3 py-2.5 text-base font-semibold hover:bg-white/15"
            >
              Y+
            </button>
            <div />

            <button
              onClick={() => jog("x", -1)}
              className="rounded-[1rem] bg-white/10 border border-white/10 px-3 py-2.5 text-base font-semibold hover:bg-white/15"
            >
              X-
            </button>
            <div className="rounded-[1rem] border border-white/10 bg-black/20 p-3 flex items-center justify-center text-slate-300 font-medium">
              Jog
            </div>
            <button
              onClick={() => jog("x", 1)}
              className="rounded-[1rem] bg-white/10 border border-white/10 px-3 py-2.5 text-base font-semibold hover:bg-white/15"
            >
              X+
            </button>

            <div />
            <button
              onClick={() => jog("y", -1)}
              className="rounded-[1rem] bg-white/10 border border-white/10 px-3 py-2.5 text-base font-semibold hover:bg-white/15"
            >
              Y-
            </button>
            <div />
          </div>

          <div className="mb-3 max-w-lg mx-auto w-full shrink-0">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-slate-400">Step Size: {step.toFixed(1)} mm</div>
              <button
                onClick={() =>
                  setKeypadState({
                    open: true,
                    title: "Step Size",
                    value: String(step),
                    apply: (v) => setStep(Number(v || 0.1)),
                    allowNegative: false,
                    allowDecimal: true,
                  })
                }
                className="rounded-lg bg-white/10 border border-white/10 px-3 py-1 text-xs"
              >
                Enter
              </button>
            </div>
            <TouchSlider
              min="0.1"
              max="10"
              step="0.1"
              value={step}
              onChange={(e) => setStep(Number(e.target.value))}
            />
          </div>

          <div className="grid grid-cols-2 gap-2 max-w-lg mx-auto w-full mt-auto shrink-0">
            <button
              onClick={() => setZ("DOWN")}
              className="rounded-[0.85rem] h-10 bg-white/10 border border-white/10 px-3 text-sm font-semibold hover:bg-white/15"
            >
              Z DOWN
            </button>
            <button
              onClick={() => setZ("UP")}
              className="rounded-[0.85rem] h-10 bg-white/10 border border-white/10 px-3 text-sm font-semibold hover:bg-white/15"
            >
              Z UP
            </button>
          </div>
        </HudCard>

        <HudCard
          accent={cAccent.color}
          accentRgb={cAccent.rgb}
          className="col-span-4 p-2 flex flex-col min-h-0 overflow-hidden"
        >
          <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1 shrink-0 pl-1">Current Position</div>
          <div className="h-px bg-white/5 mb-3 shrink-0" />

          <div className="space-y-2.5 text-sm shrink-0">
            <div className="flex justify-between"><span className="text-slate-400">Program</span><span>{program.name}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">Mode</span><span>{mode}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">X</span><span style={{ color: cAccent.color }}>{pos.x}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">Y</span><span style={{ color: cAccent.color }}>{pos.y}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">Z</span><span>{pos.z}</span></div>
          </div>

          <div className="mt-auto grid gap-2 shrink-0">
            <button
              onClick={saveStart}
              className="hud-accent-btn h-10 px-4 text-xs font-semibold tracking-[0.15em] uppercase border"
              style={{
                background: `linear-gradient(135deg, rgba(${cAccent.rgb},0.85), rgba(${cAccent.rgb},0.6))`,
                borderColor: `rgba(${cAccent.rgb},0.5)`,
                boxShadow: `0 0 0 1px rgba(${cAccent.rgb},0.3), 0 0 18px rgba(${cAccent.rgb},0.25)`,
                color: "#f0f9ff",
              }}
            >
              Save Start Position
            </button>
          </div>
        </HudCard>
      </div>

      {keypadState.open && (
        <div className="absolute inset-0 z-[90] bg-black/55 rounded-[1.5rem] p-2">
          <EmbeddedNumericKeypad
            title={keypadState.title}
            value={keypadState.value}
            onChange={(v) => setKeypadState((s) => ({ ...s, value: v }))}
            onCancel={() => setKeypadState((s) => ({ ...s, open: false }))}
            onConfirm={() => {
              keypadState.apply(keypadState.value);
              setKeypadState((s) => ({ ...s, open: false }));
            }}
            allowNegative={keypadState.allowNegative}
            allowDecimal={keypadState.allowDecimal}
          />
        </div>
      )}

      {/* Move-to-start confirmation. Fires on entry so the operator can clear
          the table before the gantry drives to the saved (or default-centre)
          start position for this program/mode. */}
      {moveConfirm.open && (
        <div className="fixed inset-0 z-[9700] flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <HudCard
            accent={cAccent.color}
            accentRgb={cAccent.rgb}
            className="p-6 w-[min(520px,92vw)]"
          >
            <div className="text-[10px] tracking-[0.32em] uppercase text-slate-300 mb-1">
              Confirm Motion
            </div>
            <div
              className="text-xl font-bold mb-3"
              style={{ color: cAccent.color }}
            >
              Okay to move table?
            </div>
            <div className="text-sm text-slate-200 mb-3 leading-relaxed">
              The table will raise Z and travel to the start position for{" "}
              <span className="font-semibold">{program.name}</span> ({mode}) so
              you can jog from there. Clear any clamps, fixturing, or parts
              from the table before continuing.
            </div>
            <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-slate-300 leading-snug mb-5 font-mono">
              Target:&nbsp;X&nbsp;{(moveConfirm.target?.x ?? 0).toFixed(2)} mm
              &nbsp;·&nbsp;Y&nbsp;{(moveConfirm.target?.y ?? 0).toFixed(2)} mm
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={cancelMoveToStart}
                className="h-11 px-5 text-xs font-semibold tracking-[0.15em] uppercase rounded-lg border border-white/10 bg-white/5 hover:bg-white/10"
              >
                Not Yet
              </button>
              <button
                onClick={confirmMoveToStart}
                className="h-11 px-5 text-xs font-bold tracking-[0.18em] uppercase rounded-lg"
                style={{
                  background: `linear-gradient(135deg, rgba(${cAccent.rgb},0.85), rgba(${cAccent.rgb},0.5))`,
                  border: `1px solid rgba(${cAccent.rgb},0.5)`,
                  boxShadow: `0 0 18px rgba(${cAccent.rgb},0.3)`,
                  color: "#f0f9ff",
                }}
              >
                Move Table
              </button>
            </div>
          </HudCard>
        </div>
      )}

      {/* Pre-save confirmation. Operator pressed Save Start Position —
          gate the actual persist behind an explicit Yes so an accidental
          tap doesn't overwrite a known-good stored start position.
          Cancel just closes; Save lands updateProgramStartPosition and then
          opens the post-save park prompt below. */}
      {saveConfirm.open && (
        <div className="fixed inset-0 z-[9700] flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <HudCard
            accent={cAccent.color}
            accentRgb={cAccent.rgb}
            className="p-6 w-[min(520px,92vw)]"
          >
            <div className="text-[10px] tracking-[0.32em] uppercase text-slate-300 mb-1">
              Confirm Save
            </div>
            <div
              className="text-xl font-bold mb-3"
              style={{ color: cAccent.color }}
            >
              Save this start position?
            </div>
            <div className="text-sm text-slate-200 mb-3 leading-relaxed">
              This will overwrite the stored start position for{" "}
              <span className="font-semibold">{program.name}</span> ({mode})
              with the current jog position. The new value is used the next
              time you run this program.
            </div>
            <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-slate-300 leading-snug mb-5 font-mono">
              New start:&nbsp;X&nbsp;{(pos.x ?? 0).toFixed(2)} mm
              &nbsp;·&nbsp;Y&nbsp;{(pos.y ?? 0).toFixed(2)} mm
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={cancelSaveStart}
                className="h-11 px-5 text-xs font-semibold tracking-[0.15em] uppercase rounded-lg border border-white/10 bg-white/5 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={confirmSaveStart}
                className="h-11 px-5 text-xs font-bold tracking-[0.18em] uppercase rounded-lg"
                style={{
                  background: `linear-gradient(135deg, rgba(${cAccent.rgb},0.85), rgba(${cAccent.rgb},0.5))`,
                  border: `1px solid rgba(${cAccent.rgb},0.5)`,
                  boxShadow: `0 0 18px rgba(${cAccent.rgb},0.3)`,
                  color: "#f0f9ff",
                }}
              >
                Save
              </button>
            </div>
          </HudCard>
        </div>
      )}

      {/* Post-save confirmation + park-to-loading prompt. Shown after the
          operator confirms the save above. Matches the entry-time
          moveConfirm overlay stylistically so the "okay to move table?"
          gate is visually consistent across the screen. The save itself
          already landed before this overlay opens — Skip here only skips
          the park, it doesn't undo the save. */}
      {savedPrompt.open && (
        <div className="fixed inset-0 z-[9700] flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <HudCard
            accent={cAccent.color}
            accentRgb={cAccent.rgb}
            className="p-6 w-[min(520px,92vw)]"
          >
            <div className="text-[10px] tracking-[0.32em] uppercase text-slate-300 mb-1">
              Start Position Saved
            </div>
            <div
              className="text-xl font-bold mb-3"
              style={{ color: cAccent.color }}
            >
              Okay to move table back to loading position?
            </div>
            <div className="text-sm text-slate-200 mb-3 leading-relaxed">
              The new start position for{" "}
              <span className="font-semibold">{program.name}</span> ({mode})
              has been saved. The table will raise Z and travel to the stored
              loading position so the next operation starts from a known
              reference. Clear any clamps, fixturing, or parts from the table
              before continuing.
            </div>
            {machine.state.loadingPosition &&
              Number.isFinite(Number(machine.state.loadingPosition.x)) &&
              Number.isFinite(Number(machine.state.loadingPosition.y)) && (
                <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-slate-300 leading-snug mb-5 font-mono">
                  Loading position:&nbsp;X&nbsp;
                  {Number(machine.state.loadingPosition.x).toFixed(2)} mm
                  &nbsp;·&nbsp;Y&nbsp;
                  {Number(machine.state.loadingPosition.y).toFixed(2)} mm
                </div>
              )}
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={skipParkAfterSave}
                className="h-11 px-5 text-xs font-semibold tracking-[0.15em] uppercase rounded-lg border border-white/10 bg-white/5 hover:bg-white/10"
              >
                Skip
              </button>
              <button
                onClick={confirmParkAfterSave}
                className="h-11 px-5 text-xs font-bold tracking-[0.18em] uppercase rounded-lg"
                style={{
                  background: `linear-gradient(135deg, rgba(${cAccent.rgb},0.85), rgba(${cAccent.rgb},0.5))`,
                  border: `1px solid rgba(${cAccent.rgb},0.5)`,
                  boxShadow: `0 0 18px rgba(${cAccent.rgb},0.3)`,
                  color: "#f0f9ff",
                }}
              >
                Move Table
              </button>
            </div>
          </HudCard>
        </div>
      )}

      {/* Park-to-loading overlay shown after Save Start Position. Reuses the
          same ionetic spinner + live axis ticker pattern as the homing /
          loading-position / post-run-park overlays so the operator gets
          consistent visual feedback whenever the gantry moves itself. */}
      <LoadingOverlay
        visible={movingToLoad}
        title="Moving to loading position"
        subtext="Raising Z and travelling to the stored loading position"
      >
        <HomingAxisTicker />
      </LoadingOverlay>
    </ScreenShell>
  );
}

/* --------------------------- PROGRAMS: EDIT MODE -------------------------- */

function EditProgramScreen({
  program,
  mode,
  setEditing,
  setCalibratingStart,
  onHome,
  onBack,
  renameProgram,
  deleteProgram,
  saveProgramPattern,
}) {
  const machine = useMachine();
  const [showRenamePrompt, setShowRenamePrompt] = useState(false);
  const [renameValue, setRenameValue] = useState(program.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [exportStatus, setExportStatus] = useState({ label: "Export to USB", busy: false });

  const [cellXSpacing, setCellXSpacing] = useState(program.pattern?.cellXSpacing || "");
  const [cellYSpacing, setCellYSpacing] = useState(program.pattern?.cellYSpacing || "");
  const [cellsX, setCellsX] = useState(program.pattern?.cellsX || "");
  const [cellsY, setCellsY] = useState(program.pattern?.cellsY || "");
  const [offsetDirection, setOffsetDirection] = useState(program.pattern?.offsetDirection || "Offset Left");
  const [dwellTime, setDwellTime] = useState(
    program.pattern?.dwellTime != null ? String(program.pattern.dwellTime) : String(DEFAULT_DWELL_MS)
  );
  const [solenoid, setSolenoid] = useState(program.pattern?.solenoid || DEFAULT_SOLENOID);

  const [keypadState, setKeypadState] = useState({
    open: false,
    title: "",
    value: "",
    apply: () => {},
    allowNegative: false,
    allowDecimal: true,
  });

  useEffect(() => {
    setRenameValue(program.name);
    setCellXSpacing(program.pattern?.cellXSpacing || "");
    setCellYSpacing(program.pattern?.cellYSpacing || "");
    setCellsX(program.pattern?.cellsX || "");
    setCellsY(program.pattern?.cellsY || "");
    setOffsetDirection(program.pattern?.offsetDirection || "Offset Left");
    setDwellTime(program.pattern?.dwellTime != null ? String(program.pattern.dwellTime) : String(DEFAULT_DWELL_MS));
    setSolenoid(program.pattern?.solenoid || DEFAULT_SOLENOID);
  }, [program]);

  const previewCoordinates = useMemo(
    () =>
      generatePatternCoordinates({
        cellXSpacing,
        cellYSpacing,
        cellsX,
        cellsY,
        offsetDirection,
      }),
    [cellXSpacing, cellYSpacing, cellsX, cellsY, offsetDirection]
  );

  const confirmRename = () => {
    const nextName = renameValue.trim();
    if (!nextName || nextName === program.name) {
      setShowRenamePrompt(false);
      return;
    }
    renameProgram(program.name, nextName);
    setShowRenamePrompt(false);
  };

  const confirmDelete = () => {
    deleteProgram(program.name);
    setShowDeleteConfirm(false);
    setEditing(false);
    onBack();
  };

  const handleSavePattern = () => {
    saveProgramPattern(program.name, {
      cellXSpacing,
      cellYSpacing,
      cellsX,
      cellsY,
      offsetDirection,
      dwellTime: Number(dwellTime) || DEFAULT_DWELL_MS,
      solenoid,
    });
  };

  const openKeypad = (title, currentValue, applyFn, allowNegative = false, allowDecimal = true) => {
    setKeypadState({
      open: true,
      title,
      value: String(currentValue ?? ""),
      apply: applyFn,
      allowNegative,
      allowDecimal,
    });
  };

  return (
    <ScreenShell mode="programs" onHome={onHome} onBack={onBack}>
      <div className="h-full min-h-0 grid grid-cols-12 gap-2 relative">
        <div className="col-span-6 h-full min-h-0">
          {!keypadState.open ? (
            <ProgramGraphic previewAllGrey coordinates={previewCoordinates} />
          ) : (
            <EmbeddedNumericKeypad
              title={keypadState.title}
              value={keypadState.value}
              onChange={(v) => setKeypadState((s) => ({ ...s, value: v }))}
              onCancel={() => setKeypadState((s) => ({ ...s, open: false }))}
              onConfirm={() => {
                keypadState.apply(keypadState.value);
                setKeypadState((s) => ({ ...s, open: false }));
              }}
              allowNegative={keypadState.allowNegative}
              allowDecimal={keypadState.allowDecimal}
            />
          )}
        </div>

        <HudCard
          accent={accentFor("programs").color}
          accentRgb={accentFor("programs").rgb}
          className="col-span-3 p-2 flex flex-col min-h-0 overflow-hidden"
        >
          <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1 pl-1">Pattern Edit</div>
          <div className="h-px bg-white/5 mb-2" />

          <DragScroll
            className="rounded-xl border p-3 flex-1 min-h-0 overflow-auto flex flex-col gap-3"
            style={{
              background: `linear-gradient(135deg, rgba(${accentFor("programs").rgb},0.04), rgba(0,0,0,0.4))`,
              borderColor: `rgba(${accentFor("programs").rgb},0.18)`,
            }}
          >
            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Cell X Spacing</label>
              <button
                onClick={() => openKeypad("Cell X Spacing", cellXSpacing, setCellXSpacing, false, true)}
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10"
              >
                {cellXSpacing || "Enter value"}
              </button>
            </div>

            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Cell Y Spacing</label>
              <button
                onClick={() => openKeypad("Cell Y Spacing", cellYSpacing, setCellYSpacing, false, true)}
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10"
              >
                {cellYSpacing || "Enter value"}
              </button>
            </div>

            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Cells X</label>
              <button
                onClick={() => openKeypad("Cells X", cellsX, setCellsX, false, false)}
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10"
              >
                {cellsX || "Enter value"}
              </button>
            </div>

            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Cells Y</label>
              <button
                onClick={() => openKeypad("Cells Y", cellsY, setCellsY, false, false)}
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10"
              >
                {cellsY || "Enter value"}
              </button>
            </div>

            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Row Offset Direction</label>
              <ModeSwitch
                mode={offsetDirection}
                setMode={setOffsetDirection}
                leftLabel="Offset Left"
                rightLabel="Offset Right"
                width="w-full"
              />
            </div>

            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Laser Dwell (ms)</label>
              <button
                onClick={() => openKeypad("Laser Dwell Time (ms)", dwellTime, setDwellTime, false, false)}
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10"
              >
                {dwellTime || "Enter value"}
              </button>
            </div>

            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Solenoid</label>
              <div className="grid grid-cols-3 gap-1.5">
                {SOLENOID_OPTIONS.map((opt) => {
                  const active = solenoid === opt;
                  return (
                    <button
                      key={opt}
                      onClick={() => setSolenoid(opt)}
                      className="rounded-lg border px-2 py-2 text-xs font-bold tracking-wider transition"
                      style={{
                        background: active
                          ? `linear-gradient(135deg, rgba(${accentFor("programs").rgb},0.7), rgba(${accentFor("programs").rgb},0.35))`
                          : "rgba(255,255,255,0.04)",
                        borderColor: active
                          ? `rgba(${accentFor("programs").rgb},0.55)`
                          : "rgba(255,255,255,0.1)",
                        color: active ? "#f0f9ff" : "rgba(255,255,255,0.75)",
                        boxShadow: active
                          ? `0 0 12px rgba(${accentFor("programs").rgb},0.35)`
                          : "none",
                      }}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
              <div className="text-[10px] text-slate-500 mt-1 leading-tight">
                3 solenoids on manifold · A is primary head
              </div>
            </div>
          </DragScroll>
        </HudCard>

        <HudCard
          accent={accentFor("programs").color}
          accentRgb={accentFor("programs").rgb}
          className="col-span-3 p-2 flex flex-col gap-2 min-h-0 overflow-hidden justify-start"
        >
          <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1 pl-1">Program Actions</div>
          <div className="h-px bg-white/5" />

          <div
            className="rounded-xl border p-2.5 text-xs space-y-1.5 shrink-0"
            style={{
              background: `linear-gradient(135deg, rgba(${accentFor("programs").rgb},0.06), rgba(0,0,0,0.35))`,
              borderColor: `rgba(${accentFor("programs").rgb},0.2)`,
            }}
          >
            <div className="flex justify-between"><span className="text-slate-400">Program</span><span>{program.name}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">Mode</span><span>{mode}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">Cells</span><span>{previewCoordinates.length}</span></div>
          </div>

          <div className="grid auto-rows-min gap-2 shrink-0">
            <button
              onClick={() => setShowRenamePrompt(true)}
              className="rounded-[0.75rem] h-10 bg-white/5 border border-white/10 px-3 text-xs font-semibold tracking-wide text-left flex items-center hover:bg-white/10"
            >
              Rename Program
            </button>

            <button
              onClick={async () => {
                if (exportStatus.busy) return;
                setExportStatus({ label: "Exporting…", busy: true });
                try {
                  const res = await machine.exportUsbProgram(program);
                  setExportStatus({
                    label: res?.ok ? "Exported ✓" : (res?.reply || "Export failed"),
                    busy: false,
                  });
                } catch (err) {
                  setExportStatus({ label: err?.message || "Export failed", busy: false });
                }
                setTimeout(() => setExportStatus({ label: "Export to USB", busy: false }), 2000);
              }}
              disabled={exportStatus.busy}
              className="rounded-[0.75rem] h-10 bg-white/5 border border-white/10 px-3 text-xs font-semibold tracking-wide text-left flex items-center justify-between hover:bg-white/10"
            >
              <span>{exportStatus.label}</span>
              {exportStatus.busy && <RingSpinner size={12} stroke={3} speed={1.0} />}
            </button>

            <button
              onClick={() => setCalibratingStart(true)}
              className="rounded-[0.75rem] h-10 bg-white/5 border border-white/10 px-3 text-xs font-semibold tracking-wide text-left flex items-center hover:bg-white/10"
            >
              Calibrate Start Position
            </button>

            <button
              onClick={handleSavePattern}
              className="hud-accent-btn h-10 px-3 text-xs font-semibold tracking-[0.15em] uppercase text-left flex items-center border"
              style={{
                background: `linear-gradient(135deg, rgba(${accentFor("programs").rgb},0.85), rgba(${accentFor("programs").rgb},0.6))`,
                borderColor: `rgba(${accentFor("programs").rgb},0.5)`,
                boxShadow: `0 0 0 1px rgba(${accentFor("programs").rgb},0.3), 0 0 18px rgba(${accentFor("programs").rgb},0.25)`,
                color: "#f0f9ff",
              }}
            >
              Save Pattern
            </button>

            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="rounded-[0.75rem] h-10 px-3 text-xs font-semibold tracking-[0.1em] uppercase text-left flex items-center border"
              style={{
                background: "rgba(239,68,68,0.14)",
                borderColor: "rgba(239,68,68,0.35)",
                color: "#fecaca",
              }}
            >
              Delete Program
            </button>
          </div>
        </HudCard>

        {showRenamePrompt && (
          <div className="absolute inset-0 bg-black/60 z-[95] p-0">
            <EmbeddedQwertyKeyboard
              title="Rename Program"
              value={renameValue}
              onChange={setRenameValue}
              onCancel={() => setShowRenamePrompt(false)}
              onConfirm={confirmRename}
            />
          </div>
        )}

        {showDeleteConfirm && (
          <div className="absolute inset-0 bg-black/55 flex items-center justify-center z-[95]">
            <div className="w-[360px] rounded-[1.5rem] border border-white/10 bg-slate-900 p-5 shadow-2xl">
              <div className="text-xl font-semibold mb-3">Delete Program?</div>
              <div className="text-slate-300 text-sm mb-5">
                Are you sure you want to delete {program.name}? This cannot be undone.
              </div>
              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="rounded-[1rem] bg-white/10 border border-white/10 px-4 py-3 font-semibold"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDelete}
                  className="rounded-[1rem] bg-red-600 hover:bg-red-500 px-4 py-3 font-semibold"
                >
                  Confirm Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ScreenShell>
  );
}

/* -------------------------- PROGRAMS: CREATE NEW -------------------------- */

function CreateProgramScreen({ onHome, onBack, addProgram }) {
  const [rows, setRows] = useState([]);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [newProgramName, setNewProgramName] = useState("");
  const [cellXSpacing, setCellXSpacing] = useState("");
  const [cellYSpacing, setCellYSpacing] = useState("");
  const [cellsX, setCellsX] = useState("");
  const [cellsY, setCellsY] = useState("");
  const [offsetDirection, setOffsetDirection] = useState("Offset Right");
  const [dwellTime, setDwellTime] = useState(String(DEFAULT_DWELL_MS));
  const [solenoid, setSolenoid] = useState(DEFAULT_SOLENOID);
  const [keypadState, setKeypadState] = useState({
    open: false,
    title: "",
    value: "",
    apply: () => {},
    allowNegative: false,
    allowDecimal: true,
  });

  useEffect(() => {
    const generated = generatePatternCoordinates({
      cellXSpacing,
      cellYSpacing,
      cellsX,
      cellsY,
      offsetDirection,
    });
    setRows(generated);
  }, [cellXSpacing, cellYSpacing, cellsX, cellsY, offsetDirection]);

  const openKeypad = (title, currentValue, applyFn, allowNegative = false, allowDecimal = true) => {
    setKeypadState({
      open: true,
      title,
      value: String(currentValue ?? ""),
      apply: applyFn,
      allowNegative,
      allowDecimal,
    });
  };

  const saveProgram = () => {
    if (!newProgramName.trim()) return;
    addProgram({
      ...makeProgram(
        newProgramName.trim(),
        makePattern(
          cellXSpacing,
          cellYSpacing,
          cellsX,
          cellsY,
          offsetDirection,
          Number(dwellTime) || DEFAULT_DWELL_MS,
          solenoid
        )
      ),
      measured: null,
    });
    onBack();
  };

  return (
    <ScreenShell mode="programs" onHome={onHome} onBack={onBack}>
      <div className="h-full min-h-0 grid grid-cols-12 gap-2 relative">
        <div className="col-span-8 h-full min-h-0">
          {!keypadState.open ? (
            <ProgramGraphic previewAllGrey coordinates={rows} />
          ) : (
            <EmbeddedNumericKeypad
              title={keypadState.title}
              value={keypadState.value}
              onChange={(v) => setKeypadState((s) => ({ ...s, value: v }))}
              onCancel={() => setKeypadState((s) => ({ ...s, open: false }))}
              onConfirm={() => {
                keypadState.apply(keypadState.value);
                setKeypadState((s) => ({ ...s, open: false }));
              }}
              allowNegative={keypadState.allowNegative}
              allowDecimal={keypadState.allowDecimal}
            />
          )}
        </div>

        <HudCard
          accent={accentFor("programs").color}
          accentRgb={accentFor("programs").rgb}
          className="col-span-4 p-2 flex flex-col gap-2 min-h-0 overflow-hidden"
        >
          <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1 pl-1">New Program</div>
          <div className="h-px bg-white/5" />

          <DragScroll
            className="rounded-xl border p-3 space-y-3 overflow-auto flex-1 min-h-0"
            style={{
              background: `linear-gradient(135deg, rgba(${accentFor("programs").rgb},0.04), rgba(0,0,0,0.4))`,
              borderColor: `rgba(${accentFor("programs").rgb},0.18)`,
            }}
          >
            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Cell X Spacing</label>
              <button
                onClick={() => openKeypad("Cell X Spacing", cellXSpacing, setCellXSpacing, false, true)}
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10"
              >
                {cellXSpacing || "Enter value"}
              </button>
            </div>

            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Cell Y Spacing</label>
              <button
                onClick={() => openKeypad("Cell Y Spacing", cellYSpacing, setCellYSpacing, false, true)}
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10"
              >
                {cellYSpacing || "Enter value"}
              </button>
            </div>

            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Cells X</label>
              <button
                onClick={() => openKeypad("Cells X", cellsX, setCellsX, false, false)}
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10"
              >
                {cellsX || "Enter value"}
              </button>
            </div>

            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Cells Y</label>
              <button
                onClick={() => openKeypad("Cells Y", cellsY, setCellsY, false, false)}
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10"
              >
                {cellsY || "Enter value"}
              </button>
            </div>

            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Row Offset Direction</label>
              <ModeSwitch
                mode={offsetDirection}
                setMode={setOffsetDirection}
                leftLabel="Offset Left"
                rightLabel="Offset Right"
                width="w-full"
              />
            </div>

            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Laser Dwell (ms)</label>
              <button
                onClick={() => openKeypad("Laser Dwell Time (ms)", dwellTime, setDwellTime, false, false)}
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10"
              >
                {dwellTime || "Enter value"}
              </button>
            </div>

            <div>
              <label className="block text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1.5">Solenoid</label>
              <div className="grid grid-cols-3 gap-1.5">
                {SOLENOID_OPTIONS.map((opt) => {
                  const active = solenoid === opt;
                  return (
                    <button
                      key={opt}
                      onClick={() => setSolenoid(opt)}
                      className="rounded-lg border px-2 py-2 text-xs font-bold tracking-wider transition"
                      style={{
                        background: active
                          ? `linear-gradient(135deg, rgba(${accentFor("programs").rgb},0.7), rgba(${accentFor("programs").rgb},0.35))`
                          : "rgba(255,255,255,0.04)",
                        borderColor: active
                          ? `rgba(${accentFor("programs").rgb},0.55)`
                          : "rgba(255,255,255,0.1)",
                        color: active ? "#f0f9ff" : "rgba(255,255,255,0.75)",
                        boxShadow: active
                          ? `0 0 12px rgba(${accentFor("programs").rgb},0.35)`
                          : "none",
                      }}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
              <div className="text-[10px] text-slate-500 mt-1 leading-tight">
                3 solenoids on manifold · A is primary head
              </div>
            </div>

            <div
              className="rounded-xl border p-2.5 text-xs space-y-1.5"
              style={{
                background: `rgba(${accentFor("programs").rgb},0.06)`,
                borderColor: `rgba(${accentFor("programs").rgb},0.2)`,
              }}
            >
              <div className="flex justify-between"><span className="text-slate-400">Total Cells</span><span>{rows.length}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Pattern</span><span>{cellsX || 0} × {cellsY || 0}</span></div>
            </div>
          </DragScroll>

          <div className="grid gap-2 shrink-0">
            <button
              onClick={() => setShowSavePrompt(true)}
              className="hud-accent-btn h-10 px-4 text-xs font-semibold tracking-[0.15em] uppercase text-left flex items-center border"
              style={{
                background: `linear-gradient(135deg, rgba(${accentFor("programs").rgb},0.85), rgba(${accentFor("programs").rgb},0.6))`,
                borderColor: `rgba(${accentFor("programs").rgb},0.5)`,
                boxShadow: `0 0 0 1px rgba(${accentFor("programs").rgb},0.3), 0 0 18px rgba(${accentFor("programs").rgb},0.25)`,
                color: "#f0f9ff",
              }}
            >
              Save Program
            </button>

            <button
              onClick={onBack}
              className="rounded-[0.75rem] h-10 bg-white/5 border border-white/10 px-4 text-xs font-semibold tracking-wide text-left flex items-center"
            >
              Cancel
            </button>
          </div>
        </HudCard>

        {showSavePrompt && (
          <div className="absolute inset-0 bg-black/60 z-[95] p-0">
            <EmbeddedQwertyKeyboard
              title="Save New Program"
              value={newProgramName}
              onChange={setNewProgramName}
              onCancel={() => setShowSavePrompt(false)}
              onConfirm={saveProgram}
            />
          </div>
        )}
      </div>
    </ScreenShell>
  );
}

/* ------------------------------- PROGRAMS -------------------------------- */

function ProgramsScreen({ programs, setPrograms, addProgram, setScreen, onHome, onBack, setActiveRun }) {
  const machine = useMachine();
  const [selectedProgramName, setSelectedProgramName] = useState(programs[0]?.name || "");
  const [mode, setMode] = useState("Positive");
  const [manualMode, setManualMode] = useState(false);
  const [editing, setEditing] = useState(false);
  const [calibratingStart, setCalibratingStart] = useState(false);
  const [selectedCell, setSelectedCell] = useState(1);
  const [reweldedCells, setReweldedCells] = useState([]);
  const [usbImport, setUsbImport] = useState({ open: false, loading: false, files: [], error: null, importing: null });

  const selectedProgram =
    programs.find((p) => p.name === selectedProgramName) ||
    (programs.length > 0 ? programs[0] : null);

  useEffect(() => {
    if (!manualMode) setReweldedCells([]);
  }, [manualMode]);

  useEffect(() => {
    setReweldedCells([]);
  }, [selectedProgramName]);

  useEffect(() => {
    if (selectedProgram?.coordinates?.length) {
      setSelectedCell((prev) => {
        const exists = selectedProgram.coordinates.some((c) => c.id === prev);
        return exists ? prev : selectedProgram.coordinates[0].id;
      });
    } else {
      setSelectedCell(1);
    }
  }, [selectedProgram]);

  // -------------------------------------------------------------------------
  // Manual Cell Select — handlers
  //
  // The Manual Cell Select panel lets the operator pick any cell in the
  // pattern and run the per-cell sequence by hand (move to it, drop Z, fire,
  // raise Z). Useful for re-welding a missed cell after a run aborted, or for
  // smoke-testing a new program one cell at a time before committing to a
  // full run.
  //
  // Cell → machine coordinate has to match the runOrchestrator's mapping
  // exactly, otherwise the manual move would land somewhere different to
  // where the run would have welded that cell:
  //   1. Logical pattern coord (cx, cy) comes off selectedProgram.coordinates
  //      indexed by `selectedCell` (1-based id).
  //   2. PATTERN_ROTATION (90° CCW): physical offset = (-cy, cx). The cell
  //      module is mounted rotated 90° CW relative to the pattern editor's
  //      logical layout — see PATTERN_ROTATION at the top of
  //      server/runOrchestrator.js for the full derivation.
  //   3. Moving-table frame inversion: target = start - physical offset.
  // Keep these in lockstep with runOrchestrator.runLoop's cell→target maths.
  const manualCellTarget = () => {
    if (!selectedProgram) return null;
    const start = selectedProgram.startPositions?.[modeKey(mode)];
    if (!start || !Number.isFinite(Number(start.x)) || !Number.isFinite(Number(start.y))) {
      return null;
    }
    const cell = selectedProgram.coordinates?.find((c) => c.id === selectedCell);
    if (!cell) return null;
    const cx = Number(cell.x) || 0;
    const cy = Number(cell.y) || 0;
    // Same 90° CCW rotation runOrchestrator uses.
    const px = -cy;
    const py =  cx;
    // Moving-table frame inversion.
    const tx = Number(start.x) - px;
    const ty = Number(start.y) - py;
    return { x: tx, y: ty };
  };

  const handleManualMoveToCell = async () => {
    const target = manualCellTarget();
    if (!target) return;  // No start position set / no coords — silently no-op.
    // Z UP before any XY motion — same rule every other operation in the GUI
    // follows. Without this the manual move would race the firmware's z_safe()
    // interlock and get rejected with BUSY whenever the operator had Z DOWN
    // from a prior manual cycle.
    try { await machine.setZ('UP'); } catch { /* non-fatal */ }
    try { await machine.moveTo(target.x, target.y); } catch { /* non-fatal */ }
  };

  const handleManualZDown = () => { machine.setZ('DOWN'); };
  const handleManualZUp   = () => { machine.setZ('UP'); };

  // Fire Laser: actually fire the laser via the firmware FIRE command, then
  // mark the cell as rewelded in the UI (the existing visual cue — coloured
  // dot on the pattern graphic — works off `reweldedCells`). Previous
  // behaviour only updated the UI state and never sent FIRE to the firmware,
  // so the laser never pulsed.
  const handleManualFire = async () => {
    try { await machine.fire(); } catch { /* non-fatal — operator can retry */ }
    if (!reweldedCells.includes(selectedCell)) {
      setReweldedCells([...reweldedCells, selectedCell]);
    }
  };

  const updateProgramStartPosition = (programName, modeName, pos) => {
    setPrograms((prev) =>
      prev.map((p) =>
        p.name === programName
          ? {
              ...p,
              startPositions: {
                ...p.startPositions,
                [modeName]: pos,
              },
            }
          : p
      )
    );
  };

  const renameProgram = (oldName, newName) => {
    setPrograms((prev) =>
      prev.map((p) =>
        p.name === oldName
          ? {
              ...p,
              name: newName,
            }
          : p
      )
    );
    setSelectedProgramName(newName);
  };

  const deleteProgram = (programName) => {
    setPrograms((prev) => {
      const filtered = prev.filter((p) => p.name !== programName);
      setSelectedProgramName(filtered[0]?.name || "");
      return filtered;
    });
  };

  // ------------------------- USB import/export -------------------------
  //
  // The Pi mounts the FAT32 stick at /mnt/usb. The backend scans for
  // `*.gillis.json` files when the operator presses Import from USB on
  // this screen or Export to USB on the edit screen. We surface errors
  // inline in the modal so the operator knows whether the stick is
  // missing / write-protected / empty.
  const openUsbImport = async () => {
    setUsbImport({ open: true, loading: true, files: [], error: null, importing: null });
    try {
      const res = await machine.listUsbPrograms();
      if (!res?.ok) {
        setUsbImport({
          open: true,
          loading: false,
          files: [],
          error: res?.reply || "USB not available",
          importing: null,
        });
        return;
      }
      setUsbImport({
        open: true,
        loading: false,
        files: Array.isArray(res.files) ? res.files : [],
        error: null,
        importing: null,
      });
    } catch (err) {
      setUsbImport({
        open: true,
        loading: false,
        files: [],
        error: err?.message || "USB read failed",
        importing: null,
      });
    }
  };

  const closeUsbImport = () => setUsbImport((s) => ({ ...s, open: false }));

  const importFromUsb = async (filename) => {
    setUsbImport((s) => ({ ...s, importing: filename, error: null }));
    try {
      const res = await machine.importUsbProgram(filename);
      if (!res?.ok || !res.program) {
        setUsbImport((s) => ({
          ...s,
          importing: null,
          error: res?.reply || "Import failed",
        }));
        return;
      }
      // Normalise the imported program so it has all fields our UI expects,
      // without clobbering a program of the same name — we suffix with a
      // timestamp on collision.
      const incoming = res.program;
      let importedName = incoming.name || filename.replace(/\.gillis\.json$/i, "") || "Imported";
      if (programs.some((p) => p.name === importedName)) {
        importedName = `${importedName} (imported ${new Date().toLocaleTimeString()})`;
      }
      const pattern = {
        cellXSpacing: String(incoming.pattern?.cellXSpacing ?? 20),
        cellYSpacing: String(incoming.pattern?.cellYSpacing ?? 20),
        cellsX: String(incoming.pattern?.cellsX ?? 1),
        cellsY: String(incoming.pattern?.cellsY ?? 1),
        offsetDirection: incoming.pattern?.offsetDirection || DEFAULT_OFFSET_DIRECTION,
        dwellTime: Number(incoming.pattern?.dwellTime) || DEFAULT_DWELL_MS,
        solenoid: SOLENOID_OPTIONS.includes(incoming.pattern?.solenoid)
          ? incoming.pattern.solenoid
          : DEFAULT_SOLENOID,
      };
      const coordinates = Array.isArray(incoming.coordinates) && incoming.coordinates.length
        ? incoming.coordinates
        : generatePatternCoordinates(pattern);
      addProgram({
        name: importedName,
        cells: coordinates.length,
        measured: incoming.measured || null,
        pattern,
        coordinates,
        startPositions: incoming.startPositions || {
          positive: makeXYZ(),
          negative: makeXYZ(),
        },
      });
      setSelectedProgramName(importedName);
      setUsbImport({ open: false, loading: false, files: [], error: null, importing: null });
    } catch (err) {
      setUsbImport((s) => ({
        ...s,
        importing: null,
        error: err?.message || "Import failed",
      }));
    }
  };

  const saveProgramPattern = (programName, pattern) => {
    const coordinates = generatePatternCoordinates(pattern);
    setPrograms((prev) =>
      prev.map((p) =>
        p.name === programName
          ? {
              ...p,
              pattern: {
                cellXSpacing: String(pattern.cellXSpacing),
                cellYSpacing: String(pattern.cellYSpacing),
                cellsX: String(pattern.cellsX),
                cellsY: String(pattern.cellsY),
                offsetDirection: pattern.offsetDirection,
                dwellTime:
                  pattern.dwellTime != null
                    ? Number(pattern.dwellTime) || DEFAULT_DWELL_MS
                    : p.pattern?.dwellTime ?? DEFAULT_DWELL_MS,
                solenoid:
                  SOLENOID_OPTIONS.includes(pattern.solenoid)
                    ? pattern.solenoid
                    : p.pattern?.solenoid || DEFAULT_SOLENOID,
              },
              coordinates,
              cells: coordinates.length,
            }
          : p
      )
    );
  };

  if (calibratingStart && selectedProgram) {
    return (
      <CalibrationScreen
        program={selectedProgram}
        mode={mode}
        onBack={() => setCalibratingStart(false)}
        onHome={onHome}
        updateProgramStartPosition={updateProgramStartPosition}
      />
    );
  }

  if (editing && selectedProgram) {
    return (
      <EditProgramScreen
        program={selectedProgram}
        mode={mode}
        setEditing={setEditing}
        setCalibratingStart={setCalibratingStart}
        onHome={onHome}
        onBack={onBack}
        renameProgram={renameProgram}
        deleteProgram={deleteProgram}
        saveProgramPattern={saveProgramPattern}
      />
    );
  }

  const accent = accentFor("programs");
  const amber = accentFor("diagnostics");

  return (
    <ScreenShell mode="programs" onHome={onHome} onBack={onBack}>
      <div className="h-full min-h-0 grid grid-cols-12 gap-2">
        {!manualMode && (
          <HudCard
            accent={accent.color}
            accentRgb={accent.rgb}
            className="col-span-2 p-2 flex flex-col min-h-0"
          >
            <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1 pl-1">Programs</div>
            <div className="h-px bg-white/5 mb-2" />

            <DragScroll className="flex-1 space-y-1.5 overflow-auto pr-1">
              {programs.length > 0 ? (
                programs.map((p) => {
                  const isSelected = selectedProgramName === p.name;
                  return (
                    <button
                      key={p.name}
                      onClick={() => setSelectedProgramName(p.name)}
                      className="w-full rounded-lg p-2 text-left border transition"
                      style={
                        isSelected
                          ? {
                              background: `rgba(${accent.rgb},0.14)`,
                              borderColor: `rgba(${accent.rgb},0.5)`,
                              boxShadow: `inset 0 0 10px rgba(${accent.rgb},0.1), 0 0 0 1px rgba(${accent.rgb},0.12)`,
                            }
                          : {
                              background: "rgba(255,255,255,0.03)",
                              borderColor: "rgba(255,255,255,0.08)",
                            }
                      }
                    >
                      <div className={`text-sm font-medium ${isSelected ? "text-white" : ""}`}>{p.name}</div>
                      <div className="text-[11px] text-slate-400 mt-1">{p.cells} cells</div>
                    </button>
                  );
                })
              ) : (
                <div className="text-center text-slate-400 text-sm mt-10">
                  No programs yet
                  <br />
                  Tap "Create New Program"
                </div>
              )}
            </DragScroll>

            <div className="mt-3 grid gap-2">
              <button
                onClick={() => setScreen("createProgram")}
                className="hud-accent-btn h-10 px-3 text-xs font-semibold tracking-[0.15em] uppercase border"
                style={{
                  background: `linear-gradient(135deg, rgba(${accent.rgb},0.85), rgba(${accent.rgb},0.6))`,
                  borderColor: `rgba(${accent.rgb},0.5)`,
                  boxShadow: `0 0 0 1px rgba(${accent.rgb},0.3), 0 0 18px rgba(${accent.rgb},0.25)`,
                  color: "#f0f9ff",
                }}
              >
                Create New
              </button>
              <button
                onClick={openUsbImport}
                className="rounded-[0.75rem] h-9 bg-white/5 border border-white/10 px-3 text-xs font-semibold tracking-wide hover:bg-white/10"
              >
                Import from USB
              </button>
            </div>
          </HudCard>
        )}

        <div className={`${manualMode ? "col-span-8" : "col-span-7"} h-full min-h-0 overflow-hidden`}>
          {selectedProgram ? (
            <ProgramGraphic
              selectable={manualMode}
              selectedCell={selectedCell}
              setSelectedCell={setSelectedCell}
              reweldedCells={reweldedCells}
              previewAllGrey
              coordinates={selectedProgram.coordinates}
            />
          ) : (
            <HudCard
              accent={accent.color}
              accentRgb={accent.rgb}
              className="h-full flex items-center justify-center text-slate-400 text-sm"
            >
              No program selected
            </HudCard>
          )}
        </div>

        <HudCard
          accent={accent.color}
          accentRgb={accent.rgb}
          className={`${manualMode ? "col-span-4" : "col-span-3"} p-2 flex flex-col gap-2 min-h-0 overflow-hidden`}
        >
          <div className="flex items-center justify-between gap-2 flex-wrap pl-1">
            <div>
              <div className="text-base font-semibold tracking-wide">{selectedProgram?.name || "No Program"}</div>
              <div className="text-slate-400 text-[10px] tracking-[0.2em] uppercase mt-0.5">Program Detail</div>
            </div>
            <ModeSwitch mode={mode} setMode={setMode} width={manualMode ? "w-52" : "w-44"} />
          </div>
          <div className="h-px bg-white/5" />

          {selectedProgram ? (
            <>
              {!manualMode && (
                <div
                  className="rounded-xl border p-2.5"
                  style={{
                    background: `linear-gradient(135deg, rgba(${accent.rgb},0.06), rgba(0,0,0,0.35))`,
                    borderColor: `rgba(${accent.rgb},0.2)`,
                  }}
                >
                  <div className="text-[10px] tracking-[0.25em] uppercase text-slate-400 mb-2">Program Info</div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between"><span className="text-slate-400">Mode</span><span>{mode}</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">Cells</span><span>{selectedProgram.cells}</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">Last Cycle</span><span>{selectedProgram.measured || "—"}</span></div>
                  </div>
                </div>
              )}

              {manualMode ? (
                <DragScroll
                  className="rounded-xl border p-2.5 flex flex-col gap-2 flex-1 min-h-0 overflow-auto"
                  style={{
                    background: `linear-gradient(135deg, rgba(${amber.rgb},0.08), rgba(0,0,0,0.35))`,
                    borderColor: `rgba(${amber.rgb},0.3)`,
                  }}
                >
                  <div className="text-xs tracking-[0.2em] uppercase font-semibold text-amber-200">Manual Cell Select</div>

                  <div className="text-xs text-slate-300">Cell {selectedCell}</div>

                  <div className="grid gap-2 mt-1">
                    <button
                      onClick={handleManualMoveToCell}
                      className="rounded-[0.75rem] h-10 bg-blue-600 text-sm font-semibold hover:bg-blue-500"
                    >
                      Move to Cell
                    </button>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={handleManualZDown}
                        className="rounded-[0.75rem] h-10 bg-white/10 text-sm font-semibold hover:bg-white/15"
                      >
                        Z Down
                      </button>
                      <button
                        onClick={handleManualZUp}
                        className="rounded-[0.75rem] h-10 bg-white/10 text-sm font-semibold hover:bg-white/15"
                      >
                        Z Up
                      </button>
                    </div>

                    <button
                      onClick={handleManualFire}
                      className="rounded-[0.75rem] h-10 bg-red-600 text-sm font-semibold hover:bg-red-500"
                    >
                      Fire Laser
                    </button>

                    <button
                      onClick={() => {
                        setReweldedCells([]);
                        setManualMode(false);
                      }}
                      className="rounded-[0.75rem] h-10 bg-white/10 text-sm font-semibold"
                    >
                      Exit
                    </button>
                  </div>
                </DragScroll>
              ) : (
                <div className="mt-auto grid gap-2 pt-1 shrink-0">
                  <button
                    onClick={() => {
                      if (!selectedProgram) return;
                      setActiveRun({
                        programName: selectedProgram.name,
                        mode,
                        cells: selectedProgram.cells,
                        measured: selectedProgram.measured,
                        coordinates: selectedProgram.coordinates,
                        startPosition: selectedProgram.startPositions?.[modeKey(mode)] || null,
                        testRun: true,
                      });
                      setScreen("run");
                    }}
                    className="hud-accent-btn h-10 px-4 text-xs font-semibold tracking-[0.15em] uppercase border"
                    style={{
                      background: `linear-gradient(135deg, rgba(${accent.rgb},0.85), rgba(${accent.rgb},0.6))`,
                      borderColor: `rgba(${accent.rgb},0.5)`,
                      boxShadow: `0 0 0 1px rgba(${accent.rgb},0.3), 0 0 18px rgba(${accent.rgb},0.25)`,
                      color: "#f0f9ff",
                    }}
                  >
                    ▸ Test Run
                  </button>

                  <button
                    onClick={() => setEditing(true)}
                    className="rounded-[0.75rem] h-10 bg-white/5 border border-white/10 px-4 text-xs font-semibold tracking-wide"
                  >
                    Edit Program
                  </button>

                  <button
                    onClick={() => setManualMode(true)}
                    className="rounded-[0.75rem] h-10 px-4 text-xs font-semibold tracking-wide border"
                    style={{
                      background: `rgba(${amber.rgb},0.12)`,
                      borderColor: `rgba(${amber.rgb},0.3)`,
                      color: "#fde68a",
                    }}
                  >
                    Manual Cell Select
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
              No program loaded
            </div>
          )}
        </HudCard>
      </div>

      {usbImport.open && (
        <UsbImportModal
          state={usbImport}
          onClose={closeUsbImport}
          onPick={importFromUsb}
          onRefresh={openUsbImport}
        />
      )}
    </ScreenShell>
  );
}

/* --------------------------- USB IMPORT MODAL ---------------------------- */
// Thin, self-contained modal for picking a `*.gillis.json` file off the USB
// stick mounted at /mnt/usb. All command plumbing lives on ProgramsScreen;
// this component is pure presentation + event handlers.

function UsbImportModal({ state, onClose, onPick, onRefresh }) {
  const accent = accentFor("programs");
  const busy = state.loading || !!state.importing;

  return (
    <div className="absolute inset-0 z-[95] flex items-center justify-center bg-black/70 backdrop-blur-sm p-6">
      <HudCard
        accent={accent.color}
        accentRgb={accent.rgb}
        className="p-5 w-[min(560px,92vw)] max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between mb-1">
          <div>
            <div className="text-[10px] tracking-[0.32em] uppercase text-slate-300">USB Program Library</div>
            <div className="text-lg font-bold mt-0.5">Import from USB</div>
          </div>
          <button
            onClick={onRefresh}
            disabled={busy}
            className="h-8 px-3 text-[10px] tracking-[0.2em] uppercase rounded-lg border border-white/15 bg-white/5 hover:bg-white/10"
          >
            Refresh
          </button>
        </div>
        <div className="h-px bg-white/5 my-3" />

        {state.loading ? (
          <div className="flex-1 flex items-center justify-center gap-3 text-slate-300 text-sm py-8">
            <RingSpinner size={16} stroke={3} speed={0.9} />
            Reading USB…
          </div>
        ) : state.error ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-8 px-4">
            <div className="text-red-300 text-sm font-semibold mb-1">USB unavailable</div>
            <div className="text-slate-400 text-xs leading-snug max-w-sm">{state.error}</div>
            <div className="text-slate-500 text-[10px] mt-2">
              Plug a FAT32 stick with <span className="font-mono">*.gillis.json</span> files into any USB port.
            </div>
          </div>
        ) : state.files.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-8 px-4">
            <div className="text-slate-200 text-sm font-semibold">No programs on stick</div>
            <div className="text-slate-400 text-xs mt-1 leading-snug max-w-sm">
              The stick mounted OK but no <span className="font-mono">*.gillis.json</span> files
              were found at its root.
            </div>
          </div>
        ) : (
          <DragScroll className="flex-1 min-h-0 overflow-auto pr-1 space-y-1.5">
            {state.files.map((f) => {
              const importing = state.importing === f;
              return (
                <button
                  key={f}
                  onClick={() => onPick(f)}
                  disabled={busy}
                  className="w-full rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 px-3 py-2.5 text-left flex items-center justify-between gap-3 transition"
                  style={
                    importing
                      ? {
                          background: `rgba(${accent.rgb},0.16)`,
                          borderColor: `rgba(${accent.rgb},0.45)`,
                        }
                      : undefined
                  }
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{f.replace(/\.gillis\.json$/i, "")}</div>
                    <div className="text-[10px] text-slate-400 font-mono truncate">{f}</div>
                  </div>
                  {importing ? (
                    <RingSpinner size={12} stroke={3} speed={1.0} />
                  ) : (
                    <span className="text-[10px] tracking-[0.22em] uppercase text-slate-300">Import</span>
                  )}
                </button>
              );
            })}
          </DragScroll>
        )}

        <div className="h-px bg-white/5 mt-3 mb-3" />
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] text-slate-500 tracking-[0.18em] uppercase">
            Source · /mnt/usb
          </div>
          <button
            onClick={onClose}
            className="h-9 px-4 text-[11px] font-semibold tracking-[0.15em] uppercase rounded-lg border border-white/15 bg-white/5 hover:bg-white/10"
          >
            Close
          </button>
        </div>
      </HudCard>
    </div>
  );
}

/* ---------------------------------- RUN ---------------------------------- */

function RunScreen({ onHome, onBack, activeRun, setActiveRun, loadingPosition, motionSettings }) {
  const machine = useMachine();
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [startedAt, setStartedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  // Remembers whether we auto-paused on the operator tapping Abort, so we
  // know whether to auto-resume if they cancel the confirm dialog.
  const [autoPausedByAbort, setAutoPausedByAbort] = useState(false);
  // Marks whether we've already sent RUN_ABORT from the confirm path, so the
  // mount-effect's unmount cleanup doesn't fire a second abort (which would
  // cancel the Z-up + move-to-loading park motion we just queued). Declared
  // up here so the mount useEffect below can reference it safely.
  const abortedRef = useRef(false);

  // ---- Offline demo simulation ------------------------------------------
  // Phases:
  //   'moving'  – first 3s, XY travelling to start position (overlay visible,
  //               graphic NOT advancing)
  //   'ready'   – at start position, waiting for operator to press Start
  //   'running' – per-cell cycle: travel to cell, fire once, advance
  //   'paused'  – operator pressed Pause
  //   'complete'– last cell finished
  // Test runs now drive the real firmware (same motion, FIRE skipped by the
  // backend orchestrator) — they stop being a demo. Demo mode only fires when
  // the backend isn't reachable, so the offline UI still has something to show.
  const isTestRun = !!activeRun?.testRun;
  const demoMode = !machine.state.connected;
  const totalCellsBase = activeRun?.cells || machine.state.run?.total || 0;

  const [demoPhase, setDemoPhase] = useState("moving");
  const [demoIndex, setDemoIndex] = useState(1);
  const [demoFiring, setDemoFiring] = useState(false);
  // Sub-cycle within 'running': 'travel' (moving to cell, laser off) then
  // 'fire' (laser on). Each full cycle advances demoIndex by one.
  const [demoCycle, setDemoCycle] = useState("travel");

  // Pre-run sequence gate — only meaningful for real (non-demo) runs. The demo
  // mode has its own demoPhase that already models moving → ready → running.
  //
  // Stages:
  //   'resume-prompt' — a previous run of this program aborted. Ask the
  //                     operator whether to resume from that cell or start
  //                     over. Only shown if localStorage has a saved point.
  //   'confirm'       — confirmation modal, "Move" button. Nothing has moved yet.
  //   'moving'        — operator pressed Move; Z rising + XY travelling to start.
  //                     Shows the ionetic loading gif + live axis ticker.
  //   'at-start'      — arrived at start position; green reticle + "Begin" button.
  //                     Weld cycle does NOT start until the operator taps Begin.
  //   null            — past the prerun sequence; runProgram has been (or is
  //                     about to be) dispatched.
  //
  // This splits what used to be a single "Begin → raise Z → move → start
  // welding" action into an explicit "Move to start, verify, then Begin" flow
  // so the operator can see the table arrive before the laser is enabled.
  //
  // The initial stage picks 'resume-prompt' when an abort point exists for
  // this program so we don't silently skip the "resume from cell N?" option.
  const [prerunPhase, setPrerunPhase] = useState(() => {
    if (demoMode) return null;
    if (activeRun?.programName && getAbortPoint(activeRun.programName)) {
      return 'resume-prompt';
    }
    return 'confirm';
  });

  // Cached abort point for the resume prompt. Captured at mount so clearing
  // the store part-way through doesn't blank out the prompt before the
  // operator taps a button.
  const [pendingAbortPoint] = useState(() =>
    !demoMode && activeRun?.programName ? getAbortPoint(activeRun.programName) : null
  );

  // Once the operator has aborted *this* run we flip to a dedicated terminal
  // screen (dismissable, not a fault) instead of onBack()ing straight out.
  // Only ever set by confirmAbort; cleared by the Dismiss button on the way
  // back to Production.
  const [abortedPanel, setAbortedPanel] = useState(null); // null | { cellIndex, total }

  // FIRST mount of a new activeRun — clear the reducer's terminal phase from
  // the *previous* run immediately, regardless of where we are in the prerun
  // sequence. Without this the old 'complete' (or 'aborted') phase lingers in
  // state the whole time the confirm / move-to-start / resume-prompt modals
  // are up, and the moment the operator actually taps Begin the
  // Program-Complete green overlay flashes on top of the starting run — so
  // the operator sees "complete" for a previously-finished program and can't
  // actually start a new one. The main mount effect below also dispatches
  // run_reset, but only after the prerun gate opens (prerunPhase === null);
  // this runs earlier so the stale phase is gone from the first render.
  useEffect(() => {
    if (!activeRun) return;
    machine.dispatch({ type: 'run_reset' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun]);

  // On mount: kick off real backend run, or start the demo "moving to start
  // position" countdown. Stays in 'ready' until the user presses Start.
  useEffect(() => {
    if (!activeRun) return undefined;
    // Real runs wait behind the prerun sequence — don't fire RUN_START until
    // the operator has walked through Confirm → Move → Begin. This stops the
    // firmware from raising Z and welding the instant the operator taps
    // "Begin" on the Production/Programs screen.
    if (!demoMode && prerunPhase !== null) return undefined;

    setStartedAt(null);
    // Drop any stale run.phase (e.g. 'aborted', 'complete') from a previous
    // run, otherwise the first render of this screen briefly shows the old
    // terminal state — and the user reads it as "clicking Begin went straight
    // to Aborted".
    machine.dispatch({ type: 'run_reset' });
    setShowAbortConfirm(false);
    setAutoPausedByAbort(false);

    if (!demoMode) {
      // React 18 StrictMode double-invokes mount effects: the first invocation
      // runs, its cleanup runs immediately, and THEN the real mount's effect
      // runs. A naive `machine.runProgram()` at the top of this block would
      // therefore dispatch TWO RUN_STARTs back-to-back with a RUN_ABORT
      // sandwiched between them. That previously exploded into a multi-fire
      // at cell 1 because the backend's wind-down race let the pre-move for
      // the aborted first run and the pre-move for the restart both pass
      // through before anything got cancelled.
      //
      // The StrictMode-safe pattern: schedule the dispatch on a microtask
      // via setTimeout(0). If StrictMode is going to tear us down, the
      // cleanup below runs synchronously BEFORE the timer fires and simply
      // clears it — no RUN_START is ever sent for that stillborn first
      // mount. Only the "real" second mount's timer survives to dispatch.
      //
      // A plain useRef latch does NOT work here: refs are per-component-
      // instance, and StrictMode gives the remount a fresh instance with
      // a fresh ref. The closure variable `didDispatch` works because it's
      // captured by the cleanup of its own effect-invocation.
      let didDispatch = false;
      const dispatchTimer = setTimeout(() => {
        setStartedAt(Date.now());
        abortedRef.current = false;
        didDispatch = true;
        machine.runProgram({
          programName: activeRun.programName,
          mode: activeRun.mode,
          coordinates: activeRun.coordinates,
          startPosition: activeRun.startPosition,
          // Backend orchestrator skips the FIRE command when this is true —
          // XY + Z still cycle through every cell exactly like a real run.
          testRun: isTestRun,
          // Resume-from-abort: the orchestrator starts its per-cell loop at
          // `resumeIndex` (0-based). Left undefined → starts from cell 1 as
          // normal. Set when the operator picked "Resume from cell N" on
          // the prerun prompt.
          resumeIndex: Number.isFinite(activeRun.resumeIndex) ? activeRun.resumeIndex : 0,
          // Rev4.4 — weld-cycle holds stamped onto the RUN_START payload
          // so in-flight Settings edits can't drift this run's timing
          // mid-cycle. The orchestrator reads them instead of snapshotting
          // firmware state on every iteration.
          //
          // IMPORTANT: read from the local Settings-screen `motionSettings`
          // prop, NOT from `machine.state.motionSettings`. The local prop
          // reflects whatever the operator just typed-and-saved in Settings,
          // and is always immediately consistent. `machine.state.motionSettings`
          // only updates when a SNAPSHOT echo arrives from the firmware, so
          // depending on it here means values can silently fall back to 0 if
          // the firmware/mock isn't echoing the new keys yet (or if the
          // SNAPSHOT round-trip races RUN_START on a slow link).
          preWeldHoldMs:  Number(motionSettings?.preWeldHoldMs)  || 0,
          postWeldHoldMs: Number(motionSettings?.postWeldHoldMs) || 0,
          // Rev4.4 — where to park after the last cell. Both real and test
          // runs end at the loading position so the operator always unloads
          // from the same spot.
          loadingPosition: loadingPosition || machine.state.loadingPosition || null,
          // Bench-mode flag forwarded so the orchestrator can skip waiting
          // on the final Z UP confirmation. On a bench rig the Z-up sensor
          // isn't always wired, which would otherwise hang the run at the
          // last cell waiting for a DONE that never arrives. Applies to
          // both test runs and production runs (same end-of-run Z step).
          benchMode: !!machine.state.benchMode,
        });
      }, 0);
      return () => {
        // StrictMode teardown: cancel the pending dispatch so no RUN_START
        // is ever sent for this effect-invocation.
        clearTimeout(dispatchTimer);
        // Real unmount (or dep change): only abort if we actually started
        // a run AND the operator didn't already go through the confirmAbort
        // path — otherwise the in-flight park motion would be cancelled by
        // a duplicate RUN_ABORT.
        if (didDispatch && !abortedRef.current) machine.abortRun();
      };
    }

    // --- demo "moving to start position" ---
    setDemoPhase("moving");
    setDemoIndex(1);
    setDemoFiring(false);
    setDemoCycle("travel");

    const moveTimer = setTimeout(() => {
      setDemoPhase("ready");
    }, 3000);

    return () => {
      clearTimeout(moveTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun, demoMode, prerunPhase]);

  // Demo per-cell cycle: runs ONLY while phase === 'running'. Each invocation
  // of this effect drives one half-step of the cycle:
  //   travel → (300ms, laser off) → fire
  //   fire   → (450ms, laser on) → advance index + back to travel
  // Once every cell has fired exactly once the effect bails out and the
  // completion effect below takes over with a 1s hold before 'complete'.
  useEffect(() => {
    if (!demoMode) return undefined;
    if (demoPhase !== "running") return undefined;
    // All cells have fired — stop cycling so the laser doesn't re-fire on the
    // final cell while we wait for the completion effect to flip to 'complete'.
    if (totalCellsBase > 0 && demoIndex >= totalCellsBase) {
      setDemoFiring(false);
      return undefined;
    }

    let timer;
    if (demoCycle === "travel") {
      setDemoFiring(false);
      timer = setTimeout(() => setDemoCycle("fire"), 300);
    } else if (demoCycle === "fire") {
      // Test run: skip the laser-on visual entirely; still hold briefly so
      // each cell has a dwell before advancing.
      setDemoFiring(!isTestRun);
      timer = setTimeout(() => {
        setDemoFiring(false);
        setDemoIndex((idx) => {
          if (!totalCellsBase) return idx;
          if (idx >= totalCellsBase) return idx; // completion effect will handle
          return idx + 1;
        });
        setDemoCycle("travel");
      }, isTestRun ? 300 : 450);
    }
    return () => clearTimeout(timer);
  }, [demoMode, demoPhase, demoCycle, demoIndex, totalCellsBase, isTestRun]);

  // Flip demo to 'complete' once we've fired at the final cell.
  // Hold for 1s first so the operator sees the final cell welded (green)
  // before the completion overlay covers the graphic.
  useEffect(() => {
    if (!demoMode) return undefined;
    if (
      demoPhase === "running" &&
      totalCellsBase > 0 &&
      demoIndex >= totalCellsBase &&
      demoCycle === "travel" // last fire just finished, we're back to travel
    ) {
      setDemoFiring(false);
      const t = setTimeout(() => setDemoPhase("complete"), 1000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [demoMode, demoPhase, demoIndex, demoCycle, totalCellsBase]);

  // Kick the demo off when the operator presses Start
  const beginDemoRun = () => {
    if (!demoMode) return;
    if (demoPhase !== "ready") return;
    setStartedAt(Date.now());
    setDemoCycle("travel");
    setDemoPhase("running");
  };

  // Resume-or-restart prompt handlers — fired from the 'resume-prompt' stage.
  // Choosing Resume seeds activeRun.resumeIndex so the mount effect passes it
  // through to the orchestrator. Start-over clears the saved abort point so
  // the machine begins from cell 1.
  const handleResumeFromAbort = () => {
    if (!pendingAbortPoint) { setPrerunPhase('confirm'); return; }
    setActiveRun((prev) => (prev ? { ...prev, resumeIndex: pendingAbortPoint.cellIndex } : prev));
    setPrerunPhase('confirm');
  };
  const handleStartOver = () => {
    if (activeRun?.programName) clearAbortPoint(activeRun.programName);
    setActiveRun((prev) => (prev ? { ...prev, resumeIndex: 0 } : prev));
    setPrerunPhase('confirm');
  };

  // Prerun step 1: "Move to start position". Raises Z and drives XY to the
  // stored start position while the loading overlay + axis ticker give the
  // operator visual confirmation the machine is moving where they expect.
  // Errors drop us back to the confirm modal so retry is one tap away.
  const handleMoveToStart = async () => {
    if (demoMode) return;
    setPrerunPhase('moving');
    try {
      // MOVE is gated on z_safe() in the firmware — raise Z first so the
      // subsequent travel isn't rejected with BUSY. Z is almost always
      // already up (we got here from the loading position), so this is
      // typically a no-op, but belt-and-braces.
      try { await machine.setZ('UP'); } catch { /* non-fatal */ }
      if (
        activeRun?.startPosition &&
        Number.isFinite(activeRun.startPosition.x) &&
        Number.isFinite(activeRun.startPosition.y)
      ) {
        await machine.moveTo(
          activeRun.startPosition.x,
          activeRun.startPosition.y,
        );
      }
      setPrerunPhase('at-start');
    } catch {
      // Move failed (fault, disconnect, …). Bounce back to confirm so the
      // operator can retry, cancel, or go clear whatever fault popped.
      setPrerunPhase('confirm');
    }
  };

  // Prerun step 2: "Begin" at the reticle — unifies demo and real runs. Demo
  // flips the simulator into 'running'; real runs clear the prerun gate so
  // the mount effect dispatches runProgram(). The backend still re-issues a
  // MOVE to the start position in its runLoop, but since we're already there
  // the firmware returns DONE almost immediately.
  const beginRun = () => {
    if (demoMode) {
      beginDemoRun();
      return;
    }
    setPrerunPhase(null);
  };

  // Tick the elapsed-time display while the run is live. Stop ticking (and
  // snapshot a fixed stop time) once the run completes or is aborted so the
  // Elapsed figure holds steady on screen.
  const [stoppedAt, setStoppedAt] = useState(null);

  useEffect(() => {
    const terminal =
      (demoMode ? demoPhase : machine.state.run?.phase) === "complete" ||
      (demoMode ? demoPhase : machine.state.run?.phase) === "aborted";
    if (terminal) {
      setStoppedAt((prev) => prev || Date.now());
      return undefined;
    }
    // Live run → clear any prior stop snapshot and resume ticking
    setStoppedAt(null);
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [demoMode, demoPhase, machine.state.run?.phase]);

  // Derived state — prefer demo values when offline, otherwise live feed
  const laserFiring = isTestRun
    ? false
    : demoMode
      ? (demoPhase === "running" && demoFiring)
      : machine.state.laser === "FIRING";
  const isPaused = demoMode
    ? demoPhase === "paused"
    : (machine.state.run?.paused || false);
  const activeCell = demoMode
    ? Math.max(1, demoIndex)
    : Math.max(1, machine.state.run?.index || 1);
  const totalCells = totalCellsBase;
  const progressPct = totalCells > 0 ? (activeCell / totalCells) * 100 : 0;

  const elapsedSec = startedAt
    ? Math.floor(((stoppedAt || now) - startedAt) / 1000)
    : 0;
  const elapsedLabel = `${String(Math.floor(elapsedSec / 60)).padStart(2, "0")}:${String(elapsedSec % 60).padStart(2, "0")}`;

  const runState = demoMode ? demoPhase : (machine.state.run?.phase || "idle");
  const stateLabel =
    runState === "paused" ? "Paused"
    : runState === "complete" ? "Complete"
    : runState === "aborted" ? "Aborted"
    : runState === "running" ? "Running"
    : runState === "ready" ? "Ready"
    : runState === "moving" ? "Moving to start…"
    : runState === "moving_to_load" ? "Moving to loading position…"
    : "Starting…";

  const togglePause = () => {
    if (demoMode) {
      if (demoPhase === "running") {
        setDemoPhase("paused");
      } else if (demoPhase === "paused") {
        setDemoPhase("running");
      }
      return;
    }
    if (isPaused) machine.resumeRun();
    else machine.pauseRun();
  };

  const [aborting, setAborting] = useState(false);

  // Step 1 of the abort flow: tap the Abort button. Pauses motion immediately
  // (safe-state) and opens the confirm dialog. `autoPausedByAbort` lets us
  // undo the pause if the operator changes their mind.
  const requestAbort = () => {
    if (showAbortConfirm) return;
    if (demoMode) {
      if (demoPhase === "running") {
        setDemoPhase("paused");
        setAutoPausedByAbort(true);
      } else {
        setAutoPausedByAbort(false);
      }
    } else {
      if (machine.state.run?.active && !machine.state.run?.paused) {
        machine.pauseRun();
        setAutoPausedByAbort(true);
      } else {
        setAutoPausedByAbort(false);
      }
    }
    setShowAbortConfirm(true);
  };

  // Step 2a: operator cancels the abort — resume whatever we auto-paused.
  const cancelAbort = () => {
    setShowAbortConfirm(false);
    if (autoPausedByAbort) {
      if (demoMode) setDemoPhase("running");
      else machine.resumeRun();
    }
    setAutoPausedByAbort(false);
  };

  // Step 2b: operator confirms — tear the run down. Aborting is treated as a
  // clean operator action (NOT a fault) — we stop motion, raise Z, park at
  // the loading position, then show a dismissable "Run Aborted" panel in
  // place of auto-navigating out. The panel's Dismiss button is what
  // eventually returns to Production. This lets the operator linger on the
  // abort screen and confirms nothing was left in a fault state.
  //
  // The cell index reached before abort is persisted in localStorage so the
  // next launch of this program offers "Resume from cell N" vs "Start over".
  const confirmAbort = async () => {
    setShowAbortConfirm(false);
    setAutoPausedByAbort(false);

    // Snapshot the cell we were on BEFORE the run state gets torn down.
    // Reducer stores `index` as 1-based; orchestrator's `resumeIndex` is
    // 0-based. Subtract 1 and clamp at 0 so cell 1 aborts store as index 0
    // (resume = restart from 1). For a mid-run abort we resume from the
    // cell we were about to weld, so using the index we were actively on is
    // the right call — the operator didn't finish that cell either.
    const liveRun = machine.state?.run;
    const index0 = Math.max(0, (liveRun?.index || 1) - 1);
    const total = liveRun?.total || activeRun?.cells || 0;
    const abortEntry = { cellIndex: index0, total };
    if (activeRun?.programName) {
      saveAbortPoint(activeRun.programName, abortEntry);
    }

    if (demoMode) {
      setDemoPhase("aborted");
      abortedRef.current = true;
      setAbortedPanel(abortEntry);
      return;
    }
    setAborting(true);
    try {
      abortedRef.current = true;
      await machine.abortRun();
      // Post-abort recovery sequence — REQUIRED so the operator never has to
      // unload a workpiece that's still clamped under the weld head, and
      // ends up at a known unload position regardless of where in the
      // program they aborted:
      //   1) settle (160 ms): the firmware's stepper_stop_all() inside
      //      RUN_ABORT slams the motors to a halt with no decel ramp, which
      //      can briefly pulse the CL57Y ALM lines → fault_check() picks
      //      that up as FAULT_DRIVER_X/YL/YR. Sleeping a frame lets the ALM
      //      transient drop before we issue more commands.
      //   2) Z UP: retract the head off the workpiece BEFORE any XY move so
      //      we don't drag the welder across the part.
      //   3) MOVE to loadingPosition: park the table where the operator
      //      reaches in to swap the workpiece, matching the end-of-run
      //      behaviour. Skipped if loadingPosition is unset / {0,0} (the
      //      sentinel both homing.h and runOrchestrator.js use for "no
      //      loading position configured").
      //
      // All three are wrapped in try/catch and intentionally ignore their
      // responses: if Z UP times out (FAULT_Z_TIMEOUT_UP) or driver ALM
      // ghosts trip a fault, the post-abort fault-dismiss useEffect
      // further down in this component clears it silently and restores
      // homed=true — so the operator never sees the red overlay or the
      // re-home gate just because they hit Abort.
      await new Promise((r) => setTimeout(r, 160));
      try {
        await machine.setZ('UP');
      } catch { /* swallowed — safety net handles any resulting fault */ }

      const lp = loadingPosition || machine.state.loadingPosition;
      if (lp &&
          Number.isFinite(Number(lp.x)) &&
          Number.isFinite(Number(lp.y)) &&
          (Number(lp.x) !== 0 || Number(lp.y) !== 0)) {
        try {
          await machine.moveTo(Number(lp.x), Number(lp.y));
        } catch { /* swallowed — operator can manually re-park if MOVE rejected */ }
      }
    } finally {
      setAborting(false);
      setAbortedPanel(abortEntry);
    }
  };

  // Clicking Dismiss on the abort panel is what takes the operator back to
  // Production. No Z / XY motion here — confirmAbort already asked the
  // firmware to stop, and anything else is a separate operator decision
  // (e.g. "Loading Position" from the main menu).
  const dismissAbortPanel = () => {
    setAbortedPanel(null);
    onBack();
  };

  // Safety net for the abort path. The firmware's RUN_ABORT handler stops
  // motion and drops to STATE_IDLE without raising a fault — but the
  // stepper_stop_all() inside RUN_ABORT is an instant halt with no decel
  // ramp, and at welding speeds the motor's back-EMF can pulse the stepper
  // driver's ALM output for a handful of milliseconds. fault_check() picks
  // that up and fires FAULT_DRIVER_X/YL/YR, which the reducer flags as
  // `requiresHome` AND zeroes `homed` — bouncing the operator to the
  // "Gillis is lost" re-home gate after every abort. That's a hardware
  // artifact of a deliberate operator stop, not a real condition the
  // position counters need to distrust, so we swallow it here via
  // `abort_fault_dismiss` (which also restores homed=true and drops run
  // phase back to idle). E-STOP is excluded — hardware lockout runs its
  // own flow.
  useEffect(() => {
    if (demoMode) return;
    if (!abortedPanel) return;
    const faultActive = !!machine.state.fault?.active;
    const phaseFaulted = machine.state.run?.phase === 'faulted';
    if (!faultActive && !phaseFaulted) return;
    if (machine.state.fault?.code === 'FAULT_ESTOP') return;
    // Tell the firmware to drop out of STATE_FAULT_LOCKOUT. Safe to spam —
    // fault_clear() no-ops once the ALM has subsided and returns false while
    // it's still tripped; the retry covers the latter case. Then locally
    // dismiss the fault AND restore homed so the operator isn't sent to
    // the re-home screen for a deliberate abort.
    try { machine.clearFault?.(); } catch { /* non-fatal */ }
    const retry = setTimeout(() => {
      try { machine.clearFault?.(); } catch { /* non-fatal */ }
    }, 400);
    machine.dispatch({ type: 'abort_fault_dismiss' });
    return () => clearTimeout(retry);
  }, [
    demoMode,
    abortedPanel,
    machine.state.fault?.active,
    machine.state.fault?.code,
    machine.state.run?.phase,
  ]);

  // When a run finishes cleanly, clear any stored abort point for this
  // program so the next launch doesn't offer a stale resume prompt.
  useEffect(() => {
    const phase = demoMode ? demoPhase : machine.state.run?.phase;
    if (phase === 'complete' && activeRun?.programName) {
      clearAbortPoint(activeRun.programName);
    }
  }, [demoMode, demoPhase, machine.state.run?.phase, activeRun?.programName]);

  // Persist the last-seen live cell/total while the run is actually moving,
  // so an involuntary interruption (E-STOP, hardware fault) that tears
  // run.active down to false and flips phase → 'faulted' in the same reducer
  // tick still has access to the cell we were on. Without this snapshot the
  // fault/estop effect below would read run.index AFTER it had already been
  // zeroed by `run.active: false` flows and persist cellIndex=0.
  const lastLiveCellRef = useRef({ cellIndex: 0, total: 0 });
  useEffect(() => {
    const r = machine.state.run;
    if (
      r?.active &&
      (r.phase === 'running' || r.phase === 'moving' || r.phase === 'paused')
    ) {
      lastLiveCellRef.current = {
        cellIndex: Math.max(0, (r.index || 1) - 1),
        total: r.total || 0,
      };
    }
  }, [
    machine.state.run?.active,
    machine.state.run?.phase,
    machine.state.run?.index,
    machine.state.run?.total,
  ]);

  // E-STOP / hardware fault → save the abort point so the next launch of this
  // program offers "Resume from cell N" just like an operator-initiated Abort
  // already does. `confirmAbort` already calls saveAbortPoint for deliberate
  // aborts; this effect covers the other two ways a run can end mid-program:
  // the big red button, or a driver / air-pressure / ESTOP fault raised by
  // the firmware. Rising-edge detection on active flags keeps us from
  // re-saving on every render while the overlay is up.
  const prevEstopActiveRef = useRef(false);
  const prevFaultActiveRef = useRef(false);
  useEffect(() => {
    if (demoMode) {
      prevEstopActiveRef.current = false;
      prevFaultActiveRef.current = false;
      return;
    }
    const estopNow = !!machine.state.estop?.active;
    const faultNow = !!machine.state.fault?.active;
    const estopRising = estopNow && !prevEstopActiveRef.current;
    const faultRising = faultNow && !prevFaultActiveRef.current;
    if ((estopRising || faultRising) && activeRun?.programName) {
      // Use the live-cell snapshot captured just before the interruption —
      // it's already in 0-based form and matches what `confirmAbort` writes
      // for deliberate aborts, so the resume prompt renders consistently
      // regardless of how the run was torn down.
      const cached = lastLiveCellRef.current || { cellIndex: 0, total: 0 };
      const total = cached.total || activeRun.cells || totalCellsBase || 0;
      saveAbortPoint(activeRun.programName, {
        cellIndex: cached.cellIndex || 0,
        total,
      });
    }
    prevEstopActiveRef.current = estopNow;
    prevFaultActiveRef.current = faultNow;
  }, [
    demoMode,
    activeRun,
    totalCellsBase,
    machine.state.estop?.active,
    machine.state.fault?.active,
  ]);

  // "Starting program" overlay visibility — only during the XY travel phase.
  // Live runs: backend emits a 'moving' phase while the pre-move to the start
  // position is in flight, then flips to 'running' once it arrives. Also
  // covers the brief window between dispatching run_reset on mount and the
  // backend's first run event arriving. Suppressed while the prerun sequence
  // is on screen — the operator is actively walking through confirm/move/
  // begin and we have dedicated overlays for each stage.
  const isStarting = demoMode
    ? demoPhase === "moving"
    : (
        !!activeRun &&
        !aborting &&
        prerunPhase === null &&
        (runState === "moving" || (runState === "idle" && !machine.state.run?.active))
      );

  // "At start position" reticle + Begin prompt. Now shown for both demo and
  // real runs — demo uses its simulator's 'ready' phase, real runs use the
  // prerun 'at-start' stage reached after the move-to-start completes.
  const isReady = demoMode
    ? demoPhase === "ready"
    : prerunPhase === 'at-start';

  // "Program Complete" overlay visibility — works for both demo and live.
  //
  // The backend flips run.phase → 'complete' the instant the last cell's
  // weld cycle wraps up, but the reticle's CSS transition to that final
  // cell may still be mid-flight, and even when it isn't the operator has
  // no visible moment to register "we just finished the last cell" before
  // the green overlay steals the screen. The operator asked for the last
  // cell to sit on screen for 2 s after the reticle arrives — so we hold
  // the overlay behind a timer whose duration = (transition time to the
  // last cell) + 2000 ms hold. Mirrors ProgramGraphic's own reticle-speed
  // math so fast and slow motion settings stay in sync.
  const finalHoldCoords = activeRun?.coordinates;
  const finalHoldMs = useMemo(() => {
    const pts = Array.isArray(finalHoldCoords) ? finalHoldCoords : [];
    const xSp = Math.max(1, Number(machine.state.motionSettings?.xSpeed) || 120);
    const ySp = Math.max(1, Number(machine.state.motionSettings?.ySpeed) || 120);
    let transitionMs = 140;
    if (pts.length >= 2) {
      const prev = pts[pts.length - 2] || {};
      const last = pts[pts.length - 1] || {};
      const dxMm = Math.abs((Number(last.x) || 0) - (Number(prev.x) || 0));
      const dyMm = Math.abs((Number(last.y) || 0) - (Number(prev.y) || 0));
      const timeS = Math.max(dxMm / xSp, dyMm / ySp);
      transitionMs = Math.max(60, Math.min(10000, Math.round(timeS * 1000)));
    }
    return transitionMs + 2000;
  }, [finalHoldCoords, machine.state.motionSettings?.xSpeed, machine.state.motionSettings?.ySpeed]);

  const [showComplete, setShowComplete] = useState(false);
  useEffect(() => {
    if (runState !== "complete") {
      setShowComplete(false);
      return undefined;
    }
    const timer = setTimeout(() => setShowComplete(true), finalHoldMs);
    return () => clearTimeout(timer);
  }, [runState, finalHoldMs]);

  const isComplete = showComplete && !aborting;

  if (!activeRun) {
    return (
      <ScreenShell mode="run" onHome={onHome} onBack={onBack}>
        <div className="h-full flex items-center justify-center">
          <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-6 text-center max-w-lg">
            <div className="text-xl font-semibold mb-3">No Active Run</div>
            <div className="text-slate-300 mb-5">Start a program from the Production screen first.</div>
            <button
              onClick={onBack}
              className="rounded-[1rem] bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-sm font-semibold"
            >
              Back
            </button>
          </div>
        </div>
      </ScreenShell>
    );
  }

  // After the final fire in demo mode, show every cell as welded so the
  // operator sees a fully green board during the 1s hold before the
  // completion overlay.
  const finalFireDone =
    demoMode &&
    totalCellsBase > 0 &&
    demoIndex >= totalCellsBase &&
    demoCycle === "travel" &&
    demoPhase === "running";
  const progressCountValue =
    finalFireDone || runState === "complete"
      ? totalCells
      : Math.max(0, Math.min(activeCell - 1, totalCells || 1));

  return (
    <ScreenShell
      mode="run"
      running
      progress={progressPct}
      pulse={!isPaused}
      onHome={onHome}
      onBack={onBack}
      activeRun={activeRun}
    >
      <div className="h-full min-h-0 grid grid-cols-12 gap-2 relative">
        <div className="col-span-8 h-full min-h-0">
          <ProgramGraphic
            running
            activeCell={Math.min(activeCell, totalCells || 1)}
            progressCount={progressCountValue}
            laserFiring={laserFiring && !isPaused}
            coordinates={activeRun.coordinates}
          />
        </div>

        <div className="col-span-4 h-full min-h-0 flex flex-col gap-2">
          <div className="rounded-[1.25rem] border border-white/10 bg-white/5 p-2 shrink-0">
            <div className="flex items-center justify-between mb-2">
              <div className="text-base font-semibold">Run Info</div>
              {isTestRun && (
                <span
                  className="text-[10px] font-bold tracking-[0.18em] uppercase px-2 py-0.5 rounded-md"
                  style={{
                    color: "#bfdbfe",
                    background: "rgba(59,130,246,0.18)",
                    border: "1px solid rgba(96,165,250,0.45)",
                    boxShadow: "0 0 12px rgba(59,130,246,0.25)",
                  }}
                >
                  Test Run
                </span>
              )}
            </div>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-slate-400">Program</span><span>{activeRun.programName}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Cell</span><span>{Math.min(activeCell, totalCells)} / {totalCells}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Mode</span><span>{activeRun.mode}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Elapsed</span><span>{elapsedLabel}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Last Cycle</span><span>{activeRun.measured || "Not yet measured"}</span></div>
              <div className="flex justify-between">
                <span className="text-slate-400">Laser</span>
                <span className={laserFiring ? "text-red-300 font-semibold" : "text-slate-300"}>
                  {laserFiring ? "FIRING" : "OFF"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">State</span>
                <span>{stateLabel}</span>
              </div>
            </div>
          </div>

          <div className="rounded-[1.25rem] border border-white/10 bg-white/5 p-2 flex-1 min-h-0 flex flex-col justify-end">
            <div className="text-base font-semibold mb-2">Controls</div>
            <div className="grid gap-2">
              <button
                onClick={togglePause}
                className="rounded-[1rem] bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-sm font-semibold"
              >
                {isPaused ? "Resume" : "Pause"}
              </button>

              <button
                onClick={requestAbort}
                className="rounded-[1rem] bg-red-600 hover:bg-red-500 px-4 py-2.5 text-sm font-semibold"
              >
                Abort
              </button>
            </div>
          </div>
        </div>

        {showAbortConfirm && (
          <div className="absolute inset-0 bg-black/55 flex items-center justify-center z-[95]">
            <div className="w-[400px] rounded-[1.5rem] border border-white/10 bg-slate-900 p-5 shadow-2xl">
              <div className="text-xl font-semibold mb-3">Abort Program?</div>
              <div className="text-slate-300 text-sm mb-2">
                Motion has been paused. Confirm to fully abort — Z will raise
                and the table will travel to the loading position.
              </div>
              <div className="text-slate-400 text-xs mb-5">
                Press “Resume” to cancel and continue the run from where it paused.
              </div>
              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={cancelAbort}
                  className="rounded-[1rem] bg-white/10 border border-white/10 px-4 py-3 font-semibold"
                >
                  Resume
                </button>
                <button
                  onClick={confirmAbort}
                  className="rounded-[1rem] bg-red-600 hover:bg-red-500 px-4 py-3 font-semibold"
                >
                  Yes, Abort
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Prerun stage 0: resume-or-restart prompt — surfaced when
            localStorage holds an abort point for this program. Gives the
            operator the choice to pick up from where the last run aborted
            or to start over from cell 1. Choosing a button advances to the
            normal 'confirm' modal. */}
        {!demoMode && activeRun && prerunPhase === 'resume-prompt' && pendingAbortPoint && (
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center backdrop-blur-md bg-slate-950/80"
            role="dialog"
            aria-label="Resume or restart"
          >
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "radial-gradient(circle at 50% 45%, rgba(251,191,36,0.18) 0%, rgba(251,191,36,0.05) 25%, rgba(2,6,23,0) 60%)",
              }}
            />
            <div className="relative w-[min(520px,92vw)] rounded-[1.5rem] border border-amber-400/30 bg-slate-900/90 p-7 shadow-2xl">
              <div className="text-[10px] tracking-[0.32em] uppercase text-amber-200/80 mb-1">
                Previous Run Aborted
              </div>
              <div className="text-xl font-bold mb-3 text-amber-100">
                Resume {activeRun.programName || "program"}?
              </div>
              <div className="text-sm text-slate-300 leading-relaxed mb-5">
                This program was aborted at{" "}
                <span className="font-semibold text-amber-200">
                  cell {Math.min((pendingAbortPoint.cellIndex || 0) + 1, pendingAbortPoint.total || activeRun.cells || 0)}
                  {" "}of {pendingAbortPoint.total || activeRun.cells || "—"}
                </span>
                . Would you like to resume from that cell, or start the whole program over?
              </div>

              <div className="grid grid-cols-1 gap-2.5">
                <button
                  onClick={handleResumeFromAbort}
                  className="h-12 px-5 rounded-[1rem] font-semibold text-sm tracking-[0.12em] uppercase"
                  style={{
                    background: "linear-gradient(135deg, rgba(251,191,36,0.9), rgba(217,119,6,0.8))",
                    boxShadow: "0 0 0 1px rgba(251,191,36,0.45), 0 0 22px rgba(251,191,36,0.28)",
                    color: "#1f1305",
                  }}
                >
                  Resume from cell {(pendingAbortPoint.cellIndex || 0) + 1}
                </button>
                <button
                  onClick={handleStartOver}
                  className="h-12 px-5 rounded-[1rem] font-semibold text-sm tracking-[0.12em] uppercase bg-white/10 border border-white/10 hover:bg-white/15"
                >
                  Start from beginning
                </button>
                <button
                  onClick={onBack}
                  className="h-10 text-slate-400 hover:text-slate-200 text-xs tracking-[0.18em] uppercase"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Prerun stage 1: confirmation — shown before any Z motion or XY
            travel happens on a real (non-demo) run. Gives the operator the
            final "yes, the workspace is clear" acknowledgement before the
            gantry starts moving toward the start position. */}
        {!demoMode && activeRun && prerunPhase === 'confirm' && (
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center backdrop-blur-md bg-slate-950/80"
            role="dialog"
            aria-label={isTestRun ? "Confirm test run start" : "Confirm program start"}
          >
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "radial-gradient(circle at 50% 45%, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0.05) 25%, rgba(2,6,23,0) 60%)",
              }}
            />
            <div className="relative w-[min(520px,92vw)] rounded-[1.5rem] border border-blue-400/30 bg-slate-900/90 p-7 shadow-2xl">
              <div className="text-[10px] tracking-[0.32em] uppercase text-slate-300 mb-1">
                {isTestRun ? "Confirm Test Run" : "Confirm Program Start"}
              </div>
              <div className="text-xl font-bold mb-3 text-blue-200">
                Move to start position?
              </div>
              <div className="text-sm text-slate-300 leading-relaxed mb-4">
                <div className="mb-2">
                  {isTestRun ? (
                    <>Pressing <span className="font-semibold text-blue-200">Move</span> will raise Z and travel X/Y to the start position. You'll be asked to confirm again before the test-run cycle begins. <span className="font-semibold">The laser will NOT fire</span> during this test run.</>
                  ) : (
                    <>Pressing <span className="font-semibold text-blue-200">Move</span> will raise Z and travel X/Y to the start position. You'll be asked to confirm again before the welding sequence begins.</>
                  )}
                </div>
                <div className="rounded-lg border border-amber-400/25 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200/90 leading-snug">
                  Check that the workspace is clear and the battery tray is correctly loaded before continuing.
                </div>
              </div>

              {/* Program / target summary */}
              <div className="grid grid-cols-3 gap-2 text-xs mb-5">
                <div className="rounded-lg border border-white/10 bg-white/5 py-2 px-3">
                  <div className="text-slate-400 uppercase tracking-widest text-[10px]">Program</div>
                  <div className="mt-1 text-slate-100 font-semibold truncate">
                    {activeRun.programName || "—"}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 py-2 px-3">
                  <div className="text-slate-400 uppercase tracking-widest text-[10px]">Mode</div>
                  <div className="mt-1 text-slate-100 font-semibold truncate">
                    {activeRun.mode || "—"}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 py-2 px-3">
                  <div className="text-slate-400 uppercase tracking-widest text-[10px]">Cells</div>
                  <div className="mt-1 text-slate-100 font-semibold">
                    {totalCellsBase || activeRun.cells || "—"}
                  </div>
                </div>
              </div>

              {/* Start-position target (if known) */}
              {activeRun.startPosition && (
                <div className="mb-5 text-[11px] text-slate-400 text-center">
                  Start position &nbsp;·&nbsp;
                  <span className="text-slate-200 font-mono tabular-nums">
                    X {Number(activeRun.startPosition.x || 0).toFixed(2)}
                    {"  "}
                    Y {Number(activeRun.startPosition.y || 0).toFixed(2)}
                  </span>
                </div>
              )}

              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={onBack}
                  className="h-11 px-5 text-xs font-semibold tracking-[0.15em] uppercase rounded-lg border border-white/10 bg-white/5 hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  onClick={handleMoveToStart}
                  className="hud-accent-btn h-11 px-6 text-xs font-bold tracking-[0.18em] uppercase border inline-flex items-center gap-2"
                  style={{
                    background: "linear-gradient(135deg, rgba(59,130,246,0.85), rgba(37,99,235,0.6))",
                    borderColor: "rgba(59,130,246,0.55)",
                    boxShadow: "0 0 18px rgba(59,130,246,0.35)",
                    color: "#f0f9ff",
                  }}
                >
                  ▶ Move
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Prerun stage 2: travelling to start position — operator pressed
            Move on the confirmation modal. Real runs only; stays visible
            until machine.moveTo() resolves and we flip to 'at-start'. */}
        <LoadingOverlay
          visible={prerunPhase === 'moving'}
          title="Moving to start position"
          subtext={
            isTestRun
              ? "Raising Z and travelling X/Y to start · Laser will NOT fire"
              : "Raising Z and travelling X/Y to start"
          }
        >
          <HomingAxisTicker />
        </LoadingOverlay>

        <LoadingOverlay
          visible={isStarting}
          title={isTestRun ? "Starting test run" : "Starting program"}
          subtext={
            isTestRun
              ? `Moving X/Y to start position · Laser will NOT fire`
              : `Moving X/Y to start position · ${activeRun?.programName || "run"}`
          }
        >
          <HomingAxisTicker />
        </LoadingOverlay>
        <LoadingOverlay
          visible={aborting}
          title="Aborting run"
          subtext="Stopping motion and retracting Z axis..."
        >
          <HomingAxisTicker />
        </LoadingOverlay>

        {/* Post-run park-to-load (Rev4.4). Shown between the final cell's
            Z UP and the "Program Complete" overlay while the orchestrator
            drives the table back to the stored loading position. Applies
            to real runs AND test runs — both end at the loading position
            so the operator always unloads in the same spot. The Program
            Complete overlay is already gated behind run.phase === 'complete',
            which the orchestrator emits AFTER this move resolves, so the
            two overlays don't overlap. */}
        <LoadingOverlay
          visible={runState === 'moving_to_load'}
          title="Moving to loading position"
          subtext="Returning the table to the loading position"
        >
          <HomingAxisTicker />
        </LoadingOverlay>

        {/* Ready — waiting for operator Start */}
        {isReady && (
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center backdrop-blur-md bg-slate-950/70"
            role="dialog"
            aria-label="Ready to begin"
          >
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "radial-gradient(circle at 50% 45%, rgba(34,197,94,0.16) 0%, rgba(34,197,94,0.05) 25%, rgba(2,6,23,0) 60%)",
              }}
            />
            <div className="relative flex flex-col items-center">
              {/* Target-ring glyph */}
              <svg viewBox="0 0 80 80" width="96" height="96" className="drop-shadow-[0_0_16px_rgba(34,197,94,0.35)]">
                <circle cx="40" cy="40" r="34" fill="none" stroke="#22c55e" strokeWidth="1.2" opacity="0.55" />
                <circle cx="40" cy="40" r="22" fill="none" stroke="#22c55e" strokeWidth="1.2" opacity="0.75" />
                <circle cx="40" cy="40" r="4"  fill="#22c55e" />
                <line x1="4"  y1="40" x2="18" y2="40" stroke="#22c55e" strokeWidth="1.4" />
                <line x1="62" y1="40" x2="76" y2="40" stroke="#22c55e" strokeWidth="1.4" />
                <line x1="40" y1="4"  x2="40" y2="18" stroke="#22c55e" strokeWidth="1.4" />
                <line x1="40" y1="62" x2="40" y2="76" stroke="#22c55e" strokeWidth="1.4" />
              </svg>

              <div className="mt-5 text-slate-100 text-xl font-semibold tracking-[0.12em] uppercase">
                At Start Position
              </div>
              <div className="mt-2 text-slate-400 text-sm max-w-md text-center">
                {activeRun?.programName || "Program"} · {totalCells} cells · {activeRun?.mode}
                {isTestRun && (
                  <>
                    <br />
                    <span className="text-amber-300/90 text-xs tracking-[0.18em] uppercase">Test run · Laser will NOT fire</span>
                  </>
                )}
              </div>

              <button
                onClick={beginRun}
                className="mt-7 px-7 py-3 rounded-[1rem] font-semibold text-base tracking-[0.15em] uppercase"
                style={{
                  background: "linear-gradient(135deg, rgba(34,197,94,0.95), rgba(22,163,74,0.95))",
                  boxShadow: "0 0 0 1px rgba(34,197,94,0.45), 0 0 26px rgba(34,197,94,0.4)",
                  color: "#ecfdf5",
                }}
              >
                {isTestRun ? "▶ Begin Test Run" : "▶ Begin"}
              </button>

              <button
                onClick={onBack}
                className="mt-3 text-slate-400 hover:text-slate-200 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Program Complete */}
        {isComplete && (
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center backdrop-blur-md bg-slate-950/70"
            role="dialog"
            aria-label="Program complete"
          >
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "radial-gradient(circle at 50% 45%, rgba(34,197,94,0.22) 0%, rgba(34,197,94,0.07) 25%, rgba(2,6,23,0) 60%)",
              }}
            />
            <div className="relative w-[420px] rounded-[1.5rem] border border-green-400/30 bg-slate-900/80 p-7 shadow-2xl text-center">
              <div
                className="mx-auto mb-4 w-16 h-16 rounded-full grid place-items-center"
                style={{
                  background: "rgba(34,197,94,0.12)",
                  border: "1px solid rgba(34,197,94,0.45)",
                  boxShadow: "0 0 18px rgba(34,197,94,0.35), inset 0 0 18px rgba(34,197,94,0.15)",
                }}
              >
                <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12.5l5 5L20 7" />
                </svg>
              </div>

              <div className="text-2xl font-semibold tracking-[0.1em] uppercase text-green-200">
                Program Complete
              </div>
              <div className="mt-2 text-slate-300 text-sm">
                {activeRun?.programName || "Run"}
              </div>

              <div className="mt-5 grid grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl border border-white/10 bg-white/5 py-2">
                  <div className="text-slate-400 uppercase tracking-widest text-[10px]">Cells</div>
                  <div className="mt-1 text-lg font-semibold text-slate-100">{totalCells}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 py-2">
                  <div className="text-slate-400 uppercase tracking-widest text-[10px]">Elapsed</div>
                  <div className="mt-1 text-lg font-semibold text-slate-100">{elapsedLabel}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 py-2">
                  <div className="text-slate-400 uppercase tracking-widest text-[10px]">Mode</div>
                  <div className="mt-1 text-lg font-semibold text-slate-100">{activeRun?.mode}</div>
                </div>
              </div>

              <button
                onClick={onBack}
                className="mt-6 w-full rounded-[1rem] bg-green-600 hover:bg-green-500 px-4 py-3 font-semibold text-sm tracking-[0.12em] uppercase"
              >
                Back to Production
              </button>
            </div>
          </div>
        )}

        {/* Run Aborted — dismissable panel shown after the operator confirms
            abort. No fault workflow, no CLEAR_FAULT. Just "run was stopped"
            + the cell we got to + a single Dismiss button. The next launch
            of the same program will offer Resume / Start over. */}
        {abortedPanel && (
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center backdrop-blur-md bg-slate-950/75"
            role="dialog"
            aria-label="Run aborted"
          >
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "radial-gradient(circle at 50% 45%, rgba(251,191,36,0.18) 0%, rgba(251,191,36,0.05) 25%, rgba(2,6,23,0) 60%)",
              }}
            />
            <div className="relative w-[420px] rounded-[1.5rem] border border-amber-400/30 bg-slate-900/85 p-7 shadow-2xl text-center">
              <div
                className="mx-auto mb-4 w-16 h-16 rounded-full grid place-items-center"
                style={{
                  background: "rgba(251,191,36,0.12)",
                  border: "1px solid rgba(251,191,36,0.45)",
                  boxShadow: "0 0 18px rgba(251,191,36,0.32), inset 0 0 18px rgba(251,191,36,0.15)",
                }}
              >
                <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#fbbf24" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
              </div>

              <div className="text-2xl font-semibold tracking-[0.1em] uppercase text-amber-100">
                Run Aborted
              </div>
              <div className="mt-2 text-slate-300 text-sm">
                {activeRun?.programName || "Run"}
              </div>

              <div className="mt-5 text-sm text-slate-300 leading-relaxed">
                Stopped at{" "}
                <span className="font-semibold text-amber-200">
                  cell {Math.min((abortedPanel.cellIndex || 0) + 1, abortedPanel.total || totalCellsBase || 0)}
                  {" "}of {abortedPanel.total || totalCellsBase || "—"}
                </span>
                .
                <br />
                <span className="text-slate-400 text-xs">
                  The next time you start this program, you'll be offered the
                  option to resume from cell {(abortedPanel.cellIndex || 0) + 1}
                  {" "}or start over.
                </span>
              </div>

              <button
                onClick={dismissAbortPanel}
                className="mt-6 w-full rounded-[1rem] bg-amber-500 hover:bg-amber-400 px-4 py-3 font-semibold text-sm tracking-[0.12em] uppercase"
                style={{ color: "#1f1305" }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    </ScreenShell>
  );
}

/* -------------------------------- SETTINGS ------------------------------- */

// FieldButton is hoisted to module scope so its component identity is stable
// across SettingsScreen re-renders. Defining it inside SettingsScreen meant
// every machine-state tick (e.g. SENSORS at 4 Hz, AIR pressure events) gave
// React a *new* component type, which forced an unmount/remount of every
// box — and any finger-tap that straddled a re-render had its pointerdown
// element ripped out from under it before pointerup, so the synthesised
// click never landed. The boxes "looked" tappable but did nothing on the
// Pi touchscreen. The Edit Program screen never had this bug because its
// keypad-trigger buttons are inline JSX, not a re-defined component.
const SettingsFieldButton = React.memo(function SettingsFieldButton({
  label,
  title,
  value,
  apply,
  allowDecimal = true,
  accentRgb,
  openKeypad,
}) {
  return (
    <div>
      <div className="text-[10px] tracking-[0.2em] uppercase text-slate-400 mb-1">{label}</div>
      <button
        // Opt out of the parent card's drag-scroll. Without this, the Pi's
        // capacitive touchscreen wobble during a stationary tap can cross
        // useDragScroll's threshold and onClickCapture swallows the synthesised
        // click. Settings cards are short enough that opting out doesn't cost
        // any meaningful scroll surface — labels above each button still drag.
        data-no-drag
        onClick={() => openKeypad(title, value, apply, allowDecimal)}
        className="w-full p-2.5 rounded-lg border text-left text-sm font-semibold hover:brightness-110 transition"
        style={{
          background: `linear-gradient(135deg, rgba(${accentRgb},0.08), rgba(0,0,0,0.4))`,
          borderColor: `rgba(${accentRgb},0.22)`,
        }}
      >
        {value}
      </button>
    </div>
  );
});

function SettingsScreen({
  motionSettings,
  setMotionSettings,
  travelLimits,
  setTravelLimits,
  setScreen,
  onHome,
  onBack,
}) {
  const machine = useMachine();
  // Home-on-boot is gated on a successful homing cycle having happened in
  // the current session — proof that every limit switch is wired correctly.
  // Until the machine has been homed at least once we keep the toggle locked
  // and nudge the operator toward the Test Motion screen.
  const canToggleHomeOnBoot = !!machine.state.homed;
  // Local mirror of the home-on-boot flag. Flipped immediately on tap and
  // also dispatched into the reducer so the UI stays consistent even in
  // offline demo mode (no firmware round-trip to bounce the value back).
  const homeOnBootDraft = !!machine.state.homeOnBoot;
  const [homeOnBootPending, setHomeOnBootPending] = useState(false);
  const toggleHomeOnBoot = async () => {
    if (homeOnBootPending) return;
    if (!canToggleHomeOnBoot) return;
    const next = !homeOnBootDraft;
    // Optimistic: flip the reducer so the pill/label updates immediately.
    machine.dispatch({ type: 'home_on_boot', value: next });
    setHomeOnBootPending(true);
    try {
      const res = await machine.setHomeOnBoot(next);
      // Only roll back if we're actually connected and the firmware rejected
      // the write. In offline demo mode we keep the optimistic flip.
      if (res && res.ok === false && machine.state.connected) {
        machine.dispatch({ type: 'home_on_boot', value: !next });
      }
    } finally {
      setHomeOnBootPending(false);
    }
  };
  // Bench Mode — EEPROM-backed firmware flag. When ON the homing cycle
  // completes each axis on the first sensor trigger (no back-off + slow
  // re-touch) so the tech can tap each limit switch once during bench
  // testing. Real production homing behaviour is unchanged when OFF.
  const benchModeDraft = !!machine.state.benchMode;
  const [benchModePending, setBenchModePending] = useState(false);
  const toggleBenchMode = async () => {
    if (benchModePending) return;
    const next = !benchModeDraft;
    machine.dispatch({ type: 'bench_mode', value: next });
    setBenchModePending(true);
    try {
      const res = await machine.setBenchMode(next);
      if (res && res.ok === false && machine.state.connected) {
        machine.dispatch({ type: 'bench_mode', value: !next });
      }
    } finally {
      setBenchModePending(false);
    }
  };
  const [saveLabel, setSaveLabel] = useState("Save to Teensy EEPROM");
  const [saving, setSaving] = useState(false);
  // Air pressure threshold is owned by the machine state (so it stays in sync
  // with the firmware snapshot). We mirror it into a local edit buffer so
  // operator keypad edits don't immediately clobber the live reading, and
  // only flush it to EEPROM on Save.
  const [airThresholdDraft, setAirThresholdDraft] = useState(
    machine.state.airThresholdBar
  );
  useEffect(() => {
    // Keep the draft in sync when a fresh snapshot arrives (e.g. reconnect).
    setAirThresholdDraft(machine.state.airThresholdBar);
  }, [machine.state.airThresholdBar]);
  const [keypadState, setKeypadState] = useState({
    open: false,
    title: "",
    value: "",
    apply: () => {},
    allowNegative: false,
    allowDecimal: true,
  });

  // Touch-drag scroll refs for the two main settings cards. The Pi touchscreen
  // hides the native scrollbar (see index.css) so without these the operator
  // can't reach any field that overflows the card. Mouse + touch both work.
  const motionCardRef = useDragScroll();
  const envelopeCardRef = useDragScroll();

  // Rev4.4 — profile selector for the motion-settings card. Both profiles
  // (fast + cell) live in `motionSettings` simultaneously and both ship in
  // the SETMOTION payload on Save. The toggle just swaps which set of four
  // fields the keypad currently edits, so the operator can see all four
  // X/Y speed+accel values in one screenful instead of stacked vertically.
  const [motionProfile, setMotionProfile] = useState('fast'); // 'fast' | 'cell'

  const update = (key, value) => {
    setMotionSettings((prev) => ({ ...prev, [key]: value }));
  };
  const updateTravel = (key, value) => {
    setTravelLimits((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    if (saving) return;
    // Coerce string inputs to numbers and build a nested SETMOTION payload:
    // the firmware's cmd_setmotion accepts either legacy flat keys (which
    // only hit the fast profile) or the Rev4.3 nested { fast, cell, … }
    // shape that updates BOTH profiles atomically. We always send nested.
    const motionPayload = {
      fast: {
        xSpeed: Number(motionSettings.xSpeed),
        ySpeed: Number(motionSettings.ySpeed),
        xAccel: Number(motionSettings.xAccel),
        yAccel: Number(motionSettings.yAccel),
      },
      cell: {
        xSpeed: Number(motionSettings.cellXSpeed),
        ySpeed: Number(motionSettings.cellYSpeed),
        xAccel: Number(motionSettings.cellXAccel),
        yAccel: Number(motionSettings.cellYAccel),
      },
      dwellMs: Number(motionSettings.zDownDwell),
      preWeldHoldMs:  Number(motionSettings.preWeldHoldMs)  || 0,
      postWeldHoldMs: Number(motionSettings.postWeldHoldMs) || 0,
    };
    const travelPayload = {
      maxX: Number(travelLimits.maxX),
      maxY: Number(travelLimits.maxY),
    };
    const airBar = Number(airThresholdDraft);
    setSaving(true);
    try {
      // Fire all four writes in parallel. The three firmware commands cover
      // the "happy path" where the Teensy actually persists; the Pi-side
      // settings save is the safety net for firmware builds that don't
      // round-trip these values through EEPROM. Without the Pi save the
      // operator's envelope/air values would vanish on the next reload,
      // which is the bug the operator was hitting.
      const [mRes, tRes, aRes] = await Promise.all([
        machine.setMotionSettings(motionPayload),
        machine.setTravelLimits(travelPayload),
        machine.setAirThreshold(airBar),
        machine.saveSettings({
          travelLimits: travelPayload,
          motionSettings: motionPayload,
          airThresholdBar: airBar,
        }).catch(() => null),
      ]);
      // Push the just-saved values into machine.state so that exiting and
      // re-entering Settings in the same session shows the new values
      // (airThresholdDraft mirrors machine.state.airThresholdBar on mount).
      // Without this the draft re-initialised from the firmware's stale
      // default and the operator saw "Save didn't work".
      machine.dispatch({
        type: 'settings_hydrate',
        state: {
          travelLimits: travelPayload,
          motionSettings: { ...machine.state.motionSettings, ...motionPayload },
          airThresholdBar: airBar,
        },
      });
      const ok =
        (mRes?.ok ?? true) && (tRes?.ok ?? true) && (aRes?.ok ?? true);
      setSaveLabel(ok ? "Saved ✓" : "Save failed");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveLabel("Save to Teensy EEPROM"), 1500);
    }
  };

  const accent = accentFor("settings");
  const accentBlue = accentFor("programs");

  // Stable onClick wrapper so FieldButton (defined at module scope, see
  // below) keeps a steady identity across re-renders. Without this, every
  // SENSORS tick (4 Hz) re-mounted each FieldButton's <button> element,
  // and a finger-tap that straddled a re-render lost its click target —
  // the box looked tappable but nothing happened. See note on FieldButton.
  const openKeypad = (title, value, apply, allowDecimal = true) => {
    setKeypadState({
      open: true,
      title,
      value: String(value),
      apply,
      allowNegative: false,
      allowDecimal,
    });
  };

  return (
    <ScreenShell mode="settings" onHome={onHome} onBack={onBack}>
      <div className="h-full min-h-0 flex flex-col gap-2">
        {keypadState.open ? (
          <HudCard
            accent={accent.color}
            accentRgb={accent.rgb}
            className="p-3 flex-1 min-h-0"
          >
            <EmbeddedNumericKeypad
              title={keypadState.title}
              value={keypadState.value}
              onChange={(v) => setKeypadState((s) => ({ ...s, value: v }))}
              onCancel={() => setKeypadState((s) => ({ ...s, open: false }))}
              onConfirm={() => {
                keypadState.apply(keypadState.value);
                setKeypadState((s) => ({ ...s, open: false }));
              }}
              allowNegative={keypadState.allowNegative}
              allowDecimal={keypadState.allowDecimal}
            />
          </HudCard>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 flex-1 min-h-0">
              <HudCard
                ref={motionCardRef}
                accent={accent.color}
                accentRgb={accent.rgb}
                className="p-2.5 min-h-0 overflow-y-auto flex flex-col gap-3"
              >
                {/* MOTION PROFILES — one card, toggled view.
                      FAST profile = every motion outside a RUN: pre-move to
                      start position, park to loading position, JOG, Test
                      Motion screen. Tuned fast-but-safe.
                      CELL profile = cell-to-cell moves DURING a running
                      program. The Pi orchestrator tags each per-cell MOVE
                      with `P=C` so the Teensy switches to these settings
                      before stepping between weld points. Usually tuned
                      slower / lower-accel for repeatable positioning.
                    Both profiles live in `motionSettings` simultaneously and
                    both ship on Save; the toggle below only changes which
                    set of four fields is currently visible/editable so the
                    whole settings screen fits without scrolling. */}
                <div className="flex flex-col">
                  <div className="flex items-center justify-between gap-2 mb-1 shrink-0">
                    <div className="text-[11px] tracking-[0.2em] uppercase text-slate-400">
                      {motionProfile === 'fast'
                        ? 'Fast Motion (non-run moves)'
                        : 'Cell-to-Cell Motion (in-program)'}
                    </div>
                    {/* FAST | CELL toggle pill — opt out of drag-scroll so a
                        tap is never absorbed by the parent card's pointer
                        capture. Each half is a real <button>, which the
                        useDragScroll shouldIgnore() rule already exempts. */}
                    <div
                      data-no-drag
                      className="inline-flex items-center rounded-full border p-0.5"
                      style={{
                        background: "rgba(255,255,255,0.04)",
                        borderColor: "rgba(255,255,255,0.10)",
                      }}
                    >
                      {[
                        { key: 'fast', label: 'Fast' },
                        { key: 'cell', label: 'Cell' },
                      ].map((opt) => {
                        const on = motionProfile === opt.key;
                        return (
                          <button
                            key={opt.key}
                            onClick={() => setMotionProfile(opt.key)}
                            className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-[0.18em] uppercase transition-colors"
                            style={{
                              background: on
                                ? `linear-gradient(135deg, rgba(${accent.rgb},0.35), rgba(${accent.rgb},0.15))`
                                : "transparent",
                              color: on ? accent.color : "#94a3b8",
                              border: on
                                ? `1px solid rgba(${accent.rgb},0.45)`
                                : "1px solid transparent",
                              boxShadow: on
                                ? `0 0 10px rgba(${accent.rgb},0.25)`
                                : "none",
                              minWidth: 44,
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="h-px bg-white/5 mb-2 shrink-0" />
                  {motionProfile === 'fast' ? (
                    <div className="grid grid-cols-2 gap-2 content-start">
                      <SettingsFieldButton accentRgb={accent.rgb} openKeypad={openKeypad} label="X Speed (mm/s)" title="Fast X Speed" value={motionSettings.xSpeed} apply={(v) => update("xSpeed", v)} />
                      <SettingsFieldButton accentRgb={accent.rgb} openKeypad={openKeypad} label="Y Speed (mm/s)" title="Fast Y Speed" value={motionSettings.ySpeed} apply={(v) => update("ySpeed", v)} />
                      <SettingsFieldButton accentRgb={accent.rgb} openKeypad={openKeypad} label="X Accel (mm/s²)" title="Fast X Acceleration" value={motionSettings.xAccel} apply={(v) => update("xAccel", v)} />
                      <SettingsFieldButton accentRgb={accent.rgb} openKeypad={openKeypad} label="Y Accel (mm/s²)" title="Fast Y Acceleration" value={motionSettings.yAccel} apply={(v) => update("yAccel", v)} />
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2 content-start">
                      <SettingsFieldButton accentRgb={accent.rgb} openKeypad={openKeypad} label="X Speed (mm/s)" title="Cell X Speed" value={motionSettings.cellXSpeed} apply={(v) => update("cellXSpeed", v)} />
                      <SettingsFieldButton accentRgb={accent.rgb} openKeypad={openKeypad} label="Y Speed (mm/s)" title="Cell Y Speed" value={motionSettings.cellYSpeed} apply={(v) => update("cellYSpeed", v)} />
                      <SettingsFieldButton accentRgb={accent.rgb} openKeypad={openKeypad} label="X Accel (mm/s²)" title="Cell X Acceleration" value={motionSettings.cellXAccel} apply={(v) => update("cellXAccel", v)} />
                      <SettingsFieldButton accentRgb={accent.rgb} openKeypad={openKeypad} label="Y Accel (mm/s²)" title="Cell Y Acceleration" value={motionSettings.cellYAccel} apply={(v) => update("cellYAccel", v)} />
                    </div>
                  )}
                </div>

                {/* Weld-cycle timing (Rev4.4). Per-cell sequence is:
                      MOVE → Z DOWN → [Pre-weld Hold] → FIRE (Laser On Time)
                                    → [Post-weld Hold] → Z UP
                    All three timers live together in Settings so they're
                    tuned side-by-side. Pre/Post default to 0 so nothing
                    changes for existing welds until the operator dials
                    them in. */}
                <div className="flex flex-col">
                  <div className="text-[11px] tracking-[0.2em] uppercase text-slate-400 mb-1 shrink-0">Weld Cycle Timing</div>
                  <div className="h-px bg-white/5 mb-2 shrink-0" />
                  <div className="grid grid-cols-2 gap-2 content-start">
                    <SettingsFieldButton accentRgb={accent.rgb} openKeypad={openKeypad} label="Pre-weld Hold (ms)"  title="Pre-weld Hold (after Z Down)"  value={motionSettings.preWeldHoldMs}  apply={(v) => update("preWeldHoldMs", v)} />
                    <SettingsFieldButton accentRgb={accent.rgb} openKeypad={openKeypad} label="Laser On Time (ms)"  title="Laser On Time"                 value={motionSettings.zDownDwell}     apply={(v) => update("zDownDwell", v)} />
                    <SettingsFieldButton accentRgb={accent.rgb} openKeypad={openKeypad} label="Post-weld Hold (ms)" title="Post-weld Hold (before Z Up)" value={motionSettings.postWeldHoldMs} apply={(v) => update("postWeldHoldMs", v)} />
                  </div>
                </div>
              </HudCard>

              <HudCard
                ref={envelopeCardRef}
                accent={accent.color}
                accentRgb={accent.rgb}
                className="p-2.5 min-h-0 overflow-y-auto flex flex-col"
              >
                <div className="text-[11px] tracking-[0.2em] uppercase text-slate-400 mb-1 shrink-0">Envelope &amp; Air</div>
                <div className="h-px bg-white/5 mb-2 shrink-0" />

                <div className="grid grid-cols-2 gap-2">
                  <SettingsFieldButton
                    accentRgb={accent.rgb}
                    openKeypad={openKeypad}
                    label="Max X Travel (mm)"
                    title="Max X Travel"
                    value={travelLimits.maxX}
                    apply={(v) => updateTravel("maxX", v)}
                  />
                  <SettingsFieldButton
                    accentRgb={accent.rgb}
                    openKeypad={openKeypad}
                    label="Max Y Travel (mm)"
                    title="Max Y Travel"
                    value={travelLimits.maxY}
                    apply={(v) => updateTravel("maxY", v)}
                  />
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-slate-400">
                  <div className="rounded-md border border-white/10 bg-white/5 px-2 py-1">
                    <div className="tracking-[0.22em] uppercase text-[9px]">Envelope</div>
                    <div className="text-slate-200 text-xs mt-0.5 font-semibold">
                      {AXIS_LENGTH_X_MM} × {AXIS_LENGTH_Y_MM} mm
                    </div>
                  </div>
                  <div className="rounded-md border border-white/10 bg-white/5 px-2 py-1">
                    <div className="tracking-[0.22em] uppercase text-[9px]">Soft Limits</div>
                    <div className="text-slate-200 text-xs mt-0.5 font-semibold">
                      {Number(travelLimits.maxX).toFixed(0)} × {Number(travelLimits.maxY).toFixed(0)} mm
                    </div>
                  </div>
                </div>

                <div className="mt-2 h-px bg-white/5" />

                <div className="grid grid-cols-2 gap-2 mt-2">
                  <SettingsFieldButton
                    accentRgb={accent.rgb}
                    openKeypad={openKeypad}
                    label="Low Air (bar)"
                    title="Low Air Threshold"
                    value={airThresholdDraft}
                    apply={(v) => setAirThresholdDraft(v)}
                  />
                  <div className="rounded-md border border-white/10 bg-white/5 px-2 py-1 flex flex-col justify-center">
                    <div className="tracking-[0.22em] uppercase text-[9px] text-slate-400">Live Pressure</div>
                    <div className="text-slate-200 text-xs mt-0.5 font-semibold">
                      {Number(machine.state.airPressureBar ?? 0).toFixed(2)} bar
                    </div>
                  </div>
                </div>

              </HudCard>
            </div>

            {/* Bottom row — Commissioning controls live on the left, Save to
                Teensy lives on the right, all in a single shrink-0 strip so
                everything above can claim the rest of the screen height. The
                Commissioning HudCard absorbs the leftover horizontal space
                (flex-1) and Save sits at the far right at a fixed width. */}
            <div className="flex items-stretch gap-2 shrink-0">
            <HudCard
              accent={accent.color}
              accentRgb={accent.rgb}
              className="p-2.5 flex-1 min-w-0"
            >
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="text-[11px] tracking-[0.2em] uppercase text-slate-400">Commissioning</div>
                  <div className="text-[10px] text-slate-400 mt-0.5 leading-snug">
                    {canToggleHomeOnBoot
                      ? "Sensors verified by the last homing cycle. Auto-home is safe to enable."
                      : "Verify limit switches in Test Motion, then run a Homing cycle to unlock auto-home."}
                  </div>
                </div>
                <div className="flex items-center gap-2.5">
                  {/* Home on Boot toggle — locked until the machine has been
                      homed at least once this session. */}
                  <div
                    className="flex items-center gap-2 rounded-lg border px-2.5 py-1"
                    style={{
                      background: canToggleHomeOnBoot ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.02)",
                      borderColor: canToggleHomeOnBoot ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.06)",
                      opacity: canToggleHomeOnBoot ? 1 : 0.55,
                    }}
                    title={canToggleHomeOnBoot
                      ? "Toggle automatic homing on boot"
                      : "Home the machine at least once this session to unlock this toggle"}
                  >
                    <div className="text-[10px] tracking-[0.22em] uppercase text-slate-300">
                      Home on Boot
                    </div>
                    <button
                      onClick={toggleHomeOnBoot}
                      disabled={homeOnBootPending || !canToggleHomeOnBoot}
                      aria-pressed={homeOnBootDraft}
                      className="relative inline-flex items-center h-5 w-10 rounded-full transition-colors border disabled:cursor-not-allowed"
                      style={{
                        background: homeOnBootDraft
                          ? `rgba(${accent.rgb},0.6)`
                          : "rgba(255,255,255,0.08)",
                        borderColor: homeOnBootDraft
                          ? `rgba(${accent.rgb},0.7)`
                          : "rgba(255,255,255,0.15)",
                        boxShadow: homeOnBootDraft
                          ? `0 0 10px rgba(${accent.rgb},0.35)`
                          : "none",
                      }}
                    >
                      <span
                        className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
                        style={{
                          transform: homeOnBootDraft
                            ? "translateX(20px)"
                            : "translateX(2px)",
                        }}
                      />
                    </button>
                    <div
                      className="text-[10px] font-semibold tracking-widest"
                      style={{
                        color: !canToggleHomeOnBoot
                          ? "#64748b"
                          : homeOnBootDraft
                            ? accent.color
                            : "#94a3b8",
                        minWidth: 24,
                      }}
                    >
                      {!canToggleHomeOnBoot ? "LOCKED" : homeOnBootDraft ? "ON" : "OFF"}
                    </div>
                  </div>

                  {/* Bench Mode toggle — skips the back-off + slow re-touch
                      homing phases so a single tap on each limit switch
                      completes that axis. Intended for bench testing only. */}
                  <div
                    className="flex items-center gap-2 rounded-lg border px-2.5 py-1"
                    style={{
                      background: benchModeDraft
                        ? "rgba(250, 204, 21, 0.08)"
                        : "rgba(255,255,255,0.04)",
                      borderColor: benchModeDraft
                        ? "rgba(250, 204, 21, 0.35)"
                        : "rgba(255,255,255,0.10)",
                    }}
                    title="Bench testing only — homing completes each axis on the first sensor trigger. Turn OFF for real machines."
                  >
                    <div className="text-[10px] tracking-[0.22em] uppercase text-slate-300">
                      Bench Mode
                    </div>
                    <button
                      onClick={toggleBenchMode}
                      disabled={benchModePending}
                      aria-pressed={benchModeDraft}
                      className="relative inline-flex items-center h-5 w-10 rounded-full transition-colors border disabled:cursor-not-allowed"
                      style={{
                        background: benchModeDraft
                          ? "rgba(250, 204, 21, 0.6)"
                          : "rgba(255,255,255,0.08)",
                        borderColor: benchModeDraft
                          ? "rgba(250, 204, 21, 0.7)"
                          : "rgba(255,255,255,0.15)",
                        boxShadow: benchModeDraft
                          ? "0 0 10px rgba(250, 204, 21, 0.35)"
                          : "none",
                      }}
                    >
                      <span
                        className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
                        style={{
                          transform: benchModeDraft
                            ? "translateX(20px)"
                            : "translateX(2px)",
                        }}
                      />
                    </button>
                    <div
                      className="text-[10px] font-semibold tracking-widest"
                      style={{
                        color: benchModeDraft ? "#fbbf24" : "#94a3b8",
                        minWidth: 24,
                      }}
                    >
                      {benchModeDraft ? "ON" : "OFF"}
                    </div>
                  </div>

                  {/* Test Motion button */}
                  <button
                    onClick={() => setScreen("testMotion")}
                    className="hud-accent-btn h-9 px-3 text-[11px] font-semibold tracking-[0.15em] uppercase border inline-flex items-center gap-2"
                    style={{
                      background: `linear-gradient(135deg, rgba(${accent.rgb},0.18), rgba(${accent.rgb},0.05))`,
                      borderColor: `rgba(${accent.rgb},0.35)`,
                      color: accent.color,
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M12 2v4" />
                      <path d="M12 18v4" />
                      <path d="M2 12h4" />
                      <path d="M18 12h4" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    Test Motion
                  </button>
                </div>
              </div>
            </HudCard>

            {/* Save sits at the right end of the same row, so the user can
                tap Save without hunting for a separate strip below. Width is
                fixed at ~14rem so the Commissioning card claims the rest of
                the row regardless of viewport size. */}
            <button
                onClick={handleSave}
                disabled={saving}
                className="hud-accent-btn px-5 text-xs font-semibold tracking-[0.15em] uppercase border inline-flex items-center justify-center gap-2 shrink-0"
                style={{
                  width: "14rem",
                  background: `linear-gradient(135deg, rgba(${accentBlue.rgb},0.85), rgba(${accentBlue.rgb},0.6))`,
                  borderColor: `rgba(${accentBlue.rgb},0.5)`,
                  boxShadow: `0 0 0 1px rgba(${accentBlue.rgb},0.3), 0 0 18px rgba(${accentBlue.rgb},0.25)`,
                  color: "#f0f9ff",
                }}
              >
                {saving && <Loading size="xs" />}
                {saving ? "Saving..." : saveLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </ScreenShell>
  );
}

/* ------------------------------ TEST MOTION ------------------------------ */
// Manual jog + live limit-switch readout. Used during first-power-on
// commissioning to verify every sensor wire reaches the Teensy before the
// automatic homing cycle is ever allowed to run. Also surfaces the ALM lines
// from the CL57Y drivers so a bad motor phase is caught immediately.

function TestMotionScreen({ onHome, onBack }) {
  const machine = useMachine();
  const s = machine.state;
  const accent = accentFor("settings");
  const [stepSize, setStepSize] = useState(1.0);
  // Sensor-lamp column is scrollable on small screens; enable drag-to-scroll
  // so the Pi touchscreen user can swipe through it.
  const sensorPanelRef = useDragScroll();
  const [keypadState, setKeypadState] = useState({
    open: false,
    title: "",
    value: "",
    apply: () => {},
    allowNegative: false,
    allowDecimal: true,
  });

  // Request a fresh SENSORS packet on entry so the indicator grid isn't
  // blank for up to 250 ms while we wait for the next periodic tick.
  useEffect(() => {
    if (machine.requestSensors) machine.requestSensors();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Relative single-axis jog — uses the new JOG X/Y commands so the firmware
  // respects soft limits even when the machine isn't homed.
  const jog = (axis, dir) => {
    const mm = dir * stepSize;
    if (axis === "x") machine.jogX(mm);
    else if (axis === "y") machine.jogY(mm);
  };

  const [driverBusy, setDriverBusy] = useState(false);
  const toggleDrivers = async () => {
    if (driverBusy) return;
    setDriverBusy(true);
    try {
      if (s.driversEnabled) await machine.disableDrivers();
      else                  await machine.enableDrivers();
    } finally {
      setDriverBusy(false);
    }
  };

  const LampDot = ({ on, color = accent.color, label }) => (
    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
      <span
        className="inline-block w-2.5 h-2.5 rounded-full transition"
        style={{
          background: on ? color : "rgba(255,255,255,0.12)",
          boxShadow: on ? `0 0 8px ${color}, 0 0 2px ${color}` : "none",
        }}
      />
      <span
        className="text-[10px] tracking-[0.14em] uppercase"
        style={{ color: on ? "#e2e8f0" : "#64748b" }}
      >
        {label}
      </span>
    </div>
  );

  const sensors = s.sensors || {};
  const jogBtn =
    "rounded-[0.85rem] bg-white/10 border border-white/10 py-2 text-sm font-semibold hover:bg-white/15 active:bg-white/20 transition";

  return (
    <ScreenShell mode="settings" onHome={onHome} onBack={onBack}>
      <div className="h-full min-h-0 grid grid-cols-12 gap-2">
        {/* ------------- Left column: jog + step ------------- */}
        <HudCard
          accent={accent.color}
          accentRgb={accent.rgb}
          className="col-span-6 p-3 flex flex-col min-h-0"
        >
          {!keypadState.open ? (
            <>
              <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1 shrink-0">
                Manual Jog
              </div>
              <div className="text-[10px] text-amber-300/80 mb-2 shrink-0 leading-tight">
                ⚠ Machine may not be homed. Move slowly and watch the table.
              </div>
              <div className="h-px bg-white/5 mb-3 shrink-0" />

              {/* X/Y jog pad */}
              <div className="grid grid-cols-3 gap-2 max-w-[300px] mx-auto w-full shrink-0">
                <div />
                <button onClick={() => jog("y", +1)} className={jogBtn}>Y+</button>
                <div />
                <button onClick={() => jog("x", -1)} className={jogBtn}>X-</button>
                <div className="rounded-[0.85rem] border border-white/10 bg-black/20 py-2 flex items-center justify-center text-slate-300 text-[11px] font-medium">
                  Jog
                </div>
                <button onClick={() => jog("x", +1)} className={jogBtn}>X+</button>
                <div />
                <button onClick={() => jog("y", -1)} className={jogBtn}>Y-</button>
                <div />
              </div>

              {/* Step size */}
              <div className="mt-3 max-w-[300px] mx-auto w-full shrink-0">
                <div className="flex items-center justify-between mb-0.5">
                  <div className="text-[11px] text-slate-400">Step: {stepSize.toFixed(2)} mm</div>
                  <button
                    onClick={() =>
                      setKeypadState({
                        open: true,
                        title: "Jog Step Size",
                        value: String(stepSize),
                        apply: (v) => setStepSize(Number(v || 0.1)),
                        allowNegative: false,
                        allowDecimal: true,
                      })
                    }
                    className="rounded-md bg-white/10 border border-white/10 px-2 py-0.5 text-[11px]"
                  >
                    Enter
                  </button>
                </div>
                <TouchSlider
                  min="0.1"
                  max="50"
                  step="0.1"
                  value={stepSize}
                  onChange={(e) => setStepSize(Number(e.target.value))}
                />
                <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
                  <span>0.1</span><span>1</span><span>10</span><span>50 mm</span>
                </div>
              </div>

              {/* Z up / down */}
              <div className="mt-3 grid grid-cols-2 gap-2 max-w-[300px] mx-auto w-full shrink-0">
                <button
                  onClick={() => machine.setZ("DOWN")}
                  className="rounded-[0.85rem] bg-white/10 border border-white/10 py-2 text-xs font-semibold hover:bg-white/15"
                >
                  Z DOWN
                </button>
                <button
                  onClick={() => machine.setZ("UP")}
                  className="rounded-[0.85rem] bg-white/10 border border-white/10 py-2 text-xs font-semibold hover:bg-white/15"
                >
                  Z UP
                </button>
              </div>

              {/* Drivers enable/disable */}
              <div className="mt-3 max-w-[300px] mx-auto w-full shrink-0">
                <button
                  onClick={toggleDrivers}
                  disabled={driverBusy}
                  className="w-full rounded-[0.85rem] h-10 text-xs font-semibold tracking-[0.14em] uppercase border inline-flex items-center justify-center gap-2"
                  style={{
                    background: s.driversEnabled
                      ? `linear-gradient(135deg, rgba(${accent.rgb},0.25), rgba(${accent.rgb},0.08))`
                      : "rgba(255,255,255,0.05)",
                    borderColor: s.driversEnabled
                      ? `rgba(${accent.rgb},0.4)`
                      : "rgba(255,255,255,0.15)",
                    color: s.driversEnabled ? accent.color : "#cbd5e1",
                  }}
                >
                  {driverBusy && <RingSpinner size={10} stroke={3} speed={1.0} />}
                  {s.driversEnabled ? "Drivers ENABLED — click to disable" : "Drivers DISABLED — click to enable"}
                </button>
                <div className="text-[10px] text-slate-500 mt-1 leading-tight">
                  Disable drivers to push the table by hand and watch the limit lamps flip.
                </div>
              </div>

              {/* Live position readout */}
              <div className="mt-auto pt-3 grid grid-cols-3 gap-2 shrink-0">
                <div className="rounded-lg border border-white/10 bg-white/5 p-2 text-center">
                  <div className="text-[9px] tracking-[0.22em] uppercase text-slate-400">X</div>
                  <div className="text-lg font-bold" style={{ color: accent.color }}>
                    {Number(s.position.x).toFixed(2)}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-2 text-center">
                  <div className="text-[9px] tracking-[0.22em] uppercase text-slate-400">Y</div>
                  <div className="text-lg font-bold" style={{ color: accent.color }}>
                    {Number(s.position.y).toFixed(2)}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-2 text-center">
                  <div className="text-[9px] tracking-[0.22em] uppercase text-slate-400">Z</div>
                  <div className="text-lg font-bold" style={{ color: accent.color }}>
                    {s.position.z}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <EmbeddedNumericKeypad
              title={keypadState.title}
              value={keypadState.value}
              onChange={(v) => setKeypadState((st) => ({ ...st, value: v }))}
              onCancel={() => setKeypadState((st) => ({ ...st, open: false }))}
              onConfirm={() => {
                keypadState.apply(keypadState.value);
                setKeypadState((st) => ({ ...st, open: false }));
              }}
              allowNegative={keypadState.allowNegative}
              allowDecimal={keypadState.allowDecimal}
            />
          )}
        </HudCard>

        {/* ------------- Right column: sensor lamps ------------- */}
        <HudCard
          ref={sensorPanelRef}
          accent={accent.color}
          accentRgb={accent.rgb}
          className="col-span-6 p-3 flex flex-col min-h-0 overflow-auto"
        >
          <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1 shrink-0">
            Limit &amp; Driver State
          </div>
          <div className="text-[10px] text-slate-500 mb-2 shrink-0 leading-tight">
            Live · updated on change and every 250 ms.
          </div>
          <div className="h-px bg-white/5 mb-3 shrink-0" />

          {/* Home switches */}
          <div className="mb-3">
            <div className="text-[10px] tracking-[0.22em] uppercase text-slate-400 mb-1.5">
              Home Switches
            </div>
            <div className="grid grid-cols-3 gap-2">
              <LampDot on={!!sensors.xHome}      color="#60a5fa" label="X Home" />
              <LampDot on={!!sensors.yLeftHome}  color="#60a5fa" label="Y-Left Home" />
              <LampDot on={!!sensors.yRightHome} color="#60a5fa" label="Y-Right Home" />
            </div>
          </div>

          {/* Z cylinder reed switches */}
          <div className="mb-3">
            <div className="text-[10px] tracking-[0.22em] uppercase text-slate-400 mb-1.5">
              Z Cylinder Reeds
            </div>
            <div className="grid grid-cols-2 gap-2">
              <LampDot on={!!sensors.zUp}   color="#34d399" label="Z Up" />
              <LampDot on={!!sensors.zDown} color="#34d399" label="Z Down" />
            </div>
          </div>

          {/* Driver ALM lines */}
          <div className="mb-3">
            <div className="text-[10px] tracking-[0.22em] uppercase text-slate-400 mb-1.5">
              Driver Alarms <span className="text-slate-500">(OFF = healthy)</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <LampDot on={!!sensors.xAlm}      color="#f87171" label="X ALM" />
              <LampDot on={!!sensors.yLeftAlm}  color="#f87171" label="Y-Left ALM" />
              <LampDot on={!!sensors.yRightAlm} color="#f87171" label="Y-Right ALM" />
            </div>
          </div>

          {/* Legend + refresh */}
          <div className="mt-auto shrink-0">
            <div className="h-px bg-white/5 my-2" />
            <div className="flex items-center justify-between gap-3">
              <div className="text-[10px] text-slate-500 leading-tight">
                Tap a switch by hand while drivers are disabled — lamps should
                light the moment the switch closes.
              </div>
              <button
                onClick={() => machine.requestSensors()}
                className="shrink-0 rounded-md bg-white/10 border border-white/10 px-3 py-1.5 text-[11px]"
              >
                Refresh
              </button>
            </div>
          </div>
        </HudCard>
      </div>
    </ScreenShell>
  );
}

/* --------------------------------- SETUP --------------------------------- */

function LoadingPositionScreen({ loadingPosition, setLoadingPosition, onHome, onBack }) {
  const machine = useMachine();
  const [step, setStep] = useState(1.0);
  const [pos, setPos] = useState(loadingPosition);
  // On entry we want to move the table to the currently-stored loading
  // position (default = center of axis). Ask first — the operator may have
  // clamps or fixturing on the table that needs clearing before any motion.
  const [moveConfirm, setMoveConfirm] = useState({
    open: true,
    target: loadingPosition,
  });
  // Tracks the initial "move to stored loading position" travel so we can
  // throw up the same loading gif + live axis ticker the homing overlay uses.
  // Without this the operator just stares at the graphic while the gantry
  // drives itself silently for up to a few seconds.
  const [movingToLoad, setMovingToLoad] = useState(false);
  const [keypadState, setKeypadState] = useState({
    open: false,
    title: "",
    value: "",
    apply: () => {},
    allowNegative: false,
    allowDecimal: true,
  });

  const confirmMove = async () => {
    const t = moveConfirm.target || loadingPosition;
    setMoveConfirm({ open: false, target: null });
    // Raise Z first, then move in-plane. Matches the firmware's own load-pos
    // sequencing at the end of homing. Both steps are best-effort — a
    // rejected setZ / moveTo should still drop the overlay rather than
    // leaving the operator stuck on a spinner.
    setMovingToLoad(true);
    try { await machine.setZ("UP"); } catch { /* non-fatal */ }
    try { await machine.moveTo(t.x, t.y); } catch { /* non-fatal */ }
    setPos(t);
    setMovingToLoad(false);
  };
  const cancelMove = () => setMoveConfirm({ open: false, target: null });

  const jog = (axis, dir) => {
    setPos((p) => {
      const next = { ...p, [axis]: Number((p[axis] + dir * step).toFixed(2)) };
      // Calibration jog — bypasses the firmware Z-up gate so the operator
      // can nudge the table while teaching the loading position with Z down
      // (e.g. to fine-tune where the work piece will land relative to the
      // weld head). Every non-calibration MOVE still uses moveTo() and
      // gets the standard z_safe() interlock.
      machine.moveToCal(next.x, next.y);
      return next;
    });
  };

  const setZLocal = (dir) => {
    setPos((p) => ({ ...p, z: dir }));
    machine.setZ(dir);
  };

  const save = () => {
    setLoadingPosition(pos);
    // Persist to Teensy EEPROM so the machine parks here after homing
    machine.setLoadingPosition(pos);
    // Mirror to Pi-side settings file so the value survives across reboots
    // even when the firmware build doesn't round-trip LOADPOS via SNAPSHOT
    // (same pattern as envelope / air threshold).
    machine.saveSettings({ loadingPosition: pos }).catch(() => {});
    // Push into machine.state so anything reading from there sees the new
    // value immediately (machine.state.loadingPosition feeds the run-screen
    // post-run park target and the parking-position graphic preview).
    machine.dispatch({ type: 'settings_hydrate', state: { loadingPosition: pos } });
    onBack();
  };

  return (
    <ScreenShell mode="setup" onHome={onHome} onBack={onBack}>
      <div className="h-full min-h-0 grid grid-cols-12 gap-2">
        <div className="col-span-6 h-full min-h-0">
          {!keypadState.open ? (
            // Drive the graphic off the LIVE machine position so the operator
            // sees the table where it actually is — both on entry (default
            // loading position = centre of travel → table renders centred) and
            // during jogging (table slides as MOVE commands complete).
            <MachineTravelGraphic position={machine.state.position} />
          ) : (
            <EmbeddedNumericKeypad
              title={keypadState.title}
              value={keypadState.value}
              onChange={(v) => setKeypadState((s) => ({ ...s, value: v }))}
              onCancel={() => setKeypadState((s) => ({ ...s, open: false }))}
              onConfirm={() => {
                keypadState.apply(keypadState.value);
                setKeypadState((s) => ({ ...s, open: false }));
              }}
              allowNegative={keypadState.allowNegative}
              allowDecimal={keypadState.allowDecimal}
            />
          )}
        </div>

        <HudCard
          accent={accentFor("setup").color}
          accentRgb={accentFor("setup").rgb}
          className="col-span-6 p-2 flex flex-col min-h-0"
        >
          <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1 pl-1 shrink-0">Loading Position</div>
          <div className="h-px bg-white/5 mb-1.5 shrink-0" />
          <div className="text-slate-400 text-[10px] mb-1.5 shrink-0 leading-tight pl-1">
            Table parks here after power-on, homing, and end of program.
          </div>

          <div className="grid grid-cols-3 gap-1.5 mb-1.5 max-w-[280px] mx-auto w-full shrink-0">
            <div />
            <button
              onClick={() => jog("y", 1)}
              className="rounded-[0.85rem] bg-white/10 border border-white/10 py-1.5 text-sm font-semibold hover:bg-white/15"
            >
              Y+
            </button>
            <div />

            <button
              onClick={() => jog("x", -1)}
              className="rounded-[0.85rem] bg-white/10 border border-white/10 py-1.5 text-sm font-semibold hover:bg-white/15"
            >
              X-
            </button>
            <div className="rounded-[0.85rem] border border-white/10 bg-black/20 py-1.5 flex items-center justify-center text-slate-300 text-xs font-medium">
              Jog
            </div>
            <button
              onClick={() => jog("x", 1)}
              className="rounded-[0.85rem] bg-white/10 border border-white/10 py-1.5 text-sm font-semibold hover:bg-white/15"
            >
              X+
            </button>

            <div />
            <button
              onClick={() => jog("y", -1)}
              className="rounded-[0.85rem] bg-white/10 border border-white/10 py-1.5 text-sm font-semibold hover:bg-white/15"
            >
              Y-
            </button>
            <div />
          </div>

          <div className="mb-1.5 max-w-md mx-auto w-full shrink-0">
            <div className="flex items-center justify-between mb-0.5">
              <div className="text-[11px] text-slate-400">Step: {step.toFixed(1)} mm</div>
              <button
                onClick={() =>
                  setKeypadState({
                    open: true,
                    title: "Step Size",
                    value: String(step),
                    apply: (v) => setStep(Number(v || 0.1)),
                    allowNegative: false,
                    allowDecimal: true,
                  })
                }
                className="rounded-md bg-white/10 border border-white/10 px-2 py-0.5 text-[11px]"
              >
                Enter
              </button>
            </div>
            <TouchSlider
              min="0.1"
              max="10"
              step="0.1"
              value={step}
              onChange={(e) => setStep(Number(e.target.value))}
            />
          </div>

          <div className="grid grid-cols-2 gap-1.5 max-w-md mx-auto w-full mb-1.5 shrink-0">
            <button
              onClick={() => setZLocal("DOWN")}
              className="rounded-[0.85rem] bg-white/10 border border-white/10 px-3 py-1.5 font-semibold hover:bg-white/15 text-xs"
            >
              Z DOWN
            </button>
            <button
              onClick={() => setZLocal("UP")}
              className="rounded-[0.85rem] bg-white/10 border border-white/10 px-3 py-1.5 font-semibold hover:bg-white/15 text-xs"
            >
              Z UP
            </button>
          </div>

          <div className="mt-auto grid gap-1.5 max-w-md mx-auto w-full shrink-0">
            <button
              onClick={save}
              className="rounded-[0.85rem] h-9 bg-blue-600 hover:bg-blue-500 px-4 text-xs font-semibold"
            >
              Save Loading Position
            </button>

            <button
              onClick={onBack}
              className="rounded-[0.85rem] h-8 bg-white/10 border border-white/10 px-4 text-xs font-semibold"
            >
              Cancel
            </button>
          </div>
        </HudCard>
      </div>

      {/* Move-to-loading-position confirmation. Fires on entry so the operator
          can clear the table before the gantry drives itself there. */}
      {moveConfirm.open && (
        <div className="fixed inset-0 z-[9700] flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <HudCard
            accent={accentFor("setup").color}
            accentRgb={accentFor("setup").rgb}
            className="p-6 w-[min(520px,92vw)]"
          >
            <div className="text-[10px] tracking-[0.32em] uppercase text-slate-300 mb-1">
              Confirm Motion
            </div>
            <div
              className="text-xl font-bold mb-3"
              style={{ color: accentFor("setup").color }}
            >
              Okay to move table?
            </div>
            <div className="text-sm text-slate-200 mb-3 leading-relaxed">
              The table will raise Z and travel to the stored loading position
              so you can fine-tune it from there. Clear any clamps, fixturing,
              or parts from the table before continuing.
            </div>
            <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-slate-300 leading-snug mb-5 font-mono">
              Target:&nbsp;X&nbsp;{(moveConfirm.target?.x ?? 0).toFixed(2)} mm
              &nbsp;·&nbsp;Y&nbsp;{(moveConfirm.target?.y ?? 0).toFixed(2)} mm
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={cancelMove}
                className="h-11 px-5 text-xs font-semibold tracking-[0.15em] uppercase rounded-lg border border-white/10 bg-white/5 hover:bg-white/10"
              >
                Not Yet
              </button>
              <button
                onClick={confirmMove}
                className="h-11 px-5 text-xs font-bold tracking-[0.18em] uppercase rounded-lg"
                style={{
                  background: `linear-gradient(135deg, rgba(${accentFor("setup").rgb},0.85), rgba(${accentFor("setup").rgb},0.5))`,
                  border: `1px solid rgba(${accentFor("setup").rgb},0.5)`,
                  boxShadow: `0 0 18px rgba(${accentFor("setup").rgb},0.3)`,
                  color: "#f0f9ff",
                }}
              >
                Move Table
              </button>
            </div>
          </HudCard>
        </div>
      )}

      {/* Travel overlay — shown while the gantry is moving to the stored
          loading position so the operator gets the same visual feedback as
          the homing / start-position moves (ionetic gif + live axis ticker
          instead of a silently-sliding table). */}
      <LoadingOverlay
        visible={movingToLoad}
        title="Moving to loading position"
        subtext="Raising Z and travelling to the stored loading position"
      >
        <HomingAxisTicker />
      </LoadingOverlay>
    </ScreenShell>
  );
}

function XAxisTrammingScreen({ onHome, onBack }) {
  const machine = useMachine();
  const [offset, setOffset] = useState(machine.state.gantryOffsetMm || 0);
  const [savedOffset, setSavedOffset] = useState(machine.state.gantryOffsetMm || 0);
  // Jog step — tramming involves driving the table back and forth to touch off
  // against reference points. Coarse range (1–20 mm, 1 mm increments) so the
  // operator can actually get somewhere with a few taps.
  const [stepSize, setStepSize] = useState(5);
  // Offset-adjustment step — independent of jog step because tramming the
  // right-hand ballscrew is a fine-precision operation. The operator dials
  // this in via the Offset Step slider below the visualisation (0.01–2 mm).
  // Default starts at 0.01 mm so a brand-new screen doesn't accidentally
  // rack the gantry by 2 mm on the first tap.
  const [offsetStep, setOffsetStep] = useState(0.01);
  const [keypadState, setKeypadState] = useState({
    open: false,
    title: "",
    value: "",
    apply: () => {},
    allowNegative: true,
    allowDecimal: true,
  });

  const adjustOffset = (delta) => {
    const next = Number((offset + delta).toFixed(3));
    setOffset(next);
    // Fire-and-forget: TRAM_PREVIEW moves Y_RIGHT alone to (Y_LEFT + next) so
    // the gantry visibly squares in real time. If the firmware returns BUSY
    // (a previous tiny move is still finishing — sub-100ms in practice) the
    // local setpoint will be one tap ahead of the motor until the next tap
    // lands. Acceptable at human-tap speeds.
    machine.tramPreview(next);
  };

  // Jog the single set of X/Y controls as normal axis moves (step-size aware).
  // Step size is millimetres per tap — the slider is pinned to whole-mm values.
  const jogGantry = (axis, dir) => {
    const cur = machine.state.position;
    const x = axis === "x" ? Number((cur.x + dir * stepSize).toFixed(3)) : cur.x;
    const y = axis === "y" ? Number((cur.y + dir * stepSize).toFixed(3)) : cur.y;
    machine.moveTo(x, y);
  };

  const [savingGantry, setSavingGantry] = useState(false);
  // Tracks the post-save park-to-loading travel so we can throw up the same
  // ionetic gif + live axis ticker that the homing / loading-position /
  // post-run-park overlays use. After tramming the operator was being left
  // at whatever (often awkward) X/Y the touch-off process ended at, instead
  // of back at the loading position where the next operation starts from.
  const [movingToLoad, setMovingToLoad] = useState(false);
  const saveGantry = async () => {
    if (savingGantry) return;
    setSavingGantry(true);
    try {
      // §4.1 SET_TRAM — setGantryOffset is an alias kept for back-compat.
      await machine.setTram(offset);
      setSavedOffset(offset);
    } finally {
      setSavingGantry(false);
    }
    // Park to loading position after the save lands. Same Z-UP-then-XY
    // sequence as CalibrationScreen.saveStart and the post-run park —
    // best-effort, swallow any motion failures so the operator isn't
    // stranded on the spinner.
    setMovingToLoad(true);
    try { await machine.setZ('UP'); } catch { /* non-fatal */ }
    const lp = machine.state.loadingPosition;
    if (lp &&
        Number.isFinite(Number(lp.x)) &&
        Number.isFinite(Number(lp.y)) &&
        (Number(lp.x) !== 0 || Number(lp.y) !== 0)) {
      try { await machine.moveTo(Number(lp.x), Number(lp.y)); } catch { /* non-fatal */ }
    }
    setMovingToLoad(false);
  };

  const restoreGantry = () => {
    setOffset(savedOffset);
    // Physically revert Y_RIGHT to the saved-offset position so the operator
    // doesn't just see the number snap back while the gantry stays racked at
    // the previewed value. Mirrors what TRAM_PREVIEW does on every ↑/↓ tap.
    machine.tramPreview(savedOffset);
  };

  // If the operator leaves the tramming screen without committing the change,
  // physically revert Y_RIGHT to the saved-offset position. Without this the
  // firmware's RAM-side tramOffset stays at the previewed value and the next
  // regular Y move would slew Y_RIGHT to the wrong place. Refs are used so
  // the unmount cleanup sees the latest values without a stale closure.
  const offsetRef = useRef(offset);
  const savedOffsetRef = useRef(savedOffset);
  useEffect(() => { offsetRef.current = offset; }, [offset]);
  useEffect(() => { savedOffsetRef.current = savedOffset; }, [savedOffset]);
  useEffect(() => {
    return () => {
      if (offsetRef.current !== savedOffsetRef.current) {
        machine.tramPreview(savedOffsetRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tramming visualisation — Y_LEFT reference at lineX1 stays fixed, Y_RIGHT
  // at lineX2 rises/falls with the offset. Insets keep both circles + line
  // strokes safely inside the bordered viewport, and the rise is clamped so
  // the right circle never disappears off the top/bottom of the SVG when the
  // operator dials in larger offsets (a 1.5 mm offset would have pushed the
  // circle outside the old viewBox).
  const lineX1 = 60;
  const lineX2 = 420;
  const centerY = 110;
  const rawRise = offset * 40;          // mm → svg-units (scale tuned for visibility)
  const rise = Math.max(-80, Math.min(80, rawRise)); // clamp inside viewBox
  const y1 = centerY;
  const y2 = centerY - rise;

  // Bumped up from px-3/py-2/text-sm — tramming jog buttons should feel like
  // primary touch targets at arm's reach on the bench, not crammed. py-3
  // (not py-5) keeps the 3-row jog grid short enough that the step-size
  // slider below it still fits inside the panel — at py-5 the slider got
  // pushed below the panel border and ended up behind the right-panel
  // Save/Restore card.
  const jogBtn =
    "rounded-[0.85rem] bg-white/10 border border-white/10 px-5 py-3 text-base font-semibold hover:bg-white/15";

  const gAccent = accentFor("setup");

  return (
    <ScreenShell mode="setup" onHome={onHome} onBack={onBack}>
      <div className="h-full min-h-0 grid grid-cols-12 gap-2">
        <HudCard
          accent={gAccent.color}
          accentRgb={gAccent.rgb}
          className="col-span-7 p-2 flex flex-col gap-3 min-h-0 overflow-hidden"
        >
          {!keypadState.open ? (
            <>
              <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1.5 shrink-0 pl-1">X Axis Tramming</div>

              <div className="grid grid-cols-3 gap-2 max-w-[420px] mx-auto w-full shrink-0">
                <div />
                <button onClick={() => jogGantry("y", 1)} className={jogBtn}>Y+</button>
                <div />

                <button onClick={() => jogGantry("x", -1)} className={jogBtn}>X-</button>
                <div className="rounded-[0.85rem] border border-white/10 bg-black/20 py-3 flex items-center justify-center text-slate-300 text-sm font-medium">
                  Jog
                </div>
                <button onClick={() => jogGantry("x", 1)} className={jogBtn}>X+</button>

                <div />
                <button onClick={() => jogGantry("y", -1)} className={jogBtn}>Y-</button>
                <div />
              </div>

              {/* Step-size slider container width matches the jog button grid above
                  so the slider track aligns with the X-/X+ column and doesn't
                  visually drift wider than the buttons on the wider Pi screen. */}
              <div className="mt-3 max-w-[420px] mx-auto w-full shrink-0">
                <div className="flex items-center justify-between mb-0.5">
                  <div className="text-[11px] text-slate-400">Step: {stepSize} mm</div>
                  <button
                    onClick={() =>
                      setKeypadState({
                        open: true,
                        title: "Step Size",
                        value: String(stepSize),
                        apply: (v) => {
                          // Clamp user entry to the slider's 1–20 mm range so
                          // the slider thumb never lands off its own track.
                          const n = Number(v);
                          if (!Number.isFinite(n)) return;
                          setStepSize(Math.max(1, Math.min(20, Math.round(n))));
                        },
                        allowNegative: false,
                        allowDecimal: false,
                      })
                    }
                    className="rounded-md bg-white/10 border border-white/10 px-2 py-0.5 text-[11px]"
                  >
                    Enter
                  </button>
                </div>
                <TouchSlider
                  min="1"
                  max="20"
                  step="1"
                  value={stepSize}
                  onChange={(e) => setStepSize(Number(e.target.value))}
                />
              </div>
            </>
          ) : (
            <EmbeddedNumericKeypad
              title={keypadState.title}
              value={keypadState.value}
              onChange={(v) => setKeypadState((s) => ({ ...s, value: v }))}
              onCancel={() => setKeypadState((s) => ({ ...s, open: false }))}
              onConfirm={() => {
                keypadState.apply(keypadState.value);
                setKeypadState((s) => ({ ...s, open: false }));
              }}
              allowNegative={keypadState.allowNegative}
              allowDecimal={keypadState.allowDecimal}
            />
          )}
        </HudCard>

        <div className="col-span-5 flex flex-col gap-1.5 min-h-0">
          <HudCard
            accent={gAccent.color}
            accentRgb={gAccent.rgb}
            className="p-2 flex flex-col items-center gap-2 flex-1 min-h-0"
          >
            <div className="text-[10px] tracking-[0.2em] uppercase text-slate-400 self-start pl-1 shrink-0">Right Ballscrew Offset</div>

            <button
              onClick={() => adjustOffset(offsetStep)}
              title={`+${offsetStep.toFixed(2)} mm`}
              className="w-20 h-10 rounded-[0.75rem] bg-white/10 border border-white/10 text-xl font-semibold hover:bg-white/15 shrink-0"
              style={{ color: gAccent.color }}
            >
              ↑
            </button>

            <div className="w-full flex-1 min-h-0 rounded-[0.85rem] border border-white/10 bg-black/20 p-2 flex items-center justify-center">
              <svg
                viewBox="0 0 480 220"
                preserveAspectRatio="xMidYMid meet"
                className="w-full h-full"
              >
                <line x1="50" y1={centerY} x2="430" y2={centerY} stroke="rgba(255,255,255,0.18)" strokeWidth="3" strokeDasharray="10 10" />
                <line x1={lineX1} y1={y1} x2={lineX2} y2={y2} stroke={gAccent.color} strokeWidth="10" strokeLinecap="round" />
                <circle cx={lineX1} cy={y1} r="12" fill={gAccent.color} />
                <circle cx={lineX2} cy={y2} r="12" fill={gAccent.color} />
                <text x="55" y="205" fill="rgba(255,255,255,0.85)" fontSize="16" fontWeight="600">Left reference</text>
                <text x="295" y="205" fill="rgba(255,255,255,0.85)" fontSize="16" fontWeight="600">Right adjusted</text>
              </svg>
            </div>

            <button
              onClick={() => adjustOffset(-offsetStep)}
              title={`-${offsetStep.toFixed(2)} mm`}
              className="w-20 h-10 rounded-[0.75rem] bg-white/10 border border-white/10 text-xl font-semibold hover:bg-white/15 shrink-0"
              style={{ color: gAccent.color }}
            >
              ↓
            </button>

            {/* Offset-step slider — controls how many mm each ↑/↓ tap advances
                Y_RIGHT by. Range 0.01–2 mm covers fine touch-off (0.01 mm)
                through coarse correction (2 mm) without operators needing to
                spam a button hundreds of times. Lives inside the same card as
                the ↑/↓ buttons so the step control is right next to the
                controls it affects. */}
            <div className="w-full max-w-[280px] shrink-0 px-1">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[11px] text-slate-400">
                  Step: {offsetStep.toFixed(2)} mm
                </div>
              </div>
              <TouchSlider
                min="0.01"
                max="2"
                step="0.01"
                value={offsetStep}
                onChange={(e) => setOffsetStep(Number(e.target.value))}
              />
            </div>
          </HudCard>

          <HudCard
            accent={gAccent.color}
            accentRgb={gAccent.rgb}
            className="p-2 flex flex-col shrink-0"
          >
            <div className="flex items-baseline justify-between mb-1 shrink-0 pl-1">
              <div className="text-[10px] tracking-[0.2em] uppercase text-slate-400">Adjustment</div>
              <div className="text-lg font-bold tracking-wide" style={{ color: gAccent.color }}>
                {offset >= 0 ? "+" : ""}
                {offset.toFixed(3)} mm
              </div>
            </div>
            <div className="text-slate-400 text-[10px] mb-1.5 shrink-0 leading-tight pl-1">Right-hand ballscrew correction</div>

            <div className="grid gap-1.5 shrink-0">
              <button
                onClick={saveGantry}
                disabled={savingGantry}
                className="hud-accent-btn h-9 px-4 text-xs font-semibold tracking-[0.15em] uppercase inline-flex items-center justify-center gap-2 border"
                style={{
                  background: `linear-gradient(135deg, rgba(96,165,250,0.85), rgba(96,165,250,0.6))`,
                  borderColor: "rgba(96,165,250,0.5)",
                  boxShadow: "0 0 0 1px rgba(96,165,250,0.3), 0 0 16px rgba(96,165,250,0.25)",
                  color: "#f0f9ff",
                }}
              >
                {savingGantry && <Loading size="xs" />}
                {savingGantry ? "Saving..." : "Save to Teensy"}
              </button>
              <button onClick={restoreGantry} className="rounded-[0.85rem] h-8 bg-white/5 border border-white/10 px-4 text-xs font-semibold">
                Restore Previous
              </button>
            </div>
          </HudCard>
        </div>
      </div>

      {/* Park-to-loading overlay shown after Save to Teensy. Reuses the same
          ionetic spinner + live axis ticker pattern as homing /
          loading-position / post-run-park overlays. */}
      <LoadingOverlay
        visible={movingToLoad}
        title="Moving to loading position"
        subtext="Raising Z and travelling to the stored loading position"
      >
        <HomingAxisTicker />
      </LoadingOverlay>
    </ScreenShell>
  );
}

function SetupMenuScreen({ setScreen, onHome, onBack }) {
  const machine = useMachine();
  // Single source of truth: the reducer flips this on homing:start /
  // homing:done. See LostScreen for the rationale.
  const homing = machine.state.homing;

  const startHome = async () => {
    if (homing) return;
    await machine.home();
  };

  const accent = accentFor("setup");
  const cards = [
    {
      label: "Loading Position",
      screen: "loadingPosition",
      description: "Set unload position for finished packs",
      icon: (
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 16l8-8 8 8" /><path d="M4 20h16" />
        </svg>
      ),
    },
    {
      label: "X Axis Tramming",
      screen: "xAxisTramming",
      description: "Tram the X axis square to the gantry",
      icon: (
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="4" y="4" width="16" height="16" /><line x1="4" y1="4" x2="20" y2="20" />
        </svg>
      ),
    },
    {
      label: "Homing",
      screen: "homing",
      description: "Home all machine axes",
      icon: (
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
        </svg>
      ),
    },
  ];

  return (
    <ScreenShell mode="setup" onHome={onHome} onBack={onBack}>
      <div className="grid grid-cols-3 gap-3 h-full">
        {cards.map((card) => (
          <button
            key={card.label}
            onClick={() => (card.screen === "homing" ? startHome() : setScreen(card.screen))}
            className="hud-tile border flex flex-col items-center justify-center text-center p-5 relative"
            style={{
              background: `linear-gradient(135deg, rgba(${accent.rgb},0.07) 0%, rgba(${accent.rgb},0.025) 50%, rgba(15,23,42,0.5) 100%)`,
              borderColor: `rgba(${accent.rgb},0.22)`,
              boxShadow: `inset 0 0 18px rgba(${accent.rgb},0.05)`,
            }}
          >
            <span
              className="absolute left-0 top-4 bottom-4 w-[2px] rounded-r"
              style={{ background: accent.color, opacity: 0.7, boxShadow: `0 0 6px ${accent.color}55` }}
            />
            <div
              className="rounded-xl border grid place-items-center w-14 h-14 mb-3"
              style={{
                background: `rgba(${accent.rgb},0.08)`,
                borderColor: `rgba(${accent.rgb},0.28)`,
                color: accent.color,
              }}
            >
              {card.icon}
            </div>
            <div className="text-lg font-semibold tracking-wide">{card.label}</div>
            <div className="text-slate-400 mt-2 max-w-[200px] text-xs">{card.description}</div>
            {card.screen === "homing" && machine.state.homed && (
              <div className="mt-3 text-[11px] tracking-[0.25em] text-green-300/80 uppercase">Homed ✓</div>
            )}
          </button>
        ))}
      </div>

      <LoadingOverlay
        visible={homing}
        title="Homing axes"
        subtext="Seeking home switches on X and Y. Keep the workspace clear."
      >
        <HomingAxisTicker />
      </LoadingOverlay>
    </ScreenShell>
  );
}

/* ------------------------------- DIAGNOSTICS ------------------------------ */

function DiagnosticsScreen({ diagnostics, onHome, onBack }) {
  const machine = useMachine();
  const teensyLabel = machine.state.connected ? machine.state.health.teensy : "Disconnected";
  const driversLabel = machine.state.health.drivers || diagnostics.drivers;
  const airLabel = machine.state.health.air || diagnostics.air;
  const machineHours = machine.state.runtime?.machineHours ?? diagnostics.machineRuntimeHours;
  const sessionHours = machine.state.runtime?.sessionHours ?? diagnostics.sessionRuntimeHours;

  const accent = accentFor("diagnostics");
  const StatusDot = ({ ok }) => (
    <span
      className="inline-block w-2 h-2 rounded-full"
      style={{
        background: ok ? "#4ade80" : "#f87171",
        boxShadow: `0 0 6px ${ok ? "#4ade80" : "#f87171"}aa`,
      }}
    />
  );
  const teensyOk = teensyLabel !== "Disconnected";
  const driversOk = !driversLabel?.toLowerCase?.().includes("fault");
  const airOk = (airLabel || "").toLowerCase() === "ok";

  // Offline-demo dev helpers — let the operator fire synthetic FAULT and
  // ESTOP_CLEARED events to walk through the lockout overlay without having
  // to wait for the firmware to misbehave. Quietly hidden once a real backend
  // is connected (it's a QA affordance, not an operator control).
  const simulate = (type, payload = {}) => {
    machine.dispatch({ type, ...payload });
  };
  const showSim = !machine.state.connected;

  return (
    <ScreenShell mode="diagnostics" onHome={onHome} onBack={onBack}>
      <div className="grid grid-cols-2 gap-3 h-full">
        <HudCard accent={accent.color} accentRgb={accent.rgb} className="p-3">
          <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1">Machine Health</div>
          <div className="h-px bg-white/5 mb-3" />
          <div className="space-y-2.5 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Teensy</span>
              <span className="inline-flex items-center gap-2"><StatusDot ok={teensyOk} />{teensyLabel}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Drivers</span>
              <span className="inline-flex items-center gap-2"><StatusDot ok={driversOk} />{driversLabel}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Air</span>
              <span className="inline-flex items-center gap-2"><StatusDot ok={airOk} />{airLabel}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Last Service</span>
              <span className="text-slate-200">{diagnostics.lastService}</span>
            </div>
          </div>
        </HudCard>

        <HudCard accent={accent.color} accentRgb={accent.rgb} className="p-3">
          <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-1">Runtime</div>
          <div className="h-px bg-white/5 mb-3" />
          <div className="grid grid-cols-2 gap-3">
            <div
              className="rounded-lg p-3 border"
              style={{
                background: `rgba(${accent.rgb},0.06)`,
                borderColor: `rgba(${accent.rgb},0.2)`,
              }}
            >
              <div className="text-[10px] tracking-[0.2em] uppercase text-slate-400">Machine Total</div>
              <div className="text-2xl font-bold mt-1" style={{ color: accent.color }}>
                {Number(machineHours).toFixed(2)}<span className="text-sm text-slate-400 ml-1">h</span>
              </div>
            </div>
            <div
              className="rounded-lg p-3 border"
              style={{
                background: `rgba(${accent.rgb},0.06)`,
                borderColor: `rgba(${accent.rgb},0.2)`,
              }}
            >
              <div className="text-[10px] tracking-[0.2em] uppercase text-slate-400">Session</div>
              <div className="text-2xl font-bold mt-1" style={{ color: accent.color }}>
                {Number(sessionHours).toFixed(2)}<span className="text-sm text-slate-400 ml-1">h</span>
              </div>
            </div>
          </div>
          <div className="mt-4 text-slate-400 text-xs leading-relaxed">
            Use this to schedule maintenance such as lubrication and gantry re-squaring.
          </div>
        </HudCard>

        {showSim && (
          <HudCard
            accent="#ef4444"
            accentRgb="239,68,68"
            className="p-3 col-span-2"
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs tracking-[0.2em] uppercase text-slate-400">QA · Simulate Events</div>
              <div className="text-[9px] tracking-[0.22em] uppercase text-amber-300/80">
                Visible only while backend is disconnected
              </div>
            </div>
            <div className="h-px bg-white/5 mb-3" />
            <div className="grid grid-cols-4 gap-2 text-[11px] font-semibold">
              {[
                "FAULT_LOW_AIR",
                "FAULT_Z_TIMEOUT_DOWN",
                "FAULT_Z_TIMEOUT_UP",
                "FAULT_DRIVER_X",
                "FAULT_DRIVER_YL",
                "FAULT_DRIVER_YR",
                "FAULT_ESTOP",
                "USER_ABORT",
              ].map((code) => (
                <button
                  key={code}
                  onClick={() =>
                    simulate("fault", {
                      code,
                      cellIndex: 14,
                      programName: "QA · 4x4 Module",
                    })
                  }
                  className="rounded-lg border border-red-500/25 bg-red-500/10 hover:bg-red-500/20 px-2 py-1.5 text-red-100 truncate"
                  title={code}
                >
                  {code.replace(/^FAULT_/, "").replace(/_/g, " ")}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-semibold">
              <button
                onClick={() => simulate("fault_cleared")}
                className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 hover:bg-emerald-500/20 px-3 py-1.5 text-emerald-100"
              >
                Send fault_cleared
              </button>
              <button
                onClick={() => simulate("estop_cleared")}
                className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 hover:bg-cyan-500/20 px-3 py-1.5 text-cyan-100"
              >
                Send ESTOP_CLEARED
              </button>
              <button
                onClick={() => simulate("estop")}
                className="rounded-lg border border-red-500/25 bg-red-500/10 hover:bg-red-500/20 px-3 py-1.5 text-red-100"
              >
                Trigger E-Stop
              </button>
              <button
                onClick={() =>
                  simulate("incomplete_state", {
                    record: {
                      programName: "QA · 4x4 Module",
                      programId: "qa-4x4",
                      mode: "Positive",
                      index: 14,
                      total: 28,
                      cause: "power_loss",
                      ts: Date.now(),
                    },
                  })
                }
                className="rounded-lg border border-amber-500/25 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-1.5 text-amber-100"
              >
                Seed Resume Prompt
              </button>
            </div>
          </HudCard>
        )}
      </div>
    </ScreenShell>
  );
}

/* --------------------------- SYSTEM INFO SCREEN -------------------------- */
// Hidden screen reached via the 5-tap easter egg on the Home logo. Shows
// GUI version + a few Pi vitals (CPU temp / usage, RAM, uptime) that the
// engineering team uses to sanity-check the pendant in the field. Polls
// /api/sysinfo every 2s — the endpoint is cheap (a couple of /proc/* reads
// and an os.hostname() call). On dev machines (mac/Windows) most fields
// come back null; the screen renders em-dashes for missing data.

function SystemInfoScreen({ onHome, onBack }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [tickedAt, setTickedAt] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await fetch('/api/sysinfo', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (cancelled) return;
        if (body?.ok) {
          setInfo(body.info || null);
          setError(null);
          setTickedAt(Date.now());
        } else {
          setError(body?.reply || 'sysinfo unavailable');
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || 'sysinfo fetch failed');
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const accent = accentFor("diagnostics");
  const fmt = (v, suffix = '') =>
    v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v).toFixed(suffix === '%' || suffix === '°C' ? 1 : 0)}${suffix}`;
  const fmtUptime = (sec) => {
    if (sec == null || !Number.isFinite(Number(sec))) return '—';
    const s = Math.max(0, Math.round(Number(sec)));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${ss}s`;
    return `${ss}s`;
  };
  const ramPct = info?.ramTotalMb && info?.ramUsedMb != null
    ? Math.max(0, Math.min(100, (info.ramUsedMb / info.ramTotalMb) * 100))
    : null;

  // Color the CPU temp tile by how toasty the Pi is. <60 cool, <70 warm,
  // <80 hot, >=80 throttling territory.
  const tempColor = (() => {
    const t = info?.cpuTempC;
    if (t == null) return accent.color;
    if (t < 60) return '#22c55e';
    if (t < 70) return '#facc15';
    if (t < 80) return '#fb923c';
    return '#ef4444';
  })();

  const Tile = ({ label, value, sub, color }) => (
    <div
      className="rounded-lg p-3 border flex flex-col"
      style={{
        background: `rgba(${accent.rgb},0.06)`,
        borderColor: `rgba(${accent.rgb},0.2)`,
      }}
    >
      <div className="text-[10px] tracking-[0.2em] uppercase text-slate-400">{label}</div>
      <div className="text-3xl font-bold mt-1 tabular-nums" style={{ color: color || accent.color }}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-slate-500 mt-1">{sub}</div>}
    </div>
  );

  return (
    <ScreenShell mode="diagnostics" onHome={onHome} onBack={onBack}>
      <div className="h-full flex flex-col gap-2">
        <HudCard accent={accent.color} accentRgb={accent.rgb} className="p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs tracking-[0.2em] uppercase text-slate-400">System Info</div>
              <div className="text-[10px] text-slate-500 mt-0.5">
                Hidden engineering panel — Pi vitals, polled every 2s
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] tracking-[0.22em] uppercase text-slate-400">GUI Version</div>
              <div className="text-lg font-semibold tabular-nums" style={{ color: accent.color }}>
                v{info?.guiVersion || '—'}
              </div>
            </div>
          </div>
        </HudCard>

        <div className="grid grid-cols-2 gap-2">
          <Tile
            label="CPU Temp"
            value={info?.cpuTempC != null ? `${info.cpuTempC.toFixed(1)}°C` : '—'}
            sub={info?.cpuTempC == null ? 'unavailable on this host' : info.cpuTempC < 70 ? 'within nominal range' : info.cpuTempC < 80 ? 'running warm' : 'throttling risk'}
            color={tempColor}
          />
          <Tile
            label="CPU Usage"
            value={fmt(info?.cpuPct, '%')}
            sub="aggregate, sampled over 120ms"
          />
          <Tile
            label="RAM Used"
            value={info?.ramUsedMb != null ? `${info.ramUsedMb} MB` : '—'}
            sub={info?.ramTotalMb ? `of ${info.ramTotalMb} MB total${ramPct != null ? `  ·  ${ramPct.toFixed(0)}%` : ''}` : null}
          />
          <Tile
            label="Uptime"
            value={fmtUptime(info?.uptimeSec)}
            sub={info?.hostname ? `host: ${info.hostname}` : null}
          />
        </div>

        <HudCard accent={accent.color} accentRgb={accent.rgb} className="p-3">
          <div className="text-xs tracking-[0.2em] uppercase text-slate-400 mb-2">Environment</div>
          <div className="h-px bg-white/5 mb-3" />
          <div className="grid grid-cols-2 gap-y-1.5 text-sm">
            <span className="text-slate-400">Platform</span>
            <span className="text-slate-200 text-right tabular-nums">{info?.platform || '—'}</span>
            <span className="text-slate-400">Node</span>
            <span className="text-slate-200 text-right tabular-nums">{info?.nodeVersion || '—'}</span>
            <span className="text-slate-400">Serial mode</span>
            <span className="text-slate-200 text-right tabular-nums">{info?.serialMode || '—'}</span>
            <span className="text-slate-400">Last update</span>
            <span className="text-slate-200 text-right tabular-nums">
              {tickedAt ? new Date(tickedAt).toLocaleTimeString() : '—'}
            </span>
          </div>
          {error && (
            <div className="mt-3 text-[11px] text-amber-300/80">
              {error}
            </div>
          )}
        </HudCard>
      </div>
    </ScreenShell>
  );
}

/* ---------------------------------- APP ---------------------------------- */

export default function App() {
  return (
    <MachineProvider>
      <AppInner />
    </MachineProvider>
  );
}

function AppInner() {
  const [screen, setScreen] = useState("home");
  const [history, setHistory] = useState(["home"]);

  // Bench-mode homing bypass. When bench mode is on, the LostScreen renders a
  // "Continue anyway" button that flips this flag — every gated screen then
  // skips the not-homed wall and renders normally. Cleared automatically once
  // the firmware confirms a real home, and on E-stop (where we lose home
  // status legitimately). Not persisted across power cycles by design — the
  // operator should consciously re-acknowledge the bypass each boot.
  const [homingBypassed, setHomingBypassed] = useState(false);

  const [programs, setPrograms] = useState(initialPrograms);
  // Programs are persisted to ~/.gillis/programs.json by the backend.
  //   - Hydrate once on mount via PROGRAMS_LOAD (fall back to initialPrograms
  //     if the file is missing / empty / the backend hasn't answered yet).
  //   - On every subsequent change, debounce-save via PROGRAMS_SAVE so we
  //     don't thrash the disk while the operator is typing.
  // `programsHydrated` guards the save effect so the first post-mount render
  // doesn't overwrite the saved list with our in-memory defaults.
  const [programsHydrated, setProgramsHydrated] = useState(false);
  // Settings (envelope / motion / loading position / air threshold) hydrate
  // from ~/.gillis/settings.json on first connect. Pi-side persistence is the
  // reliable path here because the firmware's EEPROM round-trip for
  // SET_TRAVEL / SET_AIR_THRESHOLD doesn't always echo back, so without this
  // the UI re-initialised to compile-time defaults every boot and operators
  // saw their saved envelope/air values vanish across power cycles.
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [motionSettings, setMotionSettings] = useState(initialMotionSettings);
  const [travelLimits, setTravelLimits] = useState(initialTravelLimits);
  const [loadingPosition, setLoadingPosition] = useState({
    x: DEFAULT_START_X,
    y: DEFAULT_START_Y,
    z: DEFAULT_START_Z,
  });
  const [diagnostics] = useState(initialDiagnostics);
  const [activeRun, setActiveRun] = useState(null);

  // Boot splash:
  //   - min display time of 900ms (brand beat)
  //   - if the backend answers before that, boot as soon as min is done
  //   - if it doesn't, boot anyway after 3500ms so the UI is usable offline
  // Once booted, a persistent banner is shown if we never connected, so the
  // operator knows they're driving a disconnected shell.
  const machine = useMachine();
  const [booted, setBooted] = useState(false);
  const [minSplashDone, setMinSplashDone] = useState(false);
  const [splashTimedOut, setSplashTimedOut] = useState(false);
  const [everConnected, setEverConnected] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setMinSplashDone(true), 900);
    const t2 = setTimeout(() => setSplashTimedOut(true), 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);
  useEffect(() => {
    if (machine.state.connected) setEverConnected(true);
  }, [machine.state.connected]);
  useEffect(() => {
    if (minSplashDone && (machine.state.connected || splashTimedOut)) setBooted(true);
  }, [minSplashDone, splashTimedOut, machine.state.connected]);

  // Clear the bench-mode bypass once we have a real home, or when the machine
  // legitimately re-loses home (E-stop). Both transitions re-arm the gate so
  // a careless second-shift operator can't carry someone else's bypass
  // forwards into a "real" run.
  useEffect(() => {
    if (machine.state.homed) setHomingBypassed(false);
  }, [machine.state.homed]);
  useEffect(() => {
    if (machine.state.estop?.active) setHomingBypassed(false);
  }, [machine.state.estop?.active]);

  // (Previous revisions had useEffect blocks here that mirrored
  // machine.state.travelLimits / motionSettings / loadingPosition into
  // the AppInner-local copies on every firmware SNAPSHOT. They've been
  // removed: the firmware doesn't reliably round-trip these values, so
  // each SNAPSHOT was overwriting the Pi-hydrated copy with the firmware's
  // stale default and the operator saw "envelope/air didn't save" even
  // when the underlying writes had succeeded. The reducer's 'snapshot'
  // case now explicitly drops these fields and the Pi hydrate effect
  // below is the only path that updates them.

  // ---- Drivers auto-enable on connect ----------------------------------
  // The machine should be "alive" the moment the Pi boots so any button that
  // drives motion (homing, loading-position, test motion, run) just works.
  // The operator can still manually disable via Test Motion → Driver toggle
  // if they need to push the gantry by hand.
  // Fires exactly once per connection: guarded by a ref so we don't re-ENABLE
  // after the operator has intentionally disabled from Test Motion.
  const driversBootedRef = useRef(false);
  useEffect(() => {
    if (!machine.state.connected) {
      // Reset on disconnect so we'll re-enable on the next fresh connect.
      driversBootedRef.current = false;
      return;
    }
    if (driversBootedRef.current) return;
    driversBootedRef.current = true;
    // Only send ENABLE if firmware reports drivers OFF. If they're already on
    // (e.g. firmware boots with them enabled), leave them alone.
    if (!machine.state.driversEnabled) {
      machine.enableDrivers().catch(() => {
        // Non-fatal — operator can still toggle from Test Motion.
      });
    }
  }, [machine.state.connected, machine.state.driversEnabled, machine.enableDrivers]);

  // ---- Program persistence ---------------------------------------------
  // Hydrate from ~/.gillis/programs.json once the WebSocket is open.
  // Falls back gracefully to the built-in initialPrograms if the file is
  // empty or the backend doesn't answer.
  useEffect(() => {
    if (programsHydrated) return;
    if (!machine.state.connected) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await machine.loadPrograms();
        if (cancelled) return;
        if (res?.ok && Array.isArray(res.programs) && res.programs.length) {
          setPrograms(res.programs);
        }
      } catch {
        // Keep the defaults; the save effect will flush them to disk below.
      } finally {
        if (!cancelled) setProgramsHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [machine.state.connected, programsHydrated, machine.loadPrograms]);

  // Debounced save — wait 800ms after the last edit before hitting the disk.
  useEffect(() => {
    if (!programsHydrated) return;
    const t = setTimeout(() => {
      machine.savePrograms(programs).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [programs, programsHydrated, machine.savePrograms]);

  // ---- Settings persistence (Pi-side) ---------------------------------
  // Hydrate envelope / motion / loading position / air threshold from
  // ~/.gillis/settings.json on first connect. Mirrors the programs hydrate
  // pattern. If the file doesn't exist yet (fresh Pi) we keep the compile-
  // time defaults; the operator's next Save will create the file.
  useEffect(() => {
    if (settingsHydrated) return;
    if (!machine.state.connected) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await machine.loadSettings();
        if (cancelled) return;
        const s = res?.ok ? res.settings : null;
        if (s && typeof s === 'object') {
          // Update AppInner-local copies for the SettingsScreen / loading-
          // position screen to read from. Each is a one-level merge so a
          // partial Pi-side file (legacy, missing fields, etc.) doesn't
          // erase fields we still have defaults for.
          const tl = (s.travelLimits && typeof s.travelLimits === 'object')
            ? { ...initialTravelLimits, ...s.travelLimits } : null;
          const ms = (s.motionSettings && typeof s.motionSettings === 'object')
            ? { ...initialMotionSettings, ...s.motionSettings } : null;
          const lp = (s.loadingPosition && typeof s.loadingPosition === 'object')
            ? s.loadingPosition : null;
          const at = Number.isFinite(Number(s.airThresholdBar))
            ? Number(s.airThresholdBar) : null;
          if (tl) setTravelLimits(tl);
          if (ms) setMotionSettings(ms);
          if (lp) setLoadingPosition((prev) => ({ ...prev, ...lp }));
          // Push the same values into machine.state via 'settings_hydrate'
          // (NOT 'snapshot' — the snapshot reducer now drops these fields
          // so it can't fight us when the next firmware SNAPSHOT arrives).
          // This keeps machine.state.airThresholdBar / travelLimits /
          // motionSettings / loadingPosition aligned with the Pi-hydrated
          // values, so anything reading from machine.state (e.g. the
          // SettingsScreen airThresholdDraft mirror) sees the right thing.
          const patch = {};
          if (tl) patch.travelLimits = tl;
          if (ms) patch.motionSettings = ms;
          if (lp) patch.loadingPosition = { ...machine.state.loadingPosition, ...lp };
          if (at !== null) patch.airThresholdBar = at;
          if (Object.keys(patch).length) {
            machine.dispatch({ type: 'settings_hydrate', state: patch });
          }
        }
      } catch {
        // Keep the defaults; first Save will create the file.
      } finally {
        if (!cancelled) setSettingsHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [machine.state.connected, settingsHydrated, machine.loadSettings, machine.dispatch]);

  const navigate = (next) => {
    setScreen(next);
    setHistory((prev) => [...prev, next]);
  };

  const goHome = () => {
    setScreen("home");
    setHistory((prev) => [...prev, "home"]);
  };

  const goBack = () => {
    setHistory((prev) => {
      if (prev.length <= 1) return prev;
      const nextHistory = prev.slice(0, -1);
      setScreen(nextHistory[nextHistory.length - 1]);
      return nextHistory;
    });
  };

  const addProgram = (program) => {
    setPrograms((prev) => [...prev, program]);
  };

  return (
    <div className="w-screen h-screen bg-black text-white font-sans overflow-hidden">
      <HudStyles />
      <div className="h-full flex flex-col">
        <div className="flex-1 min-h-0">
          {screen === "home" && (
            <HomeScreen
              setScreen={navigate}
              onHome={goHome}
              onBack={goBack}
            />
          )}

          {screen === "production" && (
            (machine.state.homed || homingBypassed) ? (
              <ProductionScreen
                setScreen={navigate}
                programs={programs}
                onHome={goHome}
                onBack={goBack}
                setActiveRun={setActiveRun}
              />
            ) : (
              <LostScreen
                mode="production"
                onHome={goHome}
                onBack={goBack}
                onGoHoming={() => navigate("setup")}
                onContinueAnyway={machine.state.benchMode ? () => setHomingBypassed(true) : null}
              />
            )
          )}

          {screen === "programs" && (
            (machine.state.homed || homingBypassed) ? (
              <ProgramsScreen
                programs={programs}
                setPrograms={setPrograms}
                addProgram={addProgram}
                setScreen={navigate}
                onHome={goHome}
                onBack={goBack}
                setActiveRun={setActiveRun}
              />
            ) : (
              <LostScreen
                mode="programs"
                onHome={goHome}
                onBack={goBack}
                onGoHoming={() => navigate("setup")}
                onContinueAnyway={machine.state.benchMode ? () => setHomingBypassed(true) : null}
              />
            )
          )}

          {screen === "createProgram" && (
            <CreateProgramScreen
              onHome={goHome}
              onBack={goBack}
              addProgram={addProgram}
            />
          )}

          {screen === "run" && (
            <RunScreen
              onHome={goHome}
              onBack={goBack}
              activeRun={activeRun}
              setActiveRun={setActiveRun}
              loadingPosition={loadingPosition}
              motionSettings={motionSettings}
            />
          )}

          {screen === "settings" && (
            <SettingsScreen
              motionSettings={motionSettings}
              setMotionSettings={setMotionSettings}
              travelLimits={travelLimits}
              setTravelLimits={setTravelLimits}
              setScreen={navigate}
              onHome={goHome}
              onBack={goBack}
            />
          )}

          {screen === "testMotion" && (
            <TestMotionScreen
              onHome={goHome}
              onBack={goBack}
            />
          )}

          {screen === "setup" && (
            <SetupMenuScreen
              setScreen={navigate}
              onHome={goHome}
              onBack={goBack}
            />
          )}

          {screen === "loadingPosition" && (
            (machine.state.homed || homingBypassed) ? (
              <LoadingPositionScreen
                loadingPosition={loadingPosition}
                setLoadingPosition={setLoadingPosition}
                onHome={goHome}
                onBack={goBack}
              />
            ) : (
              <LostScreen
                mode="setup"
                onHome={goHome}
                onBack={goBack}
                onGoHoming={() => navigate("setup")}
                onContinueAnyway={machine.state.benchMode ? () => setHomingBypassed(true) : null}
              />
            )
          )}

          {screen === "xAxisTramming" && (
            (machine.state.homed || homingBypassed) ? (
              <XAxisTrammingScreen
                onHome={goHome}
                onBack={goBack}
              />
            ) : (
              <LostScreen
                mode="setup"
                onHome={goHome}
                onBack={goBack}
                onGoHoming={() => navigate("setup")}
                onContinueAnyway={machine.state.benchMode ? () => setHomingBypassed(true) : null}
              />
            )
          )}

          {screen === "diagnostics" && (
            <DiagnosticsScreen
              diagnostics={diagnostics}
              onHome={goHome}
              onBack={goBack}
            />
          )}

          {screen === "systemInfo" && (
            <SystemInfoScreen
              onHome={goHome}
              onBack={goBack}
            />
          )}
        </div>

        {/* Dev navigation shortcuts — visible only on desktop monitors >=1536px
            so they never appear on the Pi Screen 2 (1280x720) which used to
            trip the xl: breakpoint (1280px) and overlay these tabs on top of
            the production status bar. Bumped to 2xl: 2026-05-18. */}
        <div className="absolute top-2 left-2 z-50 hidden 2xl:flex gap-2 opacity-70">
          <button onClick={() => navigate("home")} className="px-3 py-1 rounded-lg bg-black/40 border border-white/10 text-xs">Home</button>
          <button onClick={() => navigate("production")} className="px-3 py-1 rounded-lg bg-black/40 border border-white/10 text-xs">Production</button>
          <button onClick={() => navigate("programs")} className="px-3 py-1 rounded-lg bg-black/40 border border-white/10 text-xs">Programs</button>
          <button onClick={() => navigate("run")} className="px-3 py-1 rounded-lg bg-black/40 border border-white/10 text-xs">Run</button>
          <button onClick={() => navigate("settings")} className="px-3 py-1 rounded-lg bg-black/40 border border-white/10 text-xs">Settings</button>
          <button onClick={() => navigate("setup")} className="px-3 py-1 rounded-lg bg-black/40 border border-white/10 text-xs">Setup</button>
          <button onClick={() => navigate("diagnostics")} className="px-3 py-1 rounded-lg bg-black/40 border border-white/10 text-xs">Diagnostics</button>
        </div>
      </div>

      {/* Boot splash — shown until backend snapshot arrives + min 900ms,
          or the fallback timeout expires for offline demo mode */}
      {!booted && <BootSplash />}

      {/* Ready-to-home prompt — shown once right after the boot splash clears.
          If the Teensy's EEPROM has `homeOnBoot = 1` the prompt auto-resolves
          and fires HOME. Otherwise the operator chooses — this is the safety
          net that stops a brand-new, un-commissioned machine from slamming
          into an axis before limit switches are verified. */}
      {booted && <BootHomePrompt />}

      {/* Fault lockout overlay — full takeover when the firmware reports a
          FAULT. Walks the operator through clear → (home if needed) → resume. */}
      {booted && (
        <FaultLockoutOverlay
          activeRun={activeRun}
          setActiveRun={setActiveRun}
          navigate={navigate}
        />
      )}

      {/* Run abort reason overlay — softer modal shown when the orchestrator
          aborts a run for a non-firmware reason (BUSY race, send timeout,
          script throw, etc). FaultLockoutOverlay takes priority if a firmware
          fault is also active. */}
      {booted && <RunAbortReasonOverlay />}

      {/* E-stop cleared popup — nudge to home once the NC loop is closed. */}
      {booted && <EStopClearedPopup navigate={navigate} />}

      {/* Incomplete-state resume prompt — shown when the backend reports a
          state file on disk from a prior interrupted run (§3.2). */}
      {booted && (
        <IncompleteStatePrompt
          setActiveRun={setActiveRun}
          navigate={navigate}
        />
      )}

      {/* Reconnect overlay — only after we had connected once and lost it */}
      <LoadingOverlay
        visible={booted && everConnected && !machine.state.connected}
        title="Reconnecting to machine"
        subtext="Lost the link to the Teensy controller. Retrying..."
      />

      {/* Offline state is surfaced as an inline OFFLINE pill in TopStatusBar
          so it no longer covers the working area. */}
    </div>
  );
}

/* -------------------------------- BOOT SPLASH --------------------------- */

function BootSplash() {
  const machine = useMachine();
  const s = machine.state;

  // If we've been showing the splash for ~1.3s and still haven't heard from
  // the backend, flip to an offline hint so the user knows we're about to
  // enter demo mode (the parent auto-dismisses the splash at 3.5s total).
  const [offlineHint, setOfflineHint] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOfflineHint(true), 1300);
    return () => clearTimeout(t);
  }, []);
  const offline = offlineHint && !s.connected;

  // Build checklist lines. Values tagged "pending" start blank and fill in
  // as the real snapshot arrives, giving the feel of a system probing itself.
  const lines = useMemo(() => {
    const connected = s.connected;
    return [
      { key: "boot",    label: "BOOT",          value: "GILLIS WELD-BOT V2",                                                       ok: true },
      { key: "link",    label: "TEENSY LINK",   value: connected ? "OK" : (offline ? "OFFLINE — UI DEMO MODE" : "..."),             ok: connected, warn: !connected && offline },
      { key: "drivers", label: "DRIVERS",       value: (s.health?.drivers || (offline ? "—" : "...")).toUpperCase(),                ok: !!s.health?.drivers && s.health.drivers.toLowerCase().includes("healthy") },
      { key: "air",     label: "AIR PRESSURE",  value: s.airPressureBar ? `${s.airPressureBar.toFixed(2)} bar` : (offline ? "—" : "..."), ok: Number.isFinite(Number(s.airThresholdBar)) ? Number(s.airPressureBar) >= Number(s.airThresholdBar) : s.airPressureBar >= 5.5 },
      { key: "motion",  label: "MOTION PARAMS", value: s.motionSettings?.xSpeed ? `${s.motionSettings.xSpeed} mm/s · ${s.motionSettings.xAccel} mm/s²` : (offline ? "—" : "..."), ok: !!s.motionSettings?.xSpeed },
      { key: "runtime", label: "MACHINE HOURS", value: typeof s.runtime?.machineHours === "number" ? `${s.runtime.machineHours.toFixed(2)} h` : (offline ? "—" : "..."), ok: typeof s.runtime?.machineHours === "number" },
      { key: "homed",   label: "HOMED",         value: s.homed ? "YES" : "NO — HOME BEFORE USE",                                    ok: s.homed, warn: !s.homed && s.connected },
    ];
  }, [s, offline]);

  // Stagger reveal of each line
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    const timers = lines.map((_, i) =>
      setTimeout(() => setRevealed((n) => Math.max(n, i + 1)), 160 + i * 110)
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-[9998] flex flex-col items-center justify-center bg-black overflow-hidden">
      <style>{`
        @keyframes splash-fade-in {
          0% { opacity: 0; transform: translateY(4px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .splash-in { animation: splash-fade-in 600ms ease-out both; }
        @keyframes splash-sweep {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .splash-sweep { animation: splash-sweep 2.4s ease-in-out infinite; }
        @keyframes boot-flicker {
          0%, 100% { opacity: 1; }
          42%      { opacity: 1; }
          45%      { opacity: 0.35; }
          48%      { opacity: 1; }
          60%      { opacity: 0.7; }
          62%      { opacity: 1; }
        }
        .boot-flicker { animation: boot-flicker 2.6s ease-in-out; }
        @keyframes boot-line-in {
          0%   { opacity: 0; transform: translateX(-6px); }
          100% { opacity: 1; transform: translateX(0); }
        }
        .boot-line-in { animation: boot-line-in 240ms ease-out both; }
      `}</style>

      {/* Ambient backdrop wash + subtle electron field */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at 50% 40%, rgba(59,130,246,0.18) 0%, rgba(2,6,23,0) 55%)",
        }}
      />
      <div className="absolute inset-0 opacity-40 pointer-events-none">
        <ElectronField density={28} />
      </div>

      <div className="splash-in relative flex flex-col items-center">
        <img
          src="/brand/ionetic-logo.png"
          alt="Ionetic"
          className="w-[320px] max-w-[70vw] object-contain drop-shadow-[0_0_18px_rgba(148,163,184,0.25)] boot-flicker"
          draggable={false}
        />

        {/* Thin scanning bar under the logo */}
        <div className="mt-6 w-[260px] h-[2px] bg-white/5 overflow-hidden rounded-full">
          <div
            className="h-full splash-sweep"
            style={{
              width: "40%",
              background:
                "linear-gradient(to right, rgba(59,130,246,0) 0%, rgba(96,165,250,0.9) 50%, rgba(59,130,246,0) 100%)",
            }}
          />
        </div>

        <div className="mt-5 text-slate-400 text-[11px] tracking-[0.4em] uppercase">
          Gillis Weld-bot V2 · Initializing
        </div>

        {/* Streaming checklist */}
        <div className="mt-6 w-[min(460px,85vw)] font-mono text-[11px] leading-relaxed text-slate-300 px-4 py-3 rounded-lg border border-white/10 bg-slate-950/60 backdrop-blur">
          {lines.slice(0, revealed).map((line) => (
            <div key={line.key} className="boot-line-in flex items-center gap-3">
              <span
                className={
                  line.ok
                    ? "text-green-400"
                    : line.warn
                      ? "text-amber-300"
                      : "text-slate-500"
                }
              >
                {line.ok ? "✓" : line.warn ? "!" : "…"}
              </span>
              <span className="text-slate-400 w-[120px] shrink-0 tracking-[0.15em]">{line.label}</span>
              <span className="text-slate-200">{line.value}</span>
            </div>
          ))}
          {revealed < lines.length && (
            <div className="flex items-center gap-3 mt-1 text-slate-500">
              <span>…</span>
              <span className="w-[120px] shrink-0">SCANNING</span>
              <span>
                <RingSpinner size={10} stroke={3} speed={1.2} />
              </span>
            </div>
          )}
        </div>

        {offline && (
          <div className="mt-4 text-amber-300/90 text-[10px] tracking-[0.25em] uppercase boot-line-in">
            Backend not responding · Entering offline demo mode
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------- RUN ABORT REASON OVERLAY ------------------------ */
// Modal shown when the orchestrator aborts a run for a reason that ISN'T a
// firmware fault — e.g. "move cell 1 failed: BUSY" (Z race), "z-down cell 0
// failed: ERROR timeout" (serial stall), "scp failed", "loop threw: ...".
// Without this, the only visible symptom was the run pill flipping to
// "aborted" silently while the reason sat in /tmp/gillis-server.log.
//
// Suppressed if a firmware fault is also active (FaultLockoutOverlay takes
// priority — it walks the operator through clear/home/resume) and if the
// abort was a deliberate user abort (the orchestrator filters "user abort"
// to null in useMachine.jsx so we never see it here).
function RunAbortReasonOverlay() {
  const machine = useMachine();
  const { run, fault } = machine.state;
  if (fault.active) return null;
  if (run.phase !== 'aborted' || !run.reason) return null;

  const accent = "#f59e0b";        // amber — recoverable, distinct from red fault
  const accentRgb = "245,158,11";
  const dismiss = () => machine.dispatch({ type: 'run_reason_dismiss' });

  return (
    <div className="fixed inset-0 z-[9890] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <HudCard
        accent={accent}
        accentRgb={accentRgb}
        className="p-6 w-[min(560px,92vw)]"
      >
        <div className="flex items-center gap-3 mb-3">
          <div
            className="w-3 h-3 rounded-full"
            style={{ background: accent, boxShadow: `0 0 14px ${accent}` }}
          />
          <div className="flex-1">
            <div className="text-[10px] tracking-[0.32em] uppercase text-slate-300">
              Run Stopped
            </div>
            <div className="text-xl font-bold leading-tight" style={{ color: accent }}>
              Aborted Before Completion
            </div>
          </div>
        </div>

        <div className="text-sm text-slate-200 mb-4 leading-relaxed">
          The run ended early. The operator was not notified by a firmware
          fault — the orchestrator caught an unexpected reply or timeout.
        </div>

        <div className="rounded-lg border border-amber-400/30 bg-amber-500/5 p-3 mb-4">
          <div className="text-[9px] tracking-[0.24em] uppercase text-amber-200/80 mb-1">
            Reason
          </div>
          <div className="font-mono text-[12px] text-amber-100 break-words">
            {run.reason}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-[11px] text-slate-300 mb-5">
          <div className="rounded-lg border border-white/10 bg-white/5 p-2">
            <div className="text-[9px] tracking-[0.24em] uppercase text-slate-400">Program</div>
            <div className="font-semibold truncate">{run.programName || "—"}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-2">
            <div className="text-[9px] tracking-[0.24em] uppercase text-slate-400">Stopped At Cell</div>
            <div className="font-semibold">
              {typeof run.cellIndex === 'number'
                ? `${run.cellIndex + 1}${run.total ? ` / ${run.total}` : ''}`
                : '—'}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end">
          <button
            onClick={dismiss}
            className="h-11 px-5 text-xs font-bold tracking-[0.18em] uppercase rounded-lg border"
            style={{
              background: `linear-gradient(135deg, rgba(${accentRgb},0.85), rgba(${accentRgb},0.55))`,
              borderColor: `rgba(${accentRgb},0.5)`,
              boxShadow: `0 0 18px rgba(${accentRgb},0.35)`,
              color: "#fff",
            }}
          >
            Dismiss
          </button>
        </div>
      </HudCard>
    </div>
  );
}

/* --------------------------- FAULT LOCKOUT OVERLAY ----------------------- */
// Full-screen takeover shown whenever the reducer has an active fault. Walks
// the operator through §3.2 of the master plan:
//   1. Lockout: show fault + Clear Fault button (enabled once cleared)
//   2. Home prompt (driver faults / E-stop only): "Home now?"
//   3. Resume prompt: Re-run cell N / Continue from N+1 / Start from beginning
//
// The overlay closes by dispatching a synthetic `fault_dismiss` event and,
// for resume actions, calling machine.runProgram with a resumeIndex.

function FaultLockoutOverlay({ activeRun, setActiveRun, navigate }) {
  const machine = useMachine();
  const { fault } = machine.state;
  const [stage, setStage] = useState("lockout"); // lockout | home | resume
  // Read the homing-in-progress flag from the reducer (single source of
  // truth — see #67). Local useState here would race with the WS event
  // stream the same way the boot/setup screens used to.
  const homing = machine.state.homing;

  // Reset to the first stage whenever a new fault fires.
  useEffect(() => {
    if (fault.active) setStage("lockout");
  }, [fault.active, fault.code]);

  // Advance to the resume picker when the homing cycle completes (or fails)
  // after the operator clicked Home from this overlay.
  useEffect(() => {
    if (stage !== "home") return;
    const off = machine.subscribe((evt) => {
      if (evt?.type !== 'homing') return;
      if (evt.phase === 'done' || evt.phase === 'fault' || evt.phase === 'aborted') {
        setStage("resume");
      }
    });
    return off;
  }, [stage, machine.subscribe]);

  if (!fault.active) return null;

  const meta = FAULT_DESCRIPTIONS[fault.code] || {
    title: String(fault.code || "Unknown Fault"),
    body: fault.message || "No additional detail.",
    eStop: false,
  };
  const isEstop = !!meta.eStop;
  const cellIndex = typeof fault.cellIndex === "number" ? fault.cellIndex : 0;

  const handleClear = async () => {
    await machine.clearFault();
    if (fault.requiresHome) setStage("home");
    else setStage("resume");
  };

  const handleHome = async () => {
    if (homing) return;
    // Don't hand-roll local homing state here — the reducer flips
    // machine.state.homing on the homing:start event and the effect above
    // moves us to the resume picker on homing:done.
    await machine.home();
  };

  const pickResume = (resumeIndex, mode = "resume") => {
    // Dismiss the overlay first so the RunScreen can take over cleanly.
    machine.dispatch({ type: "fault_dismiss" });
    if (!activeRun) {
      navigate("programs");
      return;
    }
    const nextRun = { ...activeRun, resumeIndex, resumeMode: mode };
    setActiveRun(nextRun);
    try {
      machine.runProgram({
        programId: activeRun.programId,
        programName: activeRun.programName,
        mode: activeRun.mode,
        resumeIndex,
        // Forward bench-mode so the orchestrator's end-of-run Z UP skip
        // works on fault-recovery resumes too (otherwise a bench-rig resume
        // would hang on the final-cell Z UP just like a fresh run did).
        benchMode: !!machine.state.benchMode,
      });
    } catch {
      /* no-op: demo / offline */
    }
    navigate("run");
  };

  const discard = () => {
    machine.dispatch({ type: "fault_dismiss" });
    setActiveRun(null);
    navigate("home");
  };

  // Accent colors: red for the hardware lockout, amber once the operator
  // reaches the resume picker (the condition is resolved).
  const accentRgb = isEstop ? "248,113,113" : stage === "resume" ? "245,158,11" : "239,68,68";
  const accent    = isEstop ? "#f87171"      : stage === "resume" ? "#f59e0b"    : "#ef4444";

  return (
    <div className="fixed inset-0 z-[9900] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <style>{`
        @keyframes fault-pulse {
          0%, 100% { opacity: 1; filter: drop-shadow(0 0 10px rgba(239,68,68,0.65)); }
          50%      { opacity: 0.55; filter: drop-shadow(0 0 18px rgba(239,68,68,0.95)); }
        }
        .fault-pulse { animation: fault-pulse 1.1s ease-in-out infinite; }
        @keyframes fault-bar-sweep {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .fault-bar { animation: fault-bar-sweep 1.6s linear infinite; }
      `}</style>

      <HudCard
        accent={accent}
        accentRgb={accentRgb}
        className="p-6 w-[min(640px,92vw)]"
      >
        {/* Header band */}
        <div className="flex items-center gap-3 mb-3">
          <div
            className="fault-pulse w-3 h-3 rounded-full"
            style={{ background: accent, boxShadow: `0 0 14px ${accent}` }}
          />
          <div className="flex-1">
            <div className="text-[10px] tracking-[0.32em] uppercase text-slate-300">
              {isEstop ? "Emergency Stop" : "Fault Lockout"}
            </div>
            <div className="text-xl font-bold leading-tight" style={{ color: accent }}>
              {meta.title}
            </div>
          </div>
          <div className="text-right text-[10px] tracking-[0.2em] uppercase text-slate-400">
            <div>CODE</div>
            <div className="text-slate-200 font-mono text-[11px]">{fault.code}</div>
          </div>
        </div>

        {/* Sweeping danger bar */}
        <div className="relative h-[3px] bg-white/5 rounded-full overflow-hidden mb-4">
          <div
            className="fault-bar absolute inset-y-0 w-1/3"
            style={{
              background: `linear-gradient(to right, transparent 0%, ${accent} 50%, transparent 100%)`,
            }}
          />
        </div>

        {/* Body per stage */}
        {stage === "lockout" && (
          <>
            <div className="text-sm text-slate-200 mb-4 leading-relaxed">{meta.body}</div>
            <div className="grid grid-cols-2 gap-3 text-[11px] text-slate-300 mb-5">
              <div className="rounded-lg border border-white/10 bg-white/5 p-2">
                <div className="text-[9px] tracking-[0.24em] uppercase text-slate-400">Program</div>
                <div className="font-semibold truncate">
                  {fault.programName || activeRun?.programName || "—"}
                </div>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/5 p-2">
                <div className="text-[9px] tracking-[0.24em] uppercase text-slate-400">Cell Index</div>
                <div className="font-semibold">{cellIndex}</div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-[10px] tracking-[0.22em] uppercase text-slate-400">
                {fault.cleared
                  ? "Condition cleared — you may proceed"
                  : isEstop
                    ? "Waiting for E-stop release…"
                    : "Waiting for condition to resolve…"}
              </div>
              <div className="flex items-center gap-2">
                {/* Manual override — dismisses the lockout locally even if the
                    underlying condition hasn't resolved yet. Useful when the
                    operator knows the reported condition is a false alarm
                    (bench testing with simulated limit switches, a flaky air
                    sensor, etc). We still try to send CLEAR_FAULT so the
                    firmware can clear its flag if it's willing to, but we
                    always dispatch the local dismiss so the overlay closes. */}
                <button
                  onClick={() => {
                    machine.clearFault().catch(() => {});
                    machine.dispatch({ type: "fault_dismiss" });
                  }}
                  className="h-11 px-4 text-[11px] font-semibold tracking-[0.15em] uppercase rounded-lg border border-amber-400/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-100"
                  title="Close this overlay without waiting for the condition to clear. The fault code remains in the firmware's log."
                >
                  Override &amp; Dismiss
                </button>
                <button
                  onClick={handleClear}
                  disabled={!fault.cleared}
                  className="hud-accent-btn h-11 px-5 text-xs font-bold tracking-[0.18em] uppercase border disabled:opacity-40"
                  style={{
                    background: fault.cleared
                      ? `linear-gradient(135deg, rgba(${accentRgb},0.85), rgba(${accentRgb},0.55))`
                      : "rgba(255,255,255,0.04)",
                    borderColor: `rgba(${accentRgb},0.5)`,
                    boxShadow: fault.cleared ? `0 0 18px rgba(${accentRgb},0.35)` : "none",
                    color: "#fff",
                  }}
                >
                  Clear Fault
                </button>
              </div>
            </div>
          </>
        )}

        {stage === "home" && (
          <>
            <div className="text-sm text-slate-200 mb-4 leading-relaxed">
              The machine must be homed before continuing. Home now?
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={discard}
                className="h-11 px-5 text-xs font-semibold tracking-[0.15em] uppercase rounded-lg border border-white/10 bg-white/5 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={handleHome}
                disabled={homing}
                className="hud-accent-btn h-11 px-5 text-xs font-bold tracking-[0.18em] uppercase border inline-flex items-center gap-2"
                style={{
                  background: `linear-gradient(135deg, rgba(34,211,238,0.85), rgba(34,211,238,0.5))`,
                  borderColor: `rgba(34,211,238,0.5)`,
                  boxShadow: `0 0 18px rgba(34,211,238,0.3)`,
                  color: "#f0f9ff",
                }}
              >
                {homing && <RingSpinner size={12} stroke={3} speed={1.0} />}
                {homing ? "Homing…" : "Home Now"}
              </button>
            </div>
          </>
        )}

        {stage === "resume" && (
          <>
            <div className="text-sm text-slate-200 mb-4 leading-relaxed">
              Choose how to continue the program:
            </div>
            <div className="grid gap-2 mb-2">
              <button
                onClick={() => pickResume(cellIndex, "rerun")}
                className="text-left p-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition"
              >
                <div className="text-[10px] tracking-[0.24em] uppercase text-slate-400">Safer — weld may not have fired</div>
                <div className="text-sm font-semibold">Re-run cell {cellIndex}</div>
              </button>
              <button
                onClick={() => pickResume(cellIndex + 1, "continue")}
                className="text-left p-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition"
              >
                <div className="text-[10px] tracking-[0.24em] uppercase text-slate-400">Skip — cell already welded</div>
                <div className="text-sm font-semibold">Continue from cell {cellIndex + 1}</div>
              </button>
              <button
                onClick={() => pickResume(0, "restart")}
                className="text-left p-3 rounded-lg border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 transition"
              >
                <div className="text-[10px] tracking-[0.24em] uppercase text-red-300/70">Scrap partial run</div>
                <div className="text-sm font-semibold text-red-200">Start from beginning</div>
              </button>
            </div>
            <div className="flex items-center justify-end pt-1">
              <button
                onClick={discard}
                className="h-9 px-3 text-[11px] font-semibold tracking-[0.15em] uppercase rounded-lg border border-white/10 bg-white/5 hover:bg-white/10"
              >
                Discard & return home
              </button>
            </div>
          </>
        )}
      </HudCard>
    </div>
  );
}

/* ----------------------------- E-STOP POPUP ------------------------------ */
// Fires when the firmware reports ESTOP_CLEARED and there is no active fault
// keeping the main lockout overlay visible. Nudges the operator to home
// before continuing per §3.2.

function EStopClearedPopup({ navigate }) {
  const machine = useMachine();
  const { estop, fault } = machine.state;
  // Reducer-backed homing flag (#67) — see other Home buttons.
  const homing = machine.state.homing;

  // Dismiss the popup once the homing cycle that we kicked off finishes.
  useEffect(() => {
    if (!estop.clearedPrompt) return;
    const off = machine.subscribe((evt) => {
      if (evt?.type !== 'homing') return;
      if (evt.phase === 'done' || evt.phase === 'fault' || evt.phase === 'aborted') {
        machine.dispatch({ type: "estop_dismiss" });
      }
    });
    return off;
  }, [estop.clearedPrompt, machine.subscribe]);

  // Only show the popup when the firmware has signalled ESTOP_CLEARED and
  // we aren't still displaying the Fault Lockout overlay for the E-stop.
  if (!estop.clearedPrompt) return null;
  if (fault.active) return null;

  const dismiss = () => machine.dispatch({ type: "estop_dismiss" });

  const handleHome = async () => {
    if (homing) return;
    // Don't hand-roll local homing state — the reducer flips
    // machine.state.homing on homing:start; the effect above dismisses the
    // popup on homing:done.
    await machine.home();
  };

  return (
    <div className="fixed inset-0 z-[9800] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <HudCard
        accent="#22d3ee"
        accentRgb="34,211,238"
        className="p-6 w-[min(520px,90vw)]"
      >
        <div className="text-[10px] tracking-[0.32em] uppercase text-slate-300 mb-1">
          E-Stop Released
        </div>
        <div className="text-xl font-bold text-cyan-200 mb-3">Home before continuing?</div>
        <div className="text-sm text-slate-200 mb-5 leading-relaxed">
          The emergency stop has been released. The machine must be homed before any motion is permitted.
        </div>
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={() => {
              dismiss();
              navigate("home");
            }}
            className="h-11 px-5 text-xs font-semibold tracking-[0.15em] uppercase rounded-lg border border-white/10 bg-white/5 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={handleHome}
            disabled={homing}
            className="hud-accent-btn h-11 px-5 text-xs font-bold tracking-[0.18em] uppercase border inline-flex items-center gap-2"
            style={{
              background: `linear-gradient(135deg, rgba(34,211,238,0.85), rgba(34,211,238,0.5))`,
              borderColor: `rgba(34,211,238,0.5)`,
              boxShadow: `0 0 18px rgba(34,211,238,0.3)`,
              color: "#f0f9ff",
            }}
          >
            {homing && <RingSpinner size={12} stroke={3} speed={1.0} />}
            {homing ? "Homing…" : "Home Now"}
          </button>
        </div>
      </HudCard>
    </div>
  );
}

/* --------------------------- BOOT HOME PROMPT ---------------------------- */
// Shown once, immediately after the boot splash clears. Gives the operator
// the option to skip the automatic homing cycle — essential during first
// power-on before the limit switches have been verified. Honours the
// Teensy-stored `homeOnBoot` EEPROM flag: when ON we auto-fire HOME and
// never render the modal.

function BootHomePrompt() {
  const machine = useMachine();
  const s = machine.state;
  // Local lifecycle — 'pending' the first time we render, 'done' once the
  // operator has answered (or auto-home has fired). Component stays mounted
  // so the auto-home effect below can still run, but the modal disappears.
  const [phase, setPhase] = useState("pending");
  // Single source of truth for the homing-in-progress flag. The reducer
  // flips this from homing:start / homing:done events synthesised in
  // realSerial.js. Local useState here would race with the WS event stream
  // (and snapshot rebroadcasts) and was the cause of the homing-overlay
  // flash regression — see #66.
  const homing = s.homing;
  // Track whether we've already auto-resolved for this session to avoid
  // firing HOME twice if homeOnBoot flaps during reconnects.
  const autoFiredRef = useRef(false);
  // Track whether the modal has ever been rendered. Once the operator has
  // had the chance to see the prompt, the auto-home effect is locked out
  // permanently — otherwise a snapshot arriving with homeOnBoot=true after
  // initial render would race the user's tap and fire HOME from under them
  // (the modal-vs-snapshot race that left operators tapping "Not yet" only
  // to watch the gantry start moving anyway).
  const modalEverShownRef = useRef(false);

  // We still need a subscribe-listener to advance our LOCAL `phase` to
  // "done" when the homing cycle terminates (start → idle modal hidden,
  // done/fault/aborted → modal stays hidden permanently). The overlay flag
  // itself is now read straight from machine.state.homing above.
  useEffect(() => {
    const off = machine.subscribe((evt) => {
      if (evt?.type !== 'homing') return;
      if (evt.phase === 'done' || evt.phase === 'fault' || evt.phase === 'aborted') {
        setPhase("done");
      }
    });
    return off;
  }, [machine.subscribe]);

  // While other overlays own the screen, don't pile another modal on top.
  // (But keep this component mounted — the subscribe effect + auto-home effect
  // must still run so a reconnect mid-prompt still resolves cleanly.)
  // NB: must be computed BEFORE the auto-home effect so that effect can
  // observe the same suppressModal value the render is about to use.
  const suppressModal =
    phase !== "pending" ||
    s.fault?.active ||
    s.estop?.active ||
    s.estop?.clearedPrompt ||
    s.incompleteState ||
    s.homed ||
    (s.connected && s.homeOnBoot);

  // If the modal IS about to render (suppressModal=false), record that. We
  // gate the auto-home effect on this — once the user has been shown the
  // choice, only an explicit "Home now" click should kick off homing.
  if (!suppressModal) modalEverShownRef.current = true;

  // Auto-home path: if the firmware snapshot says homeOnBoot = true and the
  // machine isn't already homed, auto-fire HOME and skip the prompt. The
  // reducer flips machine.state.homing to true within ~5 ms of the OK ack,
  // so the overlay covers the screen continuously from before this effect's
  // promise even resolves.
  useEffect(() => {
    if (phase !== "pending") return;
    if (autoFiredRef.current) return;
    // Operator has already seen the modal — don't yank control away from
    // them with an auto-fire if a late snapshot flips homeOnBoot to true.
    if (modalEverShownRef.current) return;
    if (!s.connected) return;
    if (s.homeOnBoot && !s.homed) {
      autoFiredRef.current = true;
      machine.home().then((res) => {
        if (res && res.ok === false) {
          setPhase("done");
        }
      }).catch(() => {
        setPhase("done");
      });
    } else if (s.homed) {
      setPhase("done");
    }
  }, [phase, s.connected, s.homeOnBoot, s.homed, machine]);

  const handleYes = async () => {
    if (homing) return;
    // Latch the auto-fire ref too so the auto-home effect doesn't
    // double-fire after our explicit HOME (could otherwise happen if
    // homeOnBoot is true and snapshot lands while we're still awaiting
    // the OK ack).
    autoFiredRef.current = true;
    try {
      const res = await machine.home();
      if (res && res.ok === false) {
        setPhase("done");
      }
      // Otherwise: HOME accepted. Don't dismiss here — wait for the
      // firmware's `homing:done`, which is handled by the subscribe effect
      // above (and which flips the reducer's homing flag false too).
    } catch {
      setPhase("done");
    }
  };
  // Tapping "Not yet" must permanently disable the auto-home effect for
  // this session. Without setting autoFiredRef here, a homeOnBoot=true
  // SNAPSHOT arriving on the WS *after* the click would re-trigger the
  // auto-home effect (it depends on s.homeOnBoot, so it re-runs on
  // every state delta). The effect's other guard `phase !== "pending"`
  // is supposed to catch this, but in practice the SNAPSHOT race with
  // the user tap meant HOME got fired before phase had transitioned to
  // "done" — operators reported the machine homed itself even after
  // tapping Not yet.
  const handleNo = () => {
    autoFiredRef.current = true;
    setPhase("done");
  };

  if (suppressModal && !homing) return null;

  const accent = accentFor("setup");

  return (
    <>
      {!suppressModal && (
        <div className="fixed inset-0 z-[9700] flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <HudCard
            accent={accent.color}
            accentRgb={accent.rgb}
            className="p-6 w-[min(560px,92vw)]"
          >
            <div className="text-[10px] tracking-[0.32em] uppercase text-slate-300 mb-1">
              Boot Check
            </div>
            <div className="text-xl font-bold mb-3" style={{ color: accent.color }}>
              Ready to home the axes?
            </div>
            <div className="text-sm text-slate-200 mb-4 leading-relaxed">
              Running an automatic homing cycle will drive the table toward
              the X and Y home switches. Only proceed if the limit switches and
              driver wiring have been verified.
            </div>
            <div className="rounded-lg border border-amber-400/25 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200/90 leading-snug mb-5">
              First-time commissioning? Choose <span className="font-semibold">Not yet</span>,
              then use <span className="font-semibold">Settings → Test Motion</span> to
              verify every limit switch by hand before running a homing cycle.
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={handleNo}
                disabled={homing}
                className="h-11 px-5 text-xs font-semibold tracking-[0.15em] uppercase rounded-lg border border-white/10 bg-white/5 hover:bg-white/10"
              >
                Not yet
              </button>
              <button
                onClick={handleYes}
                disabled={homing}
                className="hud-accent-btn h-11 px-5 text-xs font-bold tracking-[0.18em] uppercase border inline-flex items-center gap-2"
                style={{
                  background: `linear-gradient(135deg, rgba(${accent.rgb},0.85), rgba(${accent.rgb},0.5))`,
                  borderColor: `rgba(${accent.rgb},0.5)`,
                  boxShadow: `0 0 18px rgba(${accent.rgb},0.3)`,
                  color: "#f0f9ff",
                }}
              >
                {homing && <RingSpinner size={12} stroke={3} speed={1.0} />}
                {homing ? "Homing…" : "Home Now"}
              </button>
            </div>
          </HudCard>
        </div>
      )}

      {/* Full-screen overlay covers the modal (and the app behind it) the
          moment homing kicks off. Stays up until the `homing:done` event
          fires or the HOME command is rejected — see the effects above. */}
      <LoadingOverlay
        visible={homing}
        title="Homing axes"
        subtext="Seeking home switches on X and Y. Keep the workspace clear."
      >
        <HomingAxisTicker />
      </LoadingOverlay>
    </>
  );
}

/* ------------------------- INCOMPLETE-STATE PROMPT ----------------------- */
// Fires when the backend reports an `incomplete_state` event at boot. Happens
// when the Pi was power-cycled mid-run and a state file was left on disk
// (master plan §3.2). Offers three resume paths plus Discard.

function IncompleteStatePrompt({ setActiveRun, navigate }) {
  const machine = useMachine();
  const record = machine.state.incompleteState;
  const [busy, setBusy] = useState(false);

  if (!record) return null;

  const programName = record.programName || "Last run";
  const index = Number(record.index || 0);
  const total = Number(record.total || 0);
  const nextCell = Math.min(index + 1, Math.max(total, 1));
  const mode = record.mode || "Positive";

  const accent = accentFor("programs");
  const amber = accentFor("diagnostics");

  const pickOption = async (choice) => {
    if (busy) return;
    setBusy(true);
    try {
      // Seed activeRun so the Run screen shows the right program header while
      // the backend spins the actual run up.
      setActiveRun({
        programName,
        programId: record.programId || null,
        mode,
        cells: total,
        resumeIndex: choice === "rerun" ? index : choice === "continue" ? nextCell : 0,
        resumeMode: choice,
        coordinates: [],
        startPosition: null,
        resumed: true,
      });
      await machine.resumeIncomplete(choice);
      machine.dispatch({ type: "incomplete_state_cleared" });
      navigate("run");
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await machine.discardIncomplete();
      machine.dispatch({ type: "incomplete_state_cleared" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9850] flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <HudCard
        accent={amber.color}
        accentRgb={amber.rgb}
        className="p-6 w-[min(640px,92vw)]"
      >
        <div className="text-[10px] tracking-[0.32em] uppercase text-slate-300 mb-1">
          Interrupted Run Detected
        </div>
        <div className="text-xl font-bold text-amber-200 mb-3">
          Resume {programName}?
        </div>
        <div className="text-sm text-slate-200 mb-4 leading-relaxed">
          The last run stopped at cell <span className="font-semibold text-white">{index}</span>
          {total ? <> of <span className="font-semibold text-white">{total}</span></> : null}
          {record.cause ? <> — <span className="text-slate-300 uppercase tracking-widest text-[10px]">{String(record.cause)}</span></> : null}.
          Pick how to continue.
        </div>

        <div className="grid grid-cols-3 gap-2 mb-4">
          <button
            onClick={() => pickOption("rerun")}
            disabled={busy}
            className="hud-accent-btn h-12 px-3 text-[11px] font-bold tracking-[0.14em] uppercase border text-left flex flex-col items-start justify-center leading-tight"
            style={{
              background: `linear-gradient(135deg, rgba(${accent.rgb},0.85), rgba(${accent.rgb},0.55))`,
              borderColor: `rgba(${accent.rgb},0.55)`,
              boxShadow: `0 0 16px rgba(${accent.rgb},0.3)`,
              color: "#f0f9ff",
            }}
          >
            <span>Re-run Cell {index}</span>
            <span className="text-[9px] opacity-70 normal-case tracking-normal">Redo the interrupted weld</span>
          </button>
          <button
            onClick={() => pickOption("continue")}
            disabled={busy}
            className="h-12 px-3 text-[11px] font-bold tracking-[0.14em] uppercase rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-left flex flex-col items-start justify-center leading-tight"
          >
            <span>Continue N+1</span>
            <span className="text-[9px] opacity-60 normal-case tracking-normal">Skip to cell {nextCell}</span>
          </button>
          <button
            onClick={() => pickOption("restart")}
            disabled={busy}
            className="h-12 px-3 text-[11px] font-bold tracking-[0.14em] uppercase rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-left flex flex-col items-start justify-center leading-tight"
          >
            <span>Start Over</span>
            <span className="text-[9px] opacity-60 normal-case tracking-normal">Redo from cell 1</span>
          </button>
        </div>

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={discard}
            disabled={busy}
            className="h-10 px-4 text-[11px] font-semibold tracking-[0.15em] uppercase rounded-lg border"
            style={{
              background: "rgba(239,68,68,0.12)",
              borderColor: "rgba(239,68,68,0.3)",
              color: "#fecaca",
            }}
          >
            Discard Record
          </button>
        </div>
      </HudCard>
    </div>
  );
}
