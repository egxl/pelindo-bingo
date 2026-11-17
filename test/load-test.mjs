import assert from 'node:assert/strict';
import { createGameServer } from '../server.js';
import { CHAPTERS, TILES } from '../data/tiles.js';

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

async function batchConcurrent(total, batchSize, fn) {
  const results = [];
  for (let start = 0; start < total; start += batchSize) {
    const end = Math.min(total, start + batchSize);
    const chunk = await Promise.all(
      Array.from({ length: end - start }, (_, k) => fn(start + k))
    );
    results.push(...chunk);
  }
  return results;
}

async function runModeVerification(base, state, expectedGridSize, expectedHeaders) {
  const winLines = buildWinLines(expectedGridSize);
  const totalCells = expectedGridSize * expectedGridSize;
  const freeIndex = Math.floor(totalCells / 2);

  // Verify initial state for this grid size
  const initState = await fetch(`${base}/api/state?v=0`).then((r) => r.json());
  assert.equal(initState.gridSize, expectedGridSize);
  assert.deepEqual(initState.headers, expectedHeaders);
  assert.equal(initState.totalCalls, TILES.length);

  // 400 concurrent players join (100-wide bursts to stay within Windows Desktop TCP SYN cap)
  const t0 = performance.now();
  const joins = await batchConcurrent(400, 100, (i) =>
    fetch(`${base}/api/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Peserta-${i + 1}` }),
    }).then((r) => r.json())
  );
  const joinMs = performance.now() - t0;
  assert.equal(joins.length, 400);
  assert.ok(
    joins.every(
      (j) =>
        j.ok &&
        j.gridSize === expectedGridSize &&
        j.grid.length === totalCells &&
        j.grid[freeIndex].isFree &&
        new Set(j.grid.filter((c) => !c.isFree).map((c) => c.id)).size === totalCells - 1
    ),
    `All 400 cards must have ${totalCells} cells, center free (${freeIndex}), and unique tiles`
  );
  console.log(`[PASS] (${expectedGridSize}x${expectedGridSize}) 400 concurrent joins in ${joinMs.toFixed(1)} ms`);

  // Start game & verify anti-cheat rejects premature claim
  await fetch(`${base}/api/host/start`, { method: 'POST' });
  const cheatRes = await fetch(`${base}/api/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: joins[0].playerId, lineIndices: winLines[0] }),
  }).then((r) => r.json());
  assert.equal(cheatRes.ok, false, 'Premature claim must be rejected');
  console.log(`[PASS] (${expectedGridSize}x${expectedGridSize}) Anti-cheat rejected uncalled-tile claim`);

  // 400 conditional polls (200 then 304)
  const st0 = await fetch(`${base}/api/state?v=0`).then((r) => r.json());
  const tPoll = performance.now();
  const polls304 = await batchConcurrent(400, 100, () => fetch(`${base}/api/state?v=${st0.v}`));
  const pollMs = performance.now() - tPoll;
  assert.ok(polls304.every((r) => r.status === 304));
  console.log(`[PASS] (${expectedGridSize}x${expectedGridSize}) 400 concurrent 304 polls in ${pollMs.toFixed(1)} ms`);

  // Advance clues & reveals until >= 4 players have a valid winning line
  let readyClaimants = [];
  for (let step = 0; step < TILES.length; step++) {
    await fetch(`${base}/api/host/reveal`, { method: 'POST' });
    const st = await fetch(`${base}/api/state?v=0`).then((r) => r.json());
    const revealed = new Set(st.revealedIds);
    readyClaimants = [];
    for (const p of joins) {
      for (const line of winLines) {
        if (line.every((idx) => p.grid[idx].isFree || revealed.has(p.grid[idx].id))) {
          readyClaimants.push({ playerId: p.playerId, lineIndices: line });
          break;
        }
      }
    }
    if (readyClaimants.length >= 4) break;
    await fetch(`${base}/api/host/next-clue`, { method: 'POST' });
  }
  assert.ok(readyClaimants.length >= 4, `Expected >=4 eligible winners, got ${readyClaimants.length}`);

  // Race concurrent claims & verify strict Top-3 podium + 4th rejection
  const claimResults = await Promise.all(
    readyClaimants.slice(0, 6).map((c) =>
      fetch(`${base}/api/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c),
      }).then((r) => r.json())
    )
  );
  const wins = claimResults.filter((r) => r.ok);
  const fullRejects = claimResults.filter((r) => !r.ok && r.podiumFull);
  assert.equal(wins.length, 3, 'Exactly 3 winners must be crowned');
  assert.ok(fullRejects.length >= 1, '4th+ claimant must see podiumFull');
  assert.deepEqual(wins.map((w) => w.rank).sort(), [1, 2, 3]);
  assert.equal(state.phase, 'ENDED');
  console.log(`[PASS] (${expectedGridSize}x${expectedGridSize}) Top-3 podium verified (${wins.length} winners, ${fullRejects.length} overflow rejected, phase=${state.phase})`);
}

async function run() {
  assert.equal(TILES.length, 65, 'CSV must load 65 rows');

  const { server, state } = await createGameServer();
  server.keepAliveTimeout = 65_000;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', 1024, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Verify chapter-interleaved callOrder (first N calls cover all chapters)
    assert.equal(state.callOrder.length, TILES.length);
    const firstWaveBabs = new Set(
      state.callOrder.slice(0, CHAPTERS.length).map((id) => TILES[id].bab)
    );
    assert.equal(firstWaveBabs.size, CHAPTERS.length, `First ${CHAPTERS.length} calls must interleave across all ${CHAPTERS.length} chapters`);
    console.log(`[PASS] CSV ${TILES.length} rows loaded & callOrder interleaved across ${CHAPTERS.length} chapters`);

    // 2. Check static pages & QR SVG
    const [playRes, hostRes, qrRes] = await Promise.all([
      fetch(`${base}/`),
      fetch(`${base}/host`),
      fetch(`${base}/api/qr`),
    ]);
    assert.equal(playRes.status, 200);
    assert.equal(hostRes.status, 200);
    assert.equal(qrRes.status, 200);
    const playHtml = await playRes.text();
    assert.ok(playHtml.includes('CLAIM PELINDO!'), 'play.html must have CLAIM PELINDO! branding');
    assert.ok((await qrRes.text()).includes('<svg'), '/api/qr must return valid SVG');

    // 3. Default startup mode: 5x5 P-R-I-O-K
    const gameId5 = state.gameId;
    await runModeVerification(base, state, 5, ['P', 'R', 'I', 'O', 'K']);

    // 4. Reject invalid gridSize
    const badGridRes = await fetch(`${base}/api/host/set-grid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gridSize: 6 }),
    });
    assert.equal(badGridRes.status, 400);

    // 5. Switch live to 7x7 P-E-L-I-N-D-O & verify gameId rotates
    const switchRes = await fetch(`${base}/api/host/set-grid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gridSize: 7 }),
    }).then((r) => r.json());
    assert.equal(switchRes.ok, true);
    assert.notEqual(switchRes.state.gameId, gameId5, 'Switching grid must rotate gameId');
    console.log('[PASS] Live switch 5x5 -> 7x7 rotated gameId');

    // 6. Verify 7x7 P-E-L-I-N-D-O mode
    await runModeVerification(base, state, 7, ['P', 'E', 'L', 'I', 'N', 'D', 'O']);

    // 7. Switch back 7x7 -> 5x5 & verify malformed set-url returns 400
    const gameId7 = state.gameId;
    const switchBackRes = await fetch(`${base}/api/host/set-grid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gridSize: 5 }),
    }).then((r) => r.json());
    assert.equal(switchBackRes.ok, true);
    assert.equal(switchBackRes.state.gridSize, 5);
    assert.notEqual(switchBackRes.state.gameId, gameId7, 'Switching back 7x7 -> 5x5 must rotate gameId');

    const badUrlRes = await fetch(`${base}/api/host/set-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-json',
    });
    assert.equal(badUrlRes.status, 400);

    const setWinnersRes = await fetch(`${base}/api/host/set-winners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxWinners: 5 }),
    }).then((r) => r.json());
    assert.equal(setWinnersRes.ok, true);
    assert.equal(setWinnersRes.state.maxWinners, 5);

    const badWinnersRes = await fetch(`${base}/api/host/set-winners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxWinners: 11 }),
    });
    assert.equal(badWinnersRes.status, 400);

    const joinSample = await fetch(`${base}/api/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Budi Priok' }),
    }).then((r) => r.json());
    assert.equal(joinSample.ok, true);
    const stAfterJoin = await fetch(`${base}/api/state?v=0`).then((r) => r.json());
    assert.equal(stAfterJoin.recentJoins[0].name, 'Budi Priok');
    assert.equal(stAfterJoin.recentJoins[0].maskedName, 'B*** Pr***');
    console.log('[PASS] Live switch 7x7 -> 5x5, set-winners (1-10), & uncensored lobby join feed verified');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
