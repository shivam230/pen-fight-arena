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
/**
 * How much of an off-centre strike's theoretical torque actually lands.
 * See Pen.flick — a fingertip is not a point, and it slips.
 */
const STRIKE_COUPLING = 0.34;

/**
 * Sequential-impulse iterations per contact pair per substep, for the live world.
 *
 * The AI's scratch world overrides this down (see ai.js): its search runs
 * thousands of simulated substeps per turn and only needs outcomes that are
 * approximately right, whereas the world the player watches needs to look
 * correct. Charging full fidelity for both is what made the opponent's thinking
 * pause janky.
 */
const SOLVER_ITERATIONS = 6;
/** Closing speed below which a bounce is just jitter (m/s). */
const RESTITUTION_SLOP = 0.12;

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

  /**
   * Apply a flick: an impulse of `power` N·s delivered `offset` metres along the
   * barrel from the centre.
   *
   * The lever arm is deliberately scaled by STRIKE_COUPLING. Treating a finger as
   * a mathematical point delivering a pure impulse to a thin rod is textbook-
   * correct and completely wrong in practice: a 5 g pen has a moment of inertia of
   * ~9e-6 kg m², so a hard strike at the very end came out at 15 revolutions per
   * second. A real fingertip is a wide, soft contact that slips across the barrel
   * as it goes, so only part of the theoretical angular impulse ever lands. The
   * scale brings an end-strike to ~5 rev/s, which is what a pen actually does.
   *
   * The linear impulse is untouched — only the spin is moderated.
   */
  flick(dirX, dirY, power, offset = 0) {
    const jx = dirX * power;
    const jy = dirY * power;
    const lever = offset * STRIKE_COUPLING;
    const rx = Math.cos(this.a) * lever;
    const ry = Math.sin(this.a) * lever;
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
    this.solverIterations = SOLVER_ITERATIONS;
    this.events = [];
    this._accum = 0;
    this._segA = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this._segB = { x0: 0, y0: 0, x1: 0, y1: 0 };
    // Preallocated contact manifold — at most two points for a capsule pair.
    this._contacts = [0, 1].map(() => ({
      x: 0, y: 0, rax: 0, ray: 0, rbx: 0, rby: 0,
      crossAN: 0, crossBN: 0, crossAT: 0, crossBT: 0,
      massN: 0, massT: 0, pn: 0, pt: 0, bias: 0,
    }));
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

  /**
   * Build the contact manifold for two capsules.
   *
   * A single contact point is correct for a tip-first or crossed hit, but it is
   * WRONG for the most common strike in the game: two barrels meeting broadside,
   * near-parallel. Resolving that at one point lets the struck pen pivot around
   * that point instead of being driven away bodily — which is exactly why a square
   * hit used to feel mushy and under-powered.
   *
   * When the two barrels are within ~17 degrees of parallel and genuinely overlap
   * along their length, the contact is generated at BOTH ends of the overlapping
   * span. The momentum then arrives across the whole contact patch, the way it
   * does when two pens actually slap together.
   *
   * @returns {number} how many contacts were written into `this._contacts`
   */
  _buildManifold(a, b, nx, ny, pen, fallbackX, fallbackY) {
    const c = this._contacts;
    const cax = Math.cos(a.a), cay = Math.sin(a.a);
    const cbx = Math.cos(b.a), cby = Math.sin(b.a);

    // sin of the angle between the barrels
    const skew = Math.abs(cax * cby - cay * cbx);
    if (skew < 0.30 && a.half > 1e-4) {
      // Project B's endpoints onto A's axis and clip to A's extent.
      const b0x = b.x - cbx * b.half, b0y = b.y - cby * b.half;
      const b1x = b.x + cbx * b.half, b1y = b.y + cby * b.half;
      let t0 = (b0x - a.x) * cax + (b0y - a.y) * cay;
      let t1 = (b1x - a.x) * cax + (b1y - a.y) * cay;
      if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
      t0 = Math.max(-a.half, t0);
      t1 = Math.min(a.half, t1);

      // Only worth two points if the shared span is a real patch, not a nick.
      if (t1 - t0 > a.half * 0.35) {
        // Sit the points mid-way through the overlap depth.
        const push = a.rad - pen * 0.5;
        c[0].x = a.x + cax * t0 + nx * push;
        c[0].y = a.y + cay * t0 + ny * push;
        c[1].x = a.x + cax * t1 + nx * push;
        c[1].y = a.y + cay * t1 + ny * push;
        return 2;
      }
    }

    c[0].x = fallbackX;
    c[0].y = fallbackY;
    return 1;
  }

  /**
   * Resolve a pen-pen collision with sequential impulses over the manifold.
   *
   * Iterating (rather than one shot) matters once there are two contacts: solving
   * them independently in a single pass double-counts, and the pen squirts out
   * sideways. Accumulated impulses are clamped to stay non-negative so a contact
   * can never pull the pens together, and restitution is captured from the
   * approach velocity ONCE up front — recomputing it per iteration injects energy
   * and makes everything faintly bouncy.
   */
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
    const count = this._buildManifold(
      a, b, nx, ny, pen,
      (_cp.ax + _cp.bx) * 0.5, (_cp.ay + _cp.by) * 0.5,
    );

    const totalInv = a.invMass + b.invMass;
    const muC = (a.muContact + b.muContact) * 0.5;
    const e = Math.min(a.restitution, b.restitution);
    const contacts = this._contacts;

    // --- prepare: arms, effective masses, restitution bias -------------------
    let approach = 0;
    for (let i = 0; i < count; i++) {
      const k = contacts[i];
      k.rax = k.x - a.x; k.ray = k.y - a.y;
      k.rbx = k.x - b.x; k.rby = k.y - b.y;
      k.pn = 0; k.pt = 0;

      k.crossAN = k.rax * ny - k.ray * nx;
      k.crossBN = k.rbx * ny - k.rby * nx;
      k.massN = totalInv
        + k.crossAN * k.crossAN * a.invI
        + k.crossBN * k.crossBN * b.invI;

      const tx = -ny, ty = nx;
      k.crossAT = k.rax * ty - k.ray * tx;
      k.crossBT = k.rbx * ty - k.rby * tx;
      k.massT = totalInv
        + k.crossAT * k.crossAT * a.invI
        + k.crossBT * k.crossBT * b.invI;

      const vax = a.vx - a.w * k.ray, vay = a.vy + a.w * k.rax;
      const vbx = b.vx - b.w * k.rby, vby = b.vy + b.w * k.rbx;
      const vn = (vbx - vax) * nx + (vby - vay) * ny;
      if (vn < approach) approach = vn;
      // Below the slop a bounce is indistinguishable from jitter, so drop it.
      k.bias = vn < -RESTITUTION_SLOP ? e * vn : 0;
    }

    if (approach >= 0) {
      this._separate(a, b, nx, ny, pen, totalInv);
      return;
    }

    // --- solve ---------------------------------------------------------------
    const tx = -ny, ty = nx;
    const iterations = this.solverIterations;
    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < count; i++) {
        const k = contacts[i];

        // normal
        let vax = a.vx - a.w * k.ray, vay = a.vy + a.w * k.rax;
        let vbx = b.vx - b.w * k.rby, vby = b.vy + b.w * k.rbx;
        const vn = (vbx - vax) * nx + (vby - vay) * ny;
        let dPn = -(vn + k.bias) / k.massN;
        const oldPn = k.pn;
        k.pn = Math.max(0, oldPn + dPn);
        dPn = k.pn - oldPn;
        a.vx -= dPn * nx * a.invMass; a.vy -= dPn * ny * a.invMass;
        a.w -= k.crossAN * dPn * a.invI;
        b.vx += dPn * nx * b.invMass; b.vy += dPn * ny * b.invMass;
        b.w += k.crossBN * dPn * b.invI;

        // friction, Coulomb-clamped against the impulse accumulated so far.
        // This is what turns a glancing blow into spin instead of a clean shove.
        vax = a.vx - a.w * k.ray; vay = a.vy + a.w * k.rax;
        vbx = b.vx - b.w * k.rby; vby = b.vy + b.w * k.rbx;
        const vt = (vbx - vax) * tx + (vby - vay) * ty;
        let dPt = -vt / k.massT;
        const maxPt = muC * k.pn;
        const oldPt = k.pt;
        k.pt = Math.max(-maxPt, Math.min(maxPt, oldPt + dPt));
        dPt = k.pt - oldPt;
        a.vx -= dPt * tx * a.invMass; a.vy -= dPt * ty * a.invMass;
        a.w -= k.crossAT * dPt * a.invI;
        b.vx += dPt * tx * b.invMass; b.vy += dPt * ty * b.invMass;
        b.w += k.crossBT * dPt * b.invI;
      }
    }

    this._separate(a, b, nx, ny, pen, totalInv);

    a.wake(); b.wake();
    let total = 0;
    for (let i = 0; i < count; i++) total += contacts[i].pn;
    this.events.push({
      type: 'impact',
      x: contacts[0].x, y: contacts[0].y,
      strength: Math.min(1, -approach / 3.2),
      normalSpeed: -approach,
      impulse: total,
      contacts: count,
      a, b,
    });
  }

  /** Split the overlap between the two bodies by inverse mass. */
  _separate(a, b, nx, ny, pen, totalInv) {
    const corr = (pen / totalInv) * 0.8;
    a.x -= nx * corr * a.invMass; a.y -= ny * corr * a.invMass;
    b.x += nx * corr * b.invMass; b.y += ny * corr * b.invMass;
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
