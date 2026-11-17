import { spawn, exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cloudflaredPath = path.join(__dirname, 'tools', 'cloudflared.exe');
const tunnelLog = path.join(os.tmpdir(), 'pelindo-cloudflared.log');
const CF_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

if (!fs.existsSync(cloudflaredPath)) {
  console.log('[PELINDO!] Mengunduh portable cloudflared.exe (tanpa admin)...');
  fs.mkdirSync(path.dirname(cloudflaredPath), { recursive: true });
  const res = await fetch(CF_URL);
  if (!res.ok || !res.body) {
    console.error(`[PELINDO!] Gagal mengunduh cloudflared.exe (HTTP ${res.status}).`);
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(cloudflaredPath));
}
if (fs.existsSync(tunnelLog)) fs.unlinkSync(tunnelLog);

console.log('[PELINDO!] Menjalankan server lokal di 127.0.0.1:3000...');
const nodeProc = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  stdio: 'inherit',
});

console.log('[PELINDO!] Membuka Cloudflare Quick Tunnel (http2)...');
const cfProc = spawn(
  cloudflaredPath,
  ['tunnel', '--protocol', 'http2', '--url', 'http://127.0.0.1:3000', '--logfile', tunnelLog],
  { cwd: __dirname, stdio: 'ignore' }
);

function cleanup() {
  if (!cfProc.killed) cfProc.kill();
  if (!nodeProc.killed) nodeProc.kill();
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

let publicUrl = null;
let urlPosted = false;

const pollTimer = setInterval(async () => {
  if (!fs.existsSync(tunnelLog)) return;
  const text = fs.readFileSync(tunnelLog, 'utf8');
  if (!publicUrl) {
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) publicUrl = m[0];
  }
  if (publicUrl && !urlPosted && text.includes('Registered tunnel connection')) {
    urlPosted = true;
    clearInterval(pollTimer);
    setTimeout(async () => {
      try {
        await fetch('http://127.0.0.1:3000/api/host/set-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: publicUrl }),
        });
        console.log(`[PELINDO!] Tunnel aktif & terdaftar: ${publicUrl}`);
      } catch (err) {
        console.error('[PELINDO!] Gagal update QR URL:', err.message);
      }
      exec('start "" "http://127.0.0.1:3000/host"');
      console.log('[PELINDO!] Layar proyektor dibuka. Tekan Ctrl+C untuk berhenti.');
    }, 2000);
  }
}, 500);
