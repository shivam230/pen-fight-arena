/**
 * sky.js — the sky is painted once into an equirectangular canvas, then used as
 * BOTH `scene.background` and the source for the PMREM environment map.
 *
 * Doing it this way costs one texture lookup per background pixel instead of a
 * multi-octave noise shader every frame, ships zero image files, and gives each
 * biome a physically consistent look: the same sky that you see behind the plateau
 * is the sky reflecting off the pen barrels.
 */

import * as THREE from 'three';
import { Noise, mulberry32 } from './noise.js';

const W = 1024;
const H = 512;

function css(c, a = 1) {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * @param {object} sky   biome sky description
 * @param {number} seed
 * @returns {HTMLCanvasElement}
 */
function paintSky(sky, seed) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  // Flagged for readback: the horizon-glow pass below calls getImageData on this
  // canvas, and without the hint Chrome keeps it GPU-backed and stalls the
  // pipeline on every read — the browser warns about it by name. It costs
  // nothing here because this canvas is drawn once at boot and then uploaded.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const noise = new Noise(seed ^ 0x5bd1);
  const rnd = mulberry32(seed ^ 0x9e37);

  // --- vertical gradient: zenith → horizon → ground bounce -------------------
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0.0, css(sky.zenith));
  grad.addColorStop(0.38, css(sky.upper));
  grad.addColorStop(0.5, css(sky.horizon));
  grad.addColorStop(0.62, css(sky.lower));
  grad.addColorStop(1.0, css(sky.ground));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // --- cloud layers ---------------------------------------------------------
  // Bands of soft noise blobs, squashed towards the horizon so they read as
  // receding perspective rather than wallpaper.
  if (sky.cloud > 0) {
    const layers = 3;
    for (let l = 0; l < layers; l++) {
      const yCentre = H * (0.30 + l * 0.055);
      const spread = H * (0.10 - l * 0.022);
      const scale = 3.5 + l * 3.0;
      const alpha = sky.cloud * (0.5 - l * 0.11);
      const img = ctx.getImageData(0, Math.max(0, yCentre - spread * 2.2) | 0, W,
        Math.min(H, spread * 4.4) | 0);
      const d = img.data;
      const y0 = Math.max(0, yCentre - spread * 2.2) | 0;
      const cr = (sky.cloudColor >> 16) & 255;
      const cg = (sky.cloudColor >> 8) & 255;
      const cb = sky.cloudColor & 255;
      for (let py = 0; py < img.height; py++) {
        const wy = y0 + py;
        const fall = Math.exp(-((wy - yCentre) ** 2) / (2 * spread * spread));
        if (fall < 0.01) continue;
        for (let px = 0; px < W; px++) {
          // Wrap horizontally: sample on a circle so the seam matches.
          const th = (px / W) * Math.PI * 2;
          const n = noise.fbm(Math.cos(th) * scale, Math.sin(th) * scale + l * 7.1
            + (wy - yCentre) * 0.02 * scale, 4);
          const v = Math.max(0, n * 0.5 + 0.5 - sky.cloudCut);
          const a = Math.min(1, v * 2.6) * fall * alpha;
          if (a < 0.004) continue;
          const i = (py * W + px) * 4;
          d[i] = d[i] + (cr - d[i]) * a;
          d[i + 1] = d[i + 1] + (cg - d[i + 1]) * a;
          d[i + 2] = d[i + 2] + (cb - d[i + 2]) * a;
        }
      }
      ctx.putImageData(img, 0, y0);
    }
  }

  // --- sun / key light source ----------------------------------------------
  // sunAz in turns (0..1) around the horizon, sunEl in 0..1 up from horizon.
  const sx = ((sky.sunAz % 1) + 1) % 1 * W;
  const sy = H * 0.5 - sky.sunEl * H * 0.5;

  // Draw the glow twice (wrapped) so a sun near the seam doesn't get clipped.
  for (const ox of [-W, 0, W]) {
    const glow = ctx.createRadialGradient(sx + ox, sy, 0, sx + ox, sy, W * 0.30);
    glow.addColorStop(0, css(sky.sunColor, 0.95));
    glow.addColorStop(0.06, css(sky.sunColor, 0.55));
    glow.addColorStop(0.28, css(sky.sunColor, 0.13));
    glow.addColorStop(1, css(sky.sunColor, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }
  if (sky.sunDisc) {
    for (const ox of [-W, 0, W]) {
      const disc = ctx.createRadialGradient(sx + ox, sy, 0, sx + ox, sy, W * 0.018);
      disc.addColorStop(0, css(0xffffff, 1));
      disc.addColorStop(0.55, css(sky.sunColor, 1));
      disc.addColorStop(1, css(sky.sunColor, 0));
      ctx.fillStyle = disc;
      ctx.fillRect(sx + ox - W * 0.02, sy - W * 0.02, W * 0.04, W * 0.04);
    }
  }

  // --- optional aurora ribbons (glacier biome) ------------------------------
  if (sky.aurora) {
    ctx.globalCompositeOperation = 'lighter';
    for (let r = 0; r < 4; r++) {
      const baseY = H * (0.16 + rnd() * 0.16);
      const amp = H * (0.03 + rnd() * 0.05);
      const hue = sky.auroraColors[r % sky.auroraColors.length];
      const g2 = ctx.createLinearGradient(0, baseY - amp * 3, 0, baseY + amp * 3);
      g2.addColorStop(0, css(hue, 0));
      g2.addColorStop(0.5, css(hue, 0.28));
      g2.addColorStop(1, css(hue, 0));
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.moveTo(0, baseY);
      for (let px = 0; px <= W; px += 8) {
        const th = (px / W) * Math.PI * 2;
        const n = noise.fbm(Math.cos(th) * 2.2 + r * 11, Math.sin(th) * 2.2, 3);
        ctx.lineTo(px, baseY + n * amp * 2.4);
      }
      for (let px = W; px >= 0; px -= 8) {
        const th = (px / W) * Math.PI * 2;
        const n = noise.fbm(Math.cos(th) * 2.2 + r * 11, Math.sin(th) * 2.2, 3);
        ctx.lineTo(px, baseY + n * amp * 2.4 - amp * (1.4 + rnd() * 1.2));
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // --- city glow below the horizon (monsoon rooftop) ------------------------
  if (sky.cityGlow) {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 90; i++) {
      const x = rnd() * W;
      const y = H * (0.53 + rnd() * 0.16);
      const rad = 6 + rnd() * 34;
      const c = sky.cityColors[(rnd() * sky.cityColors.length) | 0];
      const g3 = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g3.addColorStop(0, css(c, 0.5));
      g3.addColorStop(1, css(c, 0));
      ctx.fillStyle = g3;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // --- horizon haze band ----------------------------------------------------
  const haze = ctx.createLinearGradient(0, H * 0.40, 0, H * 0.60);
  haze.addColorStop(0, css(sky.haze, 0));
  haze.addColorStop(0.5, css(sky.haze, sky.hazeStrength));
  haze.addColorStop(1, css(sky.haze, 0));
  ctx.fillStyle = haze;
  ctx.fillRect(0, H * 0.40, W, H * 0.20);

  return canvas;
}

/**
 * Cross-fade the left and right edges of an equirectangular image into each other.
 *
 * Text-to-image models almost never produce a seamless 360° wrap, and the join
 * lands as a hard vertical line in the background AND as a bright streak in the
 * reflections, because this same texture feeds the IBL. Blending a strip either
 * side of the wrap hides both.
 */
function blendSeam(image, blendFraction = 0.04) {
  const w = image.width, h = image.height;
  const blend = Math.max(1, Math.round(w * blendFraction));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);

  const head = ctx.getImageData(0, 0, blend, h);
  const tail = ctx.getImageData(w - blend, 0, blend, h);
  const a = head.data, b = tail.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < blend; x++) {
      const i = (y * blend + x) * 4;
      // t goes 0→1 across the strip: at the very seam the two sides are equal.
      const t = 0.5 + 0.5 * (x / blend);
      for (let k = 0; k < 3; k++) {
        const av = a[i + k], bv = b[i + k];
        a[i + k] = av * t + bv * (1 - t);
        b[i + k] = bv * t + av * (1 - t);
      }
    }
  }
  ctx.putImageData(head, 0, 0);
  ctx.putImageData(tail, w - blend, 0);
  return cv;
}

/**
 * Build the background texture + PMREM environment for a biome.
 *
 * If the biome names a panorama (`sky.image`) it is used for both the visible sky
 * and the image-based lighting, so the pens are genuinely lit by and reflect the
 * artwork rather than sitting in front of it. Otherwise the sky is painted
 * procedurally, which stays the default and the fallback.
 *
 * Call once per match, on the loading screen — `fromEquirectangular` does a GGX
 * convolution on the GPU (~5-15ms) and must not run inside the frame loop.
 */
export async function buildSkyEnvironment(renderer, sky, seed) {
  let source;
  if (sky.image) {
    try {
      const img = await new THREE.ImageLoader().loadAsync(sky.image);
      source = sky.seamBlend === 0 ? img : blendSeam(img, sky.seamBlend ?? 0.04);
    } catch {
      // A missing or broken panorama must never cost the player a match.
      source = paintSky(sky, seed);
    }
  } else {
    source = paintSky(sky, seed);
  }

  const texture = new THREE.CanvasTexture(source);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envMap = pmrem.fromEquirectangular(texture).texture;
  pmrem.dispose();

  return { background: texture, envMap };
}

/**
 * World-space direction the key light shines FROM, derived from the painted sun so
 * the shadows and the visible sun agree.
 *
 * Three samples an equirectangular background as
 *   u = atan2(dir.z, dir.x) / 2π + 0.5,   v = asin(dir.y) / π + 0.5
 * and we painted the sun at u = sunAz, v = 0.5 + sunEl/2 — so inverting gives:
 */
export function sunDirection(sky, distance = 1) {
  const phi = (sky.sunAz - 0.5) * Math.PI * 2;
  const el = sky.sunEl * Math.PI * 0.5;
  return new THREE.Vector3(
    Math.cos(el) * Math.cos(phi),
    Math.sin(el),
    Math.cos(el) * Math.sin(phi),
  ).multiplyScalar(distance);
}
