// Persistent settings (Pi-side disk store).
//
// Why this exists: the firmware was supposed to be the source of truth for
// EEPROM-backed settings (envelope / air threshold / motion / loading
// position), echoed back to the UI in the SNAPSHOT line. In practice the
// SET_TRAVEL / SET_AIR_THRESHOLD commands don't round-trip cleanly on every
// firmware build -- the UI's "Save to Teensy EEPROM" button would dispatch,
// the firmware would ack, but the next boot's SNAPSHOT either omitted the
// fields entirely or echoed the compile-time default. From the operator's
// point of view "envelope / air doesn't save".
//
// This module gives the backend a JSON file the UI hydrates from on mount
// and writes to whenever the operator hits Save. The Pi-side copy is the
// reliable source of truth across reboots; the firmware command is still
// fired in parallel so that any firmware build that DOES handle it (now or
// in future) stays in sync without a second migration step.
//
// Storage location: ~/.gillis/settings.json
// Format:
//   { version: 1, savedAt: <iso>, settings: { travelLimits, motionSettings,
//                                              loadingPosition, airThresholdBar } }
//
// Commands intercepted at the backend (mirroring PROGRAMS_LOAD / SAVE):
//   SETTINGS_LOAD          -> { ok, reply:'OK', settings: { ... } | null }
//   SETTINGS_SAVE <json>   -> { ok, reply:'OK saved' }
//
// Unknown nested keys are preserved on a round-trip (forward-compatible);
// the UI decides which fields it cares about reading.

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const FILE_VERSION = 1;

function storePath() {
  return path.join(os.homedir(), '.gillis', 'settings.json');
}

async function ensureDir() {
  await fsp.mkdir(path.dirname(storePath()), { recursive: true });
}

export async function loadSettings() {
  const file = storePath();
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (!raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Don't nuke a corrupt file automatically -- rename it so the operator can
    // recover by hand if they know what happened.
    try { await fsp.rename(file, `${file}.corrupt-${Date.now()}`); } catch {}
    return null;
  }
  // Accept either the wrapped {settings:{...}} form or a bare object (the
  // bare form is what the UI naturally serialises if someone hand-edits it).
  if (parsed && typeof parsed === 'object') {
    if (parsed.settings && typeof parsed.settings === 'object') return parsed.settings;
    if (parsed.version === FILE_VERSION) return parsed.settings || null;
    return parsed; // bare settings object
  }
  return null;
}

export async function saveSettings(settings) {
  if (!settings || typeof settings !== 'object') {
    throw new Error('settings must be an object');
  }
  await ensureDir();
  const file = storePath();
  // MERGE with the on-disk copy at the top level so a partial save from
  // (say) LoadingPositionScreen.save() doesn't wipe the envelope/motion/air
  // values that SettingsScreen.handleSave previously wrote. One-level merge
  // is intentional: each top-level key (travelLimits, motionSettings,
  // loadingPosition, airThresholdBar) is replaced wholesale if present in
  // the incoming patch, but other top-level keys are preserved untouched.
  let existing = null;
  try { existing = await loadSettings(); } catch { existing = null; }
  const merged = { ...(existing || {}), ...settings };
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify({
    version: FILE_VERSION,
    savedAt: new Date().toISOString(),
    settings: merged,
  }, null, 2);
  // Atomic write: tmp + rename so a crash mid-write can't leave the file half-flushed.
  await fsp.writeFile(tmp, payload);
  await fsp.rename(tmp, file);
  return { path: file };
}

export async function handleSettingsCommand(verb, rest) {
  if (verb === 'SETTINGS_LOAD') {
    try {
      const settings = await loadSettings();
      return { ok: true, reply: 'OK', settings };
    } catch (err) {
      return { ok: false, reply: `ERROR ${err.message}` };
    }
  }
  if (verb === 'SETTINGS_SAVE') {
    let payload;
    try {
      payload = JSON.parse(rest || '{}');
    } catch (err) {
      return { ok: false, reply: `ERROR bad json (${err.message})` };
    }
    // Accept either a bare settings object or { settings: {...} }
    const settings =
      payload && typeof payload === 'object'
        ? (payload.settings && typeof payload.settings === 'object'
            ? payload.settings
            : payload)
        : null;
    if (!settings) return { ok: false, reply: 'ERROR settings must be an object' };
    try {
      await saveSettings(settings);
      return { ok: true, reply: 'OK saved' };
    } catch (err) {
      return { ok: false, reply: `ERROR ${err.message}` };
    }
  }
  return null;
}

export function isSettingsCommand(verb) {
  return verb === 'SETTINGS_LOAD' || verb === 'SETTINGS_SAVE';
}
