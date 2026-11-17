import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { COLUMNS, TILES } from './data/tiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = '127.0.0.1';
const MAX_WINNERS = 3;

const WIN_LINES = [
  // Rows
  [0, 1, 2, 3, 4],
  [5, 6, 7, 8, 9],
  [10, 11, 12, 13, 14],
  [15, 16, 17, 18, 19],
  [20, 21, 22, 23, 24],
  // Cols
  [0, 5, 10, 15, 20],
  [1, 6, 11, 16, 21],
  [2, 7, 12, 17, 22],
  [3, 8, 13, 18, 23],
  [4, 9, 14, 19, 24],
  // Diagonals
  [0, 6, 12, 18, 24],
  [4, 8, 12, 16, 20],
];

// Deterministic PRNG (Mulberry32) so cardId always reproduces the same 5x5 grid
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithRng(arr, rng) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function generateCardGrid(cardSeed) {
  const rng = mulberry32(cardSeed);
  const byCol = [0, 1, 2, 3, 4].map((colIdx) =>
    shuffleWithRng(
      TILES.filter((t) => t.colIndex === colIdx),
      rng
    )
  );

  // 5x5 row-major array; index 12 (row 2, col 2) is FREE ★ PELINDO
  const grid = new Array(25);
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const idx = r * 5 + c;
      if (idx === 12) {
        grid[idx] = { id: -1, col: 'I', shortLabel: 'FREE ★ PELINDO', isFree: true };
      } else {
        const tile = byCol[c].pop();
        grid[idx] = { id: tile.id, col: tile.col, shortLabel: tile.shortLabel, isFree: false };
      }
    }
  }
  return grid;
}

// Balanced call order: cycles across P-R-I-O-K waves so every column stays active
function buildCallOrder() {
  const rng = mulberry32(Date.now() ^ crypto.randomInt(1, 1_000_000));
  const buckets = [0, 1, 2, 3, 4].map((c) =>
    shuffleWithRng(
      TILES.filter((t) => t.colIndex === c),
      rng
    )
  );
  const order = [];
  for (let wave = 0; wave < 7; wave++) {
    const colOrder = shuffleWithRng([0, 1, 2, 3, 4], rng);
    for (const c of colOrder) {
      if (buckets[c][wave]) order.push(buckets[c][wave].id);
    }
  }
  return order;
}

// Game state
const state = {
  gameId: crypto.randomBytes(4).toString('hex'),
  version: 1,
  phase: 'LOBBY', // LOBBY | PLAYING | ENDED
  joinUrl: `http://127.0.0.1:${PORT}`,
  qrSvg: '',
  callOrder: buildCallOrder(),
  callCursor: -1, // index into callOrder of current clue
  currentTileRevealed: false,
  currentClueStartedAt: 0,
  lastRevealAt: 0,
  revealedIds: new Set(),
  revealedHistory: [], // [{ id, col, shortLabel, answerDetail, mcInsight }]
  players: new Map(), // playerId -> { playerId, cardNum, seed, name, grid, wonRank }
  nextCardNum: 1,
  winners: [], // [{ rank, playerId, cardNum, name, claimAtMs, elapsedSinceRevealMs, lineIndices }]
  hostClients: new Set(),
};

async function refreshQrSvg() {
  state.qrSvg = await QRCode.toString(state.joinUrl, {
    type: 'svg',
    margin: 2,
    width: 320,
    color: { dark: '#030a16', light: '#ffffff' },
  });
}

// Preload & gzip static HTML at startup for 400-user burst performance
const staticCache = new Map();
function loadStaticAssets() {
  for (const file of ['play.html', 'host.html']) {
    const raw = fs.readFileSync(path.join(__dirname, 'public', file));
    const gz = zlib.gzipSync(raw, { level: 6 });
    const etag = `"${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12)}"`;
    staticCache.set(file, { raw, gz, etag });
  }
}

function getTileById(id) {
  return TILES[id];
}

function getPublicState() {
  const currentId = state.callCursor >= 0 ? state.callOrder[state.callCursor] : null;
  const currentTile = currentId !== null ? getTileById(currentId) : null;
  return {
    gameId: state.gameId,
    v: state.version,
    phase: state.phase,
    playerCount: state.players.size,
    callIndex: state.callCursor + 1,
    totalCalls: state.callOrder.length,
    currentClue: currentTile
      ? {
          col: currentTile.col,
          colName: COLUMNS[currentTile.colIndex].name,
          cluePrompt: currentTile.cluePrompt,
          revealed: state.currentTileRevealed,
          id: state.currentTileRevealed ? currentTile.id : null,
          shortLabel: state.currentTileRevealed ? currentTile.shortLabel : null,
          answerDetail: state.currentTileRevealed ? currentTile.answerDetail : null,
          mcInsight: state.currentTileRevealed ? currentTile.mcInsight : null,
        }
      : null,
    revealedIds: Array.from(state.revealedIds),
    revealedHistory: state.revealedHistory,
    winners: state.winners,
    joinUrl: state.joinUrl,
  };
}

function bumpState() {
  state.version++;
  const payload = `data: ${JSON.stringify(getPublicState())}\n\n`;
  for (const res of state.hostClients) {
    try {
      res.write(payload);
    } catch {
      state.hostClients.delete(res);
    }
  }
}

function sendJson(res, statusCode, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function serveStatic(req, res, fileName) {
  const entry = staticCache.get(fileName);
  if (!entry) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304);
    res.end();
    return;
  }
  const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
    ETag: entry.etag,
    ...(acceptGzip ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.end(acceptGzip ? entry.gz : entry.raw);
}

function readJsonBody(req, limitBytes = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isLocalhostRequest(req) {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export async function createGameServer() {
  loadStaticAssets();
  await refreshQrSvg();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    // 1. Mobile Player Page
    if (req.method === 'GET' && pathname === '/') {
      return serveStatic(req, res, 'play.html');
    }

    // 2. Projector Host Page (localhost only for safety, or open if testing locally)
    if (req.method === 'GET' && pathname === '/host') {
      return serveStatic(req, res, 'host.html');
    }

    // 3. Offline SVG QR endpoint
    if (req.method === 'GET' && pathname === '/api/qr') {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(state.qrSvg);
    }

    // 4. Conditional State Polling (for 400 phones)
    if (req.method === 'GET' && pathname === '/api/state') {
      const clientV = Number(url.searchParams.get('v') || 0);
      if (clientV === state.version) {
        res.writeHead(304, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      return sendJson(res, 200, getPublicState());
    }

    // 5. Join / Restore Player Card
    if (req.method === 'POST' && pathname === '/api/join') {
      try {
        const body = await readJsonBody(req);
        const rawName = String(body.name || '').trim().slice(0, 28);
        const existingId = typeof body.playerId === 'string' ? body.playerId : null;

        if (existingId && state.players.has(existingId)) {
          const p = state.players.get(existingId);
          if (rawName) p.name = rawName;
          return sendJson(res, 200, {
            ok: true,
            gameId: state.gameId,
            playerId: p.playerId,
            cardNum: p.cardNum,
            name: p.name,
            grid: p.grid,
            wonRank: p.wonRank,
            columns: COLUMNS,
          });
        }

        const playerId = crypto.randomUUID();
        const cardNum = state.nextCardNum++;
        const seed = crypto.randomInt(1, 2_000_000_000);
        const name = rawName || `Kapten #${String(cardNum).padStart(3, '0')}`;
        const grid = generateCardGrid(seed);
        const record = { playerId, cardNum, seed, name, grid, wonRank: null };
        state.players.set(playerId, record);
        bumpState();

        return sendJson(res, 200, {
          ok: true,
          gameId: state.gameId,
          playerId,
          cardNum,
          name,
          grid,
          wonRank: null,
          columns: COLUMNS,
        });
      } catch (err) {
        return sendJson(res, 400, { ok: false, reason: err.message });
      }
    }

    // 6. Claim "PELINDO!" (Server-Verified Millisecond Arbiter)
    if (req.method === 'POST' && pathname === '/api/claim') {
      try {
        const body = await readJsonBody(req);
        const { playerId, lineIndices, name } = body;
        const player = state.players.get(playerId);
        if (!player) {
          return sendJson(res, 404, { ok: false, reason: 'Kartu tidak ditemukan. Scan ulang QR.' });
        }
        if (typeof name === 'string' && name.trim()) {
          player.name = name.trim().slice(0, 28);
        }
        if (player.wonRank) {
          return sendJson(res, 200, {
            ok: true,
            rank: player.wonRank,
            alreadyWon: true,
            winners: state.winners,
          });
        }
        if (state.winners.length >= MAX_WINNERS) {
          return sendJson(res, 200, {
            ok: false,
            podiumFull: true,
            reason: 'Podium Juara 1–3 sudah penuh! Terima kasih sudah bermain.',
            winners: state.winners,
          });
        }
        if (state.phase !== 'PLAYING') {
          return sendJson(res, 400, { ok: false, reason: 'Permainan belum dimulai atau sudah selesai.' });
        }

        // Validate submitted line or auto-detect any valid completed line on player's card
        const candidateLines = Array.isArray(lineIndices) && lineIndices.length === 5
          ? WIN_LINES.filter((L) => L.every((idx, i) => idx === lineIndices[i]))
          : WIN_LINES;

        let matchedLine = null;
        for (const line of candidateLines) {
          const allCalled = line.every((cellIdx) => {
            const cell = player.grid[cellIdx];
            return cell.isFree || state.revealedIds.has(cell.id);
          });
          if (allCalled) {
            matchedLine = line;
            break;
          }
        }

        if (!matchedLine) {
          return sendJson(res, 200, {
            ok: false,
            reason: 'Belum valid! Pastikan 1 garis penuh hanya berisi kotak yang sudah di-reveal MC.',
          });
        }

        const nowMs = Date.now();
        const rank = state.winners.length + 1;
        player.wonRank = rank;
        const winEntry = {
          rank,
          playerId: player.playerId,
          cardNum: player.cardNum,
          name: player.name,
          claimAtMs: nowMs,
          elapsedSinceRevealMs: state.lastRevealAt ? Math.max(0, nowMs - state.lastRevealAt) : 0,
          lineIndices: matchedLine,
        };
        state.winners.push(winEntry);
        if (state.winners.length >= MAX_WINNERS) {
          state.phase = 'ENDED';
        }
        bumpState();

        return sendJson(res, 200, {
          ok: true,
          rank,
          winEntry,
          winners: state.winners,
        });
      } catch (err) {
        return sendJson(res, 400, { ok: false, reason: err.message });
      }
    }

    // 7. Host-only SSE stream & controls (localhost only)
    if (pathname.startsWith('/api/host/')) {
      if (!isLocalhostRequest(req)) {
        return sendJson(res, 403, { ok: false, reason: 'Host controls are localhost-only.' });
      }

      if (req.method === 'GET' && pathname === '/api/host/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        state.hostClients.add(res);
        res.write(`data: ${JSON.stringify(getPublicState())}\n\n`);
        req.on('close', () => state.hostClients.delete(res));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/host/set-url') {
        const body = await readJsonBody(req);
        if (typeof body.url === 'string' && body.url.startsWith('http')) {
          state.joinUrl = body.url.trim();
          await refreshQrSvg();
          bumpState();
        }
        return sendJson(res, 200, { ok: true, joinUrl: state.joinUrl });
      }

      if (req.method === 'POST' && pathname === '/api/host/start') {
        state.phase = 'PLAYING';
        if (state.callCursor < 0) {
          state.callCursor = 0;
          state.currentTileRevealed = false;
          state.currentClueStartedAt = Date.now();
        }
        bumpState();
        return sendJson(res, 200, { ok: true, state: getPublicState() });
      }

      if (req.method === 'POST' && pathname === '/api/host/reveal') {
        if (state.phase === 'LOBBY') state.phase = 'PLAYING';
        if (state.callCursor < 0) state.callCursor = 0;
        const tileId = state.callOrder[state.callCursor];
        if (tileId !== undefined && !state.currentTileRevealed) {
          state.currentTileRevealed = true;
          state.lastRevealAt = Date.now();
          if (!state.revealedIds.has(tileId)) {
            state.revealedIds.add(tileId);
            const t = getTileById(tileId);
            state.revealedHistory.unshift({
              id: t.id,
              col: t.col,
              shortLabel: t.shortLabel,
              answerDetail: t.answerDetail,
            });
          }
          bumpState();
        }
        return sendJson(res, 200, { ok: true, state: getPublicState() });
      }

      if (req.method === 'POST' && pathname === '/api/host/next-clue') {
        if (state.phase === 'LOBBY') state.phase = 'PLAYING';
        if (state.callCursor + 1 < state.callOrder.length) {
          state.callCursor++;
          state.currentTileRevealed = false;
          state.currentClueStartedAt = Date.now();
          bumpState();
        }
        return sendJson(res, 200, { ok: true, state: getPublicState() });
      }

      if (req.method === 'POST' && pathname === '/api/host/reset') {
        state.gameId = crypto.randomBytes(4).toString('hex');
        state.phase = 'LOBBY';
        state.callOrder = buildCallOrder();
        state.callCursor = -1;
        state.currentTileRevealed = false;
        state.currentClueStartedAt = 0;
        state.lastRevealAt = 0;
        state.revealedIds.clear();
        state.revealedHistory = [];
        state.players.clear();
        state.nextCardNum = 1;
        state.winners = [];
        bumpState();
        return sendJson(res, 200, { ok: true, state: getPublicState() });
      }
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // Support CLI flag: node server.js --url=https://...
  const urlArg = process.argv.find((a) => a.startsWith('--url='));
  if (urlArg) {
    state.joinUrl = urlArg.slice(6).trim();
    await refreshQrSvg();
  }

  return { server, state };
}

// Start directly when executed as main module
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server } = await createGameServer();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.listen(PORT, HOST, 1024, () => {
    console.log(`[PELINDO-GAME] Listening on http://${HOST}:${PORT}`);
    console.log(`[PELINDO-GAME] Projector Host: http://${HOST}:${PORT}/host`);
  });
}
