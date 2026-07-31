/**
 * penMesh.js — builds a pen from its catalog entry.
 *
 * The barrel is assembled from lathe segments along local +X, with `t` running
 * 0 at the cap end to 1 at the writing tip — the same convention the catalog uses.
 * Branding is painted into a small canvas so the game ships no texture files.
 *
 * Cost control: `transmission` is the only genuinely expensive material here (it
 * forces an extra scene render), so it is used on transparent barrels only, and
 * `quality.transmission === false` swaps in an alpha + fresnel fake with identical
 * geometry for weaker devices.
 */

import * as THREE from 'three';
import { FINISH } from '../game/pens.js';

const TEX_W = 128;
const TEX_H = 512;
const texCache = new Map();

function hexCss(c) {
  return `#${c.toString(16).padStart(6, '0')}`;
}

/** Albedo for the main barrel: base colour, optional two-tone / grain, branding. */
function barrelTexture(spec) {
  if (texCache.has(spec.id)) return texCache.get(spec.id);

  const cv = document.createElement('canvas');
  cv.width = TEX_W; cv.height = TEX_H;
  const ctx = cv.getContext('2d');
  const body = spec.body;

  ctx.fillStyle = hexCss(body.color);
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  if (body.twoTone !== undefined) {
    // Dual-tone barrel: the rear half in the secondary colour.
    ctx.fillStyle = hexCss(body.twoTone);
    ctx.fillRect(0, 0, TEX_W, TEX_H * 0.42);
    const blend = ctx.createLinearGradient(0, TEX_H * 0.38, 0, TEX_H * 0.48);
    blend.addColorStop(0, hexCss(body.twoTone));
    blend.addColorStop(1, hexCss(body.color));
    ctx.fillStyle = blend;
    ctx.fillRect(0, TEX_H * 0.38, TEX_W, TEX_H * 0.10);
  }

  if (body.grain) {
    // Faux woodgrain: fine longitudinal streaks.
    ctx.globalAlpha = 0.20;
    for (let i = 0; i < 46; i++) {
      const x = Math.random() * TEX_W;
      ctx.strokeStyle = Math.random() > 0.5 ? '#00000060' : '#ffffff40';
      ctx.lineWidth = 0.6 + Math.random() * 2.2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      for (let y = 0; y <= TEX_H; y += 32) {
        ctx.lineTo(x + Math.sin(y * 0.02 + i) * 2.4, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Branding, rotated so it reads along the barrel rather than around it.
  if (spec.print) {
    ctx.save();
    ctx.translate(TEX_W * 0.5, TEX_H * 0.52);
    ctx.rotate(-Math.PI / 2);
    const lum = ((body.color >> 16 & 255) * 0.299 + (body.color >> 8 & 255) * 0.587
      + (body.color & 255) * 0.114) / 255;
    ctx.fillStyle = lum > 0.55 ? 'rgba(20,22,26,0.86)' : 'rgba(248,250,252,0.88)';
    ctx.font = 'bold 15px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = '1.5px';
    ctx.fillText(spec.print, 0, 0);
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  texCache.set(spec.id, tex);
  return tex;
}

function segmentsFor(profile) {
  if (profile === 'hex') return 6;
  if (profile === 'triangle') return 3;
  return 20;
}

/** Distance from the axis to a resting flat face — how high the barrel sits. */
export function restHeight(spec) {
  const r = spec.diameterMm / 2000;
  const n = segmentsFor(spec.profile);
  return n >= 20 ? r : r * Math.cos(Math.PI / n);
}

/** A lathe segment spanning t0..t1 of the pen, radius rA→rB. */
function tube(spec, t0, t1, rA, rB, material, openEnded = true) {
  const L = spec.lengthMm / 1000;
  const n = segmentsFor(spec.profile);
  const h = (t1 - t0) * L;
  const geo = new THREE.CylinderGeometry(rB, rA, h, n, 1, openEnded);
  // Put a flat face down for polygonal barrels so they sit like the real thing.
  if (n < 20) geo.rotateY(Math.PI / n);
  geo.rotateZ(-Math.PI / 2);
  geo.translate(((t0 + t1) * 0.5 - 0.5) * L, 0, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  return mesh;
}

function makeMaterials(spec, quality) {
  const body = spec.body;
  const accent = new THREE.Color().setHex(spec.accent, THREE.SRGBColorSpace);
  const useTransmission = quality.transmission !== false;

  let barrel;
  switch (body.finish) {
    case FINISH.CLEAR:
      barrel = useTransmission
        ? new THREE.MeshPhysicalMaterial({
          color: new THREE.Color().setHex(body.color, THREE.SRGBColorSpace),
          metalness: 0, roughness: 0.06,
          transmission: 1.0, thickness: 0.006, ior: 1.49,
          clearcoat: 0.4, clearcoatRoughness: 0.08,
          envMapIntensity: 1.4,
        })
        : new THREE.MeshPhysicalMaterial({
          color: new THREE.Color().setHex(body.color, THREE.SRGBColorSpace),
          metalness: 0, roughness: 0.07, transparent: true, opacity: 0.36,
          clearcoat: 0.5, clearcoatRoughness: 0.06, envMapIntensity: 1.8,
        });
      break;
    case FINISH.FROSTED:
      barrel = useTransmission
        ? new THREE.MeshPhysicalMaterial({
          color: new THREE.Color().setHex(body.color, THREE.SRGBColorSpace),
          metalness: 0, roughness: 0.52,
          transmission: 0.86, thickness: 0.008, ior: 1.47,
          attenuationColor: new THREE.Color().setHex(body.color, THREE.SRGBColorSpace),
          attenuationDistance: 0.05,
          envMapIntensity: 1.1,
        })
        : new THREE.MeshPhysicalMaterial({
          color: new THREE.Color().setHex(body.color, THREE.SRGBColorSpace),
          metalness: 0, roughness: 0.5, transparent: true, opacity: 0.72,
          envMapIntensity: 1.2,
        });
      break;
    case FINISH.METALLIC:
      barrel = new THREE.MeshPhysicalMaterial({
        map: barrelTexture(spec), metalness: 0.72, roughness: 0.26,
        clearcoat: 0.5, clearcoatRoughness: 0.14, envMapIntensity: 1.3,
      });
      break;
    case FINISH.MATTE:
      barrel = new THREE.MeshPhysicalMaterial({
        map: barrelTexture(spec), metalness: 0.0, roughness: 0.64,
        clearcoat: 0.16, clearcoatRoughness: 0.5, envMapIntensity: 0.85,
      });
      break;
    default: // GLOSS
      barrel = new THREE.MeshPhysicalMaterial({
        map: barrelTexture(spec), metalness: 0.0, roughness: 0.19,
        clearcoat: 0.75, clearcoatRoughness: 0.07, envMapIntensity: 1.15,
      });
  }

  const capColor = new THREE.Color().setHex(spec.cap.color, THREE.SRGBColorSpace);
  const cap = spec.cap.translucent
    ? new THREE.MeshPhysicalMaterial({
      color: capColor, metalness: 0, roughness: 0.12,
      transparent: true, opacity: 0.55, clearcoat: 0.6, envMapIntensity: 1.6,
    })
    : new THREE.MeshPhysicalMaterial({
      color: capColor, metalness: 0, roughness: 0.22,
      clearcoat: 0.6, clearcoatRoughness: 0.1, envMapIntensity: 1.1,
    });

  const grip = spec.grip
    ? new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(spec.grip.color, THREE.SRGBColorSpace),
      metalness: 0, roughness: spec.grip.translucent ? 0.34 : 0.88,
      transparent: !!spec.grip.translucent,
      opacity: spec.grip.translucent ? 0.62 : 1,
      envMapIntensity: 0.7,
    })
    : null;

  const tip = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHex(spec.tip.color, THREE.SRGBColorSpace),
    metalness: 0.9, roughness: 0.28, envMapIntensity: 1.5,
  });

  const clip = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setHex(spec.clip.color, THREE.SRGBColorSpace),
    metalness: 0, roughness: 0.2, clearcoat: 0.7,
    transparent: !!spec.clip.translucent,
    opacity: spec.clip.translucent ? 0.55 : 1,
    envMapIntensity: 1.2,
  });

  const ink = new THREE.MeshBasicMaterial({ color: accent });

  return { barrel, cap, grip, tip, clip, ink };
}

/**
 * @returns {{group: THREE.Group, restHeight: number, materials: object, dispose: Function}}
 */
export function buildPen(spec, quality = {}) {
  const L = spec.lengthMm / 1000;
  const r = spec.diameterMm / 2000;
  const mats = makeMaterials(spec, quality);
  const group = new THREE.Group();
  group.name = `pen:${spec.id}`;

  const capEnd = spec.cap.length;

  // --- rear cap / click knob ------------------------------------------------
  group.add(tube(spec, 0.012, capEnd, r * 1.02, r * 1.03, mats.cap));
  const domeGeo = new THREE.SphereGeometry(r * 1.02, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  domeGeo.rotateZ(Math.PI / 2);
  domeGeo.translate(-L * 0.5 + L * 0.012, 0, 0);
  const dome = new THREE.Mesh(domeGeo, mats.cap);
  dome.castShadow = true;
  group.add(dome);

  if (spec.cap.type === 'click') {
    // A small plunger sticking out of the top.
    const kn = tube(spec, -0.02, 0.014, r * 0.42, r * 0.46, mats.clip);
    group.add(kn);
  }
  if (spec.cap.accentRing) {
    group.add(tube(spec, capEnd - 0.012, capEnd + 0.004, r * 1.05, r * 1.05, mats.clip));
  }

  // --- main barrel ----------------------------------------------------------
  const barrelStart = capEnd;
  const barrelEnd = 0.945;
  group.add(tube(spec, barrelStart, barrelEnd, r, r * 0.99, mats.barrel));

  // Ink level window on metallic barrels.
  if (spec.inkWindow) {
    group.add(tube(spec, spec.inkWindow.from, spec.inkWindow.to,
      r * 0.995, r * 0.995, mats.ink));
  }

  // --- grip sleeve ----------------------------------------------------------
  if (spec.grip) {
    const g = spec.grip;
    group.add(tube(spec, g.from, g.to, r * 1.05, r * 1.04, mats.grip));
    if (g.style === 'ribbed' || g.style === 'wave') {
      const ribs = 7;
      for (let i = 0; i < ribs; i++) {
        const t = g.from + ((i + 0.5) / ribs) * (g.to - g.from);
        const w = (g.to - g.from) / ribs * 0.42;
        group.add(tube(spec, t - w * 0.5, t + w * 0.5, r * 1.11, r * 1.11, mats.grip));
      }
    }
  }

  // Decorative machined ribs (Reynolds-style mid-barrel knurling).
  if (spec.ribs) {
    for (let i = 0; i < spec.ribs.count; i++) {
      const t = spec.ribs.from
        + ((i + 0.5) / spec.ribs.count) * (spec.ribs.to - spec.ribs.from);
      group.add(tube(spec, t - 0.004, t + 0.004, r * 1.035, r * 1.035, mats.barrel));
    }
  }

  // --- front taper and metal tip -------------------------------------------
  group.add(tube(spec, barrelEnd, 0.985, r * 0.99, r * 0.34, mats.barrel));
  const needle = spec.tip.needle;
  group.add(tube(spec, 0.985, needle ? 0.996 : 0.994, r * 0.34, r * 0.16, mats.tip));
  group.add(tube(spec, needle ? 0.996 : 0.994, 1.0, r * 0.16, r * 0.05, mats.tip, false));

  // --- pocket clip ----------------------------------------------------------
  const clipLen = spec.clip.style === 'wide' ? 0.20 : 0.17;
  const clipW = spec.clip.style === 'wide' ? r * 0.85 : r * 0.55;
  const clipGeo = new THREE.BoxGeometry(clipLen * L, r * 0.16, clipW);
  clipGeo.translate((0.03 + clipLen * 0.5 - 0.5) * L, r * 1.16, 0);
  const clipMesh = new THREE.Mesh(clipGeo, mats.clip);
  clipMesh.castShadow = true;
  group.add(clipMesh);
  // The little foot where the clip meets the cap.
  const footGeo = new THREE.BoxGeometry(r * 0.5, r * 0.32, clipW);
  footGeo.translate((0.03 - 0.5) * L, r * 1.02, 0);
  group.add(new THREE.Mesh(footGeo, mats.clip));

  const rest = restHeight(spec);

  return {
    group,
    restHeight: rest,
    materials: mats,
    dispose() {
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      Object.values(mats).forEach((m) => m && m.dispose());
    },
  };
}

/**
 * Soft contact shadow drawn under a pen. Far cheaper than SSAO and, at this scale,
 * more convincing — it is what actually glues the pen to the rock.
 */
let contactTex = null;
export function contactShadowTexture() {
  if (contactTex) return contactTex;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.62)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.30)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  contactTex = new THREE.CanvasTexture(cv);
  return contactTex;
}

export function buildContactShadow(spec) {
  const L = spec.lengthMm / 1000;
  const r = spec.diameterMm / 2000;
  const geo = new THREE.PlaneGeometry(L * 1.15, r * 6.5);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: contactShadowTexture(),
    transparent: true, depthWrite: false, opacity: 0.75,
    blending: THREE.NormalBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  return mesh;
}
