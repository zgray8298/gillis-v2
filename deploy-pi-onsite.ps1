# deploy-pi-onsite.ps1 — deploy when working from a fresh PC at a client site.
#
# Differences from deploy-pi.ps1:
#   - Builds on the Pi instead of locally, so the client PC doesn't need Node.js.
#   - Auto-discovers the Pi: tries Gillis.local first, falls back to a list of
#     known IPs, then prompts.
#   - Uses an SSH key from a path next to the script, so a USB-borne copy works.
#
# Usage:
#   .\deploy-pi-onsite.ps1                      # auto-discover Pi
#   .\deploy-pi-onsite.ps1 -PiHost 10.0.0.42    # explicit Pi IP/host

param(
  [string]$PiHost = "",
  [string]$PiUser = "ionetic",
  [string]$PiProjectRoot = "/home/ionetic/Desktop/gillis-v2-ui-v2",
  [string]$SshKey = ""    # optional explicit key path; otherwise script looks next to itself
)

$ErrorActionPreference = "Stop"
$LocalProject = Join-Path $PSScriptRoot "gillis-v2-ui-v2"

function Write-Step($msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

# Locate SSH key — explicit param wins, then ./gillis_deploy_key, then default ~/.ssh/id_ed25519
if (-not $SshKey) {
  $kitKey = Join-Path $PSScriptRoot "gillis_deploy_key"
  if (Test-Path $kitKey) {
    $SshKey = $kitKey
  } else {
    $SshKey = Join-Path $env:USERPROFILE ".ssh\id_ed25519"
  }
}
if (-not (Test-Path $SshKey)) {
  Write-Host "No SSH key found at $SshKey. Either copy your key here or generate a new one and push to the Pi." -ForegroundColor Red
  exit 1
}
$SshKeyOpts = @("-i", $SshKey, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new")

# Auto-discover Pi host
function Test-PiReachable($candidate) {
  if (-not $candidate) { return $false }
  $r = & ssh @SshKeyOpts -o BatchMode=yes -o ConnectTimeout=4 "$PiUser@$candidate" "echo ok" 2>$null
  return ($LASTEXITCODE -eq 0 -and $r -eq "ok")
}

if (-not $PiHost) {
  Write-Step "Auto-discovering Pi"
  $candidates = @("Gillis.local", "gillis.local", "192.168.11.212")
  foreach ($c in $candidates) {
    Write-Host "  trying $c..." -NoNewline
    if (Test-PiReachable $c) {
      Write-Host " OK" -ForegroundColor Green
      $PiHost = $c
      break
    } else {
      Write-Host " no" -ForegroundColor DarkGray
    }
  }
}

if (-not $PiHost -or -not (Test-PiReachable $PiHost)) {
  Write-Host ""
  Write-Host "Could not reach the Pi automatically." -ForegroundColor Yellow
  Write-Host "On the Pi screen, open a terminal and run:  hostname -I"
  $PiHost = Read-Host "Enter the IP it printed"
  if (-not (Test-PiReachable $PiHost)) {
    Write-Host "Still cannot reach $PiHost via SSH. Aborting." -ForegroundColor Red
    exit 1
  }
}

$Target = "$PiUser@$PiHost"
Write-Step "Using Pi at $Target  (key: $SshKey)"

# Sanity check the local project
if (-not (Test-Path $LocalProject)) {
  Write-Host "Local project not found at $LocalProject" -ForegroundColor Red
  exit 1
}

# Copy source files (NOT node_modules, NOT dist) to Pi for building.
# IMPORTANT: server/ must be included — the run orchestrator and serial drivers live there
# and Express serves dist/ via server/index.js, so a missing server/ leaves the Pi running an
# older backend that may not understand the new GUI's commands.
Write-Step "Pushing source to ${Target}:${PiProjectRoot}"
$items = @("src", "server", "public", "index.html", "vite.config.js", "eslint.config.js", "package.json", "package-lock.json")
foreach ($name in $items) {
  $localItem = Join-Path $LocalProject $name
  if (Test-Path $localItem) {
    Write-Host "  scp $name"
    & scp @SshKeyOpts -r -q $localItem "${Target}:$PiProjectRoot/"
    if ($LASTEXITCODE -ne 0) {
      Write-Host "scp failed for $name (exit $LASTEXITCODE)" -ForegroundColor Red
      exit 1
    }
  }
}

# Build on the Pi
Write-Step "Building on the Pi (this takes ~30-60s on a Pi 4)"
$buildCmd = "set -e; cd '$PiProjectRoot'; npm install --no-audit --no-fund --silent 2>&1 | tail -5; npm run build 2>&1 | tail -10"
& ssh @SshKeyOpts $Target $buildCmd
if ($LASTEXITCODE -ne 0) {
  Write-Host "Build failed on Pi (exit $LASTEXITCODE)" -ForegroundColor Red
  exit 1
}

Write-Step "Done. To pick up server/ changes, restart the backend on the Pi:"
Write-Host "  ssh $Target 'pkill -f `"node server/index.js`"; cd $PiProjectRoot; nohup env GILLIS_SERIAL=real npm run server > /tmp/gillis-server.log 2>&1 &'" -ForegroundColor DarkGray
Write-Host "Or just kill chromium and click the Gillis desktop icon — launcher script handles backend restart if it's down." -ForegroundColor DarkGray
