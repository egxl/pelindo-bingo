import assert from 'node:assert/strict';
import { createGameServer } from '../server.js';

const WIN_LINES = [
  [0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
  [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
  [0,6,12,18,24],[4,8,12,16,20],
];

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

async function run() {
  const { server, state } = await createGameServer();
  server.keepAliveTimeout = 65_000;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', 1024, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Check static pages & QR SVG
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

    // 2. 400 concurrent players join (100-wide bursts to stay within Windows Desktop TCP SYN cap)
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
    assert.ok(joins.every((j) => j.ok && j.grid.length === 25 && j.grid[12].isFree));
    console.log(`[PASS] 400 concurrent joins completed in ${joinMs.toFixed(1)} ms`);

    // 3. Start game & verify anti-cheat rejects premature claim
    await fetch(`${base}/api/host/start`, { method: 'POST' });
    const cheatRes = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: joins[0].playerId, lineIndices: [0, 1, 2, 3, 4] }),
    }).then((r) => r.json());
    assert.equal(cheatRes.ok, false, 'Premature claim must be rejected');
    console.log('[PASS] Anti-cheat rejected uncalled-tile claim');

    // 4. 400 conditional polls (200 then 304)
    const st0 = await fetch(`${base}/api/state?v=0`).then((r) => r.json());
    const tPoll = performance.now();
    const polls304 = await batchConcurrent(400, 100, () => fetch(`${base}/api/state?v=${st0.v}`));
    const pollMs = performance.now() - tPoll;
    assert.ok(polls304.every((r) => r.status === 304));
    console.log(`[PASS] 400 concurrent 304 conditional polls in ${pollMs.toFixed(1)} ms`);

    // 5. Advance clues & reveals until >= 4 players have a valid winning line
    let readyClaimants = [];
    for (let step = 0; step < 35; step++) {
      await fetch(`${base}/api/host/reveal`, { method: 'POST' });
      const st = await fetch(`${base}/api/state?v=0`).then((r) => r.json());
      const revealed = new Set(st.revealedIds);
      readyClaimants = [];
      for (const p of joins) {
        for (const line of WIN_LINES) {
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

    // 6. Race concurrent claims & verify strict Top-3 podium + 4th rejection
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
    console.log(`[PASS] Top-3 podium verified (${wins.length} winners, ${fullRejects.length} overflow rejected, phase=${state.phase})`);
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
