import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { CHAPTERS, GRID_CONFIGS, TILES } from './data/tiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = '127.0.0.1';
const DEFAULT_MAX_WINNERS = 3;
const MIN_WINNERS = 1;
const MAX_WINNERS_LIMIT = 10;
const CHAPTER_COLOR_MAP = Object.fromEntries(CHAPTERS.map((c) => [c.name, c.color]));

function resolveInitialGridSize() {
  const arg = process.argv.find((a) => a.startsWith('--grid='));
  const raw = arg ? Number(arg.slice(7)) : Number(process.env.GRID_SIZE || 5);
  return raw === 7 ? 7 : 5;
}

function buildWinLines(n) {
  const lines = [];
  for (let r = 0; r < n; r++) {
    lines.push(Array.from({ length: n }, (_, c) => r * n + c));
    lines.push(Array.from({ length: n }, (_, c) => c * n + r));
  }
  lines.push(Array.from({ length: n }, (_, i) => i * n + i));
  lines.push(Array.from({ length: n }, (_, i) => i * n + (n - 1 - i)));
  return lines;
}

const WIN_LINES_BY_SIZE = {
  5: buildWinLines(5),
  7: buildWinLines(7),
};

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

function generateCardGrid(cardSeed, gridSize) {
  const rng = mulberry32(cardSeed);
  const totalCells = gridSize * gridSize;
  const freeIndex = Math.floor(totalCells / 2);
  const pool = shuffleWithRng(TILES, rng);
  const grid = new Array(totalCells);
  let cursor = 0;

  for (let idx = 0; idx < totalCells; idx++) {
    if (idx === freeIndex) {
      grid[idx] = { id: -1, bab: 'FREE', shortLabel: 'FREE · PELINDO', isFree: true };
    } else {
      const tile = pool[cursor++];
      grid[idx] = { id: tile.id, bab: tile.bab, shortLabel: tile.shortLabel, isFree: false };
    }
  }
  return grid;
}

// Chapter-interleaved call order: round-robin across the 4 shuffled bab buckets
function buildCallOrder() {
  const rng = mulberry32(Date.now() ^ crypto.randomInt(1, 1_000_000));
  const buckets = CHAPTERS.map((ch) =>
    shuffleWithRng(
      TILES.filter((t) => t.bab === ch.name),
      rng
    )
  );
  const maxLen = Math.max(...buckets.map((b) => b.length));
  const order = [];
  for (let i = 0; i < maxLen; i++) {
    for (const bucket of buckets) {
      if (bucket[i]) order.push(bucket[i].id);
    }
  }
  return order;
}

function maskName(rawName) {
  const clean = String(rawName || '').trim();
  if (!clean) return 'K***';
  return clean
    .split(/\s+/)
    .map((part) => {
      const chars = Array.from(part);
      if (chars.length <= 2) return `${chars[0]}*`;
      if (chars.length <= 4) return `${chars[0]}${'*'.repeat(chars.length - 1)}`;
      return `${chars[0]}${chars[1]}${'*'.repeat(chars.length - 2)}`;
    })
    .join(' ');
}

function createEmptyTelemetry(gridSize) {
  return {
    totalPlayers: 0,
    activePlayers: 0,
    sleepingBingoCount: 0,
    sleepingBingoPct: 0,
    oneAwayCount: 0,
    oneAwayPct: 0,
    twoAwayCount: 0,
    twoAwayPct: 0,
    currentTileHoldersCount: 0,
    currentTileHoldersPct: 0,
    leaderboard: [],
  };
}

// Game state
const initialGridSize = resolveInitialGridSize();
const state = {
  gameId: crypto.randomBytes(4).toString('hex'),
  gridSize: initialGridSize,
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
  revealedHistory: [], // [{ id, bab, shortLabel }]
  players: new Map(), // playerId -> { playerId, cardNum, seed, name, grid, wonRank }
  recentJoins: [], // [{ cardNum, name, maskedName, joinedAtMs }]
  nextCardNum: 1,
  maxWinners: DEFAULT_MAX_WINNERS,
  winners: [], // [{ rank, playerId, cardNum, name, maskedName, claimAtMs, elapsedSinceRevealMs, lineIndices }]
  telemetry: createEmptyTelemetry(initialGridSize),
  hostClients: new Set(),
};

function recomputeTelemetry() {
  const totalPlayers = state.players.size;
  if (totalPlayers === 0) {
    state.telemetry = createEmptyTelemetry(state.gridSize);
    return;
  }

  const winLines = WIN_LINES_BY_SIZE[state.gridSize];
  const currentId = state.callCursor >= 0 ? state.callOrder[state.callCursor] : null;
  const checkCurrentTile = state.currentTileRevealed && currentId !== null;
  const pct = (count, denom) => (denom > 0 ? Number(((count / denom) * 100).toFixed(1)) : 0);

  let activePlayers = 0;
  let sleepingBingoCount = 0;
  let oneAwayCount = 0;
  let twoAwayCount = 0;
  let currentTileHoldersCount = 0;
  const contenders = [];

  for (const player of state.players.values()) {
    if (checkCurrentTile && player.grid.some((c) => !c.isFree && c.id === currentId)) {
      currentTileHoldersCount++;
    }
    if (player.wonRank) continue;

    activePlayers++;
    let totalHits = 0;
    for (const cell of player.grid) {
      if (!cell.isFree && state.revealedIds.has(cell.id)) totalHits++;
    }

    let maxLineHits = 0;
    let linesAtMax = 0;
    for (const line of winLines) {
      let hits = 0;
      for (const cellIdx of line) {
        const cell = player.grid[cellIdx];
        if (cell.isFree || state.revealedIds.has(cell.id)) hits++;
      }
      if (hits > maxLineHits) {
        maxLineHits = hits;
        linesAtMax = 1;
      } else if (hits === maxLineHits) {
        linesAtMax++;
      }
    }

    if (maxLineHits === state.gridSize) sleepingBingoCount++;
    else if (maxLineHits === state.gridSize - 1) oneAwayCount++;
    else if (maxLineHits === state.gridSize - 2) twoAwayCount++;

    contenders.push({
      cardNum: player.cardNum,
      maskedName: maskName(player.name),
      maxLineHits,
      gridSize: state.gridSize,
      linesAtMax,
      totalHits,
      needed: state.gridSize - maxLineHits,
    });
  }

  contenders.sort(
    (a, b) =>
      b.maxLineHits - a.maxLineHits ||
      b.linesAtMax - a.linesAtMax ||
      b.totalHits - a.totalHits ||
      a.cardNum - b.cardNum
  );

  const denom = activePlayers > 0 ? activePlayers : totalPlayers;
  state.telemetry = {
    totalPlayers,
    activePlayers,
    sleepingBingoCount,
    sleepingBingoPct: pct(sleepingBingoCount, denom),
    oneAwayCount,
    oneAwayPct: pct(oneAwayCount, denom),
    twoAwayCount,
    twoAwayPct: pct(twoAwayCount, denom),
    currentTileHoldersCount,
    currentTileHoldersPct: pct(currentTileHoldersCount, totalPlayers),
    leaderboard: contenders.slice(0, 5),
  };
}

function resetGameState(nextGridSize = state.gridSize) {
  state.gameId = crypto.randomBytes(4).toString('hex');
  state.gridSize = nextGridSize;
  state.phase = 'LOBBY';
  state.callOrder = buildCallOrder();
  state.callCursor = -1;
  state.currentTileRevealed = false;
  state.currentClueStartedAt = 0;
  state.lastRevealAt = 0;
  state.revealedIds.clear();
  state.revealedHistory = [];
  state.players.clear();
  state.recentJoins = [];
  state.nextCardNum = 1;
  state.winners = [];
  state.telemetry = createEmptyTelemetry(nextGridSize);
}

async function refreshQrSvg() {
  state.qrSvg = await QRCode.toString(state.joinUrl, {
    type: 'svg',
    margin: 2,
    width: 320,
    color: { dark: '#0a0a0a', light: '#ffffff' },
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
  const gridConfig = GRID_CONFIGS[state.gridSize];
  return {
    gameId: state.gameId,
    gridSize: state.gridSize,
    headers: gridConfig.headers,
    gridLabel: gridConfig.label,
    v: state.version,
    phase: state.phase,
    maxWinners: state.maxWinners,
    playerCount: state.players.size,
    callIndex: state.callCursor + 1,
    totalCalls: state.callOrder.length,
    currentClue: currentTile
      ? {
          bab: currentTile.bab,
          babColor: CHAPTER_COLOR_MAP[currentTile.bab] || '#38BDF8',
          cluePrompt: currentTile.cluePrompt,
          revealed: state.currentTileRevealed,
          id: state.currentTileRevealed ? currentTile.id : null,
          shortLabel: state.currentTileRevealed ? currentTile.shortLabel : null,
          answerDetail: state.currentTileRevealed ? currentTile.answerDetail : null,
        }
      : null,
    revealedIds: Array.from(state.revealedIds),
    revealedHistory: state.revealedHistory,
    recentJoins: state.recentJoins,
    telemetry: state.telemetry || createEmptyTelemetry(state.gridSize),
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
            gridSize: state.gridSize,
            headers: GRID_CONFIGS[state.gridSize].headers,
            playerId: p.playerId,
            cardNum: p.cardNum,
            name: p.name,
            grid: p.grid,
            wonRank: p.wonRank,
          });
        }

        const playerId = crypto.randomUUID();
        const cardNum = state.nextCardNum++;
        const seed = crypto.randomInt(1, 2_000_000_000);
        const name = rawName || `Kapten #${String(cardNum).padStart(3, '0')}`;
        const grid = generateCardGrid(seed, state.gridSize);
        const record = { playerId, cardNum, seed, name, grid, wonRank: null };
        state.players.set(playerId, record);
        state.recentJoins.unshift({
          cardNum,
          name,
          maskedName: maskName(name),
          joinedAtMs: Date.now(),
        });
        if (state.recentJoins.length > 6) state.recentJoins.length = 6;
        if (state.phase === 'LOBBY') {
          state.telemetry.totalPlayers = state.players.size;
          state.telemetry.activePlayers = state.players.size;
        } else {
          recomputeTelemetry();
        }
        bumpState();

        return sendJson(res, 200, {
          ok: true,
          gameId: state.gameId,
          gridSize: state.gridSize,
          headers: GRID_CONFIGS[state.gridSize].headers,
          playerId,
          cardNum,
          name,
          grid,
          wonRank: null,
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
        if (state.winners.length >= state.maxWinners) {
          return sendJson(res, 200, {
            ok: false,
            podiumFull: true,
            reason: `Podium Juara 1–${state.maxWinners} sudah penuh! Terima kasih sudah bermain.`,
            winners: state.winners,
          });
        }
        if (state.phase !== 'PLAYING') {
          return sendJson(res, 400, { ok: false, reason: 'Permainan belum dimulai atau sudah selesai.' });
        }

        // Validate submitted line or auto-detect any valid completed line on player's card
        const winLines = WIN_LINES_BY_SIZE[state.gridSize];
        const candidateLines = Array.isArray(lineIndices) && lineIndices.length === state.gridSize
          ? winLines.filter((L) => L.every((idx, i) => idx === lineIndices[i]))
          : winLines;

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
          maskedName: maskName(player.name),
          claimAtMs: nowMs,
          elapsedSinceRevealMs: state.lastRevealAt ? Math.max(0, nowMs - state.lastRevealAt) : 0,
          lineIndices: matchedLine,
        };
        state.winners.push(winEntry);
        if (state.winners.length >= state.maxWinners) {
          state.phase = 'ENDED';
        }
        recomputeTelemetry();
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
        try {
          const body = await readJsonBody(req);
          if (typeof body.url === 'string' && body.url.startsWith('http')) {
            state.joinUrl = body.url.trim();
            await refreshQrSvg();
            bumpState();
          }
          return sendJson(res, 200, { ok: true, joinUrl: state.joinUrl });
        } catch (err) {
          return sendJson(res, 400, { ok: false, reason: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/host/start') {
        state.phase = 'PLAYING';
        if (state.callCursor < 0) {
          state.callCursor = 0;
          state.currentTileRevealed = false;
          state.currentClueStartedAt = Date.now();
        }
        recomputeTelemetry();
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
              bab: t.bab,
              shortLabel: t.shortLabel,
            });
          }
          recomputeTelemetry();
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
          recomputeTelemetry();
          bumpState();
        }
        return sendJson(res, 200, { ok: true, state: getPublicState() });
      }

      if (req.method === 'POST' && pathname === '/api/host/set-grid') {
        try {
          const body = await readJsonBody(req);
          const gridSize = Number(body.gridSize);
          if (gridSize !== 5 && gridSize !== 7) {
            return sendJson(res, 400, { ok: false, reason: 'gridSize must be 5 or 7' });
          }
          resetGameState(gridSize);
          bumpState();
          return sendJson(res, 200, { ok: true, state: getPublicState() });
        } catch (err) {
          return sendJson(res, 400, { ok: false, reason: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/host/set-winners') {
        try {
          const body = await readJsonBody(req);
          const nextMax = Number(body.maxWinners);
          if (!Number.isInteger(nextMax) || nextMax < MIN_WINNERS || nextMax > MAX_WINNERS_LIMIT) {
            return sendJson(res, 400, { ok: false, reason: `maxWinners must be an integer between ${MIN_WINNERS} and ${MAX_WINNERS_LIMIT}` });
          }
          state.maxWinners = nextMax;
          if (state.phase === 'PLAYING' && state.winners.length >= state.maxWinners) {
            state.phase = 'ENDED';
          } else if (state.phase === 'ENDED' && state.winners.length < state.maxWinners) {
            state.phase = 'PLAYING';
          }
          bumpState();
          return sendJson(res, 200, { ok: true, state: getPublicState() });
        } catch (err) {
          return sendJson(res, 400, { ok: false, reason: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/host/reset') {
        resetGameState(state.gridSize);
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
