# PELINDO! — P·R·I·O·K 5×5 Auditorium QR Game

Standalone QR-scannable 5×5 **P·R·I·O·K** game for ~400 auditorium participants. Runs locally on Node.js (`127.0.0.1:3000`) with an outbound Cloudflare Quick Tunnel (`http2`) so it works without Windows Administrator privileges and bypasses auditorium WiFi Client Isolation.

## Quick Start (Windows, No Admin)

```bash
npm install
npm run live
```

Or double-click `start-game.bat`. On first run, `start-live.mjs` automatically downloads portable `tools/cloudflared.exe` if missing, starts the local server, opens the Cloudflare Quick Tunnel, updates the projector QR code, and launches `http://127.0.0.1:3000/host`.

## Host Keyboard Shortcuts

- `Space` — Next clue
- `Enter` — Reveal answer & unlock tile for server claim verification
- `F` — Toggle fullscreen

## Load & Anti-Cheat Test (400 Simulated Players)

```bash
npm test
```

## Structure

- `server.js` — Node v20 HTTP server, gzipped static cache, seeded 5×5 card generator, conditional `304` polling, localhost SSE host stream, Top-3 millisecond podium arbiter
- `data/tiles.js` — 35 Tanjung Priok facts across `P · R · I · O · K` columns (7 per column)
- `public/host.html` — 16:9 projector view
- `public/play.html` — Zero-CDN mobile card UI with `localStorage` persistence
- `start-live.mjs` / `start-game.bat` — Cross-policy launcher
- `test/load-test.mjs` — 400-player load & anti-cheat verification
