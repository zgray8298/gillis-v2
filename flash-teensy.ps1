# flash-teensy.ps1 - flash the Gillis Teensy 4.1 THROUGH THE PI (no USB swapping).
#
# The Teensy stays plugged into the Pi. This script:
#   1. Finds the newest compiled .hex (Arduino IDE: Sketch -> Export Compiled Binary)
#   2. Copies it to the Pi
#   3. Stops the Gillis backend (it holds the Teensy serial port)
#   4. Reboots the Teensy into its bootloader and flashes it with teensy_loader_cli
#   5. Restarts the backend (the GUI reconnects by itself)
#
# Gillis must be POWERED ON (the Teensy VBUS pad is cut - it runs off the
# machine's 5V rail, not USB).
#
# Usage:
#   .\flash-teensy.ps1 -PiHost 10.10.10.157            # flash
#   .\flash-teensy.ps1 -PiHost 10.10.10.157 -Setup     # ONE-TIME Pi setup (installs loader)
#   .\flash-teensy.ps1 -PiHost 10.10.10.157 -HexPath C:\path\to\file.hex

param(
  [string]$PiHost = "",
  [string]$PiUser = "ionetic",
  [string]$PiProjectRoot = "/home/ionetic/Desktop/gillis-v2-ui-v2",
  [string]$SshKey = "",
  [string]$HexPath = "",
  [switch]$Setup
)

# Continue (not Stop): Windows PowerShell 5.1 turns harmless ssh/scp stderr
# warnings into terminating errors under Stop. We check $LASTEXITCODE instead.
$ErrorActionPreference = "Continue"
# Sketch folder: "teensy firmware\gillis_firmware" in the Gillis XL work folder,
# "firmware\gillis_firmware" in the gillis-v2 git repo.
$SketchDir = Join-Path $PSScriptRoot "teensy firmware\gillis_firmware"
if (-not (Test-Path $SketchDir)) { $SketchDir = Join-Path $PSScriptRoot "firmware\gillis_firmware" }

function Write-Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

if (-not $PiHost) { Fail "Give the Pi address, e.g.  .\flash-teensy.ps1 -PiHost 10.10.10.157  (on the Pi: hostname -I)" }

# SSH key: explicit > ~/.ssh/gillis_deploy_key (permission-fixed copy) > next to script
if (-not $SshKey) {
  $userKey = Join-Path $env:USERPROFILE ".ssh\gillis_deploy_key"
  $kitKey  = Join-Path $PSScriptRoot "gillis_deploy_key"
  if (Test-Path $userKey) { $SshKey = $userKey } else { $SshKey = $kitKey }
}
if (-not (Test-Path $SshKey)) { Fail "No SSH key found at $SshKey" }
$SshOpts = @("-i", $SshKey, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new")
$Target = "$PiUser@$PiHost"

Write-Step "Checking the Pi at $Target"
$r = & ssh @SshOpts -o BatchMode=yes -o ConnectTimeout=6 $Target "echo ok" 2>$null
if ($LASTEXITCODE -ne 0 -or $r -ne "ok") { Fail "Cannot SSH to $Target. Check the IP and that the laptop is on the same network." }
Write-Host "  connected" -ForegroundColor Green

# Remote scripts are written locally with LF endings, copied over and run with
# bash - avoids PowerShell 5.1 mangling quotes in long ssh command lines.
$TmpDir = Join-Path $env:TEMP "gillis-flash"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
function Write-Lf($path, $text) {
  [System.IO.File]::WriteAllText($path, ($text -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------------------
# ONE-TIME SETUP
# ---------------------------------------------------------------------------
if ($Setup) {
  $setupSh = @'
#!/bin/bash
set -e
echo "Installing teensy_loader_cli (needs internet on the Pi)..."
sudo apt-get update -qq
sudo apt-get install -y teensy-loader-cli
echo "Installing Teensy USB permission rules..."
sudo tee /etc/udev/rules.d/00-teensy.rules >/dev/null <<'RULES'
# PJRC Teensy - allow non-root access for teensy_loader_cli + serial
ATTRS{idVendor}=="16c0", ATTRS{idProduct}=="04[789B]?", ENV{ID_MM_DEVICE_IGNORE}="1", ENV{ID_MM_PORT_IGNORE}="1"
ATTRS{idVendor}=="16c0", ATTRS{idProduct}=="04[789A]?", ENV{MTP_NO_PROBE}="1"
SUBSYSTEMS=="usb", ATTRS{idVendor}=="16c0", ATTRS{idProduct}=="04[789ABCD]?", MODE:="0666"
KERNEL=="ttyACM*", ATTRS{idVendor}=="16c0", ATTRS{idProduct}=="04[789B]?", MODE:="0666"
RULES
sudo udevadm control --reload-rules
sudo udevadm trigger
echo
teensy_loader_cli --list-mcus >/dev/null 2>&1 || true
command -v teensy_loader_cli && echo "SETUP OK"
'@
  $local = Join-Path $TmpDir "gillis-flash-setup.sh"
  Write-Lf $local $setupSh
  Write-Step "Copying setup script to the Pi"
  & scp @SshOpts -q $local "${Target}:/tmp/gillis-flash-setup.sh"
  if ($LASTEXITCODE -ne 0) { Fail "scp failed" }
  Write-Step "Running setup on the Pi (it may ask for the Pi's password for sudo)"
  & ssh @SshOpts -t $Target "bash /tmp/gillis-flash-setup.sh"
  if ($LASTEXITCODE -ne 0) { Fail "Setup failed - see messages above." }
  Write-Step "Setup complete. Now run without -Setup to flash."
  exit 0
}

# ---------------------------------------------------------------------------
# FIND THE HEX
# ---------------------------------------------------------------------------
Write-Step "Finding compiled firmware"
if (-not $HexPath) {
  $hex = Get-ChildItem -Path $SketchDir -Recurse -Filter *.hex -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $hex) {
    Fail "No .hex found under $SketchDir`nIn Arduino IDE open gillis_firmware.ino, then Sketch -> Export Compiled Binary."
  }
  $HexPath = $hex.FullName
}
if (-not (Test-Path $HexPath)) { Fail "Hex not found: $HexPath" }
$hexTime = (Get-Item $HexPath).LastWriteTime
Write-Host "  $HexPath"
Write-Host "  built $hexTime"

# Stale-build guard: refuse if any source file is newer than the hex.
$newestSrc = Get-ChildItem -Path $SketchDir -Recurse -Include *.ino,*.h,*.cpp -ErrorAction SilentlyContinue |
             Where-Object { $_.FullName -notmatch '\\build\\' } |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newestSrc -and $newestSrc.LastWriteTime -gt $hexTime) {
  Write-Host ""
  Write-Host "The .hex is OLDER than $($newestSrc.Name) (changed $($newestSrc.LastWriteTime))." -ForegroundColor Yellow
  Fail "Re-export it: Arduino IDE -> Sketch -> Export Compiled Binary, then run this again."
}

# ---------------------------------------------------------------------------
# SAFETY CONFIRM
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Before flashing:" -ForegroundColor Yellow
Write-Host "  - Gillis POWERED ON (Teensy runs off the machine's 5V)"
Write-Host "  - Laser OFF, air OFF (outputs are undefined for a few seconds while flashing)"
Write-Host "  - No program running"
$ans = Read-Host "Type FLASH to continue"
if ($ans -ne "FLASH") { Fail "Cancelled." }

# ---------------------------------------------------------------------------
# COPY + FLASH
# ---------------------------------------------------------------------------
$flashSh = @"
#!/bin/bash
set -u
HEX=/tmp/gillis-firmware.hex
PROJ='$PiProjectRoot'
LOG=/tmp/gillis-backend.log
if ! command -v teensy_loader_cli >/dev/null; then
  echo "ERROR: teensy_loader_cli is not installed on the Pi. Run this script once with -Setup."
  exit 10
fi
echo "Stopping Gillis backend..."
pkill -f "node .*server/index.js" || true
sleep 1.5
if pgrep -af "server/index.js" >/dev/null; then
  echo "  backend still running - forcing it to stop"
  pkill -9 -f "server/index.js" || true
  sleep 1
fi
TTY=`$(ls /dev/serial/by-id/*Teensy* 2>/dev/null | head -1)
[ -z "`$TTY" ] && TTY=`$(ls /dev/ttyACM* 2>/dev/null | head -1)
if [ -n "`$TTY" ]; then
  echo "Rebooting Teensy into bootloader via `$TTY"
  # The Teensy only reboots on a CHANGE of baud rate to 134, so step through
  # 9600 first (a port left at 134 by an earlier attempt would do nothing).
  stty -F "`$TTY" 9600 || echo "  (stty 9600 failed)"
  sleep 0.3
  stty -F "`$TTY" 134 || echo "  (stty 134 failed)"
else
  echo "No Teensy serial port found (already in bootloader, or Gillis is off?) - waiting anyway"
fi
echo "Flashing (waits up to 60 s for the bootloader)..."
timeout 15 teensy_loader_cli --mcu=TEENSY41 -w -v "`$HEX"
RC=`$?
if [ `$RC -eq 124 ]; then
  # Fallback: ask teensy_loader_cli to do the soft reboot itself (USB
  # control request), then keep waiting.
  echo "No bootloader yet - trying teensy_loader_cli soft reboot..."
  timeout 45 teensy_loader_cli --mcu=TEENSY41 -s -w -v "`$HEX"
  RC=`$?
fi
if [ `$RC -eq 124 ]; then echo "ERROR: timed out waiting for the Teensy bootloader. Is Gillis powered on? If so, press the button on the Teensy once."; fi
sleep 2
echo "Restarting Gillis backend..."
cd "`$PROJ" && GILLIS_SERIAL=real PORT=8787 setsid nohup node server/index.js > "`$LOG" 2>&1 < /dev/null &
sleep 4
if pgrep -f "node .*server/index.js" >/dev/null; then echo "Backend running"; else echo "WARNING: backend not running - start it from the Gillis desktop icon"; fi
exit `$RC
"@
$localSh = Join-Path $TmpDir "gillis-flash.sh"
Write-Lf $localSh $flashSh

Write-Step "Copying firmware to the Pi"
& scp @SshOpts -q $HexPath "${Target}:/tmp/gillis-firmware.hex"
if ($LASTEXITCODE -ne 0) { Fail "scp of hex failed" }
& scp @SshOpts -q $localSh "${Target}:/tmp/gillis-flash.sh"
if ($LASTEXITCODE -ne 0) { Fail "scp of flash script failed" }

Write-Step "Flashing the Teensy"
& ssh @SshOpts $Target "bash /tmp/gillis-flash.sh"
$rc = $LASTEXITCODE
if ($rc -ne 0) { Fail "Flash FAILED (exit $rc) - see messages above. The old firmware is still on the Teensy unless it says otherwise." }

Write-Step "Done. The Gillis GUI reconnects by itself (press Ctrl+R on the Pi if it doesn't within ~10 s). Home the machine before use."
