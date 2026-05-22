// piGpioEstop.js
//
// Pi-side E-stop button monitor.
//
// The Gillis V2 pendant houses both the Raspberry Pi 4 and the E-stop
// mushroom-button, so the most direct way to make the GUI E-stop-aware is to
// read the button straight off a Pi GPIO pin — no extra cable run back to the
// electronics box.
//
// Why the firmware-side detection isn't enough:
//   The Teensy's existing "all three CL57Y ALMs simultaneous" heuristic
//   (fault_handler.h, fault_check()) cannot detect an E-stop press in
//   practice. The CL57Y's ALM output is opto-isolated and its de-powered
//   state is OPEN — same as "driver healthy". So when E-stop cuts 60V driver
//   supply, the Teensy's pullups read all three ALM pins HIGH, which the
//   firmware interprets as "no faults". The press is invisible until / unless
//   an ALM transient happens to fire from the abrupt power loss, and even
//   then it's typically a single-driver glitch, not the simultaneous-three
//   pattern E-stop detection demands.
//
// Wiring (single twisted pair within the pendant):
//
//   E-stop relay aux NO contact ─┬─── Pi GPIO  (BCM pin, default 23 = physical 16)
//                                │
//                                └─── Pi GND   (physical pin 14, adjacent)
//
//   System OK   (E-stop released): NO open   → pullup pulls pin HIGH → reads HIGH
//   E-stop pressed:                NO closed → pin pulled to GND → reads LOW
//   Wire break:                    no contact → pullup pulls pin HIGH → reads HIGH
//                                  ⚠ NOT fail-safe with NO wiring — a broken
//                                  wire looks identical to "E-stop released".
//                                  The mechanical contactor still cuts driver
//                                  power on a real press so the machine is
//                                  safe; the GUI overlay just won't fire.
//                                  Switching to NC (other side wired through
//                                  GND and pullup HIGH on press) restores
//                                  fail-safe — see PIN_HIGH_MEANS_PRESSED.
//
// On press we emit `{type:'estop'}` into the same WS event stream the GUI
// already subscribes to — the existing reducer (useMachine.jsx) flips
// homed=false, drops run.phase to 'faulted', and the FaultLockoutOverlay
// renders. We also push a triple-tap of safing commands at the firmware so
// it doesn't keep driving the now-unpowered Z relay LOW (which would slam Z
// down the instant E-stop releases and 24V comes back to the solenoid coil).
//
// On release we emit `{type:'estop_cleared'}` which puts the GUI into the
// "home now?" prompt state. No automatic re-arm — the operator deliberately
// presses Home from the lockout overlay.
//
// Activated via env var `GILLIS_ESTOP_PIN=<BCM number>`. Leave unset on
// desktops / dev rigs to skip the monitor entirely.

import { execFileSync } from 'node:child_process';

// Poll cadence — fast enough for the press to feel instant in the UI, slow
// enough that spawning `gpioget` once per tick costs almost nothing on a Pi 4.
const POLL_INTERVAL_MS = 100;

// Edge debounce: require N consecutive reads of the new state before flipping.
// 2 × 100ms = 200ms minimum hold — comfortably above mechanical bounce on a
// safety-rated E-stop relay (typically < 20 ms) without making the press
// feel laggy.
const DEBOUNCE_READS = 2;

// Wiring convention — see header comment.
//   NO contact (current install, the NC contact is busy carrying the 24V
//   drive-power loop so we get the NO contact on the aux block):
//     pin LOW  = E-stop pressed   (NO closed → pulled to GND)
//     pin HIGH = E-stop released  (NO open   → pullup floats high)
//
// Flip this to `true` if rewired to the NC contact (fail-safe — broken wire
// reads HIGH which then means "pressed" and the GUI will lock out).
const PIN_HIGH_MEANS_PRESSED = false;

// =============================================================================
// Enable the Pi's internal pull-up on the chosen line.
//
// Pi OS Bookworm / Trixie ships `pinctrl` (the modern userspace tool that
// talks to the kernel pinctrl driver). Older releases ship `raspi-gpio`.
// Both achieve the same thing for this purpose. Try the newer one first.
//
// If neither is available (or both error out), the caller should ideally
// fit a 10kΩ external pull-up between the GPIO pin and 3V3 — but we don't
// abort here; the monitor will still work if the line happens to be biased
// correctly by another mechanism (boot defaults, device-tree, etc.).
// =============================================================================
function configurePullup(line) {
  const attempts = [
    ['pinctrl',    ['set', String(line), 'ip', 'pu']],
    ['raspi-gpio', ['set', String(line), 'pu']],
  ];
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'pipe', timeout: 1000 });
      return cmd;
    } catch { /* try next */ }
  }
  return null;
}

// =============================================================================
// Read a single sample from the chosen GPIO line.
//
// `gpioget` is part of libgpiod-utils and ships on every Pi OS release that
// supports the Pi 4, but the CLI changed between major versions:
//
//   libgpiod v1 (Bookworm and older): `gpioget <chip> <line>`        → "0"/"1"
//   libgpiod v2 (Trixie and newer):   `gpioget -c <chip> <line>`     → `"23"=active`
//                                     `gpioget -c <chip> --numeric <line>` → "0"/"1"
//
// Calling the v1 syntax on a v2 install yields "cannot find line 'gpiochip0'"
// because v2 treats every positional arg as a line name. Pi OS Trixie ships
// v2, so we MUST use -c. Try v2-with-numeric first, fall back to v1 syntax
// for any older box still around.
//
// Returns 1, 0, or null. null means gpioget isn't usable on this system —
// caller logs a warning and disables monitoring.
// =============================================================================
function readPin(chip, line) {
  const lineStr = String(line);
  const variants = [
    // libgpiod v2 with --numeric so the output is just "0" or "1" — most
    // unambiguous of all the format options. -c specifies the chip.
    ['-c', chip, '--numeric', lineStr],
    // libgpiod v2 default output ("<line>=active"/"<line>=inactive") in case
    // some build of gpioget doesn't recognise --numeric.
    ['-c', chip, lineStr],
    // libgpiod v1 positional syntax for older Pi OS releases.
    [chip, lineStr],
  ];
  for (const args of variants) {
    try {
      const out = execFileSync('gpioget', args, {
        encoding: 'utf8',
        timeout: 500,
      }).trim();
      if (out === '1') return 1;
      if (out === '0') return 0;
      // v2 default output: "<line>"=active|inactive  (the line number may be
      // bare or quoted depending on gpioget build).
      if (/=\s*"?active"?\s*$/i.test(out))   return 1;
      if (/=\s*"?inactive"?\s*$/i.test(out)) return 0;
      // Lenient last resort — pick up a trailing 1 or 0 wherever it lives.
      if (/(?:^|\s|=)1\s*$/.test(out)) return 1;
      if (/(?:^|\s|=)0\s*$/.test(out)) return 0;
    } catch { /* try next variant */ }
  }
  return null;
}

// =============================================================================
// startEstopMonitor — kick off the GPIO polling loop.
//
//   emit({type, ...})  — inject events into the WS broadcast stream
//                        (typically realSerial.emitEvent)
//   send(cmd)          — issue a firmware command (typically realSerial.send)
//   line               — BCM pin number
//   chip               — gpiochip device (default 'gpiochip0')
//
// Returns { stop } so the caller can shut the monitor down (used in tests).
// =============================================================================
export function startEstopMonitor({ emit, send, line, chip = 'gpiochip0' }) {
  if (line === undefined || line === null) {
    return { stop: () => {} };
  }
  const bcm = Number(line);
  if (!Number.isFinite(bcm)) {
    // eslint-disable-next-line no-console
    console.warn(`[gpio estop] invalid pin "${line}" — monitor disabled`);
    return { stop: () => {} };
  }

  const which = configurePullup(bcm);
  if (which) {
    // eslint-disable-next-line no-console
    console.log(`[gpio estop] internal pullup enabled via ${which}`);
  } else {
    // eslint-disable-next-line no-console
    console.warn('[gpio estop] could not configure internal pullup ' +
                 '(pinctrl/raspi-gpio missing or failed). Continuing — ' +
                 'fit a 10kΩ external pullup if the line floats.');
  }

  const initial = readPin(chip, bcm);
  if (initial === null) {
    // eslint-disable-next-line no-console
    console.warn(`[gpio estop] gpioget unavailable — E-stop monitoring disabled. ` +
                 `Install libgpiod-utils: sudo apt install gpiod`);
    return { stop: () => {} };
  }

  let pressed = (initial === 1) === PIN_HIGH_MEANS_PRESSED;
  // eslint-disable-next-line no-console
  console.log(`[gpio estop] monitoring BCM ${bcm} on ${chip}, ` +
              `initial state: ${pressed ? 'PRESSED' : 'released'}`);

  // The firmware-safing triplet. Sent on E-stop press to:
  //   1. Z UP — deenergise the Z relay. The 24V solenoid coil loses power
  //      at the E-stop relay anyway, so Z lifts immediately on press. The
  //      reason we still issue Z UP is for the RELEASE side: if the firmware
  //      were left driving the Z relay LOW (its energise state), then the
  //      instant 24V returns when E-stop releases, the solenoid would re-
  //      energise and slam Z back DOWN without the operator commanding it.
  //   2. RUN_ABORT — if a run was in flight, tear it down cleanly so the
  //      firmware drops from STATE_WELDING / STATE_MOVING to STATE_IDLE.
  //      The firmware's RUN_ABORT handler always transitions to IDLE
  //      regardless of prior state, so this is safe to send unconditionally.
  //   3. DISABLE — drop machineState.driversEnabled to false. The next HOME
  //      command auto-re-enables, so this is just belt-and-braces. Keeps
  //      the state machine consistent with the physical reality (drivers
  //      power-cut by the E-stop contactor).
  const safeFirmware = () => {
    send('Z UP').catch(() => {});
    send('RUN_ABORT').catch(() => {});
    send('DISABLE').catch(() => {});
  };

  // If the system boots with E-stop already pressed, we want the GUI to
  // come up showing the lockout overlay rather than acting like everything's
  // fine. Match the press-edge logic.
  if (pressed) {
    emit({ type: 'estop' });
    safeFirmware();
  }

  // Edge debounce counter — accrues on each consecutive sample that
  // disagrees with `pressed`, resets the moment the sample agrees again.
  let pendingFlips = 0;

  const tick = () => {
    const state = readPin(chip, bcm);
    if (state === null) return;

    const sample = (state === 1) === PIN_HIGH_MEANS_PRESSED;
    if (sample !== pressed) {
      pendingFlips++;
      if (pendingFlips >= DEBOUNCE_READS) {
        pressed = sample;
        pendingFlips = 0;
        if (pressed) {
          // eslint-disable-next-line no-console
          console.log('[gpio estop] E-STOP PRESSED');
          emit({ type: 'estop' });
          safeFirmware();
        } else {
          // eslint-disable-next-line no-console
          console.log('[gpio estop] E-STOP RELEASED');
          emit({ type: 'estop_cleared' });
        }
      }
    } else {
      // Steady reading — clear any in-progress debounce counter.
      pendingFlips = 0;
    }
  };

  const interval = setInterval(tick, POLL_INTERVAL_MS);

  return {
    stop: () => clearInterval(interval),
  };
}
