/**
 * fx.js — weather beds and impact VFX.
 *
 * Everything here is THREE.Points driving one draw call per system, with a small
 * custom shader so particles can have per-particle size and alpha (PointsMaterial
 * gives you one shared size for the whole system). Sprites are drawn into canvases
 * at boot, so no image files ship.
 *
 * All buffers are preallocated and written in place — nothing in this file
 * allocates during the frame loop.
 */

import * as THREE from 'three';

const spriteCache = new Map();

function sprite(kind) {
  if (spriteCache.has(kind)) return spriteCache.get(kind);
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');

  if (kind === 'streak') {
    // Rain. Points are screen-aligned squares, so a vertical streak painted into
    // the sprite stays vertical on screen — no per-particle rotation needed.
    const g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(S * 0.44, 0, S * 0.12, S);
  } else if (kind === 'ember') {
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.22, 'rgba(255,214,150,0.9)');
    g.addColorStop(0.55, 'rgba(255,130,40,0.35)');
    g.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  } else {
    // Soft dot — snow, dust, debris. A feathered edge is what lets additive
    // particles intersect geometry without a hard seam, no depth texture needed.
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  spriteCache.set(kind, tex);
  return tex;
}

let beamTex = null;
/**
 * Soft vertical shaft: brightest at the base, feathered to nothing at the top and
 * at both sides. The two gradients are multiplied via `destination-in` so the
 * alpha really is the product of both — painting them additively left hard edges
 * that bloom turned into a white slab.
 */
function beamTexture() {
  if (beamTex) return beamTex;
  const W = 64, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  const across = ctx.createLinearGradient(0, 0, W, 0);
  across.addColorStop(0.00, 'rgba(255,255,255,0)');
  across.addColorStop(0.34, 'rgba(255,255,255,0.55)');
  across.addColorStop(0.50, 'rgba(255,255,255,1)');
  across.addColorStop(0.66, 'rgba(255,255,255,0.55)');
  across.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, W, H);

  const up = ctx.createLinearGradient(0, H, 0, 0);
  up.addColorStop(0.00, 'rgba(0,0,0,1)');
  up.addColorStop(0.35, 'rgba(0,0,0,0.45)');
  up.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = up;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';

  beamTex = new THREE.CanvasTexture(cv);
  beamTex.colorSpace = THREE.SRGBColorSpace;
  return beamTex;
}

const POINT_VERT = /* glsl */`
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
uniform float uScale;   // viewportHeight / (2 * tan(fovY/2))
#include <fog_pars_vertex>
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  // aSize is a WORLD-SPACE diameter in metres; this is the standard perspective
  // projection of that size into pixels. Feeding it raw pixel numbers instead is
  // how you end up with rain streaks a kilometre tall.
  gl_PointSize = clamp(aSize * uScale / max(0.05, -mvPosition.z), 1.0, 220.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const POINT_FRAG = /* glsl */`
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  if (t.a * vAlpha < 0.004) discard;
  gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
  #include <fog_fragment>
}`;

function pointsMaterial(map, additive) {
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uMap: { value: null }, uScale: { value: 900 } },
    ]),
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  // Assigned after merge: cloneUniforms would otherwise not carry the texture.
  mat.uniforms.uMap.value = map;
  return mat;
}

/**
 * Wrap an existing geometry (position + aColor + aSize + aAlpha) in the additive
 * point material. Used for static glow scatters like a distant city skyline.
 */
export function glowPoints(geometry, scale = 900) {
  const mat = pointsMaterial(sprite('dot'), true);
  mat.uniforms.uScale.value = scale;
  const pts = new THREE.Points(geometry, mat);
  pts.frustumCulled = false;
  return pts;
}

class PointCloud {
  constructor(count, spriteKind, additive) {
    this.count = count;
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const alpha = new Float32Array(count);
    const color = new Float32Array(count * 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    const mat = pointsMaterial(sprite(spriteKind), additive);

    this.geo = geo;
    this.mat = mat;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.pos = pos; this.size = size; this.alpha = alpha; this.color = color;
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
  }

  flush() {
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/** Falling/drifting weather that follows the camera so it never runs out. */
export class Weather {
  constructor(biome) {
    const w = biome.weather;
    this.spec = w;
    this.kind = w.type;
    this.box = { x: 26, y: 16, z: 26 };

    const kindSprite = w.type === 'rain' ? 'streak' : w.type === 'ember' ? 'ember' : 'dot';
    this.cloud = new PointCloud(w.count, kindSprite, w.type === 'ember');
    this.object = this.cloud.points;

    const c = new THREE.Color().setHex(w.color, THREE.SRGBColorSpace);
    const { pos, size, alpha, color, vel } = this.cloud;
    for (let i = 0; i < w.count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.box.x;
      pos[i * 3 + 1] = Math.random() * this.box.y - 2;
      pos[i * 3 + 2] = (Math.random() - 0.5) * this.box.z;
      color[i * 3] = c.r; color[i * 3 + 1] = c.g; color[i * 3 + 2] = c.b;
      this._respawnVelocity(i, vel, size, alpha);
    }
    this.cloud.flush();
    this._t = 0;
  }

  _respawnVelocity(i, vel, size, alpha) {
    const w = this.spec;
    switch (w.type) {
      case 'rain':
        vel[i * 3] = (Math.random() - 0.5) * 0.6;
        vel[i * 3 + 1] = -(9 + Math.random() * 7);
        vel[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
        size[i] = 0.09 + Math.random() * 0.14;   // rain streak length
        alpha[i] = 0.20 + Math.random() * 0.26;
        break;
      case 'ember':
        vel[i * 3] = (Math.random() - 0.5) * w.drift;
        vel[i * 3 + 1] = 0.5 + Math.random() * 1.7;
        vel[i * 3 + 2] = (Math.random() - 0.5) * w.drift;
        size[i] = 0.010 + Math.random() * 0.030;  // ember
        alpha[i] = 0.35 + Math.random() * 0.6;
        break;
      case 'dust':
        vel[i * 3] = 0.8 + Math.random() * w.drift * 2.2;
        vel[i * 3 + 1] = (Math.random() - 0.35) * 0.35;
        vel[i * 3 + 2] = (Math.random() - 0.5) * w.drift;
        size[i] = 0.06 + Math.random() * 0.22;    // dust mote
        alpha[i] = 0.05 + Math.random() * 0.13;
        break;
      default: // snow
        vel[i * 3] = (Math.random() - 0.5) * w.drift;
        vel[i * 3 + 1] = -(0.5 + Math.random() * 1.1);
        vel[i * 3 + 2] = (Math.random() - 0.5) * w.drift;
        size[i] = 0.008 + Math.random() * 0.022;  // snowflake
        alpha[i] = 0.25 + Math.random() * 0.55;
    }
  }

  update(dt, cameraPos) {
    const { pos, vel } = this.cloud;
    const n = this.cloud.count;
    this._t += dt;
    const swayA = Math.sin(this._t * 0.7) * 0.35;
    const swayB = Math.cos(this._t * 0.53) * 0.35;
    const hx = this.box.x * 0.5, hz = this.box.z * 0.5;
    const cx = cameraPos.x, cz = cameraPos.z;
    const rising = this.kind === 'ember';

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      pos[i3] += (vel[i3] + swayA) * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += (vel[i3 + 2] + swayB) * dt;

      // Wrap around a box that rides with the camera.
      if (rising) {
        if (pos[i3 + 1] > this.box.y - 2) pos[i3 + 1] = -6 - Math.random() * 3;
      } else if (pos[i3 + 1] < -8) {
        pos[i3 + 1] = this.box.y - 2;
      }
      const dx = pos[i3] - cx;
      if (dx > hx) pos[i3] -= this.box.x; else if (dx < -hx) pos[i3] += this.box.x;
      const dz = pos[i3 + 2] - cz;
      if (dz > hz) pos[i3 + 2] -= this.box.z; else if (dz < -hz) pos[i3 + 2] += this.box.z;
    }
    this.cloud.geo.attributes.position.needsUpdate = true;
  }

  setProjectionScale(v) { this.cloud.mat.uniforms.uScale.value = v; }

  dispose() { this.cloud.dispose(); }
}

const MAX_DEBRIS = 260;

/** Impact sparks, grit and dust puffs, plus the expanding shockwave rings. */
export class ImpactFX {
  constructor(scene, biome) {
    this.biome = biome;
    // Held so dispose() can take its own objects back out of the shared scene.
    this.scene = scene;
    this.cloud = new PointCloud(MAX_DEBRIS, 'dot', true);

    scene.add(this.cloud.points);
    this._next = 0;
    for (let i = 0; i < MAX_DEBRIS; i++) this.cloud.alpha[i] = 0;
    this.cloud.flush();

    // Shockwave rings — a small pool, reused.
    const ringGeo = new THREE.RingGeometry(0.6, 1.0, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.rings = [];
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 3;
      scene.add(mesh);
      this.rings.push({ mesh, mat, t: 0, life: 0, scale: 1 });
    }
    this._ringGeo = ringGeo;

    // Knockout beacon. A pen dropping over the lip leaves the frame in a few
    // frames; this stays behind and says "it happened HERE, and it was theirs".
    const beamGeo = new THREE.PlaneGeometry(1, 1);
    beamGeo.translate(0, 0.5, 0);
    const beamMat = new THREE.MeshBasicMaterial({
      map: beamTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // Depth-tested: an un-tested beam draws straight through the plateau and
      // reads as a bug rather than a marker.
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(beamGeo, beamMat);
    this.beam.visible = false;
    this.beam.renderOrder = 8;
    scene.add(this.beam);
    this._beamLife = 0;
    this._beamGeo = beamGeo;
  }

  /**
   * Mark where a pen went over, in that player's colour.
   * @param {number} x @param {number} z
   * @param {number} colorHex owner colour
   */
  knockout(x, z, colorHex) {
    const c = new THREE.Color().setHex(colorHex, THREE.SRGBColorSpace);
    this.beam.position.set(x, 0.002, z);
    this.beam.scale.set(0.085, 0.34, 1);
    this.beam.material.color.copy(c);
    this.beam.material.opacity = 0.55;
    this.beam.visible = true;
    this._beamLife = 1.7;

    this._ring(x, z, 0.16, 0.95);
    // A puff of the owner's colour thrown upward, so the eye is pulled to the spot.
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.18 + Math.random() * 0.5;
      this._emit(
        x, 0.006, z,
        Math.cos(a) * sp, 0.8 + Math.random() * 1.9, Math.sin(a) * sp,
        0.006 + Math.random() * 0.014, 0.6 + Math.random() * 0.6,
        c.r * 1.5, c.g * 1.5, c.b * 1.5,
      );
    }
  }

  _emit(x, y, z, vx, vy, vz, size, life, r, g, b) {
    const i = this._next;
    this._next = (this._next + 1) % MAX_DEBRIS;
    const c = this.cloud;
    const i3 = i * 3;
    c.pos[i3] = x; c.pos[i3 + 1] = y; c.pos[i3 + 2] = z;
    c.vel[i3] = vx; c.vel[i3 + 1] = vy; c.vel[i3 + 2] = vz;
    c.size[i] = size;
    c.alpha[i] = 1;
    c.life[i] = life;
    c.maxLife[i] = life;
    c.color[i3] = r; c.color[i3 + 1] = g; c.color[i3 + 2] = b;
  }

  /** `strength` 0..1 from the solver's normal-impulse magnitude. */
  impact(x, z, strength) {
    const n = 6 + Math.round(strength * 18);
    const g = this.biome.ground;
    const base = new THREE.Color().setHex(g.accent, THREE.SRGBColorSpace);
    const hot = this.biome.id === 'caldera';
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.35 + Math.random() * 1.5) * (0.4 + strength);
      this._emit(
        x, 0.006 + Math.random() * 0.01, z,
        Math.cos(a) * sp, 0.35 + Math.random() * 1.5 * strength, Math.sin(a) * sp,
        0.004 + Math.random() * 0.012 * (0.4 + strength),
        0.22 + Math.random() * 0.35,
        hot ? 1.0 : base.r * 1.4,
        hot ? 0.55 + Math.random() * 0.3 : base.g * 1.35,
        hot ? 0.18 : base.b * 1.3,
      );
    }
    this._ring(x, z, 0.05 + strength * 0.22, 0.35 + strength * 0.5);
  }

  /**
   * Spray thrown up by a barrel scraping across the surface.
   *
   * What comes off depends on what it is scraping: amber sparks off basalt,
   * water off wet concrete, ice crystals off the glacier, dust off sandstone.
   * `rate` is per-second so the emission stays frame-rate independent — this runs
   * during slow-motion replay, where a per-frame count would look wrong.
   */
  friction(x, z, intensity, dirX, dirZ, dt, rate = 90) {
    this._fricAcc = (this._fricAcc || 0) + rate * intensity * dt;
    let n = Math.floor(this._fricAcc);
    if (n <= 0) return;
    this._fricAcc -= n;
    n = Math.min(n, 6);

    const id = this.biome.id;
    const wet = id === 'terrace';
    const icy = id === 'serac';
    const hot = id === 'caldera';

    for (let i = 0; i < n; i++) {
      // Thrown backwards and sideways from the direction of travel.
      const spread = (Math.random() - 0.5) * 1.1;
      const bx = -dirX + (-dirZ) * spread;
      const bz = -dirZ + dirX * spread;
      const sp = (0.25 + Math.random() * 0.85) * intensity;
      let r, g, b, size, up;

      if (hot) {
        r = 1.0; g = 0.42 + Math.random() * 0.35; b = 0.10;
        size = 0.004 + Math.random() * 0.009;
        up = 0.5 + Math.random() * 1.4;
      } else if (wet) {
        r = 0.72; g = 0.86; b = 1.0;
        size = 0.005 + Math.random() * 0.013;
        up = 0.7 + Math.random() * 1.5;
      } else if (icy) {
        r = 0.86; g = 0.96; b = 1.0;
        size = 0.004 + Math.random() * 0.010;
        up = 0.5 + Math.random() * 1.1;
      } else {
        // Sandstone / granite: warm grit, with a few genuine sparks off the tip.
        const spark = Math.random() < 0.35;
        r = spark ? 1.0 : 0.82;
        g = spark ? 0.72 : 0.70;
        b = spark ? 0.34 : 0.56;
        size = 0.004 + Math.random() * 0.011;
        up = 0.4 + Math.random() * 1.2;
      }

      this._emit(
        x + (Math.random() - 0.5) * 0.02,
        0.004 + Math.random() * 0.008,
        z + (Math.random() - 0.5) * 0.02,
        bx * sp, up * intensity, bz * sp,
        size, 0.18 + Math.random() * 0.34,
        r, g, b,
      );
    }
  }

  /** A pen going over the lip kicks grit off the edge. */
  fallPuff(x, z) {
    const g = this.biome.ground;
    const c = new THREE.Color().setHex(g.mid, THREE.SRGBColorSpace);
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      this._emit(
        x, 0.01, z,
        Math.cos(a) * 0.4 * Math.random(), -0.4 - Math.random(), Math.sin(a) * 0.4 * Math.random(),
        0.010 + Math.random() * 0.026, 0.6 + Math.random() * 0.5,
        c.r * 1.2, c.g * 1.2, c.b * 1.2,
      );
    }
  }

  _ring(x, z, scale, opacity) {
    const r = this.rings.find((k) => k.life <= 0) || this.rings[0];
    r.mesh.position.set(x, 0.004, z);
    r.mesh.visible = true;
    r.life = 0.42;
    r.t = 0;
    r.scale = scale;
    r.peak = opacity;
  }

  setProjectionScale(v) { this.cloud.mat.uniforms.uScale.value = v; }

  update(dt, camera) {
    if (this._beamLife > 0) {
      this._beamLife -= dt;
      const k = Math.max(0, this._beamLife / 1.7);
      this.beam.material.opacity = k * k * 0.55;
      this.beam.scale.y = 0.34 + (1 - k) * 0.16;
      if (camera) {
        // Billboard around Y only, so the beam always faces the camera but stays
        // vertical rather than tipping over with the view.
        this.beam.rotation.y = Math.atan2(
          camera.position.x - this.beam.position.x,
          camera.position.z - this.beam.position.z,
        );
      }
      if (this._beamLife <= 0) this.beam.visible = false;
    }

    const c = this.cloud;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      if (c.life[i] <= 0) continue;
      c.life[i] -= dt;
      const i3 = i * 3;
      if (c.life[i] <= 0) { c.alpha[i] = 0; continue; }
      c.vel[i3 + 1] -= 6.5 * dt;             // gravity
      c.vel[i3] *= 1 - 1.6 * dt;             // drag
      c.vel[i3 + 2] *= 1 - 1.6 * dt;
      c.pos[i3] += c.vel[i3] * dt;
      c.pos[i3 + 1] += c.vel[i3 + 1] * dt;
      c.pos[i3 + 2] += c.vel[i3 + 2] * dt;
      if (c.pos[i3 + 1] < 0.004) {           // settle on the rock
        c.pos[i3 + 1] = 0.004;
        c.vel[i3 + 1] *= -0.28;
        c.vel[i3] *= 0.55; c.vel[i3 + 2] *= 0.55;
      }
      c.alpha[i] = Math.max(0, c.life[i] / c.maxLife[i]);
    }
    c.flush();

    for (const r of this.rings) {
      if (r.life <= 0) { if (r.mesh.visible) r.mesh.visible = false; continue; }
      r.life -= dt;
      r.t += dt;
      const k = Math.max(0, r.life / 0.42);
      const s = r.scale * (1 + (1 - k) * 3.4);
      r.mesh.scale.set(s, 1, s);
      r.mat.opacity = k * k * r.peak;
    }
  }

  dispose() {
    this.scene.remove(this.cloud.points);
    this.scene.remove(this.beam);
    this.beam.material.map?.dispose();
    this.beam.material.dispose();
    this._beamGeo.dispose();
    this.cloud.dispose();
    this.rings.forEach((r) => {
      this.scene.remove(r.mesh);
      r.mat.dispose();
    });
    this._ringGeo.dispose();
  }
}
