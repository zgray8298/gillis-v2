// USB program library — file-system backed (Pi-side, NOT Teensy).
//
// Gillis programs saved to a FAT32 stick are plain JSON files named
// "<something>.gillis.json". This module scans the mount points a desktop
// Linux distro uses for removable media, lists them to the UI, and
// reads / writes the ones the operator picks.
//
// Intercepts the USB_LIST / USB_IMPORT / USB_EXPORT commands at the backend
// BEFORE they reach the Teensy — the Teensy has nothing to do with USB mass
// storage. See server/index.js for the integration point.
//
//   USB_LIST              → { ok, reply:'OK', files: string[] }
//   USB_IMPORT <filename> → { ok, reply:'OK', program: {...} }
//   USB_EXPORT <json>     → { ok, reply:'OK wrote <name> to <mount>' }
//
// Mount points scanned, in order:
//   /media/<user>/*       (Debian / RPi OS default — udisks2)
//   /run/media/<user>/*   (systemd / Fedora / Arch default)
//   /mnt/*                (manual mounts — fstab)
//
// Only direct children of those roots are considered. We don't recurse into
// subdirectories — programs should sit at the root of the stick so the
// operator can see them in the file manager.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const SUFFIX = '.gillis.json';

function currentUser() {
  return (
    process.env.USER ||
    process.env.LOGNAME ||
    (() => { try { return os.userInfo().username; } catch { return 'pi'; } })()
  );
}

function candidateMountRoots() {
  const user = currentUser();
  return [
    path.join('/media', user),
    path.join('/run/media', user),
    '/mnt',
  ];
}

async function safeReaddir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Return every directory that looks like a mounted USB volume — i.e. a
// direct subdirectory of one of the mount roots. Entries that we can't
// read are silently skipped.
export async function listMountedVolumes() {
  const volumes = [];
  const seen = new Set();
  for (const root of candidateMountRoots()) {
    const entries = await safeReaddir(root);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        await fsp.access(full, fs.constants.R_OK);
        volumes.push(full);
      } catch {
        // Not readable — e.g. locked encrypted volume. Skip.
      }
    }
  }
  return volumes;
}

// Gather every *.gillis.json sitting at the root of a mounted volume.
// Returns [{ filename, path, volume }, ...] — deduplicated by filename
// (first-mount-wins) so the UI sees a flat, unambiguous list.
export async function listGillisFiles() {
  const volumes = await listMountedVolumes();
  const out = [];
  const seen = new Set();
  for (const vol of volumes) {
    const entries = await safeReaddir(vol);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (!lower.endsWith(SUFFIX)) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push({
        filename: entry.name,
        path: path.join(vol, entry.name),
        volume: vol,
      });
    }
  }
  return out;
}

// Sanitize a program name to a safe file name. Keeps letters, digits,
// space, hyphen, underscore, dot, parentheses. Prevents path traversal
// and weird characters that confuse FAT32.
function safeFilename(name) {
  const base = String(name || '').replace(/[^a-z0-9_\-. ()]/gi, '_').trim();
  return (base || 'program') + SUFFIX;
}

// Top-level handler — returns the structured reply the UI expects, or
// null if this isn't a USB command (so the caller falls through to the
// serial driver).
export async function handleUsbCommand(verb, rest) {
  if (verb === 'USB_LIST') {
    try {
      const files = await listGillisFiles();
      return { ok: true, reply: 'OK', files: files.map((f) => f.filename) };
    } catch (err) {
      return { ok: false, reply: `ERROR ${err.message}` };
    }
  }

  if (verb === 'USB_IMPORT') {
    const filename = (rest || '').trim();
    if (!filename) return { ok: false, reply: 'ERROR missing filename' };
    // Reject anything that tries to escape the mount.
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return { ok: false, reply: 'ERROR invalid filename' };
    }
    try {
      const files = await listGillisFiles();
      const match = files.find((f) => f.filename === filename);
      if (!match) return { ok: false, reply: 'ERROR file not found' };
      const raw = await fsp.readFile(match.path, 'utf8');
      let program;
      try {
        program = JSON.parse(raw);
      } catch (e) {
        return { ok: false, reply: `ERROR bad json (${e.message})` };
      }
      return { ok: true, reply: 'OK', program };
    } catch (err) {
      return { ok: false, reply: `ERROR ${err.message}` };
    }
  }

  if (verb === 'USB_EXPORT') {
    let program;
    try {
      program = JSON.parse(rest || '{}');
    } catch (err) {
      return { ok: false, reply: `ERROR bad json (${err.message})` };
    }
    if (!program || typeof program !== 'object') {
      return { ok: false, reply: 'ERROR program must be a json object' };
    }
    const volumes = await listMountedVolumes();
    if (!volumes.length) {
      return { ok: false, reply: 'ERROR no usb detected' };
    }
    const filename = safeFilename(program.name);
    const payload = JSON.stringify(program, null, 2);
    let lastError = null;
    for (const vol of volumes) {
      const target = path.join(vol, filename);
      try {
        await fsp.writeFile(target, payload);
        return { ok: true, reply: `OK wrote ${filename} to ${vol}` };
      } catch (err) {
        lastError = err;
      }
    }
    return { ok: false, reply: `ERROR ${lastError?.message || 'no writable volume'}` };
  }

  return null;
}

// True for verbs we want to intercept at the backend. Anything else goes
// down to the serial driver as usual.
export function isUsbCommand(verb) {
  return verb === 'USB_LIST' || verb === 'USB_IMPORT' || verb === 'USB_EXPORT';
}
