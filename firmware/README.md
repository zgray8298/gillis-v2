# Gillis V2.0 — Teensy 4.1 Firmware (Rev4)

## Build Environment
- Arduino IDE 2.x with **Teensyduino** addon
- Board: **Teensy 4.1**
- USB Type: **Serial**
- CPU Speed: **600 MHz**
- Optimize: **Faster (O2)**
- Library: **ArduinoJson v7** (install via Library Manager — search "ArduinoJson" by Benoit Blanchon)

## File Structure
```
gillis_firmware/
  gillis_firmware.ino     ← Main sketch (open this in Arduino IDE)
  src/
    config.h              ← Machine constants — EDIT THESE FOR YOUR HARDWARE
    pins.h                ← Teensy pin assignments
    settings.h            ← EEPROM-backed settings struct (Rev4 layout)
    sensors.h             ← Sensor reading (digital + ADC, ALM debounce)
    stepper.h             ← Trapezoidal stepper engine + soft-limit clamping
    fault_handler.h       ← Fault codes, triggering, auto-clear, cellIndex tag
    run_state.h           ← RUN lifecycle tracking (Pi drives cell loop)
    homing.h              ← Y-then-X homing with tramming, post-home LOADPOS move
    z_control.h           ← Pneumatic Z with selectable head A/B/C
    state_machine.h       ← Main machine FSM (IDLE/HOMING/MOVING/WELDING/PAUSED/FAULT/ESTOP)
    telemetry.h           ← Periodic POSITION / AIR events + SNAPSHOT
    serial_protocol.h     ← Full Pi→Teensy command parser (Rev4 surface)
```

---

## ⚠️ CALIBRATION REQUIRED BEFORE FIRST USE

### 1. Steps/mm (config.h)
Configured for **5 mm-pitch ballscrews** (X and Y) at **16 microsteps**:
3200 steps/rev ÷ 5 mm/rev = **640 steps/mm**. If you swap to a different
pitch, update `src/config.h`:

```cpp
#define MM_PER_REV_X   5.0f   // MEASURE AND CONFIRM
#define MM_PER_REV_Y   5.0f
```

To calibrate: command a 100 mm move (`MOVE X100.00 Y0.00`), measure actual
travel, then `corrected = 100 * steps_per_mm / actual_mm`.

### 2. CL57Y Microstepping DIP Switches
Firmware assumes **16 microsteps (3200 steps/rev)**. Confirm DIP settings on
each CL57Y match. If you change microsteps, update `MICROSTEPS` in `config.h`.

### 3. Travel Limits (persisted in Settings)
Defaults come from `config.h` (`DEFAULT_AXIS_X_MAX_MM`, `DEFAULT_AXIS_Y_MAX_MM`).
Live values are updated at runtime via the Rev4 command:

```
SET_TRAVEL {"maxX":400.0,"maxY":300.0}
```

Every `MOVE` and `JOG` is clamped to `[0, maxX]` / `[0, maxY]` server-side as
belt-and-braces — the UI planner is expected to respect limits but the firmware
will refuse to drive past them.

### 4. Air Pressure Sensor
Voltage divider (10 kΩ + 20 kΩ) and a 0–10 bar / 0–5 V sensor assumed. Verify
`AIR_SENSOR_RANGE_BAR` in `config.h` matches your sensor datasheet.

### 5. Homing Direction
If your home sensors are at the **positive** end of travel (non-standard),
change in `config.h`:
```cpp
#define HOME_DIR_X   HIGH
#define HOME_DIR_Y   HIGH
```

### 6. Parking (LOADPOS) and Active Weld Head
Set via serial at runtime:
```
LOADPOS {"x":200.0,"y":150.0}     # auto-moved here at end of HOME
SET_SOLENOID B                    # A, B, or C
```

---

## Pin Assignments (Teensy 4.1)

| Pin | Signal           | Direction | Notes                              |
|-----|------------------|-----------|------------------------------------|
| 2   | X_STEP           | OUT       | Via 3.3V→5V opto board             |
| 3   | X_DIR            | OUT       |                                    |
| 4   | Y_LEFT_STEP      | OUT       |                                    |
| 5   | Y_LEFT_DIR       | OUT       |                                    |
| 6   | Y_RIGHT_STEP     | OUT       |                                    |
| 7   | Y_RIGHT_DIR      | OUT       |                                    |
| 8   | ALL_ENABLE       | OUT       | Active LOW — shared to all CL57Y   |
| 9   | Z_SOLENOID_A     | OUT       | Relay Ch1 — head A                 |
| 10  | LASER_RELAY      | OUT       | Relay Ch2                          |
| 11  | Z_SOLENOID_B     | OUT       | Relay Ch3 — head B (Rev4)          |
| 12  | Z_SOLENOID_C     | OUT       | Relay Ch4 — head C (Rev4)          |
| 14  | X_HOME           | IN        | Via 24V opto — active LOW          |
| 15  | Y_LEFT_HOME      | IN        |                                    |
| 16  | Y_RIGHT_HOME     | IN        |                                    |
| 17  | Z_UP_SENSOR      | IN        |                                    |
| 18  | Z_DOWN_SENSOR    | IN        |                                    |
| 19  | X_DRIVER_ALM     | IN        | CL57Y ALM — active LOW             |
| 20  | Y_LEFT_ALM       | IN        |                                    |
| 21  | Y_RIGHT_ALM      | IN        |                                    |
| A0  | AIR_PRESSURE     | ADC IN    | 5V sensor → 10k/20k divider → 3.3V |

---

## Serial Protocol (115200 baud, USB CDC)

### Pi → Teensy Commands

#### Primitives (always available)
```
PING
VERSION
STATUS                 # alias: SNAPSHOT
HOME
MOVE X152.40 Y88.20
JOG X+1.0              # or JOG Y-2.5
Z DOWN                 # legacy alias: Z_DOWN
Z UP                   # legacy alias: Z_UP
FIRE
PAUSE
RESUME
ABORT                  # alias: STOP
ENABLE
DISABLE
CLEAR_FAULT
```

#### Persistent settings (Rev4 JSON)
```
SETMOTION {"xSpeed":120,"ySpeed":120,"xAccel":500,"yAccel":500,"zDownDwell":50,"homeOnBoot":false}
SET_TRAVEL {"maxX":400.0,"maxY":300.0}
LOADPOS {"x":200.0,"y":150.0}
SET_SOLENOID A                        # A | B | C
SET_AIR_THRESHOLD 4.1
SET_HOME_ON_BOOT 1                    # 0|1 | ON|OFF | TRUE|FALSE
SENSORS                               # force immediate SENSORS event
```
Legacy forms still supported:
```
SET_SPEED X120 Y120
SET_ACCEL X500 Y500
SET_DWELL 50
SET_TRAM 0.250                        # alias: SETGANTRYOFFSET
```

#### Run lifecycle (Pi drives cell loop)
```
RUN_START {"totalCells":42,"startIndex":0,"programId":7,"mode":"SPOT"}
RUN_CELL_DONE 0                       # repeated per cell
RUN_PAUSE
RUN_RESUME
RUN_ABORT
RUN_COMPLETE
```

#### Incomplete-state + USB (Pi-side; firmware ack only)
```
RESUME_INCOMPLETE rerun               # also: continue | restart
DISCARD_INCOMPLETE
USB_LIST
USB_IMPORT <filename>
USB_EXPORT <filename>
```

### Teensy → Pi Responses / Events

#### Command replies
```
GILLIS_READY                          # on boot (followed by version line)
PONG
OK
BUSY
DONE                                  # move / Z / FIRE complete
HOMED                                 # homing (+LOADPOS) complete
ERR <reason>
FAULT_STILL_ACTIVE                    # CLEAR_FAULT rejected
```

#### Telemetry events (asynchronous)
```
POSITION X152.40 Y88.20               # ~10 Hz while moving or non-idle
AIR 5.82                              # ~2 Hz always
SENSORS XH0 YLH0 YRH0 ZU1 ZD0 XA0 YLA0 YRA0
                                      # ~4 Hz + on any edge change
                                      # XH/YLH/YRH = home sensors (1=triggered)
                                      # ZU/ZD      = Z UP/DOWN sensors
                                      # XA/YLA/YRA = CL57Y ALM bits (1=fault)
LASER ON                              # around FIRE dwell
LASER OFF
RUN phase=started programId=7 totalCells=42 startIndex=0 mode=SPOT
RUN phase=cell idx=17
RUN phase=paused
RUN phase=resumed
RUN phase=aborted idx=17
RUN phase=done totalCells=42
SNAPSHOT X.. Y.. Z.. AIR.. DRIVERS.. STATE.. [FAULT..] SOLENOIDA MAXX.. MAXY.. TRAM.. DWELL.. HOMEBOOT0|1 RUN ...
```

#### Fault events
```
FAULT FAULT_LOW_AIR                   # no run active
FAULT FAULT_Z_TIMEOUT_DOWN cellIndex=17   # appended while a run is active
FAULT_CLEARED FAULT_LOW_AIR           # auto — condition has resolved
ESTOP
ESTOP_CLEARED
```

### Fault Codes
```
FAULT_LOW_AIR           Air below threshold (default 4.1 bar / 60 PSI)
FAULT_Z_TIMEOUT_DOWN    Z didn't extend within 2 s
FAULT_Z_TIMEOUT_UP      Z didn't retract within 2 s
FAULT_DRIVER_X          X CL57Y ALM active
FAULT_DRIVER_YL         Y left CL57Y ALM active
FAULT_DRIVER_YR         Y right CL57Y ALM active
FAULT_ESTOP             E-stop — all three ALMs fire simultaneously
USER_ABORT              Operator abort / ABORT / STOP
```

---

## Commissioning Test Sequence (matches master plan §8)

1. Flash firmware. Open serial monitor @ 115200. Should see `GILLIS_READY` and version line.
2. Send `PING` → expect `PONG`.
3. Send `ENABLE` → drivers should hold (audible click or motor engagement).
4. Send `JOG X+10.0` → X axis moves 10 mm. Verify direction. Expect `OK`, `POSITION …` updates, and `DONE` isn't emitted for JOGs — watch POSITION.
5. Send `HOME` → Y left/right seek sensors, gantry advances +100 mm (clearance), then X seeks. If LOADPOS set, machine parks there. Expect `HOMED`.
6. Send `Z DOWN` → selected solenoid energises, expect `DONE` when Z_DOWN_SENSOR triggers.
7. Send `Z UP` → solenoid de-energises, expect `DONE` when Z_UP_SENSOR triggers.
8. Send `FIRE` (with Z confirmed down) → laser relay fires for `dwellMs`. Expect `LASER ON`, `LASER OFF`, `DONE`.
9. Trigger each fault condition and verify correct `FAULT …` emission. Resolve condition and verify `FAULT_CLEARED …` auto-emission.
10. Press E-stop. Verify all 3 ALMs fire → `ESTOP`. Release → `ESTOP_CLEARED`.
11. Exercise `SET_TRAVEL` / `LOADPOS` / `SET_SOLENOID`; reboot and confirm settings survive via `SNAPSHOT`.
12. With drivers enabled, send `RUN_START {"totalCells":3,"startIndex":0,"programId":1,"mode":"SPOT"}` then drive 3 cells via MOVE / Z / FIRE primitives, sending `RUN_CELL_DONE <idx>` after each. Finish with `RUN_COMPLETE`. Verify `RUN phase=*` events.

---

## Notes

- **Y gantry tramming** — `SET_TRAM <mm>` (or JSON alias `setGantryOffset`)
  offsets Y_RIGHT from Y_LEFT at the end of homing. Persisted to EEPROM.

- **E-stop detection** — Firmware distinguishes E-stop (all 3 ALMs
  simultaneously) from a single-driver fault. Hardware cuts 48 V; the Teensy
  detects via ALM and de-energises solenoids and laser.

- **Z safety interlock** — `FIRE` refuses to fire if `Z_DOWN_SENSOR` is not
  active. `MOVE` / `JOG` refuse to run unless Z is confirmed UP.

- **Air-pressure fault** — Triggers when pressure drops below
  `SET_AIR_THRESHOLD`. Auto-clears when pressure returns above threshold
  (`FAULT_CLEARED FAULT_LOW_AIR` event).

- **Who drives the cell loop** — The Raspberry Pi drives the per-cell
  `MOVE → Z_DOWN → FIRE → Z_UP` sequence. The Teensy executes primitives and
  tracks run metadata so it can tag faults with `cellIndex=N` and emit
  `RUN phase=cell idx=N` events when the Pi reports cell completion.

- **EEPROM layout upgrade** — `EEPROM_MAGIC_VALUE` is bumped to `0xCA1AC4D2`
  for Rev4. On first boot after a firmware update, settings auto-reset to
  defaults — send `SET_TRAVEL`, `LOADPOS`, `SETMOTION`, `SET_SOLENOID`, and
  `SET_AIR_THRESHOLD` to re-populate.
