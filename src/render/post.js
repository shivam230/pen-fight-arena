/**
 * post.js — the grade.
 *
 * Deliberately not EffectComposer + UnrealBloomPass: that chain costs 4–7ms on a
 * mid-range Android because it allocates a five-level mip pyramid and pays full
 * composer overhead per pass. This does the same job in four half-resolution blur
 * passes plus ONE composite that folds together bloom, chromatic aberration,
 * vignette, film grain, colour grading and the ACES tonemap.
 *
 * The scene is rendered into a linear HDR target with tone mapping OFF, so the
 * bloom threshold operates on real HDR values and the tonemap is applied exactly
 * once, at the very end, by the composite shader.
 */

import * as THREE from 'three';

const BRIGHT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Soft knee so bright areas ramp into the bloom instead of popping.
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contrib = max(soft, l - uThreshold) / max(l, 1e-5);
  gl_FragColor = vec4(c * contrib, 1.0);
}`;

const BLUR_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uDir;      // texel-sized step, already scaled by radius
void main() {
  // 9-tap Gaussian, weights folded to 5 taps via linear sampling.
  vec3 sum = texture2D(tSrc, vUv).rgb * 0.227027;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  sum += (texture2D(tSrc, vUv + o1).rgb + texture2D(tSrc, vUv - o1).rgb) * 0.3162162162;
  sum += (texture2D(tSrc, vUv + o2).rgb + texture2D(tSrc, vUv - o2).rgb) * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uExposure;
uniform float uAberration;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uFlash;
uniform vec3  uLift;
uniform vec3  uGain;
uniform float uSat;
uniform float uContrast;

// ACES filmic approximation (Narkowicz) — the curve that makes highlights roll
// off like film instead of clipping to white.
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec2 uv = vUv;
  vec2 centred = uv - 0.5;
  float r2 = dot(centred, centred);

  // Chromatic aberration: grows with radius, so the centre of the action stays
  // clean and only the frame edges smear. Punched up briefly on a hard impact.
  float ca = (uAberration + uFlash * 0.004) * r2;
  vec3 col;
  col.r = texture2D(tScene, uv - centred * ca).r;
  col.g = texture2D(tScene, uv).g;
  col.b = texture2D(tScene, uv + centred * ca).b;

  col += texture2D(tBloom, uv).rgb * uBloom;
  col *= uExposure * (1.0 + uFlash * 0.35);

  // Grade in linear: lift, gain, contrast about middle grey, then saturation.
  col = col * uGain + uLift;
  col = mix(vec3(0.18), col, uContrast);
  col = max(col, vec3(0.0));
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSat);

  col = aces(col);

  // Vignette after the tonemap so it darkens the picture, not the exposure.
  float vig = smoothstep(0.85, 0.18, r2 * uVignette);
  col *= mix(1.0, vig, 0.85);

  // Fine animated grain, scaled down in the highlights the way real grain sits.
  float g = hash(uv * vec2(1024.0, 1024.0) + fract(uTime) * 91.7) - 0.5;
  float lum = dot(col, vec3(0.333));
  col += g * uGrain * smoothstep(0.0, 0.16, lum) * (1.0 - smoothstep(0.55, 1.0, lum));

  // Linear -> sRGB. Done here because the renderer's own conversion is bypassed
  // when the scene is drawn into a linear HDR target.
  col = max(col, vec3(0.0));
  vec3 srgb = mix(col * 12.92,
                  1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055,
                  step(0.0031308, col));
  gl_FragColor = vec4(srgb, 1.0);
}`;

function fullscreenGeometry() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(
    new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return geo;
}

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;
    this.bloomScale = 0.5;

    this._geo = fullscreenGeometry();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = new THREE.Mesh(this._geo, null);
    this._quadScene = new THREE.Scene();
    this._quadScene.add(this._quad);

    const rtOpts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    };
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { ...rtOpts, samples: 4 });
    this.bloomA = new THREE.WebGLRenderTarget(1, 1, { ...rtOpts, depthBuffer: false });
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, { ...rtOpts, depthBuffer: false });

    this.brightMat = new THREE.RawShaderMaterial({
      vertexShader: `precision highp float;
        attribute vec3 position; attribute vec2 uv; varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: BRIGHT_FRAG,
      uniforms: {
        tScene: { value: null },
        uThreshold: { value: 0.85 },
        uKnee: { value: 0.35 },
      },
      depthTest: false, depthWrite: false,
    });

    this.blurMat = new THREE.RawShaderMaterial({
      vertexShader: this.brightMat.vertexShader,
      fragmentShader: BLUR_FRAG,
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false,
    });

    this.compositeMat = new THREE.RawShaderMaterial({
      vertexShader: this.brightMat.vertexShader,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uBloom: { value: 0.85 },
        uExposure: { value: 1.0 },
        uAberration: { value: 0.006 },
        uVignette: { value: 1.35 },
        uGrain: { value: 0.016 },
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uLift: { value: new THREE.Vector3(0, 0, 0) },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uSat: { value: 1.05 },
        uContrast: { value: 1.18 },
      },
      depthTest: false, depthWrite: false,
    });

    this._flash = 0;
    this._bloomStrength = 0.85;
    this._skipBloom = false;
  }

  setSize(width, height, pixelRatio) {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    this.sceneRT.setSize(w, h);
    const bw = Math.max(1, Math.floor(w * this.bloomScale));
    const bh = Math.max(1, Math.floor(h * this.bloomScale));
    this.bloomA.setSize(bw, bh);
    this.bloomB.setSize(bw, bh);
    this._bw = bw; this._bh = bh;
  }

  /** Apply a biome's look. */
  applyGrade(biome) {
    const u = this.compositeMat.uniforms;
    u.uLift.value.fromArray(biome.grade.lift);
    u.uGain.value.fromArray(biome.grade.gain);
    u.uSat.value = biome.grade.sat;
    u.uContrast.value = biome.grade.contrast ?? 1.18;
    this._bloomStrength = biome.bloom;
    u.uBloom.value = biome.bloom;
    u.uExposure.value = biome.exposure;
  }

  /** Screen punch on a heavy hit — decays on its own. */
  punch(amount) {
    this._flash = Math.min(1.4, this._flash + amount);
  }

  setQuality(tier) {
    // 'high' | 'medium' | 'low'
    this.compositeMat.uniforms.uGrain.value = tier === 'low' ? 0.0 : 0.016;
    this.compositeMat.uniforms.uAberration.value = tier === 'low' ? 0 : 0.006;
    this._skipBloom = tier === 'low';
  }

  _draw(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._quadScene, this._camera);
  }

  render(scene, camera, dt) {
    const r = this.renderer;
    this._flash = Math.max(0, this._flash - dt * 3.4);

    if (!this.enabled) {
      r.setRenderTarget(null);
      r.render(scene, camera);
      return;
    }

    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    if (!this._skipBloom) {
      this.brightMat.uniforms.tScene.value = this.sceneRT.texture;
      this._draw(this.brightMat, this.bloomA);

      const px = 1 / this._bw, py = 1 / this._bh;
      // Two blur sweeps at increasing stride give a wide, soft falloff for the
      // cost of four small passes instead of a full mip pyramid.
      for (const radius of [1.0, 2.6]) {
        this.blurMat.uniforms.tSrc.value = this.bloomA.texture;
        this.blurMat.uniforms.uDir.value.set(px * radius, 0);
        this._draw(this.blurMat, this.bloomB);

        this.blurMat.uniforms.tSrc.value = this.bloomB.texture;
        this.blurMat.uniforms.uDir.value.set(0, py * radius);
        this._draw(this.blurMat, this.bloomA);
      }
    }

    const u = this.compositeMat.uniforms;
    u.tScene.value = this.sceneRT.texture;
    // Always bind a real texture — a null sampler is undefined behaviour. When
    // bloom is off we mute its contribution instead.
    u.tBloom.value = this.bloomA.texture;
    u.uBloom.value = this._skipBloom ? 0 : this._bloomStrength;
    u.uTime.value += dt;
    u.uFlash.value = this._flash;
    this._draw(this.compositeMat, null);
  }

  dispose() {
    this.sceneRT.dispose();
    this.bloomA.dispose();
    this.bloomB.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this._geo.dispose();
  }
}
