// Node.js backend for Gillis V2 UI.
// - HTTP: a couple of one-shot endpoints for commands/status.
// - WebSocket: pushes state events to the browser in real time.
// - In dev, Vite proxies /api and /ws here (see vite.config.js).
//
//   GILLIS_SERIAL=mock   (default) — simulated machine, good for desktop dev
//   GILLIS_SERIAL=real             — opens /dev/ttyACM0 and talks to the Teensy
//   GILLIS_PORT=/dev/ttyACM0       — override the serial device path
//   GILLIS_BAUD=115200             — override the baud rate

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createMockSerial } from './mockSerial.js';
import { createRealSerial } from './realSerial.js';
import { handleUsbCommand, isUsbCommand } from './usbLibrary.js';
import { handleProgramsCommand, isProgramsCommand } from './programStore.js';
import { handleSettingsCommand, isSettingsCommand } from './settingsStore.js';
import { createRunOrchestrator } from './runOrchestrator.js';
import { startEstopMonitor } from './piGpioEstop.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createSerial() {
  const mode = process.env.GILLIS_SERIAL || 'mock';
  if (mode === 'mock') return createMockSerial();
  if (mode === 'real') return createRealSerial();
  throw new Error(
    `GILLIS_SERIAL=${mode} not recognised. Use 'mock' (default) or 'real'.`
  );
}

const PORT = Number(process.env.PORT || 8787);
const app = express();
app.use(express.json({ limit: '256kb' }));

const serial = createSerial();

// RUN orchestrator: only active in real mode. The mockSerial already
// simulates the per-cell loop internally; installing an orchestrator on
// top would double-drive it. In real mode, the firmware's run_state.h
// expects the Pi to drive MOVE→Z_DOWN→FIRE→Z_UP per cell — that's this.
const orchestrator = serial.emitEvent
  ? createRunOrchestrator({ send: serial.send, emit: serial.emitEvent })
  : null;

// Pi-side E-stop button monitor (pendant-mounted button → Pi GPIO).
// Opt-in via GILLIS_ESTOP_PIN env var so dev / mock runs aren't affected.
// See gui/server/piGpioEstop.js for wiring + rationale.
if (serial.emitEvent && process.env.GILLIS_ESTOP_PIN) {
  startEstopMonitor({
    emit: serial.emitEvent,
    send: (cmd) => serial.send(cmd),
    line: process.env.GILLIS_ESTOP_PIN,
    chip: process.env.GILLIS_ESTOP_CHIP || 'gpiochip0',
  });
}

// Any command that the Pi backend handles itself (USB library, program
// persistence, RUN orchestration, ...) is routed through here BEFORE the
// serial driver. Returns null if nothing matched — callers then fall
// through to serial.send().
async function routeCommand(cmd) {
  const trimmed = String(cmd || '').trim();
  if (!trimmed) return null;
  const firstSpace = trimmed.indexOf(' ');
  const verb = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toUpperCase();
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1);

  if (isUsbCommand(verb)) {
    return handleUsbCommand(verb, rest);
  }

  if (isProgramsCommand(verb)) {
    return handleProgramsCommand(verb, rest);
  }

  // Settings persistence is Pi-side because the firmware's EEPROM round-trip
  // for SET_TRAVEL / SET_AIR_THRESHOLD doesn't always echo back in SNAPSHOT,
  // so without this the UI would re-init to compile-time defaults every boot.
  if (isSettingsCommand(verb)) {
    return handleSettingsCommand(verb, rest);
  }

  if (orchestrator && orchestrator.isRunCommand(verb)) {
    return orchestrator.handle(verb, rest);
  }

  // SHUTDOWN — graceful Pi halt so the operator can flip mains without
  // risking SD-card corruption. Schedule the actual `sudo /sbin/poweroff`
  // for ~1.5 s in the future so this reply lands on the GUI first and the
  // pendant has time to switch to its "Safe to power off" overlay before
  // the OS goes down. Requires a one-time sudoers entry on the Pi:
  //   ionetic ALL=(root) NOPASSWD: /sbin/poweroff
  // See docs/SHUTDOWN_SETUP.md for the deploy step.
  if (verb === 'SHUTDOWN') {
    // eslint-disable-next-line no-console
    console.log('[gillis backend] SHUTDOWN requested — scheduling clean poweroff in ~1.5s');
    setTimeout(() => {
      // SD-safe halt: `systemctl poweroff` stops services, flushes and
      // UNMOUNTS the filesystems before cutting power — that clean unmount is
      // what protects the SD card from corruption (the legacy /sbin/poweroff
      // path could hang on a straggler and leave the operator stuck on the
      // splash). Absolute paths so this never depends on the PATH the backend
      // happened to be launched with, and stdout/stderr are captured to the
      // backend log (not discarded) so a failed or blocked poweroff is
      // diagnosable via `tail /tmp/gillis-server.log`.
      const child = spawn('/usr/bin/sudo', ['/usr/bin/systemctl', 'poweroff'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout?.on('data', (d) => { out += d.toString(); });
      child.stderr?.on('data', (d) => { out += d.toString(); });
      child.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error('[gillis backend] poweroff exec failed:', err.message,
          '\n  Check that ionetic has NOPASSWD sudo for /usr/bin/systemctl poweroff.');
      });
      child.on('exit', (code, signal) => {
        if (code !== 0) {
          // eslint-disable-next-line no-console
          console.error('[gillis backend] poweroff exited non-zero:',
            JSON.stringify({ code, signal }), out ? `\n  output: ${out.trim()}` : '');
        }
      });
      child.unref();
    }, 1500);
    return { ok: true, reply: 'OK' };
  }

  return null;
}

// ---- HTTP (one-shot) ----
app.post('/api/command', async (req, res) => {
  const cmd = req.body?.command;
  if (typeof cmd !== 'string') return res.status(400).json({ ok: false, reply: 'bad command' });
  const intercepted = await routeCommand(cmd);
  if (intercepted) return res.json(intercepted);
  const result = await serial.send(cmd);
  res.json(result);
});

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, state: serial.snapshot() });
});

// ---- System info (easter egg) ----
// Cheap point-in-time snapshot of Pi vitals: GUI version, CPU temp,
// CPU usage, RAM usage, uptime, hostname. Linux-only paths are best-effort:
// if we're running on macOS/Windows for dev, the relevant fields just come
// back as null and the UI shows an em-dash. CPU% is sampled by reading
// /proc/stat twice ~120ms apart and diffing the jiffy counters.

let pkgVersionCached = null;
function readPackageVersion() {
  if (pkgVersionCached) return pkgVersionCached;
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    pkgVersionCached = JSON.parse(raw)?.version || null;
  } catch {
    pkgVersionCached = null;
  }
  return pkgVersionCached;
}

function readCpuTempC() {
  // Pi 4/5 expose CPU temp here in millidegrees. /sys is Linux-only.
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    const milli = Number(String(raw).trim());
    if (!Number.isFinite(milli)) return null;
    return milli / 1000;
  } catch {
    return null;
  }
}

function readMemoryMb() {
  // /proc/meminfo gives us totals in kB. We want the "MemAvailable" line
  // for an honest "in use" number — MemFree alone undercounts available RAM
  // because it doesn't credit the page cache.
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const lines = raw.split('\n');
    const get = (key) => {
      const line = lines.find((l) => l.startsWith(key + ':'));
      if (!line) return null;
      const m = line.match(/(\d+)\s*kB/);
      return m ? Number(m[1]) : null;
    };
    const totalKb = get('MemTotal');
    const availKb = get('MemAvailable') ?? get('MemFree');
    if (!totalKb || availKb == null) return { total: null, used: null };
    const total = Math.round(totalKb / 1024);
    const used = Math.round((totalKb - availKb) / 1024);
    return { total, used };
  } catch {
    return { total: null, used: null };
  }
}

function readCpuJiffies() {
  // First line of /proc/stat is aggregate CPU: user nice system idle iowait irq softirq steal
  try {
    const raw = fs.readFileSync('/proc/stat', 'utf8');
    const first = raw.split('\n')[0] || '';
    const parts = first.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const idle = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

async function sampleCpuPct() {
  const a = readCpuJiffies();
  if (!a) return null;
  await new Promise((r) => setTimeout(r, 120));
  const b = readCpuJiffies();
  if (!b) return null;
  const idleDiff = b.idle - a.idle;
  const totalDiff = b.total - a.total;
  if (totalDiff <= 0) return null;
  return Math.max(0, Math.min(100, ((totalDiff - idleDiff) / totalDiff) * 100));
}

function readUptimeSec() {
  try {
    const raw = fs.readFileSync('/proc/uptime', 'utf8');
    const sec = Number(String(raw).trim().split(/\s+/)[0]);
    return Number.isFinite(sec) ? sec : null;
  } catch {
    // os.uptime() works cross-platform as a fallback.
    try { return Math.round(os.uptime()); } catch { return null; }
  }
}

async function getSystemInfo() {
  const mem = readMemoryMb();
  const [cpuPct] = await Promise.all([sampleCpuPct()]);
  return {
    guiVersion: readPackageVersion(),
    cpuTempC: readCpuTempC(),
    cpuPct,
    ramTotalMb: mem.total,
    ramUsedMb: mem.used,
    uptimeSec: readUptimeSec(),
    hostname: (() => { try { return os.hostname(); } catch { return null; } })(),
    platform: process.platform,
    nodeVersion: process.version,
    serialMode: process.env.GILLIS_SERIAL || 'mock',
  };
}

app.get('/api/sysinfo', async (_req, res) => {
  try {
    const info = await getSystemInfo();
    res.json({ ok: true, info });
  } catch (err) {
    res.status(500).json({ ok: false, reply: err?.message || 'sysinfo failed' });
  }
});

// ---- Static GUI (production mode) ----
// If a `dist/` folder exists alongside this backend (created by `npm run build`),
// serve the built GUI directly. This makes everything same-origin on PORT,
// bypassing all of Vite's dev-server quirks (dual-stack binds, /ws proxy
// reliability, cross-origin WebSockets, etc). Dev mode still works as
// before — Vite serves on :5173 and proxies here.
const distDir = path.resolve(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  // eslint-disable-next-line no-console
  console.log(`[gillis backend] serving static GUI from ${distDir}`);
  app.use(express.static(distDir));
  // SPA fallback — anything that isn't /api or /ws falls back to index.html.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    const indexPath = path.join(distDir, 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    next();
  });
}

// ---- WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  // Initial snapshot so the client doesn't need to poll
  ws.send(JSON.stringify({ type: 'snapshot', state: serial.snapshot() }));

  const onEvent = (evt) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(evt));
  };
  serial.on('event', onEvent);

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg?.type === 'command' && typeof msg.command === 'string') {
      const intercepted = await routeCommand(msg.command);
      const result = intercepted ?? await serial.send(msg.command);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'reply', id: msg.id ?? null, ...result }));
      }
    }
  });

  ws.on('close', () => serial.off('event', onEvent));
});

// Bind explicitly to 0.0.0.0 so we listen on all IPv4 interfaces. Some Node
// installs default to IPv6 dual-stack; being explicit means 127.0.0.1 on
// the Pi is always reachable regardless of how 'localhost' resolves in the
// browser (RPi OS Chromium tends to prefer ::1 which can miss us otherwise).
server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[gillis backend] listening on http://0.0.0.0:${PORT}  (serial=${process.env.GILLIS_SERIAL || 'mock'})`);
});
