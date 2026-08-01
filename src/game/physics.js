/**
 * physics.js — deterministic 2D rigid-body solver for pens sliding on a flat arena.
 *
 * A pen lying on a surface is, from above, a capsule: a segment of half-length
 * `half` swept by radius `rad`. Solving in 2D (world XZ) instead of full 3D keeps
 * the whole sim at a few microseconds a frame on a phone, while still giving the
 * things that make pen fight feel right: spin transfer, glancing deflections,
 * length-vs-sideways drag, and pens that pivot when hit off-centre.
 *
 * Axis convention: `x` is world X, `y` is world Z. `a` is the heading angle, so the
 * pen's tip direction is (cos a, sin a). `w` is angular velocity about world Y.
 */

const SUBSTEP = 1 / 240; // fixed step — stable capsule stacking at flick speeds
const MAX_SUBSTEPS = 8;
const SLEEP_LIN = 0.012; // m/s
const SLEEP_ANG = 0.10; // rad/s
const SLEEP_TIME = 0.16; // s below thresholds before we call it settled
const GRAVITY = 9.81;
const FRICTION_SAMPLES = 5; // points along the barrel where surface drag is applied

/**
 * The rim is grippier than the field.
 *
 * This is the main thing keeping a rally alive. Without it any pen that crossed
 * the arena kept its speed all the way to the lip, so most exchanges ended on the
 * second or third flick. With it, the outer band bleeds speed hard: a pen that
 * merely drifts out there stops and stays in play, while a genuinely hard, direct
 * hit still punches straight through. Knockouts have to be earned rather than
 * stumbled into.
 *
 * Physically it reads as weathered, grit-covered rock at the edge, and the
 * plateau is shaded to match so the band is visible.
 */
const RIM_START = 0.70;   // fraction of the local radius where the drag begins
const RIM_GRIP = 3.4;     // friction multiplier at the very lip

/** Closest points between segments A(a0->a1) and B(b0->b1). Writes into `out`. */
function closestSegmentPoints(a0x, a0y, a1x, a1y, b0x, b0y, b1x, b1y, out) {
  const dax = a1x - a0x, day = a1y - a0y;
  const dbx = b1x - b0x, dby = b1y - b0y;
  const rx = a0x - b0x, ry = a0y - b0y;
  const A = dax * dax + day * day;
  const E = dbx * dbx + dby * dby;
  const F = dbx * rx + dby * ry;

  let s = 0, t = 0;
  if (A <= 1e-12 && E <= 1e-12) {
    // both degenerate
  } else if (A <= 1e-12) {
    t = Math.min(1, Math.max(0, F / E));
  } else {
    const C = dax * rx + day * ry;
    if (E <= 1e-12) {
      s = Math.min(1, Math.max(0, -C / A));
    } else {
      const B = dax * dbx + day * dby;
      const denom = A * E - B * B;
      s = denom > 1e-12 ? Math.min(1, Math.max(0, (B * F - C * E) / denom)) : 0;
      t = (B * s + F) / E;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -C / A));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (B - C) / A));
      }
    }
  }
  out.ax = a0x + dax * s;
  out.ay = a0y + day * s;
  out.bx = b0x + dbx * t;
  out.by = b0y + dby * t;
}

const _cp = { ax: 0, ay: 0, bx: 0, by: 0 };

export class Pen {
  /**
   * @param {object} spec  entry from the pen catalog (see pens.js)
   * @param {string} owner 'player' | 'cpu'
   */
  constructor(spec, owner) {
    this.spec = spec;
    this.owner = owner;
    this.id = `${owner}:${spec.id}`;

    this.len = spec.lengthMm / 1000;
    this.rad = spec.diameterMm / 2000;
    this.half = Math.max(0.002, this.len / 2 - this.rad);
    this.mass = spec.massG / 1000;
    // Thin rod about its centre. Real pens are close enough to uniform.
    this.inertia = (this.mass * this.len * this.len) / 12;
    this.invMass = 1 / this.mass;
    this.invI = 1 / this.inertia;

    this.restitution = spec.bounce;
    this.muSurface = spec.glide; // coefficient against the arena surface
    this.muContact = 0.28; // plastic-on-plastic tangential friction

    this.x = 0; this.y = 0; this.a = 0;
    this.vx = 0; this.vy = 0; this.w = 0;

    this.alive = true;
    this.sleeping = true;
    this.sleepTimer = 0;

    // Off-the-edge state, integrated separately from the planar solver.
    this.falling = false;
    this.height = 0;      // metres below the arena surface (positive = below)
    this.vHeight = 0;
    this.tumble = 0;      // pitch/roll used only by the renderer
    this.tumbleRate = 0;
    this.fallTime = 0;
  }

  setPose(x, y, a) {
    this.x = x; this.y = y; this.a = a;
    this.vx = this.vy = this.w = 0;
    this.sleeping = true;
    this.sleepTimer = SLEEP_TIME;
  }

  /** World-space endpoints of the capsule core segment. */
  endpoints(out) {
    const c = Math.cos(this.a) * this.half;
    const s = Math.sin(this.a) * this.half;
    out.x0 = this.x - c; out.y0 = this.y - s;
    out.x1 = this.x + c; out.y1 = this.y + s;
    return out;
  }

  speed() {
    return Math.hypot(this.vx, this.vy);
  }

  wake() {
    this.sleeping = false;
    this.sleepTimer = 0;
  }

  /** Apply a flick: an impulse of `power` N·s at a point `offset` metres along the barrel. */
  flick(dirX, dirY, power, offset = 0) {
    const jx = dirX * power;
    const jy = dirY * power;
    const rx = Math.cos(this.a) * offset;
    const ry = Math.sin(this.a) * offset;
    this.vx += jx * this.invMass;
    this.vy += jy * this.invMass;
    this.w += (rx * jy - ry * jx) * this.invI;
    this.wake();
  }
}

/** Static round obstacle bolted to the arena (a boulder, a bolt head, a crystal). */
export class Obstacle {
  constructor(x, y, radius, bounce = 0.55) {
    this.x = x; this.y = y; this.radius = radius; this.bounce = bounce;
  }
}

export class PenWorld {
  constructor() {
    /** @type {Pen[]} */ this.pens = [];
    /** @type {Obstacle[]} */ this.obstacles = [];
    /** Arena boundary as a radial function of angle; set by the arena generator. */
    this.boundary = () => 1.2;
    this.surfaceFriction = 1.0; // arena-wide multiplier (ice < stone < wet rock)
    this.events = [];
    this._accum = 0;
    this._segA = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this._segB = { x0: 0, y0: 0, x1: 0, y1: 0 };
  }

  add(pen) { this.pens.push(pen); return pen; }

  reset() {
    this.pens.length = 0;
    this.obstacles.length = 0;
    this.events.length = 0;
    this._accum = 0;
  }

  /** True when every pen is asleep or gone — i.e. the turn is over. */
  isSettled() {
    for (const p of this.pens) {
      if (p.alive && !p.sleeping) return false;
      if (p.falling && p.fallTime < 1.4) return false;
    }
    return true;
  }

  /** Distance from the arena centre to the edge along the direction of (x, y). */
  edgeRadius(x, y) {
    return this.boundary(Math.atan2(y, x));
  }

  step(dt) {
    this._accum += Math.min(dt, 0.1);
    let n = 0;
    while (this._accum >= SUBSTEP && n < MAX_SUBSTEPS) {
      this._substep(SUBSTEP);
      this._accum -= SUBSTEP;
      n++;
    }
    if (n === MAX_SUBSTEPS) this._accum = 0; // don't spiral on a slow frame
  }

  _substep(h) {
    const pens = this.pens;

    for (let i = 0; i < pens.length; i++) {
      const p = pens[i];
      if (p.falling) { this._integrateFall(p, h); continue; }
      if (!p.alive || p.sleeping) continue;
      this._integrateSurface(p, h);
    }

    // Pen ↔ pen
    for (let i = 0; i < pens.length; i++) {
      const a = pens[i];
      if (!a.alive || a.falling) continue;
      for (let j = i + 1; j < pens.length; j++) {
        const b = pens[j];
        if (!b.alive || b.falling) continue;
        if (a.sleeping && b.sleeping) continue;
        this._collidePens(a, b);
      }
    }

    // Pen ↔ obstacle
    for (let i = 0; i < pens.length; i++) {
      const p = pens[i];
      if (!p.alive || p.falling || p.sleeping) continue;
      for (let k = 0; k < this.obstacles.length; k++) {
        this._collideObstacle(p, this.obstacles[k]);
      }
    }

    // Edge test — a rigid body tips once its centre of mass clears the lip.
    for (let i = 0; i < pens.length; i++) {
      const p = pens[i];
      if (!p.alive || p.falling) continue;
      const r = Math.hypot(p.x, p.y);
      if (r > this.edgeRadius(p.x, p.y)) this._beginFall(p);
    }
  }

  _integrateSurface(p, h) {
    // Surface drag sampled along the barrel. Sampling (rather than a single force
    // at the centre of mass) is what makes a spinning pen bleed spin, and what makes
    // a pen shoved sideways stop faster than one shot along its own axis.
    let rim = 1;
    const r = Math.hypot(p.x, p.y);
    if (r > 1e-6) {
      const t = r / this.edgeRadius(p.x, p.y);
      if (t > RIM_START) {
        rim = 1 + Math.min(1, (t - RIM_START) / (1 - RIM_START)) * (RIM_GRIP - 1);
      }
    }
    const mu = p.muSurface * this.surfaceFriction * rim;
    const decel = mu * GRAVITY;
    const share = 1 / FRICTION_SAMPLES;
    const ca = Math.cos(p.a), sa = Math.sin(p.a);

    let fx = 0, fy = 0, torque = 0;
    for (let k = 0; k < FRICTION_SAMPLES; k++) {
      const t = (k / (FRICTION_SAMPLES - 1) - 0.5) * 2 * p.half; // -half..+half
      const rx = ca * t, ry = sa * t;
      const px = p.vx - p.w * ry;
      const py = p.vy + p.w * rx;
      const sp = Math.hypot(px, py);
      if (sp < 1e-6) continue;
      // Impulse this sample can deliver, capped so it can never reverse the motion.
      const mag = Math.min(decel * share, sp / h * share);
      const ax = (-px / sp) * mag;
      const ay = (-py / sp) * mag;
      fx += ax; fy += ay;
      torque += (rx * ay - ry * ax) * p.mass;
    }

    p.vx += fx * h;
    p.vy += fy * h;
    p.w += (torque * p.invI) * h;
    // A touch of extra spin damping: real pens do not pirouette for long.
    p.w *= 1 - Math.min(0.9, 2.2 * mu * h);

    p.x += p.vx * h;
    p.y += p.vy * h;
    p.a += p.w * h;

    if (p.speed() < SLEEP_LIN && Math.abs(p.w) < SLEEP_ANG) {
      p.sleepTimer += h;
      if (p.sleepTimer >= SLEEP_TIME) {
        p.sleeping = true;
        p.vx = p.vy = p.w = 0;
      }
    } else {
      p.sleepTimer = 0;
    }
  }

  _integrateFall(p, h) {
    p.fallTime += h;
    p.vHeight += GRAVITY * h;
    p.height += p.vHeight * h;
    p.x += p.vx * h;
    p.y += p.vy * h;
    p.a += p.w * h;
    p.tumble += p.tumbleRate * h;
    p.vx *= 1 - 0.35 * h; // air drag, mostly for looks
    p.vy *= 1 - 0.35 * h;
    if (p.fallTime > 1.4 && p.alive) {
      p.alive = false;
      this.events.push({ type: 'lost', pen: p });
    }
  }

  _beginFall(p) {
    p.falling = true;
    p.fallTime = 0;
    p.height = 0;
    p.vHeight = 0.15;
    // Tip over the lip: the overhanging end drops first, so it pitches forward.
    p.tumbleRate = 3.2 + Math.random() * 5.5 + Math.abs(p.w) * 0.4;
    if (Math.random() < 0.5) p.tumbleRate *= -1;
    p.w *= 0.6;
    this.events.push({
      type: 'fall', pen: p, x: p.x, y: p.y,
      speed: p.speed(),
    });
  }

  _collidePens(a, b) {
    const A = a.endpoints(this._segA);
    const B = b.endpoints(this._segB);
    closestSegmentPoints(A.x0, A.y0, A.x1, A.y1, B.x0, B.y0, B.x1, B.y1, _cp);

    let nx = _cp.bx - _cp.ax;
    let ny = _cp.by - _cp.ay;
    let dist = Math.hypot(nx, ny);
    const minDist = a.rad + b.rad;
    if (dist >= minDist) return;

    if (dist < 1e-9) {
      // Perfectly coincident — push apart along an arbitrary but stable axis.
      nx = Math.cos(a.a + Math.PI / 2); ny = Math.sin(a.a + Math.PI / 2); dist = 1e-9;
    } else {
      nx /= dist; ny /= dist;
    }

    const pen = minDist - dist;
    const cx = (_cp.ax + _cp.bx) * 0.5;
    const cy = (_cp.ay + _cp.by) * 0.5;

    const rax = cx - a.x, ray = cy - a.y;
    const rbx = cx - b.x, rby = cy - b.y;

    const vax = a.vx - a.w * ray, vay = a.vy + a.w * rax;
    const vbx = b.vx - b.w * rby, vby = b.vy + b.w * rbx;
    const rvx = vbx - vax, rvy = vby - vay;
    const vn = rvx * nx + rvy * ny;

    // Positional correction always runs; impulse only if closing.
    const totalInv = a.invMass + b.invMass;
    const corr = (pen / totalInv) * 0.8;
    a.x -= nx * corr * a.invMass; a.y -= ny * corr * a.invMass;
    b.x += nx * corr * b.invMass; b.y += ny * corr * b.invMass;

    if (vn > 0) return;

    const crossA = rax * ny - ray * nx;
    const crossB = rbx * ny - rby * nx;
    const denom = totalInv + crossA * crossA * a.invI + crossB * crossB * b.invI;
    const e = Math.min(a.restitution, b.restitution);
    const j = -(1 + e) * vn / denom;

    a.vx -= j * nx * a.invMass; a.vy -= j * ny * a.invMass;
    a.w -= crossA * j * a.invI;
    b.vx += j * nx * b.invMass; b.vy += j * ny * b.invMass;
    b.w += crossB * j * b.invI;

    // Tangential friction — this is what converts an off-centre hit into spin.
    let tx = -ny, ty = nx;
    const vt = rvx * tx + rvy * ty;
    if (Math.abs(vt) > 1e-5) {
      const crossAT = rax * ty - ray * tx;
      const crossBT = rbx * ty - rby * tx;
      const denomT = totalInv + crossAT * crossAT * a.invI + crossBT * crossBT * b.invI;
      const muC = (a.muContact + b.muContact) * 0.5;
      let jt = -vt / denomT;
      jt = Math.max(-muC * j, Math.min(muC * j, jt));
      a.vx -= jt * tx * a.invMass; a.vy -= jt * ty * a.invMass;
      a.w -= crossAT * jt * a.invI;
      b.vx += jt * tx * b.invMass; b.vy += jt * ty * b.invMass;
      b.w += crossBT * jt * b.invI;
    }

    a.wake(); b.wake();
    this.events.push({
      type: 'impact', x: cx, y: cy,
      strength: Math.min(1, -vn / 3.2),
      normalSpeed: -vn,
      a, b,
    });
  }

  _collideObstacle(p, o) {
    const S = p.endpoints(this._segA);
    closestSegmentPoints(S.x0, S.y0, S.x1, S.y1, o.x, o.y, o.x, o.y, _cp);
    let nx = o.x - _cp.ax, ny = o.y - _cp.ay;
    let dist = Math.hypot(nx, ny);
    const minDist = p.rad + o.radius;
    if (dist >= minDist) return;
    if (dist < 1e-9) { nx = 1; ny = 0; dist = 1e-9; } else { nx /= dist; ny /= dist; }

    const pen = minDist - dist;
    p.x -= nx * pen; p.y -= ny * pen;

    const cx = _cp.ax, cy = _cp.ay;
    const rax = cx - p.x, ray = cy - p.y;
    const vax = p.vx - p.w * ray, vay = p.vy + p.w * rax;
    const vn = -(vax * nx + vay * ny);
    if (vn > 0) return;

    const crossA = rax * ny - ray * nx;
    const denom = p.invMass + crossA * crossA * p.invI;
    const j = -(1 + o.bounce) * vn / denom;
    p.vx += j * nx * p.invMass; p.vy += j * ny * p.invMass;
    p.w += crossA * j * p.invI;
    p.wake();

    this.events.push({
      type: 'obstacle', x: cx, y: cy,
      strength: Math.min(1, -vn / 3.0), pen: p,
    });
  }

  drainEvents() {
    const e = this.events.slice();
    this.events.length = 0;
    return e;
  }
}

export { GRAVITY, RIM_START, RIM_GRIP };
