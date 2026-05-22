// Persistent program library — file-system backed (Pi-side).
//
// The React UI historically held programs in a useState() array that was
// lost on every refresh. This module gives the backend a single JSON file
// the UI hydrates from on mount and debounce-saves into whenever the list
// changes.
//
// Storage location: ~/.gillis/programs.json
// Format:
//   { "version": 1, "savedAt": "<iso>", "programs": [ ...raw program objects... ] }
//
// Commands intercepted at the backend:
//   PROGRAMS_LOAD         → { ok, reply:'OK', programs: [...] }
//   PROGRAMS_SAVE <json>  → { ok, reply:'OK saved N programs' }
//
// We deliberately do not validate the program shape here — the UI is the
// source of truth for what a program looks like, and we want this to
// tolerate forward-compatible additions (new pattern fields, etc.).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const FILE_VERSION = 1;

function storePath() {
  return path.join(os.homedir(), '.gillis', 'programs.json');
}

async function ensureDir() {
  await fsp.mkdir(path.dirname(storePath()), { recursive: true });
}

// Load the saved program list. Returns [] if the file is missing, empty,
// or corrupt — never throws, because a fresh install should Just Work.
export async function loadPrograms() {
  const file = storePath();
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  if (!raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Don't nuke a corrupt file automatically — rename it so the user can
    // recover it if they know what happened.
    try {
      await fsp.rename(file, `${file}.corrupt-${Date.now()}`);
    } catch {}
    return [];
  }
  if (Array.isArray(parsed)) return parsed;            // legacy bare-array shape
  if (Array.isArray(parsed.programs)) return parsed.programs;
  return [];
}

// Save the list. Writes atomically — temp file, then rename — so a crash
// mid-write can't leave programs.json half-flushed.
export async function savePrograms(programs) {
  if (!Array.isArray(programs)) {
    throw new Error('programs must be an array');
  }
  await ensureDir();
  const file = storePath();
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify({
    version: FILE_VERSION,
    savedAt: new Date().toISOString(),
    programs,
  }, null, 2);
  await fsp.writeFile(tmp, payload);
  await fsp.rename(tmp, file);
  return { count: programs.length, path: file };
}

export async function handleProgramsCommand(verb, rest) {
  if (verb === 'PROGRAMS_LOAD') {
    try {
      const programs = await loadPrograms();
      return { ok: true, reply: 'OK', programs };
    } catch (err) {
      return { ok: false, reply: `ERROR ${err.message}` };
    }
  }

  if (verb === 'PROGRAMS_SAVE') {
    let payload;
    try {
      payload = JSON.parse(rest || '[]');
    } catch (err) {
      return { ok: false, reply: `ERROR bad json (${err.message})` };
    }
    // Accept either a bare array or { programs: [...] }
    const programs = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.programs) ? payload.programs : null;
    if (!programs) return { ok: false, reply: 'ERROR programs must be an array' };
    try {
      const result = await savePrograms(programs);
      return { ok: true, reply: `OK saved ${result.count} programs` };
    } catch (err) {
      return { ok: false, reply: `ERROR ${err.message}` };
    }
  }

  return null;
}

export function isProgramsCommand(verb) {
  return verb === 'PROGRAMS_LOAD' || verb === 'PROGRAMS_SAVE';
}
