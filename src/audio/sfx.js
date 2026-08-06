/**
 * sfx.js — every sound in the game is synthesized at runtime. Zero audio files.
 *
 * Signal path:
 *   voices → dry → ┐
 *                  ├→ master gain → compressor → limiter → destination
 *   voices → send → convolver (procedural IR) → wet ─┘
 *
 * The impulse response is regenerated per biome (a short, tight room for the
 * rooftop; a long, bright tail for the glacier), which is most of what makes the
 * arenas sound like different places.
 */

const NOISE_SECONDS = 3;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    // -Infinity, not 0: an AudioContext's currentTime also starts at 0, so a zero
    // here makes the rate-limiter below swallow the very first impact of the
    // session — the first pen-on-pen hit of a match was silent.
    this._lastClack = -Infinity;
    this._activeVoices = 0;
    this._ambient = null;
    this._charge = null;
    this._slide = null;
  }

  /**
   * Must be called synchronously inside a real user gesture — iOS Safari and
   * Chrome mobile both keep the context suspended otherwise.
   */
  /**
   * @param {BaseAudioContext} [providedCtx] render target. Passing an
   *   OfflineAudioContext builds the identical graph for bouncing the sounds to
   *   files (see tools/export-audio.mjs); omit it for normal play.
   */
  unlock(providedCtx) {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    let ctx = providedCtx;
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      ctx = new Ctx({ latencyHint: 'interactive' });
    }
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    comp.knee.value = 6;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    limiter.knee.value = 0;

    this.master.connect(comp);
    comp.connect(limiter);
    limiter.connect(ctx.destination);

    this.dry = ctx.createGain();
    this.dry.gain.value = 1;
    this.dry.connect(this.master);

    this.convolver = ctx.createConvolver();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.32;
    this.convolver.connect(this.wet);
    this.wet.connect(this.master);

    this.send = ctx.createGain();
    this.send.gain.value = 1;
    this.send.connect(this.convolver);

    this.ambientBus = ctx.createGain();
    this.ambientBus.gain.value = 0;
    this.ambientBus.connect(this.master);

    this._buildNoiseBuffers();
    this.setSpace(1.6, 0.9);
    this.ready = true;
    if (ctx.state === 'suspended') ctx.resume?.();
  }

  _buildNoiseBuffers() {
    const ctx = this.ctx;
    const n = ctx.sampleRate * NOISE_SECONDS;

    const white = ctx.createBuffer(1, n, ctx.sampleRate);
    const wd = white.getChannelData(0);
    for (let i = 0; i < n; i++) wd[i] = Math.random() * 2 - 1;
    this.whiteBuf = white;

    // Paul Kellett's pink filter — cheap and close enough to -3dB/octave.
    const pink = ctx.createBuffer(1, n, ctx.sampleRate);
    const pd = pink.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = wd[i];
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      pd[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    this.pinkBuf = pink;

    const brown = ctx.createBuffer(1, n, ctx.sampleRate);
    const bd = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + 0.02 * wd[i]) / 1.02;
      bd[i] = last * 3.5;
    }
    this.brownBuf = brown;
  }

  /** Rebuild the reverb tail. `seconds` = room size, `bright` = 0..1 damping. */
  setSpace(seconds, bright = 0.8, wet = 0.32) {
    if (!this.ready && !this.ctx) return;
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    // Exponentially decaying noise. The classic no-assets impulse response.
    const decay = 2.2 + (1 - bright) * 3.0;
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      const damp = 0.25 + bright * 0.6;
      for (let i = 0; i < len; i++) {
        const env = Math.pow(1 - i / len, decay);
        const white = Math.random() * 2 - 1;
        lp += damp * (white - lp); // one-pole lowpass = high-frequency damping
        d[i] = lp * env;
      }
    }
    this.convolver.buffer = ir;
    this.wet.gain.value = wet;
  }

  _noiseSource(buf) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    return src;
  }

  /**
   * A voice is one gain → panner → (dry + reverb send). `drive > 0` inserts a
   * soft-clipper, which is what gives a hard hit its splintery edge.
   */
  _voice(pan = 0, sendAmt = 0.28, drive = 0) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));

    if (drive > 0) {
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(257);
      for (let i = 0; i < 257; i++) {
        const x = (i / 128) - 1;
        curve[i] = ((1 + drive) * x) / (1 + drive * Math.abs(x));
      }
      shaper.curve = curve;
      g.connect(shaper);
      shaper.connect(p);
    } else {
      g.connect(p);
    }

    p.connect(this.dry);
    const s = ctx.createGain();
    s.gain.value = sendAmt;
    p.connect(s);
    s.connect(this.send);
    return g;
  }

  /**
   * Plastic-on-plastic. `v` 0..1 maps a soft tick to a hard crack: the body tone
   * climbs 900→1800Hz, the noise transient brightens, and past 0.6 a waveshaper
   * adds the splintery edge that makes a hard hit read as violent.
   */
  clack(v = 0.5, pan = 0, delay = 0) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + delay;
    // Rate-limit: rapid contacts within one collision cluster would otherwise
    // stack into a buzz and blow up the node count. Scheduled (delayed) hits are
    // exempt — they are a deliberate sequence, not a cluster.
    if (delay === 0) {
      if (now - this._lastClack < 0.018 || this._activeVoices > 14) return;
      this._lastClack = now;
    }
    this._activeVoices++;

    v = Math.max(0.05, Math.min(1, v));
    const out = this._voice(pan, 0.22 + v * 0.2, v > 0.6 ? (v - 0.6) * 18 : 0);
    const peak = 0.10 + v * 0.72;
    const dur = 0.06 + v * 0.10;

    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(peak, now + 0.001);
    out.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    // Body: a short pitched knock with a falling pitch envelope.
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const f0 = 900 + v * 900;
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.6, now + 0.015);
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.55;

    // Transient: filtered noise burst.
    const noise = ctx.createBufferSource();
    noise.buffer = this.whiteBuf;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2500 + v * 3500;
    bp.Q.value = 2 + v * 2;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.9, now);
    nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.012 + v * 0.028);

    osc.connect(bodyGain); bodyGain.connect(out);
    noise.connect(bp); bp.connect(nGain); nGain.connect(out);

    osc.start(now); noise.start(now);
    const stopAt = now + dur + 0.02;
    osc.stop(stopAt); noise.stop(stopAt);
    osc.onended = () => { this._activeVoices--; };
  }

  /** Rock scraping under a sliding pen. Call every frame with 0..1. */
  setSlide(intensity, pan = 0) {
    if (!this.ready) return;
    const ctx = this.ctx;
    if (!this._slide) {
      const src = this._noiseSource(this.pinkBuf);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.value = 0;
      const p = ctx.createStereoPanner();
      src.connect(bp); bp.connect(g); g.connect(p);
      p.connect(this.dry);
      const s = ctx.createGain();
      s.gain.value = 0.2;
      p.connect(s); s.connect(this.send);
      src.start();
      this._slide = { src, bp, g, p };
    }
    const s = this._slide;
    const t = ctx.currentTime;
    const target = this.muted ? 0 : Math.min(0.16, intensity * 0.16);
    s.g.gain.setTargetAtTime(target, t, 0.04);
    s.bp.frequency.setTargetAtTime(420 + intensity * 2600, t, 0.05);
    s.p.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.08);
  }

  /** A pen going over the edge: doppler drop, then clatter fading into distance. */
  fall(pan = 0) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const out = this._voice(pan, 0.5);
    out.gain.setValueAtTime(0.28, now);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(8000, now);
    lp.frequency.exponentialRampToValueAtTime(1200, now + 0.45);
    lp.connect(out);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(620, now);
    osc.frequency.exponentialRampToValueAtTime(150, now + 0.38);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.22, now);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    osc.connect(og); og.connect(lp);
    osc.start(now); osc.stop(now + 0.5);

    // Distant clatter as it hits the rock face on the way down. Scheduled on the
    // audio clock rather than with setTimeout: timers drift under load, and the
    // whole point of this sequence is its rhythm.
    let delay = 0.18;
    for (let i = 0; i < 4; i++) {
      const v = 0.32 - i * 0.06;
      this.clack(Math.max(0.08, v), pan * 0.7, delay);
      delay += 0.07 + Math.random() * 0.11;
    }
  }

  /**
   * Tension while the player pulls back.
   *
   * Deliberately NOT a rising pitch sweep — a tone that tracks your finger is
   * grating within two turns, and you hear this on every single flick. This is a
   * soft filtered-noise "draw", like a bowstring under load: it only swells in
   * volume and opens slightly in tone, with no pitch to fixate on. The one
   * discrete event is a single soft tick when you cross into overcharge, which is
   * the only moment that actually needs your attention.
   */
  chargeStart() {
    if (!this.ready || this.muted || this._charge) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const src = this._noiseSource(this.pinkBuf);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 380;
    band.Q.value = 0.7;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.012, now + 0.10);

    src.connect(band); band.connect(lp); lp.connect(g); g.connect(this.dry);
    src.start(now);

    this._charge = { src, band, lp, g, warned: false };
  }

  chargeUpdate(power) {
    if (!this._charge) return;
    const t = this.ctx.currentTime;
    const c = this._charge;
    // Volume and brightness only. Both ramp smoothly, so there is nothing to
    // "hear tracking" — it just feels like load building up.
    c.g.gain.setTargetAtTime(0.010 + power * 0.055, t, 0.05);
    c.band.frequency.setTargetAtTime(320 + power * 520, t, 0.07);
    c.lp.frequency.setTargetAtTime(800 + power * 2200, t, 0.07);

    if (!c.warned && power > 0.75) {
      c.warned = true;
      this.tick(880, 0.05);
    } else if (c.warned && power < 0.70) {
      c.warned = false;   // re-arm if they ease back off
    }
  }

  chargeStop() {
    if (!this._charge) return;
    const { src, g } = this._charge;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(0.0001, t, 0.03);
    try { src.stop(t + 0.18); } catch { /* already stopped */ }
    this._charge = null;
  }

  /** The flick itself. */
  whoosh(power = 0.5, pan = 0) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const out = this._voice(pan, 0.15);
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(0.06 + power * 0.14, now + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    const src = this._noiseSource(this.whiteBuf);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(500, now);
    bp.frequency.exponentialRampToValueAtTime(1400 + power * 3200, now + 0.06);
    bp.frequency.exponentialRampToValueAtTime(600, now + 0.17);
    src.connect(bp); bp.connect(out);
    src.start(now); src.stop(now + 0.2);
  }

  tick(freq = 1800, gain = 0.05, delay = 0) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + delay;
    const out = this._voice(0, 0.08);
    out.gain.setValueAtTime(gain, now);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(out);
    osc.start(now); osc.stop(now + 0.06);
  }

  confirm() {
    this.tick(660, 0.06);
    this.tick(990, 0.06, 0.045);
  }

  /** Two-part tabla-ish hit: low resonant thump plus a bright rim tick. */
  _tabla(when, low = 100, gain = 0.4) {
    const ctx = this.ctx;
    const out = this._voice(0, 0.35);
    out.gain.setValueAtTime(gain, when);
    out.gain.exponentialRampToValueAtTime(0.0001, when + 0.22);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(low * 1.6, when);
    osc.frequency.exponentialRampToValueAtTime(low, when + 0.05);
    osc.connect(out);
    osc.start(when); osc.stop(when + 0.25);

    const n = ctx.createBufferSource();
    n.buffer = this.whiteBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3800;
    bp.Q.value = 3;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.35, when);
    ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.02);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    n.start(when); n.stop(when + 0.05);
  }

  _note(when, freq, dur, gain = 0.14, type = 'triangle') {
    const ctx = this.ctx;
    const out = this._voice(0, 0.4);
    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(gain, when + 0.02);
    out.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = freq * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.3;
    osc.connect(out);
    osc2.connect(g2); g2.connect(out);
    osc.start(when); osc.stop(when + dur + 0.05);
    osc2.start(when); osc2.stop(when + dur + 0.05);
  }

  /** Raga Bhupali — the auspicious pentatonic. Sa Re Ga Pa Dha, no 4th or 7th. */
  win() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const sa = 261.63;
    const bhupali = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4];
    bhupali.forEach((r, i) => {
      this._note(t + i * 0.085, sa * r, 0.45 - i * 0.02, 0.13);
    });
    this._tabla(t, 110, 0.45);
    this._tabla(t + 0.26, 88, 0.34);
    this._tabla(t + 0.42, 130, 0.30);
    this._note(t + 0.62, sa * 2, 1.1, 0.16, 'sine');
    this._note(t + 0.62, sa * 3, 1.1, 0.07, 'sine');
  }

  /** Bhairavi-flavoured descent: komal Dha, komal Ga, resolving down. */
  lose() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const sa = 220;
    const desc = [8 / 5, 3 / 2, 6 / 5, 1];
    desc.forEach((r, i) => {
      this._note(t + i * 0.18, sa * r, 0.6, 0.12, 'sine');
    });
    this._note(t + 0.72, sa * 0.5, 1.6, 0.10, 'sine');
    this._tabla(t + 0.72, 70, 0.22);
  }

  /** Per-biome ambient bed. Crossfades out whatever was playing. */
  setAmbient(kind) {
    if (!this.ready) return;
    const ctx = this.ctx;
    if (this._ambient) {
      const old = this._ambient;
      old.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.4);
      setTimeout(() => old.nodes.forEach((n) => { try { n.stop ? n.stop() : n.disconnect(); } catch { /* already stopped */ } }), 1600);
      this._ambient = null;
    }
    if (!kind) return;

    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.connect(this.ambientBus);
    const nodes = [];

    const addNoise = (buf, filterType, freq, q, level) => {
      const src = this._noiseSource(buf);
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      f.Q.value = q;
      const lg = ctx.createGain();
      lg.gain.value = level;
      src.connect(f); f.connect(lg); lg.connect(g);
      src.start();
      nodes.push(src);
      return { f, lg };
    };

    const addLfo = (rate, depth, target) => {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const lg = ctx.createGain();
      lg.gain.value = depth;
      lfo.connect(lg); lg.connect(target);
      lfo.start();
      nodes.push(lfo);
    };

    switch (kind) {
      case 'wind': {
        const a = addNoise(this.pinkBuf, 'lowpass', 800, 0.9, 0.5);
        addLfo(0.07, 420, a.f.frequency);
        addLfo(0.031, 0.22, a.lg.gain);
        addNoise(this.whiteBuf, 'bandpass', 2400, 3, 0.05);
        break;
      }
      case 'ice': {
        const a = addNoise(this.pinkBuf, 'lowpass', 1100, 0.8, 0.4);
        addLfo(0.05, 620, a.f.frequency);
        addNoise(this.whiteBuf, 'highpass', 3600, 0.7, 0.045);
        break;
      }
      case 'rain': {
        addNoise(this.whiteBuf, 'highpass', 2200, 0.7, 0.16);
        const b = addNoise(this.pinkBuf, 'bandpass', 900, 0.8, 0.10);
        addLfo(0.13, 0.05, b.lg.gain);
        addNoise(this.brownBuf, 'lowpass', 260, 0.7, 0.32);
        break;
      }
      case 'lava': {
        const a = addNoise(this.brownBuf, 'lowpass', 230, 0.8, 0.62);
        addLfo(0.28, 0.26, a.lg.gain);
        const sub = ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.value = 48;
        const sg = ctx.createGain();
        sg.gain.value = 0.14;
        sub.connect(sg); sg.connect(g);
        sub.start();
        nodes.push(sub);
        addLfo(0.19, 0.09, sg.gain);
        break;
      }
      case 'desert':
      default: {
        const a = addNoise(this.pinkBuf, 'lowpass', 700, 0.7, 0.36);
        addLfo(0.045, 300, a.f.frequency);
        addLfo(0.022, 0.14, a.lg.gain);
        break;
      }
    }

    g.gain.setTargetAtTime(this.muted ? 0.0001 : 0.6, ctx.currentTime, 1.2);
    this._ambient = { gain: g, nodes };
    this.ambientBus.gain.setTargetAtTime(this.muted ? 0 : 0.5, ctx.currentTime, 1.0);
  }

  setMuted(m) {
    this.muted = m;
    if (!this.ready) return;
    this.master.gain.setTargetAtTime(m ? 0.0001 : 0.9, this.ctx.currentTime, 0.08);
  }
}

export const audio = new AudioEngine();
