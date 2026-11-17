# PELINDO! — Switchable 5×5 (P·R·I·O·K) / 7×7 (P·E·L·I·N·D·O) Auditorium QR Game

Standalone QR-scannable bingo game for ~400 auditorium participants. Boots into **5×5 `P·R·I·O·K`** by default with a 1-click live toggle on `/host` to **7×7 `P·E·L·I·N·D·O`**. Runs locally on Node.js (`127.0.0.1:3000`) with an outbound Cloudflare Quick Tunnel (`http2`) so it works without Windows Administrator privileges and bypasses auditorium WiFi Client Isolation.

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

- `server.js` — Node v20 HTTP server, gzipped static cache, seeded 5×5 / 7×7 card generator, chapter-interleaved call order, conditional `304` polling, localhost SSE host stream, `/api/host/set-grid`, Top-3 millisecond podium arbiter
- `data/bingo-7x7-tanjung-priok.csv` — 62 Tanjung Priok clues across 4 chapters (`Company Profile`, `Business Process`, `Visited Experience`, `Business Challenge`)
- `data/tiles.js` — RFC-4180 CSV loader exporting `TILES`, `CHAPTERS`, and `GRID_CONFIGS`
- `data/tiles-ai-backup.js` — Preserved backup of the original 35 AI-generated clues
- `public/host.html` — 16:9 projector view with 1-click `5×5` / `7×7` toggle
- `public/play.html` — Zero-CDN mobile card UI (dynamic `5×5` / `7×7` grid + tap-readability preview + `localStorage` persistence)
- `start-live.mjs` / `start-game.bat` — Cross-policy launcher
- `test/load-test.mjs` — 400-player load, live grid-switch, & anti-cheat verification
