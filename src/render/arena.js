/**
 * arena.js — procedural arena generation. Every match builds a fresh one:
 * an irregular rock plateau, the cliff falling away beneath it, a ring of
 * distant peaks, a sea of cloud, and whatever hazards the biome throws on top.
 *
 * The plateau's outline is a periodic radial function of angle, which is also
 * exactly what the physics solver uses for its edge test — so the silhouette you
 * see and the boundary you fall off are guaranteed to be the same curve.
 *
 * Scale note: the plateau is deliberately about the size of a school desk
 * (~1.2 m across) rather than a film set. A pen is 14 cm, so at this size it
 * reads as a real object on screen instead of a splinter on a football pitch.
 */

import * as THREE from 'three';
import { Noise, mulberry32 } from './noise.js';
import { Obstacle, RIM_START } from '../game/physics.js';
import { glowPoints } from './fx.js';

const BASE_RADIUS = 0.62;   // metres — a pen is ~1/9th of the arena, as on a desk
const CLIFF_DEPTH = 22;
// Raised from 26x120. The surface detail a polar grid can carry is capped by its
// RADIAL sampling — anything finer aliases into a pinwheel moire — so the only way
// to get genuinely rocky ground rather than a smooth dome is more rings. 41x161
// verts is nothing next to the 7k the distant range already costs.
const TOP_RINGS = 40;
const TOP_SEGS = 160;

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _hi = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

function lerpColorInto(target, a, b, t) {
  _c.setHex(a, THREE.SRGBColorSpace);
  _c2.setHex(b, THREE.SRGBColorSpace);
  target.copy(_c).lerp(_c2, THREE.MathUtils.clamp(t, 0, 1));
  return target;
}

/**
 * Builds the closed, periodic outline of the plateau.
 * Sampling noise on a circle makes it seamless at θ = 0 for free.
 */
function makeBoundary(noise, rnd) {
  const a1 = 0.10 + rnd() * 0.06;
  const a2 = 0.035 + rnd() * 0.030;
  const k1 = 1.7 + rnd() * 1.1;
  const k2 = 4.2 + rnd() * 2.4;
  const phase = rnd() * 10;
  // One deliberate flat "approach face" per arena — a wide gentle edge that reads
  // as the natural place to open from, so arenas have readable geometry.
  const faceAngle = rnd() * Math.PI * 2;
  const fn = (theta) => {
    const c = Math.cos(theta), s = Math.sin(theta);
    const n1 = noise.fbm(c * k1 + phase, s * k1, 3);
    const n2 = noise.fbm(c * k2, s * k2 + phase, 2);
    const face = Math.max(0, Math.cos(theta - faceAngle)) ** 6 * 0.06;
    return BASE_RADIUS * (1 + a1 * n1 + a2 * n2 + face);
  };
  fn.faceAngle = faceAngle;
  return fn;
}

/**
 * Polar grid → BufferGeometry.
 *
 * `normalOf(x, z, out)` is optional. Supplying it matters: a polar grid degenerates
 * into slivers at the centre, and `computeVertexNormals` on those slivers produces
 * the classic radial-petal shading artifact. Deriving normals analytically from the
 * height field instead makes the shading independent of the triangulation.
 */
function polarMesh(rings, segs, sample, closedCentre, normalOf, tCurve = 1) {
  const vCount = (rings + 1) * (segs + 1);
  const pos = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const nrm = normalOf ? new Float32Array(vCount * 3) : null;
  const idx = [];
  const c = new THREE.Color();
  const n = new THREE.Vector3();

  let v = 0;
  for (let r = 0; r <= rings; r++) {
    const t = Math.pow(r / rings, tCurve);
    for (let s = 0; s <= segs; s++) {
      const theta = (s / segs) * Math.PI * 2;
      const p = sample(theta, t, c);
      pos[v * 3] = p.x; pos[v * 3 + 1] = p.y; pos[v * 3 + 2] = p.z;
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
      if (nrm) {
        normalOf(p.x, p.z, n);
        nrm[v * 3] = n.x; nrm[v * 3 + 1] = n.y; nrm[v * 3 + 2] = n.z;
      }
      v++;
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * (segs + 1) + s;
      const b = a + segs + 1;
      if (r === 0 && closedCentre) {
        idx.push(a, b + 1, b);
      } else {
        idx.push(a, b + 1, b, a, a + 1, b + 1);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  if (nrm) geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  else geo.computeVertexNormals();
  return geo;
}

function buildPlateauTop(biome, noise, boundary) {
  const g = biome.ground;

  // Relief stays a few millimetres — the solver treats the top as a perfect plane,
  // so anything taller would visibly swallow the pens — but with 40 rings the grid
  // resolves roughly 32 cycles/m, so the detail octaves can go far finer than
  // before without aliasing. This is what turns the ground from a smooth dome into
  // something that reads as rock under a moving light.
  const relief = (x, z) =>
    noise.fbm(x * 4.5, z * 4.5, 3) * 0.0055
    + noise.fbm(x * 11, z * 11, 3) * 0.0022
    + noise.fbm(x * 23, z * 23, 2) * 0.0009;

  const eps = 0.004;
  const normalOf = (x, z, out) => {
    const dx = (relief(x + eps, z) - relief(x - eps, z)) / (2 * eps);
    const dz = (relief(x, z + eps) - relief(x, z - eps)) / (2 * eps);
    out.set(-dx, 1, -dz).normalize();
  };

  const geo = polarMesh(TOP_RINGS, TOP_SEGS, (theta, t, out) => {
    const R = boundary(theta) * t;
    const x = Math.cos(theta) * R;
    const z = Math.sin(theta) * R;
    const y = relief(x, z);

    const grain = noise.fbm(x * 6 + 40, z * 6, 3) * 0.5 + 0.5;
    const fine = noise.fbm(x * 22, z * 22, 2) * 0.5 + 0.5;
    lerpColorInto(out, g.low, g.mid, 0.25 + grain * 0.85);
    const hi = Math.max(0, grain - 0.66) * 1.9;
    if (hi > 0) out.lerp(_hi.setHex(g.high, THREE.SRGBColorSpace), Math.min(1, hi) * 0.7);

    // Scoured pale drift collecting toward the rim, kept subtle — at full strength
    // it flattens the whole surface into a white disc.
    if (g.snow) {
      const rim = Math.max(0, t - 0.66) / 0.34;
      const drift = Math.max(0, noise.fbm(x * 5 - 12, z * 5, 3) * 0.5 + 0.5 - 0.52) * 2.1;
      out.lerp(_hi.setHex(g.accent, THREE.SRGBColorSpace),
        Math.min(0.34, drift * g.snow * (0.25 + rim * 0.75)));
    }
    // Weathered, grit-covered band around the lip. This is not decoration: it
    // starts exactly where the solver's rim drag starts, so the surface that slows
    // a pen down is the surface you can see.
    const lip = Math.max(0, t - RIM_START) / (1 - RIM_START);
    out.lerp(_hi.setHex(g.low, THREE.SRGBColorSpace), lip * 0.30);
    out.multiplyScalar((0.86 + fine * 0.30) * (1 - lip * 0.16));
    return { x, y, z };
    // tCurve 1.5 packs the innermost rings against the centre, so the degenerate
    // triangle fan there is millimetres wide and its colour wedges are invisible.
  }, true, normalOf, 1.5);

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: g.roughness,
    metalness: g.wet ? 0.18 : 0.0,
    envMapIntensity: g.ice ? 1.4 : g.wet ? 1.3 : 0.7,
  });

  if (g.glowCracks) applyGlowCracks(geo, mat, noise, g.accent);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'plateau-top';
  return mesh;
}

/**
 * Molten cracks in the basalt.
 *
 * The glow rides on a per-vertex attribute patched into the standard material's
 * emissive term, so it lights up through the existing PBR shader and feeds the
 * bloom pass for free — no second material, no extra draw call, no texture.
 */
function applyGlowCracks(geo, mat, noise, colorHex) {
  const pos = geo.attributes.position;
  const glow = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    // Ridged noise peaks along thin lines — exactly the shape of a cooling crack.
    // Anisotropic sampling stretches the ridges into elongated fissures rather
    // than round glowing patches, which is what a cooling lava crust actually does.
    const r = noise.ridged(x * 2.1, z * 7.4, 3);
    const veins = Math.max(0, r - 0.80) / 0.20;
    glow[i] = Math.min(1, veins * veins * 1.3);
  }
  geo.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));

  const col = new THREE.Color().setHex(colorHex, THREE.SRGBColorSpace);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCrackColor = { value: col };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform vec3 uCrackColor;')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uCrackColor * vGlow * 2.4;');
  };
  // Materials are cached by program signature; give this one its own.
  mat.customProgramCacheKey = () => 'glow-cracks';
}

function buildCliff(biome, noise, boundary) {
  const c = biome.cliff;
  const RINGS = 20, SEGS = TOP_SEGS;
  const geo = polarMesh(RINGS, SEGS, (theta, t, out) => {
    const edge = boundary(theta);
    const ct = Math.cos(theta), st = Math.sin(theta);

    // Flare out just under the lip, then taper — the overhang that makes a
    // plateau read as a plateau and not a cylinder.
    const profile = 1 + 0.09 * Math.min(1, t * 6) - 0.74 * t * t;
    // Sampling noise on a circle of fixed radius gives features that run the full
    // height of the face — columnar fluting. Mixing in a field where DEPTH is the
    // high-frequency axis breaks the columns into proper broken crags.
    const vertical = noise.ridged(ct * 3.2, st * 3.2, 4);
    const horizontal = noise.ridged(t * 11 + ct * 1.1, t * 8 - st * 1.1, 3);
    // Vertical crags dominate near the lip and give way to horizontal strata
    // deeper down, which is how a real weathered face reads.
    const crag = vertical * (0.52 - 0.38 * t) + horizontal * (0.28 + 0.50 * t);
    const crag2 = noise.fbm(ct * 7 + t * 26, st * 7 + t * 19, 3);
    // Real horizontal ledges in the geometry, not just banded colour.
    const strataR = Math.sin(t * 26 + crag2 * 1.8) * 0.5 + 0.5;
    const R = edge * (profile + (crag - 0.4) * 0.42 * Math.min(1, t * 3)
      + crag2 * 0.14 * t + strataR * 0.055 * Math.min(1, t * 4));

    const y = -CLIFF_DEPTH * Math.pow(t, 1.5);
    const x = ct * R;
    const z = st * R;

    // Sedimentary strata: horizontal colour banding is most of what sells rock.
    const strata = strataR;
    const shade = crag * 0.5 + crag2 * 0.2 + strata * 0.28 + 0.18;
    lerpColorInto(out, c.low, c.high, shade * (1 - t * 0.3));
    out.multiplyScalar(1 - t * 0.26); // deeper = darker; cheap ambient occlusion
    return { x, y, z };
  }, false);

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: c.roughness,
    metalness: 0,
    envMapIntensity: 0.55,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'cliff';
  return mesh;
}

/**
 * Height of the distant range at a world point, plus how high up the range that
 * is (0 at the foot, 1 at the nominal peak).
 *
 * Shared by the range mesh and anything that has to stand ON it — the treeline
 * needs the identical function or the trunks float and sink.
 */
function peakSurface(biome, noise, x, z) {
  const p = biome.peaks;
  const skyline = p.skyline ?? 26;
  const f = p.frequency || 0.011;
  const R = Math.hypot(x, z);
  const ridge = noise.ridged(x * f, z * f, 5) * 0.72
    + noise.ridged(x * f * 3.1 + 91, z * f * 3.1, 3) * 0.28;
  const broad = noise.fbm(x * f * 0.32, z * f * 0.32, 4) * 0.5 + 0.5;
  const rise = THREE.MathUtils.smoothstep(R, 55, 55 + 110);
  const h = Math.pow(ridge, 1.45) * broad * p.height * rise;
  return { y: skyline - p.height * 0.6 + h, alt: h / (p.height + 0.001), broad };
}

function buildPeaks(biome, noise) {
  const p = biome.peaks;
  const skyline = p.skyline ?? 26;   // metres above the arena for the ridge line
  const RINGS = 40, SEGS = 180;
  const inner = 55, outer = p.radius;
  const geo = polarMesh(RINGS, SEGS, (theta, t, out) => {
    // Push samples outward with a power curve: more detail near the viewer.
    const tt = Math.pow(t, 1.8);
    const R = inner + (outer - inner) * tt;
    const x = Math.cos(theta) * R;
    const z = Math.sin(theta) * R;

    const f = p.frequency || 0.011;
    // Two ridge fields at different scales plus a broad mass term: one octave of
    // ridged noise on its own gives the origami-spike look, not mountains.
    const ridge = noise.ridged(x * f, z * f, 5) * 0.72
      + noise.ridged(x * f * 3.1 + 91, z * f * 3.1, 3) * 0.28;
    const broad = noise.fbm(x * f * 0.32, z * f * 0.32, 4) * 0.5 + 0.5;
    // Fade the range up out of the cloud sea so nothing pokes through near the arena.
    const rise = THREE.MathUtils.smoothstep(R, inner, inner + 110);
    const h = Math.pow(ridge, 1.45) * broad * p.height * rise;
    // Anchor the range to where its skyline should sit rather than to an arbitrary
    // depth: ridged noise only ever reaches ~60% of the nominal height, so basing
    // it on the cloud layer buried the whole range below the horizon.
    const y = skyline - p.height * 0.6 + h;

    const alt = h / (p.height + 0.001);
    lerpColorInto(out, p.base, p.base, 0);
    out.multiplyScalar(0.62 + broad * 0.5 + alt * 0.35);
    if (p.snowLine < 1.5) {
      const snowAmt = THREE.MathUtils.smoothstep(alt, p.snowLine, p.snowLine + 0.28);
      out.lerp(_hi.setHex(p.snow, THREE.SRGBColorSpace), snowAmt * 0.9);
    }
    return { x, y, z };
  }, false);

  // Smooth-shaded: at this distance faceting reads as cardboard, and aerial
  // perspective is doing most of the modelling anyway.
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.96, metalness: 0, envMapIntensity: 0.45,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'peaks';
  return mesh;
}

/** A scatter of window lights for the rooftop biome's skyline. */
function buildCityLights(biome, rnd) {
  const p = biome.peaks;
  const count = 900;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const palette = [0xffb347, 0xffd98a, 0xa9c6ff, 0xfff0c4, 0xff8f6b];
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const theta = rnd() * Math.PI * 2;
    const R = 55 + rnd() * 260;
    pos[i * 3] = Math.cos(theta) * R;
    pos[i * 3 + 1] = p.cloudSeaY - 26 + rnd() * rnd() * 46;
    pos[i * 3 + 2] = Math.sin(theta) * R;
    c.setHex(palette[(rnd() * palette.length) | 0], THREE.SRGBColorSpace);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    size[i] = 3 + rnd() * 11;   // metres — a lit window block at city distance
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(
    new Float32Array(count).fill(0.85), 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geo;
}

/**
 * Conifer silhouettes scattered over the near slopes.
 *
 * One InstancedMesh of cones — a few hundred draw as one call, and at this
 * distance a cone reads as a tree perfectly well. They are placed by sampling the
 * same height field the range mesh uses, so they sit on the terrain rather than
 * hovering over it, and thin out with altitude the way a real treeline does.
 */
function buildTreeline(biome, noise, rnd) {
  const t = biome.trees;
  // Unit-height silhouette standing on the origin, so the y scale below IS the
  // tree's height in metres. (A 3.1-tall source geometry silently tripled every
  // tree the first time round.)
  //
  // `canopy` swaps the conifer spike for a broadleaf mass. At haze distance the
  // only thing that survives is the outline, so a squashed low-poly blob on a
  // stem reads as jungle far better than a cone does — and costs the same.
  let geo;
  if (t.canopy) {
    // Detail 1, not 0: a 20-face blob flat-shades into obvious hexagonal plates.
    // Still one instanced draw call, so the extra faces are close to free.
    geo = new THREE.IcosahedronGeometry(0.5, 1);
    geo.scale(1, 0.74, 1);
    geo.translate(0, 0.66, 0);
  } else {
    geo = new THREE.ConeGeometry(1, 1, 6);
    geo.translate(0, 0.5, 0);
  }
  // White base, because the real colour goes in the per-instance attribute below
  // (three multiplies material.color by instanceColor, so leaving the tint here
  // would double it).
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1, metalness: 0, envMapIntensity: 0.35, flatShading: true,
  });
  const inst = new THREE.InstancedMesh(geo, mat, t.count);
  const baseTint = new THREE.Color().setHex(t.color, THREE.SRGBColorSpace);
  const tint = new THREE.Color();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const pos = new THREE.Vector3();

  let placed = 0;
  for (let i = 0; i < t.count * 4 && placed < t.count; i++) {
    const theta = rnd() * Math.PI * 2;
    // Bias inward so the band of trees sits where the eye actually lands.
    const R = (t.canopy ? 46 : 78) + Math.pow(rnd(), 1.7) * 230;
    const x = Math.cos(theta) * R, z = Math.sin(theta) * R;
    const surf = peakSurface(biome, noise, x, z);
    // Thin out toward the ridge tops — a treeline, not a fur coat.
    if (surf.alt > t.line && rnd() > 0.15) continue;
    const h = t.minHeight + rnd() * (t.maxHeight - t.minHeight);
    pos.set(x, surf.y - 0.6, z);
    // Broadleaf canopies are wide relative to their height; conifers are narrow.
    const spread = t.canopy ? (0.62 + rnd() * 0.30) : (0.17 + rnd() * 0.07);
    const wdt = h * spread;
    sc.set(wdt, h, wdt);
    q.setFromAxisAngle(_up, rnd() * Math.PI * 2);
    m.compose(pos, q, sc);

    // Per-instance tint. A thousand trees sharing one exact green is the single
    // loudest "this is computer graphics" signal a treeline can send — a real
    // canopy is a mess of species, age and sun exposure. Hue wanders slightly,
    // lightness a lot more, and shorter trees sit darker because they are the
    // ones living in someone else's shade.
    tint.copy(baseTint);
    const shade = 0.66 + ((h - t.minHeight) / (t.maxHeight - t.minHeight)) * 0.30;
    tint.offsetHSL((rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.22, 0);
    tint.multiplyScalar(shade * (0.86 + rnd() * 0.30));
    inst.setColorAt(placed, tint);

    inst.setMatrixAt(placed++, m);
  }
  inst.count = placed;
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.name = 'treeline';
  return inst;
}

let fallsTex = null;
/** Vertical water streaks; scrolls downward by animating the texture offset. */
function waterfallTexture() {
  if (fallsTex) return fallsTex;
  const W = 128, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  ctx.fillRect(0, 0, W, H);
  const rnd = mulberry32(99);
  for (let i = 0; i < 170; i++) {
    const x = rnd() * W;
    const w = 1 + rnd() * 4;
    const y0 = rnd() * H;
    const len = 60 + rnd() * 300;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + len);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.4, `rgba(255,255,255,${0.35 + rnd() * 0.5})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y0, w, len);
    // wrap the tail so the texture tiles vertically without a seam
    if (y0 + len > H) ctx.fillRect(x, y0 - H, w, len);
  }
  fallsTex = new THREE.CanvasTexture(cv);
  fallsTex.colorSpace = THREE.SRGBColorSpace;
  fallsTex.wrapS = fallsTex.wrapT = THREE.RepeatWrapping;
  fallsTex.repeat.set(2, 1.6);
  return fallsTex;
}

/**
 * The falls: a curtain of water on the far ridge with a mist bloom at its foot.
 *
 * Deliberately a flat billboard rather than geometry — it sits ~140 m out where
 * the only thing that reads is the silhouette and the motion, and a scrolling
 * texture gives that for one draw call.
 */
function buildWaterfall(biome, noise, rnd) {
  const f = biome.waterfall;
  const group = new THREE.Group();
  group.name = 'waterfall';

  const theta = f.azimuth;
  const R = f.distance;
  const x = Math.cos(theta) * R, z = Math.sin(theta) * R;
  const foot = peakSurface(biome, noise, x, z).y;

  const geo = new THREE.PlaneGeometry(f.width, f.height);
  const mat = new THREE.MeshBasicMaterial({
    map: waterfallTexture(),
    color: new THREE.Color().setHex(f.color, THREE.SRGBColorSpace),
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  const curtain = new THREE.Mesh(geo, mat);
  curtain.position.set(x, foot + f.height * 0.42, z);
  curtain.lookAt(0, curtain.position.y, 0);   // face the arena
  group.add(curtain);

  // Mist where it lands, plus a soft glow so it reads as spray not a decal.
  const mistGeo = new THREE.PlaneGeometry(f.width * 2.4, f.height * 0.42);
  const mistMat = new THREE.MeshBasicMaterial({
    map: contactBlobTexture(),
    color: new THREE.Color().setHex(0xdfeef2, THREE.SRGBColorSpace),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mist = new THREE.Mesh(mistGeo, mistMat);
  mist.position.set(x, foot + f.height * 0.06, z);
  mist.lookAt(0, mist.position.y, 0);
  group.add(mist);

  group.userData.scroll = mat.map;
  group.userData.speed = f.speed;
  return group;
}

let blobTex = null;
/** Soft radial blob, reused for the falls mist. */
function contactBlobTexture() {
  if (blobTex) return blobTex;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  blobTex = new THREE.CanvasTexture(cv);
  blobTex.colorSpace = THREE.SRGBColorSpace;
  return blobTex;
}

function cloudSeaTexture(color) {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const col = new THREE.Color().setHex(color, THREE.SRGBColorSpace);
  const rgb = `${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0}`;
  ctx.fillStyle = `rgb(${rgb})`;
  ctx.fillRect(0, 0, S, S);
  const rnd = mulberry32(7);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 220; i++) {
    const x = rnd() * S, y = rnd() * S, r = 8 + rnd() * 46;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.05 + rnd() * 0.08})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  return tex;
}

function buildCloudSea(biome) {
  const p = biome.peaks;
  const geo = new THREE.CircleGeometry(p.radius * 1.6, 64);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    map: cloudSeaTexture(p.cloudSea),
    color: 0xffffff,
    roughness: 1, metalness: 0,
    transparent: true, opacity: 0.95,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = p.cloudSeaY;
  mesh.name = 'cloud-sea';
  return mesh;
}

/**
 * Hazards: rounded boulders bolted to the plateau. They are real collision bodies,
 * which turns the arena into a bank-shot puzzle instead of an empty circle.
 */
function buildHazards(biome, noise, boundary, rnd, group, world) {
  const count = 1 + ((rnd() * 2.6) | 0); // 1–3
  const placed = [];
  const g = biome.ground;

  for (let i = 0; i < count; i++) {
    let x = 0, z = 0, ok = false, radius = 0;
    for (let attempt = 0; attempt < 40 && !ok; attempt++) {
      const theta = rnd() * Math.PI * 2;
      // Keep hazards out of the middle (where pens start) and off the lip.
      const rr = 0.40 + rnd() * 0.32;
      const R = boundary(theta) * rr;
      x = Math.cos(theta) * R;
      z = Math.sin(theta) * R;
      radius = 0.022 + rnd() * 0.026;
      ok = placed.every((o) => Math.hypot(o.x - x, o.z - z) > radius + o.radius + 0.10)
        && Math.hypot(x, z) > 0.16;
    }
    if (!ok) continue;
    placed.push({ x, z, radius });

    const geo = new THREE.IcosahedronGeometry(radius, 1);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let v = 0; v < pos.count; v++) {
      const vx = pos.getX(v), vy = pos.getY(v), vz = pos.getZ(v);
      const n = noise.fbm(vx * 34 + i * 9, vz * 34, 3);
      const s = 1 + n * 0.28;
      pos.setXYZ(v, vx * s, vy * s * 0.74, vz * s);
      lerpColorInto(c, g.low, g.high, 0.32 + n * 0.5 + (vy / radius) * 0.25);
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: g.roughness * 0.95, metalness: 0,
      envMapIntensity: 0.8, flatShading: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, radius * 0.34, z);
    mesh.rotation.y = rnd() * Math.PI;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    world.obstacles.push(new Obstacle(x, z, radius * 0.9, 0.52));
  }
  return placed;
}

/** Decorative boulders beyond the boundary — silhouette only, never collide. */
function buildRimDressing(biome, boundary, rnd, group) {
  const g = biome.ground;
  const count = 8 + ((rnd() * 7) | 0);
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHex(g.mid, THREE.SRGBColorSpace),
    roughness: g.roughness, metalness: 0, envMapIntensity: 0.55,
    flatShading: true,
  });
  const inst = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const theta = rnd() * Math.PI * 2;
    const R = boundary(theta) * (1.03 + rnd() * 0.09);
    const sc = 0.018 + rnd() * 0.045;
    p.set(Math.cos(theta) * R, -sc * (0.2 + rnd() * 0.6), Math.sin(theta) * R);
    e.set(rnd() * 3, rnd() * 6, rnd() * 3);
    q.setFromEuler(e);
    s.set(sc, sc * (0.5 + rnd() * 0.5), sc * (0.8 + rnd() * 0.6));
    m.compose(p, q, s);
    inst.setMatrixAt(i, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = true;
  inst.receiveShadow = true;
  group.add(inst);
}

/**
 * @param {number} seed
 * @param {object} biome
 * @param {import('../game/physics.js').PenWorld} world
 */
export function buildArena(seed, biome, world) {
  const noise = new Noise(seed);
  const rnd = mulberry32(seed ^ 0x1234abcd);
  const boundary = makeBoundary(noise, rnd);

  const root = new THREE.Group();
  root.name = `arena:${biome.id}`;

  // Everything that shrinks when the ledge starts crumbling lives in here.
  const ledge = new THREE.Group();
  ledge.name = 'ledge';
  root.add(ledge);

  ledge.add(buildPlateauTop(biome, noise, boundary));
  ledge.add(buildCliff(biome, noise, boundary));
  buildRimDressing(biome, boundary, rnd, ledge);
  const hazards = buildHazards(biome, noise, boundary, rnd, ledge, world);

  root.add(buildPeaks(biome, noise));
  if (biome.trees) root.add(buildTreeline(biome, noise, rnd));
  let waterfall = null;
  if (biome.waterfall) {
    waterfall = buildWaterfall(biome, noise, rnd);
    root.add(waterfall);
  }
  root.add(buildCloudSea(biome));
  if (biome.peaks.city) root.add(glowPoints(buildCityLights(biome, rnd)));

  world.boundary = boundary;
  world.surfaceFriction = biome.surface.friction;

  let extent = 0;
  for (let i = 0; i < 96; i++) extent = Math.max(extent, boundary((i / 96) * Math.PI * 2));

  return {
    root, ledge, boundary, hazards, noise, waterfall,
    baseRadius: BASE_RADIUS,
    faceAngle: boundary.faceAngle,
    /** Max radius of the outline — used to fit the shadow camera and the view. */
    extent,
    dispose() {
      root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((mm) => { if (mm.map) mm.map.dispose(); mm.dispose(); });
        }
      });
    },
  };
}
