# Wireless deploy to the Pi — setup guide

One-time setup so you can push GUI updates over WiFi instead of USB sticks.

End state: from Windows, run `.\deploy-pi.ps1` → builds locally → pushes `dist/` to the Pi over SSH → refresh the browser on the touchscreen. ~10 seconds.

---

## Step 1 — Pi onto WiFi + SSH enabled (one time, on the Pi)

You only need a keyboard plugged into the Pi for ~3 minutes. (Or use the touchscreen on-screen keyboard if you have one.)

**Option A — easy GUI way (RPi OS desktop):**

1. On the Pi, click the network icon in the top-right of the taskbar.
2. Select your WiFi network, enter the password.
3. Open a terminal: `Ctrl+Alt+T` (or from the menu).
4. Enable SSH:
   ```bash
   sudo raspi-config nonint do_ssh 0
   sudo systemctl enable --now ssh
   ```
5. Find the IP and hostname:
   ```bash
   hostname -I        # → e.g. 192.168.1.42
   hostname           # → e.g. raspberrypi
   ```
6. (Recommended) Rename the Pi so it's easy to address as `gillis.local` over mDNS:
   ```bash
   sudo hostnamectl set-hostname gillis
   sudo reboot
   ```

**Option B — terminal only:**

```bash
# WiFi
sudo nmcli device wifi connect "YOUR_SSID" password "YOUR_PASSWORD"
# SSH
sudo systemctl enable --now ssh
# Hostname
sudo hostnamectl set-hostname gillis
sudo reboot
```

After reboot, test from Windows PowerShell:
```powershell
ping gillis.local
ssh pi@gillis.local        # or whatever user you set up — likely 'pi' or 'zack'
```

If `gillis.local` doesn't resolve, use the IP from `hostname -I`. mDNS sometimes fails on guest WiFi networks — a static DHCP lease on your router is more reliable.

---

## Step 2 — SSH key auth from Windows (no more password prompts)

In PowerShell on your Windows machine:

```powershell
# Generate a key (accept defaults, leave passphrase empty for convenience)
ssh-keygen -t ed25519 -C "zack@gillis-deploy"

# Push the public key to the Pi (one password prompt, last one ever)
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh pi@gillis.local "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# Test — should log in with no password
ssh pi@gillis.local "echo it works"
```

---

## Step 3 — Tell me the Pi-side path

The deploy script needs to know where `gillis-v2-ui-v2/` lives on the Pi. On the Pi run:
```bash
ls ~/ && pwd
find ~ -maxdepth 3 -name "dist" -path "*gillis*" 2>/dev/null
```

Send me the path that contains `dist/` (e.g. `/home/pi/gillis-v2-ui-v2`). I'll set it in the script.

---

## Step 4 — Deploy script (already in workspace)

`deploy-pi.ps1` does the whole thing. Edit the top of it once with:
- `$PiUser` (probably `pi` or `zack`)
- `$PiHost` (`gillis.local` or the IP)
- `$PiProjectRoot` (path from Step 3)

Then from anywhere in PowerShell:
```powershell
cd "C:\Users\zackg\OneDrive\Documents\GRAYZ\IONETIC\Gillis XL\Claude Programming"
.\deploy-pi.ps1
```

That's it. Refresh the browser on the Pi touchscreen (Ctrl+R or pull-to-refresh) and you see the new build.

---

## Optional polish (later)

- **Auto-refresh the kiosk browser:** add an SSH command to the script that sends `xdotool key ctrl+r` to the running Chromium. Tells me when you want it.
- **Run backend as a systemd service:** so it survives reboots and the deploy script can `systemctl restart gillis-ui` when you eventually push backend changes too.
- **rsync instead of tar-over-ssh:** marginally faster on big trees. Requires installing rsync via Git Bash or WSL. Not worth it for `dist/` (~1 MB).
