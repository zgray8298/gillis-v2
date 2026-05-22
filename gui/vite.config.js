import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The browser UI talks to the Node backend at :8787.
// Vite proxies /api and /ws during dev so the client can use same-origin URLs.
//
// host: true binds Vite to 0.0.0.0 (IPv4 all interfaces). Without this, Vite
// defaults to IPv6 localhost only ([::1]), which mismatches the backend's
// IPv4 bind and leaves the browser unable to connect the WS through the
// proxy. Binding both to IPv4 makes same-origin work end-to-end.
//
// Pointing the proxy targets at 127.0.0.1 (rather than 'localhost') avoids
// the same IPv4/IPv6 resolution trap on the server side of the proxy.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
