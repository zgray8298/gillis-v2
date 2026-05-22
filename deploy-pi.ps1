# deploy-pi.ps1 — push a freshly-built GUI to the Pi over SSH.
#
# What it does:
#   1. Runs `npm run build` in gui/
#   2. Streams the dist/ folder to the Pi via tar over ssh (no rsync needed)
#   3. Refreshes the dist directory atomically (writes to dist.new, then swaps)
#
# NOTE: The local folder is `gui/` but the Pi-side path is still
# `/home/ionetic/Desktop/gillis-v2-ui-v2` to avoid breaking the live machine.
# Rename the Pi-side directory on the next on-site visit if desired.
#
# Backend doesn't need a restart — express.static reads from disk each request.
# Just refresh the browser on the Pi (Ctrl+R) after the script finishes.
#
# Usage:
#   .\deploy-pi.ps1                 # build + deploy
#   .\deploy-pi.ps1 -SkipBuild      # use the existing dist/ (e.g. after manual build)
#
# Edit the three variables below once and you're set.

param(
  [switch]$SkipBuild
)

# ---------- CONFIG — edit these for your Pi ----------
$PiUser        = "ionetic"                           # SSH username on the Pi
$PiHostCandidates = @("Gillis.local", "192.168.11.212")  # tried in order
$PiProjectRoot = "/home/ionetic/Desktop/gillis-v2-ui-v2"  # path on the Pi that contains dist/
# -----------------------------------------------------

$ErrorActionPreference = "Stop"
$LocalProject = Join-Path $PSScriptRoot "gui"
$LocalDist    = Join-Path $LocalProject "dist"

function Write-Step($msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

# Sanity checks
if (-not (Test-Path $LocalProject)) {
  Write-Host "Local project not found at $LocalProject" -ForegroundColor Red
  exit 1
}

# 1. Build
if (-not $SkipBuild) {
  Write-Step "Building UI (npm run build)"
  Push-Location $LocalProject
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Build failed (exit $LASTEXITCODE)" -ForegroundColor Red
      exit 1
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Step "Skipping build (-SkipBuild)"
}

if (-not (Test-Path $LocalDist)) {
  Write-Host "dist/ not found at $LocalDist after build" -ForegroundColor Red
  exit 1
}

# 2. Find a reachable Pi address (mDNS sometimes flakes; fall back to known IPs)
Write-Step "Locating Pi"
$PiHost = $null
foreach ($c in $PiHostCandidates) {
  Write-Host "  trying $c..." -NoNewline
  $null = ssh -o BatchMode=yes -o ConnectTimeout=4 "$PiUser@$c" "echo ok" 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host " OK" -ForegroundColor Green
    $PiHost = $c
    break
  } else {
    Write-Host " no" -ForegroundColor DarkGray
  }
}
if (-not $PiHost) {
  Write-Host "Could not reach the Pi at any of: $($PiHostCandidates -join ', ')" -ForegroundColor Red
  Write-Host "On the Pi screen, open a terminal and run:  hostname -I" -ForegroundColor Yellow
  $entered = Read-Host "Enter Pi IP (or blank to abort)"
  if (-not $entered) { exit 1 }
  $null = ssh -o BatchMode=yes -o ConnectTimeout=4 "$PiUser@$entered" "echo ok" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Still cannot reach $entered. Aborting." -ForegroundColor Red
    exit 1
  }
  $PiHost = $entered
}
$Target = "$PiUser@$PiHost"

# 3. Deploy via scp (PowerShell mangles binary pipes, so we can't use tar | ssh here).
#    Strategy: scp each top-level item under dist/ into a staging dir on the Pi,
#    then atomic-swap dist.new -> dist server-side.
Write-Step "Preparing staging directory on ${Target}:${PiProjectRoot}"
ssh $Target "mkdir -p '$PiProjectRoot' && rm -rf '$PiProjectRoot/dist.new' && mkdir '$PiProjectRoot/dist.new'"
if ($LASTEXITCODE -ne 0) {
  Write-Host "Could not prepare staging dir on Pi" -ForegroundColor Red
  exit 1
}

Write-Step "Copying dist/ to ${Target}:${PiProjectRoot}/dist.new"
$items = Get-ChildItem -Path $LocalDist -Force
foreach ($item in $items) {
  & scp -r $item.FullName "${Target}:$PiProjectRoot/dist.new/"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "scp failed for $($item.Name) (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
}

Write-Step "Atomic swap on Pi"
$swap = "set -e; rm -rf '$PiProjectRoot/dist.old'; if [ -d '$PiProjectRoot/dist' ]; then mv '$PiProjectRoot/dist' '$PiProjectRoot/dist.old'; fi; mv '$PiProjectRoot/dist.new' '$PiProjectRoot/dist'; echo deployed"
ssh $Target $swap
if ($LASTEXITCODE -ne 0) {
  Write-Host "Atomic swap failed (exit $LASTEXITCODE)" -ForegroundColor Red
  exit 1
}

Write-Step "Done. Refresh the browser on the Pi (Ctrl+R) to see the new build."
