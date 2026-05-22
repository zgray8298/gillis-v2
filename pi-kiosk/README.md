# Gillis V2 Pi Kiosk Launcher

Two files that turn the Gillis V2 GUI into a desktop-clickable, kiosk-mode app on the Pi.

## Files

- `start-gillis-gui.sh` — shell script that starts the Node backend (if not already running) and launches Chromium full-screen pointing at `http://localhost:8787`.
- `Gillis Welder.desktop` — XDG desktop entry that runs the script when double-tapped.

## Install on the Pi

Assuming the UI repo lives at `/home/pi/gillis-v2-ui-v2` (adjust paths if not):

```bash
# Copy the launcher script into the project folder and make it executable
cp "start-gillis-gui.sh" /home/pi/gillis-v2-ui-v2/start-gillis-gui.sh
chmod +x /home/pi/gillis-v2-ui-v2/start-gillis-gui.sh

# Put the desktop shortcut on the Pi's desktop
cp "Gillis Welder.desktop" ~/Desktop/
chmod +x ~/Desktop/"Gillis Welder.desktop"

# (Optional) Install unclutter so the cursor hides while the GUI is up
sudo apt install -y unclutter

# (Optional) Make sure the prod build exists — the backend serves dist/
cd /home/pi/gillis-v2-ui-v2
npm run build
```

After that, double-tap "Gillis Welder" on the desktop. It should:

1. Start the Node backend on port 8787 if it isn't already running
2. Wait up to 15s for the backend to respond
3. Hide the cursor (if `unclutter` is installed)
4. Disable screen blanking / DPMS
5. Launch Chromium full-screen on the GUI

## Configuration

Edit the top of `start-gillis-gui.sh` if any of these need to change:

- `PROJECT_DIR` — where the UI repo is on the Pi
- `PORT` — must match the backend's port (default 8787)
- `SERIAL_MODE` — `real` for actual Teensy, `mock` for simulated machine

## Exiting kiosk mode

`Ctrl+F4` or `Alt+F4` closes Chromium. The backend keeps running in the background. To stop the backend too:

```bash
pkill -f "node .*server/index.js"
```

## Auto-start at boot (optional)

If you want the GUI to come up automatically on Pi boot rather than requiring a tap:

### Pi OS Bookworm (Wayland / labwc)

Create `~/.config/labwc/autostart`:

```bash
mkdir -p ~/.config/labwc
echo '/home/pi/gillis-v2-ui-v2/start-gillis-gui.sh &' >> ~/.config/labwc/autostart
chmod +x ~/.config/labwc/autostart
```

### Pi OS Bullseye and older (X11 / LXDE)

Add to `~/.config/lxsession/LXDE-pi/autostart`:

```
@/home/pi/gillis-v2-ui-v2/start-gillis-gui.sh
```

## Troubleshooting

- **Backend doesn't start**: check `/tmp/gillis-backend.log` for the Node process's stderr.
- **Chromium opens but page is blank**: backend may not be serving `dist/`. Run `npm run build` in the project folder.
- **Chromium opens but says connection refused**: backend isn't running, or is on a different port. `curl http://localhost:8787/` to verify.
- **Touchscreen unresponsive after a few minutes**: screen blanking wasn't disabled — install `unclutter` and re-launch, or add `consoleblank=0` to `/boot/cmdline.txt`.
- **Returns to desktop unexpectedly**: Chromium crashed. Check `/tmp/gillis-backend.log` and Chromium's own crash log under `~/.config/chromium/Crash Reports/`.
