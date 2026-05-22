# E-stop detection — wiring and software notes

The pendant-mounted E-stop button is read directly off a Raspberry Pi GPIO
pin. The Pi-side Node backend polls the pin and emits `estop` /
`estop_cleared` events into the same WebSocket stream the GUI already
subscribes to. The existing reducer (`gui/src/lib/useMachine.jsx`) handles
the rest — drops `homed` to false, locks out motion, shows the red fault
overlay, prompts for a re-home on release.

## Why not detect via the Teensy?

The Teensy firmware has a heuristic in `fault_handler.h` that fires
`FAULT_ESTOP` when **all three CL57Y driver ALM lines assert
simultaneously**. In practice this **cannot detect a real E-stop press**:

- CL57Y ALM is an opto-isolated output. Its de-powered state is OPEN.
- When the E-stop contactor cuts 60 V driver supply, all three opto outputs
  go open — identical to "driver healthy".
- The Teensy's INPUT_PULLUPs read all three ALM pins HIGH ⇒ the firmware
  sees "no faults".

So the press is invisible to the firmware. A delayed ALM transient can fire
on a single driver during power loss but it's racy, not the three-
simultaneous pattern the E-stop detector wants, and you can't depend on it.

Bottom line: hardware-cut E-stop detection has to come from a different
sensor channel. Pi GPIO is the easiest because both Pi and E-stop button
are in the pendant — no extra cable run to the electronics box.

## Wiring

```
E-stop relay aux NO contact ─┬─── Pi GPIO  BCM 23  (physical pin 16)
                             │
                             └─── Pi GND          (physical pin 14, adjacent)
```

Single twisted pair inside the pendant. Physical pins 14 and 16 are next
to each other on the 40-pin header, so the wire run is trivial.

### Polarity (current install: NO contact)

| State | NO contact | GPIO 23 reads | Reason |
|---|---|---|---|
| System OK (E-stop released, coil energised) | open | **HIGH (1)** | Pin pulled up by Pi internal pull-up |
| E-stop pressed (coil de-energised) | closed | **LOW  (0)** | Contact pulls pin to GND |
| Wire break | (never conducts) | **HIGH (1)** | ⚠ Reads "released" — **NOT fail-safe** |

The fail-safe limitation is because the only free aux contact on the
client's E-stop relay was the NO side — the NC side is carrying 24 V to
the contactor coil. To regain fail-safe wiring, swap which side carries
the 24 V (move it to NO) so the NC is free for sense. Then flip
`PIN_HIGH_MEANS_PRESSED` in `piGpioEstop.js` back to `true`.

For now the mechanical contactor still cuts driver power on every real
press, so the machine itself is safe even if the GUI doesn't notice — the
GUI overlay just won't fire on a broken sense wire.

## Software

### Backend module

`gui/server/piGpioEstop.js` is the polling monitor. It:

1. Runs `pinctrl set 23 ip pu` (Pi OS Bookworm/Trixie) or `raspi-gpio set 23 pu`
   (legacy) at startup to enable the internal pull-up. Falls through silently
   if neither tool is installed — in that case fit a 10 kΩ external pull-up
   between the pin and 3 V3.
2. Polls `gpioget` every 100 ms. Handles libgpiod v1 (positional chip
   argument) and v2 (`-c <chip> --numeric`) syntax automatically.
3. Debounces edges by requiring 2 consecutive reads in the new state before
   flipping. 200 ms total — well above mechanical bounce.
4. On press: emits `{type: 'estop'}` to the WS stream, then sends three
   safing commands to the Teensy over USB serial:
   - `Z UP` — de-energises the Z relay. Critical: without this, when 24 V
     comes back on E-stop release, the still-driven solenoid coil would
     snap Z down immediately.
   - `RUN_ABORT` — if a run was in flight, drop the firmware out of
     `STATE_WELDING` cleanly.
   - `DISABLE` — keep the firmware's `driversEnabled` flag consistent
     with physical reality.
5. On release: emits `{type: 'estop_cleared'}`. The existing GUI reducer
   flips `estop.clearedPrompt = true` and the fault overlay shows the
   "Home now?" prompt.

### Activation

The monitor is opt-in via the `GILLIS_ESTOP_PIN` env var on the Node
backend. Leave unset (e.g. on dev / mock-serial runs) to skip the monitor
entirely.

Two launchers on the Pi both set the env var:

- `/home/ionetic/Desktop/gillis-v2-ui-v2/start-gillis-gui.sh`
  — invoked by labwc autostart at boot
- `/home/ionetic/launch-gillis.sh`
  — invoked by the desktop shortcut for manual launch

Both have a line like:

```bash
GILLIS_SERIAL=real PORT=8787 GILLIS_ESTOP_PIN=23 nohup node server/index.js ...
```

The pin number can be overridden by setting `GILLIS_ESTOP_PIN` to a
different BCM number, or `GILLIS_ESTOP_CHIP` to a different gpiochip
device (e.g. `gpiochip4` on Pi 5).

## Verification

After deploy + reboot, with E-stop released:

```bash
pinctrl get 23
# expect:  23: ip    pu | hi // GPIO23 = input

gpioget -c gpiochip0 --numeric 23
# expect:  1
```

Press the E-stop and run the gpioget again:

```bash
gpioget -c gpiochip0 --numeric 23
# expect:  0
```

The GUI should throw a red fault lockout overlay the moment you press the
button. Release and the overlay should show the "Home now?" prompt.

Backend log lines to look for at startup (`/tmp/gillis-backend.log`):

```
[gpio estop] internal pullup enabled via pinctrl
[gpio estop] monitoring BCM 23 on gpiochip0, initial state: released
```

And on a press:

```
[gpio estop] E-STOP PRESSED
[gpio estop] E-STOP RELEASED
```

## Troubleshooting

- **GUI doesn't react to press** — check the backend log for the
  `[gpio estop]` startup lines. If absent, `GILLIS_ESTOP_PIN` env var
  isn't reaching the node process. Verify with
  `cat /proc/$(pgrep -f node.*server)/environ | tr '\0' '\n' | grep ESTOP`.
- **GUI shows E-stop active at boot** — wiring is intermittent or the
  NO contact isn't fully open at rest. With the wire physically
  disconnected and the pull-up working, the pin should read HIGH (1)
  and the GUI should show no overlay.
- **`gpioget` says "cannot find line 'gpiochip0'"** — you're on libgpiod
  v2 (Pi OS Trixie) but using v1 syntax. v2 needs `-c gpiochip0`. The
  monitor module tries both automatically; this only bites when probing
  manually.
- **Pin reads 0 even with E-stop released and no wire connected** —
  pull-up didn't apply. Run `pinctrl set 23 ip pu` manually. If the
  monitor is running, this should have been done at startup already.

## Future improvements

- Switch wiring to the NC aux contact once the 24 V coil drive can be
  rerouted, restoring fail-safe behaviour.
- Consider replacing the polling loop with `gpiomon`-streamed edge events
  for faster reaction (10 ms vs current ~100 ms worst case).
- If a second pendant button is ever added (e.g. a momentary "ack"), it
  can ride alongside on another BCM pin with the same monitor pattern —
  just generalise `piGpioEstop.js` to take an array of pin descriptors.
