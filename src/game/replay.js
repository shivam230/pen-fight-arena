/**
 * replay.js — the clean-knock cinematic.
 *
 * Every player turn is recorded as a flat array of poses. If the turn ends in a
 * clean knock, the recording is played back through a small shot list rather than
 * simply re-run: a wide establishing pan, a hard cut to a slow-motion POV riding
 * a few centimetres behind the barrel, the impact, then a swing out over the lip
 * to watch the rival's pen go.
 *
 * Recording is deliberately cheap — six floats per pen per frame written into a
 * preallocated Float32Array, no objects, no allocation during play.
 */

const FLOATS_PER_PEN = 6;      // x, y, angle, height, tumble, alive
const MAX_SECONDS = 8;
const CAPTURE_HZ = 60;

export class TurnRecorder {
  constructor(maxPens = 2) {
    this.maxPens = maxPens;
    this.capacity = MAX_SECONDS * CAPTURE_HZ;
    this.data = new Float32Array(this.capacity * maxPens * FLOATS_PER_PEN);
    this.times = new Float32Array(this.capacity);
    this.reset();
  }

  reset() {
    this.frames = 0;
    this.time = 0;
    this._accum = 0;
    this.pens = null;
    this.impacts = [];
    this.firstImpact = -1;
    this.fallTime = -1;
    this.fallPen = null;
  }

  start(pens) {
    this.reset();
    this.pens = pens.slice(0, this.maxPens);
  }

  /** Call once per frame while the turn resolves. */
  capture(dt) {
    if (!this.pens) return;
    this.time += dt;
    this._accum += dt;
    const step = 1 / CAPTURE_HZ;
    if (this._accum < step || this.frames >= this.capacity) return;
    this._accum = 0;

    const base = this.frames * this.maxPens * FLOATS_PER_PEN;
    for (let i = 0; i < this.pens.length; i++) {
      const p = this.pens[i];
      const o = base + i * FLOATS_PER_PEN;
      this.data[o] = p.x;
      this.data[o + 1] = p.y;
      this.data[o + 2] = p.a;
      this.data[o + 3] = p.height;
      this.data[o + 4] = p.tumble;
      this.data[o + 5] = p.falling ? 2 : (p.alive ? 1 : 0);
    }
    this.times[this.frames] = this.time;
    this.frames++;
  }

  noteImpact(x, z, strength) {
    if (this.firstImpact < 0) this.firstImpact = this.time;
    this.impacts.push({ t: this.time, x, z, strength });
  }

  noteFall(pen) {
    if (this.fallTime < 0) {
      this.fallTime = this.time;
      this.fallPen = pen;
    }
  }

  get duration() { return this.frames ? this.times[this.frames - 1] : 0; }

  /** Interpolated pose of pen `i` at source time `t`, written into `out`. */
  sample(i, t, out) {
    if (!this.frames) return false;
    const last = this.frames - 1;
    let lo = 0, hi = last;
    if (t <= this.times[0]) { lo = hi = 0; } else if (t >= this.times[last]) {
      lo = hi = last;
    } else {
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (this.times[mid] <= t) lo = mid; else hi = mid;
      }
    }
    const span = this.times[hi] - this.times[lo];
    const f = span > 1e-6 ? (t - this.times[lo]) / span : 0;

    const stride = this.maxPens * FLOATS_PER_PEN;
    const a = lo * stride + i * FLOATS_PER_PEN;
    const b = hi * stride + i * FLOATS_PER_PEN;
    const d = this.data;

    out.x = d[a] + (d[b] - d[a]) * f;
    out.y = d[a + 1] + (d[b + 1] - d[a + 1]) * f;
    // Angles are continuous in the solver (never wrapped), so a plain lerp is safe.
    out.a = d[a + 2] + (d[b + 2] - d[a + 2]) * f;
    out.height = d[a + 3] + (d[b + 3] - d[a + 3]) * f;
    out.tumble = d[a + 4] + (d[b + 4] - d[a + 4]) * f;
    out.state = d[b + 5];
    return true;
  }
}

const _pose = { x: 0, y: 0, a: 0, height: 0, tumble: 0, state: 1 };
const _prev = { x: 0, y: 0, a: 0, height: 0, tumble: 0, state: 1 };

/**
 * Plays a recording back through a shot list. Each shot maps real elapsed time
 * onto source time (so slow motion is just a slower mapping) and positions the
 * camera itself.
 */
export class ReplayDirector {
  /**
   * @param {TurnRecorder} rec
   * @param {number} heroIndex   index of the pen that did the knocking
   * @param {number} victimIndex index of the pen that went over
   */
  constructor(rec, heroIndex, victimIndex, arenaExtent) {
    this.rec = rec;
    this.hero = heroIndex;
    this.victim = victimIndex;
    this.extent = arenaExtent;

    const impact = rec.firstImpact > 0 ? rec.firstImpact : rec.duration * 0.4;
    const fall = rec.fallTime > 0 ? rec.fallTime : rec.duration;
    const end = rec.duration;

    this.impactTime = impact;
    this.shots = [
      // Establish: low and wide, drifting, just before the pens meet.
      { id: 'wide', real: 1.05, from: Math.max(0, impact - 1.05), to: Math.max(0.02, impact - 0.20) },
      // The money shot: ~0.2x speed, camera riding just behind the barrel.
      { id: 'pov', real: 1.55, from: Math.max(0, impact - 0.20), to: Math.min(end, impact + 0.11) },
      // Swing out and follow the loser over the lip.
      { id: 'follow', real: 1.65, from: Math.min(end, impact + 0.11), to: Math.min(end, fall + 0.55) },
      // Hold on the empty ledge.
      { id: 'hold', real: 0.65, from: Math.min(end, fall + 0.55), to: end },
    ];
    this.total = this.shots.reduce((s, x) => s + x.real, 0);
    this.elapsed = 0;
    this.done = false;
    this._firedImpact = false;
    this._orbit = Math.random() * Math.PI * 2;
  }

  get progress() { return Math.min(1, this.elapsed / this.total); }

  /**
   * Advance the cinematic.
   * @param {number} dt
   * @param {object} api  { setPose(i, pose), stage, fx, onImpact(x,z,strength) }
   */
  update(dt, api) {
    this.elapsed += dt;

    let acc = 0;
    let shot = this.shots[this.shots.length - 1];
    let local = 1;
    for (const s of this.shots) {
      if (this.elapsed < acc + s.real) {
        shot = s;
        local = s.real > 0 ? (this.elapsed - acc) / s.real : 1;
        break;
      }
      acc += s.real;
    }
    if (this.elapsed >= this.total) {
      this.done = true;
      local = 1;
    }

    const srcT = shot.from + (shot.to - shot.from) * local;
    const rec = this.rec;

    // --- poses ------------------------------------------------------------
    rec.sample(this.hero, srcT, _pose);
    const heroX = _pose.x, heroZ = _pose.y;
    api.setPose(this.hero, _pose);
    // Sample a moment earlier to derive a heading for the camera and the sparks.
    rec.sample(this.hero, Math.max(0, srcT - 0.04), _prev);
    let dx = heroX - _prev.x;
    let dz = heroZ - _prev.y;
    let speed = Math.hypot(dx, dz) / 0.04;
    if (speed < 1e-4) { dx = Math.cos(_pose.a); dz = Math.sin(_pose.a); speed = 0; }
    else { dx /= speed * 0.04 || 1; dz /= speed * 0.04 || 1; }
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;

    rec.sample(this.victim, srcT, _prev);
    const victimX = _prev.x, victimZ = _prev.y;
    api.setPose(this.victim, _prev);

    // --- friction spray under the sliding pen -----------------------------
    if (speed > 0.25 && shot.id !== 'hold') {
      api.friction(heroX, heroZ, Math.min(1, speed / 2.2), dx, dz, dt);
    }

    // --- the hit ----------------------------------------------------------
    if (!this._firedImpact && srcT >= this.impactTime) {
      this._firedImpact = true;
      const hit = rec.impacts[0];
      api.onImpact(hit ? hit.x : heroX, hit ? hit.z : heroZ, hit ? hit.strength : 0.8);
    }

    // --- camera -----------------------------------------------------------
    const stage = api.stage;
    const R = this.extent;
    switch (shot.id) {
      case 'wide': {
        this._orbit += dt * 0.10;
        const d = R * 3.1;
        stage.setFreeView(
          Math.sin(this._orbit) * d, R * 1.05, Math.cos(this._orbit) * d,
          (heroX + victimX) * 0.5, 0.02, (heroZ + victimZ) * 0.5,
          42, 3.0,
        );
        break;
      }
      case 'pov': {
        // Ride 7 cm behind the barrel and 3 cm off the deck. At this range the
        // 12 mm near plane matters — anything larger clips into the pen.
        const back = 0.075, side = 0.028, height = 0.030;
        stage.setFreeView(
          heroX - dx * back - dz * side,
          height,
          heroZ - dz * back + dx * side,
          heroX + dx * 0.16, 0.012, heroZ + dz * 0.16,
          62, 9.0,
        );
        if (local < 0.02) stage.cutCamera();
        break;
      }
      case 'follow': {
        // Swing outboard of the victim so the drop is in frame behind it.
        const vr = Math.hypot(victimX, victimZ) || 1;
        const ox = victimX / vr, oz = victimZ / vr;
        const rise = 1 - local;
        stage.setFreeView(
          victimX + ox * R * 0.85, 0.10 + rise * 0.22, victimZ + oz * R * 0.85,
          victimX, -0.10 - (1 - rise) * 0.35, victimZ,
          52, 3.6,
        );
        if (local < 0.02) stage.cutCamera();
        break;
      }
      default: {
        this._orbit += dt * 0.16;
        const d = R * 2.4;
        stage.setFreeView(
          Math.sin(this._orbit) * d, R * 0.9, Math.cos(this._orbit) * d,
          0, 0.0, 0,
          46, 2.2,
        );
      }
    }
  }
}
