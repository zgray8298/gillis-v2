#!/bin/bash
# start-gillis-gui.sh
#
# Launches the Gillis V2 GUI in kiosk mode on the Pi.
# - Ensures the Node backend is running (GILLIS_SERIAL=real, port 8787).
# - Waits until the backend is responsive.
# - Disables screen blanking / cursor / screensaver.
# - Launches Chromium full-screen pointing at localhost:8787.
#
# Designed to be invoked from a desktop .desktop shortcut. Idempotent —
# repeated invocations don't spawn duplicate backends.

set -e

# --- Configuration -----------------------------------------------------------
# Resolve project dir relative to $HOME so the same script works for both the
# default `pi` user and the production `ionetic` user without an edit. Override
# by exporting GILLIS_PROJECT_DIR before invoking if your repo lives elsewhere.
PROJECT_DIR="${GILLIS_PROJECT_DIR:-${HOME}/Desktop/gillis-v2-ui-v2}"
PORT=8787                                # Must match server/index.js PORT
SERIAL_MODE=real                         # 'real' = open /dev/ttyACM0, 'mock' = simulated
# BCM pin the pendant E-stop NC contact is wired to (other side to Pi GND).
# See gui/server/piGpioEstop.js header for wiring details. Leave blank to
# disable the GPIO monitor (e.g. if running on hardware without the wire run).
ESTOP_PIN=23
URL="http://localhost:${PORT}/"
LOG="/tmp/gillis-backend.log"

# --- Start backend if not already running -----------------------------------
if ! pgrep -f "node .*server/index.js" >/dev/null; then
  echo "[gillis-launcher] backend not running, starting it..."
  cd "${PROJECT_DIR}"
  GILLIS_SERIAL=${SERIAL_MODE} PORT=${PORT} GILLIS_ESTOP_PIN=${ESTOP_PIN} nohup node server/index.js >"${LOG}" 2>&1 &
  disown
else
  echo "[gillis-launcher] backend already running, reusing"
fi

# --- Wait for backend to respond --------------------------------------------
echo "[gillis-launcher] waiting for backend on port ${PORT}..."
for i in $(seq 1 30); do
  if curl -sf "${URL}" >/dev/null 2>&1; then
    echo "[gillis-launcher] backend ready"
    break
  fi
  sleep 0.5
  if [ "$i" -eq 30 ]; then
    echo "[gillis-launcher] WARN: backend not responding after 15s, launching browser anyway"
  fi
done

# --- Suppress screen blanking + cursor while GUI is up ----------------------
# These are no-ops on Wayland; Pi OS Bookworm uses labwc and these settings
# are handled by the compositor. Safe to call regardless.
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true

# Hide cursor if unclutter is installed
if command -v unclutter >/dev/null; then
  pkill -f "unclutter -idle 0.5" 2>/dev/null || true
  unclutter -idle 0.5 -root &
fi

# --- Launch Chromium in kiosk mode ------------------------------------------
# --kiosk           : full screen, no chrome, no escape via standard shortcuts
# --noerrdialogs    : suppress "did Chrome crash?" prompts after kill
# --disable-infobars: suppress the "Chrome is being controlled" yellow bar
# --disable-session-crashed-bubble : skip restore-session prompts
# --check-for-update-interval=31536000 : effectively disable update checks
# --overscroll-history-navigation=0   : disable swipe-back gesture on touchscreen
#
# Binary name differs across Pi OS / Debian releases:
#   - Bullseye (Debian 11) and older: `chromium-browser`
#   - Bookworm (Debian 12) / Trixie (Debian 13): `chromium`
# Pick whichever is on the PATH so a fresh Pi OS install autoboots without an edit.
if   command -v chromium         >/dev/null 2>&1; then CHROMIUM=chromium
elif command -v chromium-browser >/dev/null 2>&1; then CHROMIUM=chromium-browser
else
  echo "[gillis-launcher] ERROR: no chromium binary found on PATH"
  exit 1
fi
exec "$CHROMIUM" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 \
  --start-fullscreen \
  --password-store=basic \
  "${URL}"
