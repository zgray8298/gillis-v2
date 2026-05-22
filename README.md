# Gillis V2

CNC welder control system for the Gillis V2 machine. Two compute units:

- **Teensy 4.1** — runs the realtime firmware: steppers, homing, sensors, safety, serial protocol.
- **Raspberry Pi** — runs the operator GUI and orchestrates the weld cell loop. Talks to the Teensy over USB serial (Rev4 protocol).

## Repo layout

```
firmware/     Teensy 4.1 firmware (Arduino-style C++)
gui/          React + Vite operator GUI, plus Express backend (server/)
pi-kiosk/     Pi launcher script and desktop entry for kiosk-mode boot
docs/         Design doc, runbooks, brand assets
deploy-pi.ps1         Local-network deploy: build locally, push dist/ to Pi
deploy-pi-onsite.ps1  On-site deploy: push source to Pi, build on Pi
```

## Deploying

From a dev laptop on the same network as the Pi:

```powershell
.\deploy-pi.ps1
```

This builds the GUI locally and pushes `gui/dist/` to the Pi via SSH. The
backend reads `dist/` from disk on each request, so a browser refresh on the
Pi is all that's needed to pick up changes.

From a fresh PC at the client site (e.g. via USB stick):

```powershell
.\deploy-pi-onsite.ps1
```

This pushes the source files to the Pi and builds there, so the client PC
doesn't need Node.js installed.

The Pi-side target path is `/home/ionetic/Desktop/gillis-v2-ui-v2` for
historical reasons. The local folder is `gui/`; the asymmetry will be cleaned
up on a future on-site visit.

## Firmware

Open `firmware/gillis_firmware/` in Arduino IDE 2.x with the Teensyduino
add-on, select Teensy 4.1, and upload via USB. See `docs/design-v15.docx` for
pin assignments, serial protocol, and the wider system architecture.

## Pi-side launcher

`pi-kiosk/start-gillis-gui.sh` and `pi-kiosk/Gillis Welder.desktop` are
installed on the Pi at `/home/pi/Desktop/`. They start the Node backend and
launch Chromium in kiosk mode pointing at `localhost:8787`.
