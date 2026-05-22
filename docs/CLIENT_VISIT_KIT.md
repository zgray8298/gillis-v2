# Client visit deploy kit

What to prep tonight so tomorrow's deploy from the client PC is straightforward.

---

## Bring on a USB stick

Put these on a USB stick (a normal FAT32/exFAT stick is fine):

1. **The whole `Claude Programming` workspace folder** — has source, `deploy-pi-onsite.ps1`, this checklist
2. **A copy of your SSH private key** renamed to `gillis_deploy_key`:
   ```
   Copy   C:\Users\zackg\.ssh\id_ed25519       →  USB:\gillis_deploy_key
   Copy   C:\Users\zackg\.ssh\id_ed25519.pub   →  USB:\gillis_deploy_key.pub
   ```
   `deploy-pi-onsite.ps1` looks for `gillis_deploy_key` next to itself, so dropping it in the workspace folder makes everything work without touching the client PC's `.ssh` folder.
3. **(Optional) Node.js LTS installer** — only needed if you want to fall back to `deploy-pi.ps1` (PC-build). Download from https://nodejs.org/en/download — pick the Windows `.msi`. With the onsite script we'll use, this isn't required.
4. **Your Pi's `ionetic` user password** written down somewhere — needed only if SSH key auth fails and you have to fall back to password auth.

---

## At the client site

### Step 1 — Connect the Pi to the client's WiFi

Easiest method (uses the Pi's touchscreen):

1. Plug Pi into power, wait for desktop.
2. If kiosk Chromium is full-screen, press **`Alt+F4`** (USB keyboard) or use the kiosk's exit method to drop to desktop.
3. Click the network icon in the top-right of the taskbar → pick the client's SSID → enter password.
4. Open a terminal (right-click desktop → Open Terminal, or `Ctrl+Alt+T`) and run:
   ```bash
   hostname -I
   ```
   Write down or photograph the IPv4 address. (Should be something like `10.x.x.x` or `192.168.x.x` depending on the client network.)

CLI alternative (if no GUI/keyboard handy):
```bash
sudo nmcli device wifi connect "CLIENT_SSID" password "THE_PASSWORD"
```

### Step 2 — Set up the client PC

1. Plug in the USB stick.
2. Copy the `Claude Programming` folder to the client PC (anywhere — Desktop is fine).
3. The `gillis_deploy_key` file is in there alongside `deploy-pi-onsite.ps1`. **Don't move it.**
4. Open PowerShell and one-time allow scripts to run:
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```
   Confirm with `Y`.

### Step 3 — Connect the client PC to the same WiFi as the Pi

Both machines must be on the same network for SSH to work. Use the client's WiFi.

### Step 4 — Deploy

In PowerShell:

```powershell
cd "<wherever you put the folder>\Claude Programming"
.\deploy-pi-onsite.ps1
```

What it does:
1. **Auto-discovers the Pi** — tries `Gillis.local` first (mDNS), then your home IP `192.168.11.212`, then prompts you for the IP if neither works.
2. **Pushes source** to the Pi over SSH (no `node_modules`, no `dist` — just changed source).
3. **Builds on the Pi** — Pi has Node already installed and used by the backend. Takes ~30–60s on a Pi 4.
4. Backend is already running, serves the new `dist/` on the next page load.

After the script completes, on the Pi: kill the kiosk Chromium (`killall chromium-browser` in a terminal, or `Alt+F4`) and click the **Gillis** desktop icon again to relaunch.

---

## Troubleshooting at the client site

**`Gillis.local` doesn't resolve and the auto-IP doesn't work.**
The script will prompt you for the IP. On the Pi screen, open a terminal and run `hostname -I` — type that IP into the prompt.

**Client WiFi blocks mDNS / has client isolation.**
Some corporate/guest networks prevent devices from seeing each other. Two workarounds:
- Use your phone as a hotspot — both PC and Pi join your hotspot, full local LAN.
- Connect Pi and PC with an Ethernet cable directly (if both have ports) — Windows will give them link-local IPs (`169.254.x.x`) and they can talk.

**SSH key not accepted.**
If the deploy script reports authentication failure, fall back to copying your key from the USB to the standard location and trying again:
```powershell
Copy-Item -Path .\gillis_deploy_key -Destination "$env:USERPROFILE\.ssh\id_ed25519"
Copy-Item -Path .\gillis_deploy_key.pub -Destination "$env:USERPROFILE\.ssh\id_ed25519.pub"
```
Make sure `$env:USERPROFILE\.ssh\` exists first (`mkdir $env:USERPROFILE\.ssh` if not).

**Backend isn't running on the Pi after a reboot.**
Click the Gillis desktop icon — the launcher script we set up starts the backend if it's not running, then opens Chromium.

**Build fails on the Pi with "out of memory" or kills mid-build.**
Pi 4 has tight RAM. If this happens, add swap on the Pi (one-time):
```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```
Then retry the deploy.

---

## After the visit

Optional cleanup:
- Delete the project folder from the client PC if it's not yours.
- The SSH key on the USB stick can stay — same key as your home machine, so revoking it would break your home deploy too. If the USB stick is lost, run on the Pi: `sed -i '/<the public key contents>/d' ~/.ssh/authorized_keys` to revoke just that key, then generate a fresh one at home.
