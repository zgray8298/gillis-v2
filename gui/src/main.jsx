import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Kiosk auto-zoom temporarily disabled while we triage a rendering issue on
// the Pi Screen 2 swap. The previous Math.min / Math.max experiments produced
// either "a little too small" or "massively zoomed in" depending on whether
// the viewport reported as landscape or portrait at boot, and the swap also
// raises the possibility that the panel's OS-side rotation isn't matching
// the new hardware. Reverting to 1:1 lets us confirm the un-zoomed baseline
// looks correct before re-introducing scaling.
//
// To re-enable later, restore the width-based formula:
//   const sx = window.innerWidth / 800;
//   document.documentElement.style.zoom =
//     Math.max(1.0, Math.min(1.5, sx));
//
// For diagnostics, log the reported viewport so we can sanity-check what
// Chromium is seeing on the actual Pi (vs. what we assumed it was seeing).
// Visible in the kiosk's remote-debug console at http://gillis.local:9222.
// eslint-disable-next-line no-console
console.log('[gillis] viewport', window.innerWidth, 'x', window.innerHeight,
  ' devicePixelRatio=', window.devicePixelRatio);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
