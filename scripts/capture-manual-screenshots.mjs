// capture-manual-screenshots.mjs
//
// Drives the running dev GUI through each state that the Operator Manual
// references, and saves PNG screenshots into docs/manual-images/.
//
// Prerequisites:
//   1. `npm run dev` must be running in gui/ so the GUI is at http://localhost:5173
//      and the backend is listening on :8787.
//   2. Playwright + chromium installed once:
//        npm install --save-dev playwright
//        npx playwright install chromium
//
// Run:
//   node scripts/capture-manual-screenshots.mjs
//
// The script uses two channels in parallel:
//   - A direct WebSocket to the backend at ws://localhost:5173/ws to drive
//     HOME / MOVE / RUN_START commands without needing to click through
//     the on-screen confirmations.
//   - Playwright to drive the GUI itself (dismiss boot prompt, navigate
//     between screens, click buttons, screenshot).
//
// The driven backend state propagates to the GUI via its own WebSocket, so
// the GUI's top bar / Running screen / etc. update in real time as the
// script issues commands.

import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '..', 'docs', 'manual-images');
const GUI_URL = 'http://localhost:5173/';
const BACKEND_WS = 'ws://localhost:5173/ws';
const VIEWPORT = { width: 1280, height: 720 };

// ---------------------------------------------------------------------------
// Backend command helper — opens a side-channel WS to the mock serial backend
// and sends commands directly. Lets us pre-stage machine state (homed,
// positioned, running) without walking through every on-screen confirmation.
// ---------------------------------------------------------------------------
function openBackend() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BACKEND_WS);
    let nextId = 1;
    const pending = new Map();

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'reply' && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      }
    });

    ws.on('open', () => {
      resolve({
        send(command, { timeoutMs = 15000 } = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ type: 'command', id, command }));
          return new Promise((res, rej) => {
            const t = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`backend timeout on: ${command}`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (reply) => {
                clearTimeout(t);
                res(reply);
              },
            });
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Click a button by visible text (case-insensitive, substring match).
// Used instead of Playwright's strict locators because the GUI has multiple
// elements with similar text and we want the most permissive selector.
// ---------------------------------------------------------------------------
async function clickByText(page, text) {
  await page.evaluate((needle) => {
    const btns = [...document.querySelectorAll('button')];
    const target = btns.find((b) =>
      b.textContent.toLowerCase().includes(needle.toLowerCase())
    );
    if (!target) throw new Error(`button not found: ${needle}`);
    target.click();
  }, text);
}

async function dismissBootPrompt(page) {
  // Boot prompt appears on every page load. Click "Not yet" if visible.
  try {
    await page.waitForSelector('button:has-text("Not yet")', { timeout: 3000 });
    await clickByText(page, 'not yet');
  } catch {
    // No boot prompt — fine, already past it.
  }
}

async function screenshot(page, name, region = null) {
  const file = path.join(OUTPUT_DIR, name);
  if (region) {
    await page.screenshot({ path: file, clip: region });
  } else {
    await page.screenshot({ path: file });
  }
  console.log(`saved ${name}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  await page.goto(GUI_URL);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000); // let the GUI's WS connect + snapshot arrive

  const backend = await openBackend();

  // Pre-stage: home the machine and move to a sensible position so the
  // screenshots show real X/Y values, not "?" placeholders.
  console.log('Homing machine via backend...');
  await backend.send('HOME', { timeoutMs: 30000 });
  await page.waitForTimeout(1000);

  console.log('Moving to (305, 585) loading position...');
  await backend.send('MOVE X305 Y585', { timeoutMs: 15000 });
  await page.waitForTimeout(500);

  // Boot prompt may have appeared between page load and now — dismiss.
  await dismissBootPrompt(page);
  await page.waitForTimeout(500);

  // -------------------------------------------------------------------------
  // 1. Home screen
  // -------------------------------------------------------------------------
  await screenshot(page, '01_home_screen.png');

  // -------------------------------------------------------------------------
  // 2. Status bar close-up — crop the top 75 pixels of the home screen.
  // -------------------------------------------------------------------------
  await screenshot(page, '02_status_bar.png', {
    x: 0,
    y: 0,
    width: VIEWPORT.width,
    height: 75,
  });

  // -------------------------------------------------------------------------
  // 3. Production screen
  // -------------------------------------------------------------------------
  await clickByText(page, 'production');
  await page.waitForTimeout(1500);
  await screenshot(page, '03_production_screen.png');

  // -------------------------------------------------------------------------
  // 4. Pre-run confirmation modal
  // -------------------------------------------------------------------------
  await clickByText(page, 'begin');
  await page.waitForTimeout(1500);
  await screenshot(page, '04_prerun_confirm.png');

  // -------------------------------------------------------------------------
  // 5. Running screen — click Move, then Begin, then capture mid-run.
  // -------------------------------------------------------------------------
  await clickByText(page, 'move');
  await page.waitForTimeout(2500);
  await clickByText(page, 'begin'); // second Begin on the "At start position" screen
  await page.waitForTimeout(4000); // let it get to roughly cell 12/16
  await screenshot(page, '05_running_screen.png');

  // Abort the run cleanly so we can navigate away.
  await clickByText(page, 'abort');
  await page.waitForTimeout(1000);
  // Confirm abort modal — click the destructive button
  try {
    await clickByText(page, 'abort'); // sometimes the confirm button is also "Abort"
  } catch {}
  await page.waitForTimeout(2000);

  // Navigate back home — bottom-centre house icon
  await page.evaluate(() => {
    const home = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === '⌂'
    );
    home?.click();
  });
  await page.waitForTimeout(1500);

  // -------------------------------------------------------------------------
  // 6. Programs screen
  // -------------------------------------------------------------------------
  await clickByText(page, 'edit & manage');
  await page.waitForTimeout(1500);
  await screenshot(page, '06_programs_screen.png');

  // -------------------------------------------------------------------------
  // 7. Calibrate Start Position post-save modal
  // -------------------------------------------------------------------------
  await clickByText(page, 'edit program');
  await page.waitForTimeout(1000);
  await clickByText(page, 'calibrate start position');
  await page.waitForTimeout(1500);
  // Dismiss the entry-time "Okay to move table?" prompt
  await clickByText(page, 'not yet');
  await page.waitForTimeout(800);
  // Now click Save Start Position
  await clickByText(page, 'save start position');
  await page.waitForTimeout(1000);
  // First confirm-save modal — click the SAVE button (not CANCEL)
  await page.evaluate(() => {
    const save = [...document.querySelectorAll('button')].find(
      (b) =>
        b.textContent.trim().toLowerCase() === 'save' &&
        !b.textContent.toLowerCase().includes('cancel')
    );
    save?.click();
  });
  await page.waitForTimeout(1500);
  // Now the post-save park prompt should be visible — capture it
  await screenshot(page, '07_calibrate_post_save.png');

  // Skip the park so we can navigate away
  await clickByText(page, 'skip');
  await page.waitForTimeout(1500);

  // -------------------------------------------------------------------------
  // 8. Machine Setup menu — go home first then click Machine Setup
  // -------------------------------------------------------------------------
  await page.evaluate(() => {
    const home = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === '⌂'
    );
    home?.click();
  });
  await page.waitForTimeout(1500);
  await clickByText(page, 'machine setup');
  await page.waitForTimeout(1500);
  await screenshot(page, '08_machine_setup.png');

  // -------------------------------------------------------------------------
  // 9. Diagnostics
  // -------------------------------------------------------------------------
  await page.evaluate(() => {
    const home = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === '⌂'
    );
    home?.click();
  });
  await page.waitForTimeout(1500);
  await clickByText(page, 'health & live');
  await page.waitForTimeout(1500);
  await screenshot(page, '09_diagnostics.png');

  // -------------------------------------------------------------------------
  // Done
  // -------------------------------------------------------------------------
  backend.close();
  await browser.close();
  console.log('\nAll 9 screenshots saved to docs/manual-images/.');
}

main().catch((err) => {
  console.error('capture failed:', err);
  process.exit(1);
});
