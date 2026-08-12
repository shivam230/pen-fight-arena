/**
 * make-assets.mjs — generates the app icon and splash source images.
 *
 * Written as a signed-distance renderer with 3x3 supersampling rather than a
 * canvas/font pipeline, so it needs no native deps and produces the same result
 * on any machine. Deliberately no lettering: Apple's own guidance is that icon
 * text is unreadable at 60px, and the pen silhouette carries the idea on its own.
 *
 *   node tools/make-assets.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';

// ---------------------------------------------------------------- png ------

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * Per-row PNG filter selection.
 *
 * This is the whole ballgame for these images. The art is a smooth radial
 * gradient, and writing filter 0 (None) hands deflate a stream of slowly-varying
 * absolute values it can barely compress — 1.1 MB for one splash. Filtering
 * subtracts a prediction first, so a gradient collapses to a field of near-zero
 * residuals that deflate eats alive. The heuristic is the one from the PNG spec:
 * try all five filters and keep whichever gives the smallest sum of absolute
 * (signed) residuals.
 */
function filterRow(cur, prev, w, bpp, out) {
  const n = w * bpp;
  let best = -1, bestScore = Infinity;
  const cand = Buffer.alloc(n);
  for (let f = 0; f < 5; f++) {
    let score = 0;
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;      // left
      const b = prev ? prev[i] : 0;               // up
      const c = i >= bpp && prev ? prev[i - bpp] : 0;
      let pred;
      if (f === 0) pred = 0;
      else if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      const v = (cur[i] - pred) & 0xff;
      cand[i] = v;
      score += v < 128 ? v : 256 - v;
    }
    if (score < bestScore) {
      bestScore = score;
      best = f;
      cand.copy(out);
    }
  }
  return best;
}

/** Encode an RGB Uint8Array (w*h*3) as a PNG buffer. */
function encodePNG(rgb, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  const filtered = Buffer.alloc(stride);
  let prev = null;
  for (let y = 0; y < h; y++) {
    const cur = rgb.subarray(y * stride, (y + 1) * stride);
    const f = filterRow(cur, prev, w, 3, filtered);
    raw[y * (stride + 1)] = f;
    filtered.copy(raw, y * (stride + 1) + 1);
    prev = cur;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------- shading ----

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** sRGB hex -> linear-ish float triple (we composite in sRGB, close enough here). */
function rgbOf(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

const INK = rgbOf(0x05070a);
const EMBER = rgbOf(0xff4655);
const TEAL = rgbOf(0x24e8c6);
const BARREL = rgbOf(0xf4f2ec);
const CAP = rgbOf(0x18324f);
const TIP = rgbOf(0xb9bec6);

/** Distance from point p to the segment a-b. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp01(t);
  const qx = ax + dx * t, qy = ay + dy * t;
  return { d: Math.hypot(px - qx, py - qy), t };
}

/**
 * Shade one sample in normalised [-1,1] space.
 * `penScale` lets the splash reuse the identical art at a smaller size.
 */
function shade(x, y, penScale, out) {
  // --- backdrop: deep ink with a warm ember bloom low-left and a teal rim ---
  const r = Math.hypot(x, y);
  let cr = INK[0], cg = INK[1], cb = INK[2];

  // A broad warm field first, so the icon never reads as a black square in a
  // home-screen grid, then a hotter core low-left.
  const field = 1 - smooth(0.0, 1.5, r);
  cr += 0.30 * field; cg += 0.075 * field; cb += 0.055 * field;

  const ember = Math.exp(-((x + 0.42) ** 2 + (y - 0.48) ** 2) * 1.5);
  cr += EMBER[0] * ember * 0.95;
  cg += EMBER[1] * ember * 0.34;
  cb += EMBER[2] * ember * 0.30;

  const rim = Math.exp(-((x - 0.62) ** 2 + (y + 0.62) ** 2) * 2.6) * 0.7;
  cr += TEAL[0] * rim * 0.14;
  cg += TEAL[1] * rim * 0.34;
  cb += TEAL[2] * rim * 0.34;

  // Gentle vignette only — the corners get masked off by the OS anyway.
  const vig = 1 - smooth(0.75, 1.6, r) * 0.42;
  cr *= vig; cg *= vig; cb *= vig;

  // --- the pen, drawn as a capsule along a 38 degree diagonal --------------
  const ang = -Math.PI * 0.21;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  // Sized to fill the icon's safe area: iOS masks the corners, so the mark runs
  // corner-to-corner along the diagonal rather than fitting the square.
  const L = 0.80 * penScale;      // half-length
  const R = 0.145 * penScale;     // barrel radius
  const ax = -ca * L, ay = -sa * L;
  const bx = ca * L, by = sa * L;
  const { d, t } = segDist(x, y, ax, ay, bx, by);

  // Taper the last 12% into the writing tip.
  const taper = t > 0.88 ? mix(1, 0.24, smooth(0.88, 1.0, t)) : 1;
  const edge = R * taper;
  const cov = 1 - smooth(edge - 0.008, edge + 0.008, d);

  if (cov > 0.001) {
    // Colour along the barrel: cap, body, then metal tip.
    let pr, pg, pb;
    if (t < 0.26) { [pr, pg, pb] = CAP; }
    else if (t > 0.90) { [pr, pg, pb] = TIP; }
    else { [pr, pg, pb] = BARREL; }

    // Cylindrical shading: signed offset across the barrel gives the highlight.
    const perp = (-(x - ax) * sa + (y - ay) * ca) / Math.max(edge, 1e-6);
    const lift = 1 + 0.42 * Math.exp(-((perp + 0.45) ** 2) * 5.5) - 0.40 * clamp01(perp);
    pr = clamp01(pr * lift); pg = clamp01(pg * lift); pb = clamp01(pb * lift);

    // A teal accent band where the cap meets the barrel.
    const band = Math.exp(-((t - 0.29) ** 2) * 5200);
    pr = mix(pr, TEAL[0], band * 0.9);
    pg = mix(pg, TEAL[1], band * 0.9);
    pb = mix(pb, TEAL[2], band * 0.9);

    cr = mix(cr, pr, cov);
    cg = mix(cg, pg, cov);
    cb = mix(cb, pb, cov);
  }

  // Contact glow under the pen so it sits in the scene rather than on it.
  const glow = Math.exp(-((d - R * 1.6) ** 2) * 10) * 0.22;
  cr += EMBER[0] * glow * 0.5;
  cg += TEAL[1] * glow * 0.25;
  cb += TEAL[2] * glow * 0.3;

  out[0] = clamp01(cr); out[1] = clamp01(cg); out[2] = clamp01(cb);
}

function render(size, penScale) {
  const buf = Buffer.alloc(size * size * 3);
  const SS = 3;                        // 3x3 supersampling
  const acc = [0, 0, 0];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
          const ny = ((py + (sy + 0.5) / SS) / size) * 2 - 1;
          shade(nx, ny, penScale, acc);
          r += acc[0]; g += acc[1]; b += acc[2];
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 3;
      buf[i] = Math.round((r / n) * 255);
      buf[i + 1] = Math.round((g / n) * 255);
      buf[i + 2] = Math.round((b / n) * 255);
    }
  }
  return encodePNG(buf, size, size);
}

mkdirSync(new URL('../assets/', import.meta.url), { recursive: true });
const out = (name) => new URL(`../assets/${name}`, import.meta.url);

writeFileSync(out('icon.png'), render(1024, 1.0));
console.log('assets/icon.png    1024x1024');

// Splash is a big square that gets centre-cropped to any device aspect, so the
// mark has to sit well inside the safe middle.
writeFileSync(out('splash.png'), render(2732, 0.30));
console.log('assets/splash.png  2732x2732');

writeFileSync(out('splash-dark.png'), render(2732, 0.30));
console.log('assets/splash-dark.png  2732x2732');

// --------------------------------------------------------------- imageset ---
/*
 * `capacitor-assets generate` fills the iOS Splash.imageset by writing the SAME
 * 2732px image to @1x, @2x and @3x — six copies once light and dark are counted,
 * for one unique picture, and every byte ships inside the .ipa. An asset catalog
 * already understands scale factors, so the correct assets are 911/1822/2732 and
 * the device picks one. That is ~4.6 MB of the app binary recovered for nothing.
 *
 * This runs AFTER capacitor-assets, so it is wired into `npm run assets` rather
 * than left as a manual step that the next `cap sync` would silently undo.
 */
const imageset = new URL('../ios/App/App/Assets.xcassets/Splash.imageset/', import.meta.url);
if (existsSync(imageset)) {
  let saved = 0;
  for (const scale of [1, 2, 3]) {
    const png = render(911 * scale, 0.30);
    for (const variant of ['', '-dark']) {
      const f = new URL(`Default@${scale}x~universal~anyany${variant}.png`, imageset);
      if (!existsSync(f)) continue;
      saved += statSync(f).size - png.length;
      writeFileSync(f, png);
    }
  }
  console.log(`ios Splash.imageset rescaled to 1x/2x/3x — ${(saved / 1048576).toFixed(2)} MB saved`);
} else {
  console.log('ios/ not present — skipping imageset rescale');
}
