/**
 * audio-receiver.mjs — catches rendered WAVs from the browser and writes them out.
 *
 * The game has no audio files: every sound is built from oscillators and noise at
 * runtime. To hand someone actual files, the same engine is re-run against an
 * OfflineAudioContext in a real browser (Node has no Web Audio) and the rendered
 * buffers are POSTed here.
 *
 *   node tools/audio-receiver.mjs        # then run the browser-side export
 */

import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'audio-export');
mkdirSync(OUT, { recursive: true });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Filename',
};

let written = 0;

createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, CORS).end();
    return;
  }

  const name = (req.headers['x-filename'] || 'untitled.wav')
    .toString()
    .replace(/[^a-zA-Z0-9._-]/g, '_');   // never let a header write outside OUT

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    writeFileSync(join(OUT, name), buf);
    written++;
    console.log(`${String(written).padStart(2)}  ${name.padEnd(28)} ${(buf.length / 1024).toFixed(0)} KB`);
    res.writeHead(200, CORS).end('ok');
  });
}).listen(5199, '127.0.0.1', () => {
  console.log(`receiver listening on http://127.0.0.1:5199 -> ${OUT}`);
});
