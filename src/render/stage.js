/**
 * stage.js — renderer, light rig, camera choreography and the adaptive quality
 * governor.
 *
 * Tone mapping is deliberately OFF on the renderer: the scene is drawn into a
 * linear HDR target and PostFX applies ACES exactly once at the end (see post.js).
 * Everything else here follows the mobile budget — one shadow-casting directional
 * light with a frustum fitted to the actual plateau, DPR clamped to 1.5, and a
 * governor that walks quality down if measured frame time slips.
 */

import * as THREE from 'three';
import { PostFX } from './post.js';
import { buildSkyEnvironment, sunDirection } from './sky.js';
import { Weather, ImpactFX } from './fx.js';

const TIERS = ['low', 'medium', 'high'];

// Loadout showcase: a 14 cm pen scaled to ~0.6 m so its grip ribs, clip and
// tip cone actually resolve on a phone screen.
const SHOWCASE_SCALE = 4.4;
const SHOWCASE_Y = 0.46;
const SHOWCASE_LENGTH = 0.145 * SHOWCASE_SCALE;

/** Frame-rate independent exponential smoothing. */
export function damp(current, target, lambda, dt) {
  return target + (current - target) * Math.exp(-lambda * dt);
}

function dampVec(out, target, lambda, dt) {
  out.x = damp(out.x, target.x, lambda, dt);
  out.y = damp(out.y, target.y, lambda, dt);
  out.z = damp(out.z, target.z, lambda, dt);
}

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,           // MSAA lives on the HDR target instead
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated as of r185; PCF is the supported soft path.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.012, 1400);

    // --- light rig ----------------------------------------------------------
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.scene.add(this.hemi);

    this.key = new THREE.DirectionalLight(0xffffff, 3);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.012;
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    // A dim opposing light so the shadow side of a pen still reads as plastic
    // rather than a silhouette. No shadow map, so it is effectively free.
    this.fill = new THREE.DirectionalLight(0xffffff, 0.35);
    this.scene.add(this.fill);

    this.post = new PostFX(this.renderer);

    // --- camera state -------------------------------------------------------
    this.camPos = new THREE.Vector3(0, 1.1, 2.2);
    this.camLook = new THREE.Vector3(0, 0, 0);
    this._wantPos = this.camPos.clone();
    this._wantLook = this.camLook.clone();
    this._camLambda = 3.2;
    this._shake = 0;
    this._shakeVec = new THREE.Vector3();
    this._orbit = 0;
    this._fovBase = 46;
    this._fovWant = 46;

    // --- adaptive quality ---------------------------------------------------
    this.tier = 'high';
    this._frameTimes = new Float32Array(45);
    this._ftIndex = 0;
    this._ftFilled = 0;
    this._sinceAdjust = 0;

    this.weather = null;
    this.impactFX = null;
    this._showcase = null;
    this.arena = null;
    this._envMap = null;
    this._bg = null;

    this.resize();
  }

  /** Pick a starting tier from what the device tells us before measuring. */
  detectTier() {
    const mem = navigator.deviceMemory || 4;
    const cores = navigator.hardwareConcurrency || 4;
    const coarse = matchMedia('(pointer: coarse)').matches;
    if (mem <= 3 || cores <= 4) return 'low';
    if (coarse && mem <= 6) return 'medium';
    return 'high';
  }

  applyTier(tier) {
    this.tier = tier;
    const dprCap = tier === 'high' ? 1.75 : tier === 'medium' ? 1.35 : 1.0;
    this._dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.key.shadow.mapSize.set(tier === 'high' ? 1024 : 512,
      tier === 'high' ? 1024 : 512);
    if (this.key.shadow.map) {
      this.key.shadow.map.dispose();
      this.key.shadow.map = null;
    }
    this.post.bloomScale = tier === 'high' ? 0.5 : 0.34;
    this.post.setQuality(tier);
    this.qualityTransmission = tier === 'high';
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (!this._dpr) this._dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.renderer.setPixelRatio(this._dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h, this._dpr);
    this._aspect = w / h;
    this._updateProjectionScale();
  }

  /**
   * Point sprites size themselves as `worldSize * uScale / viewDepth`, so uScale
   * has to track the viewport height and the vertical FOV or particles change
   * size when the device rotates.
   */
  _updateProjectionScale() {
    const h = (this.canvas.clientHeight || window.innerHeight) * (this._dpr || 1);
    const scale = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    if (this.weather) this.weather.setProjectionScale(scale);
    if (this.impactFX) this.impactFX.setProjectionScale(scale);
    this._projScale = scale;
    // Anything else that opted into the point shader (the aim trail, city lights).
    this.scene.traverse((o) => {
      if (o.isPoints && o.material?.uniforms?.uScale) o.material.uniforms.uScale.value = scale;
    });
  }

  /** Load a biome: sky, IBL, fog, lights, weather, grade. */
  setBiome(biome, seed) {
    this.biome = biome;

    if (this._bg) this._bg.dispose();
    if (this._envMap) this._envMap.dispose();
    const { background, envMap } = buildSkyEnvironment(this.renderer, biome.sky, seed);
    this.scene.background = background;
    this.scene.environment = envMap;
    // The IBL fills shadows beautifully but at full strength it flattens the
    // rock; dialling it back lets the key light carve form again.
    this.scene.environmentIntensity = 0.75;
    this._bg = background;
    this._envMap = envMap;

    this.scene.fog = new THREE.Fog(
      new THREE.Color().setHex(biome.fog.color, THREE.SRGBColorSpace),
      biome.fog.near, biome.fog.far,
    );

    const dir = sunDirection(biome.sky);
    this.key.position.copy(dir).multiplyScalar(30);
    this.key.target.position.set(0, 0, 0);
    this.key.color.setHex(biome.sun.color, THREE.SRGBColorSpace);
    this.key.intensity = biome.sun.intensity;

    this.fill.position.copy(dir).multiplyScalar(-18).setY(9);
    this.fill.color.setHex(biome.hemi.sky, THREE.SRGBColorSpace);
    this.fill.intensity = 0.4;

    this.hemi.color.setHex(biome.hemi.sky, THREE.SRGBColorSpace);
    this.hemi.groundColor.setHex(biome.hemi.ground, THREE.SRGBColorSpace);
    this.hemi.intensity = biome.hemi.intensity;

    if (this.weather) {
      this.scene.remove(this.weather.object);
      this.weather.dispose();
    }
    this.weather = new Weather(biome);
    this.scene.add(this.weather.object);

    if (this.impactFX) this.impactFX.dispose();   // removes its own scene objects
    this.impactFX = new ImpactFX(this.scene, biome);
    this._updateProjectionScale();

    this.post.applyGrade(biome);
  }

  setArena(arena) {
    if (this.arena) {
      this.scene.remove(this.arena.root);
      this.arena.dispose();
    }
    this.arena = arena;
    this.scene.add(arena.root);

    // Fit the shadow frustum tightly to the plateau: the single biggest lever on
    // shadow quality per texel.
    const s = arena.extent * 1.35;
    const cam = this.key.shadow.camera;
    cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
    cam.near = 12; cam.far = 60;
    cam.updateProjectionMatrix();
  }

  /** Warm the shader cache so the first real frame doesn't hitch. */
  async warmup() {
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      this.renderer.compile(this.scene, this.camera);
    }
  }

  // --- camera -------------------------------------------------------------

  // --- loadout showcase ---------------------------------------------------

  /**
   * Put a pen on display above the ledge, scaled up and slowly turning, with the
   * live arena behind it. This is the loadout screen's "background" — the game
   * itself, not a picture of it.
   */
  setShowcase(group) {
    this.clearShowcase();
    this._showcase = group;
    group.scale.setScalar(SHOWCASE_SCALE);
    group.position.set(0, SHOWCASE_Y, 0);
    this.scene.add(group);
    this._showcaseSpin = -0.5;
    this._showcaseIn = 0;
  }

  clearShowcase() {
    if (!this._showcase) return;
    this.scene.remove(this._showcase);
    this._showcase = null;
  }

  updateShowcase(dt) {
    const g = this._showcase;
    if (!g) return;
    this._showcaseSpin += dt * 0.42;
    this._showcaseIn = Math.min(1, this._showcaseIn + dt * 2.6);
    const ease = 1 - (1 - this._showcaseIn) ** 3;
    g.rotation.order = 'YZX';
    g.rotation.y = this._showcaseSpin;
    // A slow tilt oscillation so the specular highlight travels along the barrel.
    g.rotation.z = -0.22 + Math.sin(this._showcaseSpin * 0.7) * 0.14;
    g.position.y = SHOWCASE_Y + (1 - ease) * 0.25;
    g.scale.setScalar(SHOWCASE_SCALE * (0.82 + ease * 0.18));

    // Frame it: close enough that the grip ribs and the clip read clearly.
    const half = SHOWCASE_LENGTH * 0.5;
    const vFov = THREE.MathUtils.degToRad(this._fovBase);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this._aspect);
    // A little margin: at 0.94 the barrel runs off both edges of a phone screen.
    const d = half / Math.tan(Math.min(vFov, hFov) / 2) * 1.16;
    this._wantPos.set(0, SHOWCASE_Y + 0.10, d);
    this._wantLook.set(0, SHOWCASE_Y - 0.01, 0);
    this._fovWant = this._fovBase;
    this._camLambda = 2.4;
  }

  /** Direct camera control, used by the replay director. */
  setFreeView(px, py, pz, lx, ly, lz, fov, lambda = 6) {
    this._wantPos.set(px, py, pz);
    this._wantLook.set(lx, ly, lz);
    this._fovWant = fov ?? this._fovBase;
    this._camLambda = lambda;
  }

  /** Snap the camera instantly — for hard cuts between replay shots. */
  cutCamera() {
    this.camPos.copy(this._wantPos);
    this.camLook.copy(this._wantLook);
    this.camera.fov = this._fovWant;
    this.camera.updateProjectionMatrix();
  }

  /** Frame the whole arena from an orbiting hero angle. */
  setOverview(dt, radius) {
    this._orbit += dt * 0.10;
    const d = this._fitDistance(radius * 1.15);
    this._wantPos.set(
      Math.sin(this._orbit) * d * 0.72,
      d * 0.40,
      Math.cos(this._orbit) * d * 0.72,
    );
    this._wantLook.set(0, 0.10, 0);
    this._fovWant = this._fovBase;
    this._camLambda = 1.6;
  }

  /**
   * Aiming view: sit behind the player's pen looking down the line of attack, so
   * the drag direction on screen matches the direction the pen will travel.
   */
  setAimView(from, toward, radius) {
    const dx = toward.x - from.x;
    const dz = toward.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const d = this._fitDistance(radius * 1.0);

    // Sit behind the player's pen, but AIM at the midpoint between the two pens.
    // Looking at the player's own pen instead pushes the arena into a corner and
    // crops the far lip — the one piece of geometry the shot is actually about.
    const midX = (from.x + toward.x) * 0.5;
    const midZ = (from.z + toward.z) * 0.5;

    this._wantPos.set(
      from.x - ux * d * 0.68,
      d * 0.36,
      from.z - uz * d * 0.68,
    );
    this._wantLook.set(midX, 0.035, midZ);
    this._fovWant = this._fovBase;
    this._camLambda = 3.4;
  }

  /** Track a moving pen during resolution. */
  setChaseView(target, radius) {
    const d = this._fitDistance(radius * 1.10);
    this._wantPos.set(
      target.x * 0.25 + Math.sin(this._orbit) * d * 0.62,
      d * 0.42,
      target.z * 0.25 + Math.cos(this._orbit) * d * 0.62,
    );
    this._wantLook.set(target.x * 0.45, 0.06, target.z * 0.45);
    this._fovWant = this._fovBase - 2;
    this._camLambda = 2.6;
  }

  /** Swing out and down to watch a pen fall off the edge. */
  setFallView(target, radius) {
    const len = Math.hypot(target.x, target.z) || 1;
    const ux = target.x / len, uz = target.z / len;
    const d = this._fitDistance(radius * 0.75);
    this._wantPos.set(
      target.x + ux * d * 0.62,
      d * 0.20,
      target.z + uz * d * 0.62,
    );
    this._wantLook.set(target.x, -0.5, target.z);
    this._fovWant = this._fovBase + 6;
    this._camLambda = 2.2;
  }

  /**
   * Distance needed to fit a circle of `r` on screen. Portrait phones are much
   * narrower than they are tall, so the horizontal FOV is the binding constraint
   * and the camera has to pull back — this is the whole mobile-first camera fix.
   */
  _fitDistance(r) {
    const vFov = THREE.MathUtils.degToRad(this._fovBase);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this._aspect);
    const limiting = Math.min(vFov, hFov);
    return (r / Math.sin(limiting / 2)) * 0.95;
  }

  shake(amount) {
    this._shake = Math.min(0.06, this._shake + amount);
    this.post.punch(amount * 9);
  }

  updateCamera(dt) {
    dampVec(this.camPos, this._wantPos, this._camLambda, dt);
    dampVec(this.camLook, this._wantLook, this._camLambda * 1.25, dt);

    this._shake = Math.max(0, this._shake - dt * 0.22);
    if (this._shake > 0.0002) {
      const s = this._shake;
      this._shakeVec.set(
        (Math.random() - 0.5) * s,
        (Math.random() - 0.5) * s,
        (Math.random() - 0.5) * s,
      );
    } else {
      this._shakeVec.set(0, 0, 0);
    }

    this.camera.position.copy(this.camPos).add(this._shakeVec);
    this.camera.lookAt(this.camLook);

    const fov = damp(this.camera.fov, this._fovWant, 4, dt);
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Governor: walk quality down if we are consistently missing frame time. */
  _governor(dt) {
    this._frameTimes[this._ftIndex] = dt;
    this._ftIndex = (this._ftIndex + 1) % this._frameTimes.length;
    this._ftFilled = Math.min(this._ftFilled + 1, this._frameTimes.length);
    this._sinceAdjust += dt;
    if (this._ftFilled < this._frameTimes.length || this._sinceAdjust < 2.5) return;

    let sum = 0;
    for (let i = 0; i < this._frameTimes.length; i++) sum += this._frameTimes[i];
    const avg = sum / this._frameTimes.length;
    const idx = TIERS.indexOf(this.tier);

    if (avg > 0.0215 && idx > 0) {
      this.applyTier(TIERS[idx - 1]);
      this._sinceAdjust = 0;
      this._ftFilled = 0;
    } else if (avg < 0.0135 && idx < TIERS.length - 1) {
      // Hysteresis: only climb back after a long, comfortably fast stretch.
      this.applyTier(TIERS[idx + 1]);
      this._sinceAdjust = -4;
      this._ftFilled = 0;
    }
  }

  render(dt) {
    this._governor(dt);
    this.updateCamera(dt);
    if (this.weather) this.weather.update(dt, this.camera.position);
    if (this.impactFX) this.impactFX.update(dt);
    this.post.render(this.scene, this.camera, dt);
  }

  dispose() {
    if (this.arena) this.arena.dispose();
    if (this.weather) this.weather.dispose();
    if (this.impactFX) this.impactFX.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }
}
