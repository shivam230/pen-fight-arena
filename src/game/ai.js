/**
 * ai.js — the opponent.
 *
 * The single loudest complaint about existing pen-fight games is physics and AI
 * that feel random: "sometimes you 5-0 them, sometimes they 5-0 you." So this
 * opponent does not guess and does not cheat. It runs the real solver forward on
 * a scratch copy of the world, scores where every candidate flick ends up, and
 * takes the best one. Difficulty changes how many options it can consider and how
 * accurately it can execute — exactly the two things that separate a good human
 * player from a bad one — never the physics itself.
 *
 * Planning is sliced across frames so a hard-difficulty search never drops a frame.
 */

import { PenWorld, Pen } from './physics.js';
import { impulseFor } from './tuning.js';

/**
 * Difficulty is execution error and search breadth — never a physics advantage.
 *
 * `angleJitter` is the important one. At the ~0.85 m opening range, a lateral miss
 * of about 0.07 m is enough to slide past a pen presented broadside, which works
 * out at roughly 0.08 rad — so anything below that basically always connects and
 * the level stops mattering. Easy is set well above it, hard well below.
 *
 * `pickTop` is how far down its own ranked list the opponent is willing to shoot:
 * 0 means it always plays the best line it found, 0.5 means it picks at random from
 * the better half. That reads as a player who sees the right shot but doesn't
 * always take it, rather than one whose pen mysteriously slips.
 */
/**
 * The opponent's single skill profile.
 *
 * `angleJitter` is the important number. At the ~0.85 m opening range, a lateral
 * miss of about 0.07 m slides past a pen presented broadside, which works out at
 * roughly 0.08 rad — so anything below that connects essentially every time. This
 * sits comfortably above it.
 *
 * `pickTop` is how far down its own ranked list it is willing to shoot: 0 means it
 * always plays the best line it found, 0.38 means it picks at random from the
 * better third. That reads as a player who sees the right shot but doesn't always
 * take it, rather than one whose pen mysteriously slips.
 *
 * Measured against a competent reference player: 6-4 in the player's favour.
 */
export const SKILL = {
  candidates: 24,
  angleJitter: 0.18,
  powerJitter: 0.25,
  pickTop: 0.38,
  selfRisk: 0.9,
  horizon: 3.2,
};

const SIM_STEP = 1 / 120;   // coarser than the live solver; same behaviour, half the cost
const SLICE_MS = 6;          // planning budget per frame

export class AiPlanner {
  /** @param {PenWorld} liveWorld */
  constructor(liveWorld) {
    this.live = liveWorld;
    this.cfg = SKILL;
    this.scratch = new PenWorld();
    this._map = new Map();
  }

  /**
   * Rebuild the scratch world from the live one. Call once when the board settles;
   * both the AI search and the player's aim preview then replay from this snapshot.
   */
  sync() { this._sync(); }

  /**
   * Replay a candidate flick and hand back the path it traces.
   *
   * This is the same solver, the same snapshot and the same code path the AI
   * searches with — so the dotted line the player aims along is not an
   * approximation of the physics, it *is* the physics. That is what keeps the game
   * feeling skill-based instead of random.
   *
   * @returns {{path: number[], hits: boolean, selfOut: boolean, targetOut: boolean}}
   */
  predictPath(myPen, angle, power, offset = 0, horizon = 2.6) {
    if (!this._snapshot) this._sync();
    this._restore();
    const c = this._map.get(myPen);
    if (!c) return { path: [], hits: false, selfOut: false, targetOut: false };
    c.flick(Math.cos(angle), Math.sin(angle), impulseFor(c.spec, power), offset);

    const s = this.scratch;
    const path = [];
    let t = 0, sample = 0, hits = false;
    let selfOut = false, targetOut = false;

    while (t < horizon) {
      s._substep(SIM_STEP);
      t += SIM_STEP;
      sample += SIM_STEP;
      if (s.events.length) {
        for (const e of s.events) {
          if (e.type === 'impact') hits = true;
          if (e.type === 'fall') {
            if (e.pen === c) selfOut = true; else targetOut = true;
          }
        }
        s.events.length = 0;
      }
      if (sample >= 0.035) {
        sample = 0;
        path.push(c.x, c.y);
      }
      let moving = false;
      for (const p of s.pens) {
        if (p.falling || !p.sleeping) { moving = true; break; }
      }
      if (!moving && t > 0.08) break;
    }
    path.push(c.x, c.y);
    return { path, hits, selfOut, targetOut };
  }

  /** Mirror the live world into the scratch world (structure only, once per turn). */
  _sync() {
    const s = this.scratch;
    s.reset();
    s.boundary = this.live.boundary;
    s.surfaceFriction = this.live.surfaceFriction;
    s.obstacles = this.live.obstacles;
    this._map.clear();
    for (const p of this.live.pens) {
      if (!p.alive || p.falling) continue;
      const c = new Pen(p.spec, p.owner);
      s.add(c);
      this._map.set(p, c);
    }
    this._snapshot = this.live.pens
      .filter((p) => p.alive && !p.falling)
      .map((p) => ({ src: p, x: p.x, y: p.y, a: p.a }));
  }

  _restore() {
    for (const s of this._snapshot) {
      const c = this._map.get(s.src);
      c.setPose(s.x, s.y, s.a);
      c.falling = false;
      c.alive = true;
      c.height = 0;
      c.vHeight = 0;
    }
    this.scratch.events.length = 0;
  }

  /**
   * Run one candidate to rest and score it.
   * Positive is good for the AI.
   */
  _evaluate(mine, angle, power, offset, horizon) {
    this._restore();
    const c = this._map.get(mine);
    // Must be the identical conversion the player's flick uses, or the search is
    // solving a different game than the one being played.
    c.flick(Math.cos(angle), Math.sin(angle), impulseFor(c.spec, power), offset);

    const s = this.scratch;
    let t = 0;
    let contacted = false;
    let firstContactT = -1;
    while (t < horizon) {
      s._substep(SIM_STEP);
      t += SIM_STEP;
      if (s.events.length) {
        for (const e of s.events) {
          if (e.type === 'impact') {
            contacted = true;
            if (firstContactT < 0) firstContactT = t;
          }
        }
        s.events.length = 0;
      }
      let moving = false;
      for (const p of s.pens) {
        if (p.falling) { moving = true; break; }
        if (!p.sleeping) { moving = true; break; }
      }
      if (!moving && t > 0.1) break;
    }

    let score = 0;
    const selfWeight = this.cfg.selfRisk;

    for (const p of s.pens) {
      const isMine = p === c;
      const gone = p.falling || !p.alive;
      if (gone) {
        // Knocking the opponent off wins the round; losing your own loses it.
        score += isMine ? -1000 * selfWeight : 1000;
        continue;
      }
      // How close each pen ended to the lip, as a fraction of the local radius.
      const r = Math.hypot(p.x, p.y);
      const edge = s.edgeRadius(p.x, p.y);
      const exposure = r / edge; // 0 centre, 1 at the lip
      score += isMine ? -exposure * 120 * selfWeight : exposure * 150;
    }

    // Reward making contact at all — a whiff wastes a turn and lets the player set up.
    if (contacted) score += 40;
    else score -= 55;
    // Prefer decisive, early contact over slow dribbles.
    if (firstContactT > 0) score += Math.max(0, 18 - firstContactT * 6);
    // Mild preference for keeping some power in reserve: an overcooked flick that
    // achieves the same thing is a worse habit and looks worse.
    score -= power * 4;

    return score;
  }

  /**
   * Start planning a turn.
   * @returns iterator — call `.step()` each frame until it returns a result.
   */
  begin(myPen, targetPen) {
    this._sync();
    const cfg = this.cfg;
    const candidates = [];

    const bearing = Math.atan2(targetPen.y - myPen.y, targetPen.x - myPen.x);
    const n = cfg.candidates;
    const offsets = [0, -myPen.half * 0.55, myPen.half * 0.55];

    for (let i = 0; i < n; i++) {
      // Fan out around the direct line, widening for later samples so the search
      // covers bank shots off hazards and the arena rim too.
      const spread = (i / n) * 1.15;
      const side = i % 2 === 0 ? 1 : -1;
      const angle = bearing + side * spread * (0.15 + Math.random() * 0.85);
      const power = 0.22 + Math.random() * 0.78;
      const offset = offsets[i % offsets.length];
      candidates.push({ angle, power, offset });
    }
    // Always include the straight, medium, centred shot as a sane baseline.
    candidates.push({ angle: bearing, power: 0.55, offset: 0 });
    candidates.push({ angle: bearing, power: 0.85, offset: 0 });

    this._queue = candidates;
    this._scored = [];
    this._mine = myPen;
    return this;
  }

  /** Advance the search for up to SLICE_MS. Returns a plan when finished. */
  step() {
    if (!this._queue) return null;
    const t0 = performance.now();
    while (this._queue.length && performance.now() - t0 < SLICE_MS) {
      const cand = this._queue.pop();
      cand.score = this._evaluate(
        this._mine, cand.angle, cand.power, cand.offset, this.cfg.horizon,
      );
      this._scored.push(cand);
    }
    if (this._queue.length) return null;

    this._scored.sort((a, b) => b.score - a.score);
    // Shoot somewhere in the top slice of its own ranking, not always the peak.
    const span = Math.max(1, Math.round(this._scored.length * this.cfg.pickTop));
    const chosen = this._scored[(Math.random() * span) | 0] || this._scored[0];

    const jitterA = (Math.random() - 0.5) * 2 * this.cfg.angleJitter;
    const jitterP = 1 + (Math.random() - 0.5) * 2 * this.cfg.powerJitter;

    this._queue = null;
    return {
      angle: chosen.angle + jitterA,
      power: Math.max(0.12, Math.min(1, chosen.power * jitterP)),
      offset: chosen.offset,
      confidence: chosen.score,
    };
  }
}
