/**
 * match.js — the game itself: rules, turn flow, input, and the glue between the
 * solver, the renderer and the audio engine.
 *
 * Rules follow the folk game as it is actually played, with the two conventions
 * that exist specifically to keep it fair:
 *   · the opening flick of a round cannot eliminate anybody (no lucky first bomb)
 *   · both pens off on the same turn is a draw, and the round is replayed
 * On top of that, two additions that fix the failure modes of the digital versions:
 *   · a crumbling ledge, so two pens can never circle each other forever
 *   · overcharge — power past the safe mark is genuinely stronger AND genuinely
 *     more likely to carry your own pen over the lip. No randomness, just physics.
 */

import * as THREE from 'three';
import { PenWorld, Pen } from './physics.js';
import { PENS, PEN_BY_ID } from './pens.js';
import { AiPlanner } from './ai.js';
import { buildArena } from '../render/arena.js';
import { glowPoints } from '../render/fx.js';
import { buildPen, buildContactShadow, restHeight } from '../render/penMesh.js';
import { BIOMES } from '../render/biomes.js';
import { audio } from '../audio/sfx.js';
import { impulseFor, OVERCHARGE_AT } from './tuning.js';
import { TurnRecorder, ReplayDirector } from './replay.js';
import { hapticImpact, hapticKnockout } from '../platform/native.js';

const ROUNDS_TO_WIN = 2;         // best of three

/**
 * The ledge starts closing in after this many turns in a round.
 *
 * Previously this counted only turns WITHOUT contact, and any hit reset it. Now
 * that the grippy rim keeps pens on the deck, two players can trade blows
 * indefinitely without either going over — so a contact-reset timer would never
 * fire and the round would never end. Counting total turns instead gives a round a
 * shape: open, rally, then the arena forces a decision.
 */
const CRUMBLE_AFTER_TURNS = 8;
const CRUMBLE_PER_TURN = 0.94;
const MIN_SHRINK = 0.30;

/**
 * Absolute ceiling on a round.
 *
 * The crumble alone is not a guarantee: two well-matched pens on a grippy rim can
 * trade hits forever, and a shrink floor would let that run indefinitely. At the
 * cap the round goes to whoever is holding the middle, which is both a legible
 * rule and the thing good play was already aiming at.
 */
const MAX_TURNS_PER_ROUND = 24;
const AIM_MAX_POINTS = 220;

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _aimColor = new THREE.Color();

export const STATE = {
  LOADING: 'loading',
  LOADOUT: 'loadout',
  INTRO: 'intro',
  AIM: 'aim',
  RESOLVE: 'resolve',
  CPU_THINK: 'cpu-think',
  CPU_RESOLVE: 'cpu-resolve',
  REPLAY: 'replay',
  ROUND_OVER: 'round-over',
  MATCH_OVER: 'match-over',
};

export class Match {
  constructor(stage, opts = {}) {
    this.stage = stage;
    this.world = new PenWorld();
    this.state = STATE.LOADING;
    this.listeners = {};

    this.playerSpecId = opts.playerPen;
    this.cpuSpecId = opts.cpuPen;

    // One fixed skill level — see SKILL in ai.js.
    this.ai = new AiPlanner(this.world);
    this.recorder = new TurnRecorder(2);
    this.replay = null;
    this.score = { player: 0, cpu: 0 };
    this.roundNumber = 0;
    this.cleanKnocks = { player: 0, cpu: 0 };

    this.visuals = new Map();     // Pen -> { pen, shadow }
    this._aimLine = null;
    this._aimGhost = null;
    this._buildAimHelpers();

    this._drag = null;
    this._predictThrottle = 0;
    this._pendingPredict = false;
    this._timer = 0;
    this._settleGrace = 0;
    this._shrink = 1;
    this._turnInRound = 0;
    this._flickerThisTurn = null;
    this._selfWasSafe = true;
    this._slowmo = 0;
    this._knockPoint = null;
  }

  on(evt, fn) {
    (this.listeners[evt] ||= []).push(fn);
    return this;
  }

  emit(evt, payload) {
    (this.listeners[evt] || []).forEach((f) => f(payload));
  }

  // ---------------------------------------------------------------- setup ---

  /** Build a fresh arena + biome. Returns the biome so the UI can name it. */
  async newMatch(seed = (Math.random() * 1e9) | 0) {
    // Building an arena is async (shader warmup). Two overlapping calls would each
    // spawn a set of pens and leave the losers orphaned in the scene, so refuse
    // to start a second build while one is in flight.
    if (this._building) return this._building;
    this._building = this._buildMatch(seed);
    try {
      return await this._building;
    } finally {
      this._building = null;
    }
  }

  async _buildMatch(seed) {
    this.seed = seed;
    this.biome = BIOMES[seed % BIOMES.length];
    this.score = { player: 0, cpu: 0 };
    this.cleanKnocks = { player: 0, cpu: 0 };
    this.roundNumber = 0;

    this.world.reset();
    await this.stage.setBiome(this.biome, seed);
    this.arena = buildArena(seed, this.biome, this.world);
    this.stage.setArena(this.arena);
    this._baseBoundary = this.arena.boundary;
    this._baseObstacles = this.world.obstacles.map((o) => ({
      x: o.x, y: o.y, radius: o.radius,
    }));

    this._spawnPens();
    await this.stage.warmup();

    audio.setAmbient(this.biome.ambient);
    // Bigger, brighter spaces get a longer tail; the rooftop is tight and damped.
    const space = {
      dhauladhar: [2.6, 0.85, 0.34], caldera: [2.0, 0.45, 0.30],
      terrace: [1.1, 0.6, 0.22], serac: [3.2, 0.95, 0.38],
    }[this.biome.id] || [1.8, 0.8, 0.3];
    audio.setSpace(space[0], space[1], space[2]);

    this.state = STATE.INTRO;
    this._timer = 0;
    this.emit('biome', this.biome);
    return this.biome;
  }

  /**
   * Park the built match so the loadout screen can use its arena as a live
   * backdrop. The pens are hidden — the showcase pen is the subject there.
   */
  holdForLoadout() {
    this.state = STATE.LOADOUT;
    for (const v of this.visuals.values()) {
      v.built.group.visible = false;
      v.shadow.visible = false;
      v.marker.visible = false;
    }
  }

  /** Hand the scene over to an actual match. */
  beginPlay() {
    for (const v of this.visuals.values()) {
      v.built.group.visible = true;
      v.shadow.visible = true;
      v.marker.visible = true;
    }
    this.state = STATE.INTRO;
    this._timer = 0;
  }

  /**
   * Ground ring under a pen. Two jobs: tell you at a glance which pen is yours
   * (gold) and which is the rival's (red), and pulse on whoever is on turn. A
   * white pen on pale granite is otherwise genuinely hard to find.
   */
  _buildMarker(owner) {
    const geo = new THREE.RingGeometry(0.052, 0.070, 40);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: owner === 'player' ? 0x24e8c6 : 0xff4655,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    return mesh;
  }

  _spawnPens() {
    for (const v of this.visuals.values()) {
      this.stage.scene.remove(v.built.group);
      this.stage.scene.remove(v.shadow);
      this.stage.scene.remove(v.marker);
      v.marker.geometry.dispose();
      v.marker.material.dispose();
      v.built.dispose();
    }
    this.visuals.clear();

    const quality = { transmission: this.stage.qualityTransmission !== false };
    const mk = (specId, owner) => {
      const spec = this._specById(specId);
      const pen = new Pen(spec, owner);
      const built = buildPen(spec, quality);
      const shadow = buildContactShadow(spec);
      const marker = this._buildMarker(owner);
      this.stage.scene.add(built.group);
      this.stage.scene.add(shadow);
      this.stage.scene.add(marker);
      this.world.add(pen);
      this.visuals.set(pen, { built, shadow, marker, rest: restHeight(spec) });
      return pen;
    };

    this.playerPen = mk(this.playerSpecId, 'player');
    this.cpuPen = mk(this.cpuSpecId, 'cpu');
    this._placeForRound();
  }

  _specById(id) {
    return PEN_BY_ID[id] || PENS[0];
  }

  _placeForRound() {
    // Opening positions face each other across the arena's flat approach face, so
    // the first exchange is always readable rather than a lucky diagonal.
    const axis = this.arena.faceAngle;
    const player = this.roundNumber % 2 === 0 ? axis : axis + Math.PI;
    const cpu = player + Math.PI;

    const place = (pen, theta) => {
      // Well inboard of the grippy rim: the opening should be a rally, not a
      // pair of pens already teetering on the edge.
      const R = this.world.boundary(theta) * 0.56;
      // Lie across the line of attack — the way you actually set a pen down.
      pen.setPose(Math.cos(theta) * R, Math.sin(theta) * R, theta + Math.PI / 2);
      pen.alive = true;
      pen.falling = false;
      pen.height = 0;
      pen.vHeight = 0;
      pen.tumble = 0;
      const v = this.visuals.get(pen);
      if (v) {
        v.built.group.visible = true;
        v.shadow.visible = true;
      }
    };
    place(this.playerPen, player);
    place(this.cpuPen, cpu);
    this._syncVisuals(0);
  }

  // ----------------------------------------------------------- round flow ---

  startRound() {
    this.roundNumber++;
    this._turnInRound = 0;
    this._setShrink(1);
    this._placeForRound();
    // The player who did NOT open last round opens this one.
    this._turnOwner = this.roundNumber % 2 === 1 ? 'player' : 'cpu';
    this.emit('round', {
      round: this.roundNumber, score: this.score, opener: this._turnOwner,
    });
    this._beginTurn();
  }

  _beginTurn() {
    this._knockPoint = null;
    this._slowmo = 0;
    this.world.drainEvents();
    this.ai.sync();
    if (this._turnOwner === 'player') {
      this.state = STATE.AIM;
      this.emit('turn', { owner: 'player', turn: this._turnInRound });
    } else {
      this.state = STATE.CPU_THINK;
      this._timer = 0;
      this._readyPlan = null;
      // Its own first flick of the round is played as a positioning move.
      this._plan = this.ai.begin(this.cpuPen, this.playerPen, this._turnInRound <= 1);
      this.emit('turn', { owner: 'cpu', turn: this._turnInRound });
    }
  }

  _setShrink(k) {
    this._shrink = k;
    const base = this._baseBoundary;
    this.world.boundary = (theta) => base(theta) * k;
    this.arena.ledge.scale.setScalar(k);
    // Hazards are baked into the ledge, so their collision bodies scale with it.
    this.world.obstacles.forEach((o, i) => {
      const b = this._baseObstacles[i];
      o.x = b.x * k; o.y = b.y * k; o.radius = b.radius * k;
    });
  }

  /** Fire the player's flick. `angle` in world XZ, `power` 0..1. */
  flick(angle, power, offset = 0) {
    if (this.state !== STATE.AIM) return;
    const pen = this.playerPen;
    this._doFlick(pen, angle, power, offset);
    this.state = STATE.RESOLVE;
    this._settleGrace = 0.25;
    this._hideAim();
  }

  _doFlick(pen, angle, power, offset) {
    // Only the player's turns are recorded — the cinematic only ever fires for a
    // clean knock they made, so recording the rival's turns is pure waste.
    if (pen === this.playerPen) this.recorder.start(this.world.pens);
    else this.recorder.reset();

    const j = impulseFor(pen.spec, power);
    pen.flick(Math.cos(angle), Math.sin(angle), j, offset);
    this._flickerThisTurn = pen;
    this._selfWasSafe = true;
    audio.whoosh(power, this._panFor(pen.x));
    this.stage.shake(0.004 + power * 0.006);
  }

  _panFor(x) {
    return Math.max(-0.85, Math.min(0.85, x / (this.arena.extent * 1.3)));
  }

  // ----------------------------------------------------------------- loop ---

  update(dt) {
    switch (this.state) {
      case STATE.LOADOUT:
        return;   // the loadout screen drives the camera via Stage.updateShowcase

      case STATE.INTRO:
        this._timer += dt;
        this.stage.setOverview(dt, this.arena.extent * this._shrink);
        if (this._timer > 2.6) this.startRound();
        break;

      case STATE.AIM: {
        this.stage.setAimView(
          { x: this.playerPen.x, z: this.playerPen.y },
          { x: this.cpuPen.x, z: this.cpuPen.y },
          this.arena.extent * this._shrink,
        );
        this._predictThrottle -= dt;
        if (this._pendingPredict && this._predictThrottle <= 0) this._runPredict();
        if (this._drag) this._showStrikePoint(this._drag.offset || 0);
        break;
      }

      case STATE.CPU_THINK: {
        this._timer += dt;
        this.stage.setAimView(
          { x: this.cpuPen.x, z: this.cpuPen.y },
          { x: this.playerPen.x, z: this.playerPen.y },
          this.arena.extent * this._shrink,
        );
        // The search is sliced across frames; hold a beat even if it finishes
        // instantly, so the opponent reads as deliberating rather than twitching.
        this._readyPlan = this._readyPlan || this._plan.step();
        if (this._readyPlan && this._timer > 0.85) {
          const plan = this._readyPlan;
          this._readyPlan = null;
          this._doFlick(this.cpuPen, plan.angle, plan.power, plan.offset);
          this.state = STATE.CPU_RESOLVE;
          this._settleGrace = 0.25;
        }
        break;
      }

      case STATE.RESOLVE:
      case STATE.CPU_RESOLVE:
        this._stepPhysics(dt);
        break;

      case STATE.REPLAY:
        this._updateReplay(dt);
        break;

      case STATE.ROUND_OVER:
        this._timer += dt;
        this.stage.setOverview(dt, this.arena.extent * this._shrink);
        if (this._timer > 2.4) {
          if (this.score.player >= ROUNDS_TO_WIN || this.score.cpu >= ROUNDS_TO_WIN) {
            this.state = STATE.MATCH_OVER;
            const won = this.score.player > this.score.cpu;
            if (won) audio.win(); else audio.lose();
            this.emit('matchover', { won, score: this.score, clean: this.cleanKnocks });
          } else {
            this.startRound();
          }
        }
        break;

      default:
        break;
    }

    if (this.state !== STATE.LOADING) this._syncVisuals(dt);
  }

  _stepPhysics(realDt) {
    // Slow motion is applied to the simulation only; the camera and UI keep
    // running at real time so the transition doesn't feel like a stutter.
    let dt = realDt;
    if (this._slowmo > 0) {
      this._slowmo -= realDt;
      dt = realDt * 0.32;
    }
    this.world.step(dt);
    this._handleEvents();
    this.recorder.capture(dt);

    // Scrape audio follows the fastest-moving pen.
    let fastest = 0, fx = 0;
    for (const p of this.world.pens) {
      if (!p.alive || p.falling) continue;
      const s = p.speed();
      if (s > fastest) { fastest = s; fx = p.x; }
    }
    audio.setSlide(Math.min(1, fastest / 2.4), this._panFor(fx));

    // Camera: chase the action, or push in on the spot where a pen went over.
    const falling = this.world.pens.find((p) => p.falling);
    if (falling || this._knockPoint) {
      const at = this._knockPoint || { x: falling.x, z: falling.y };
      this.stage.setKnockoutView(at, this.arena.extent * this._shrink);
    } else {
      const lead = fastest > 0.05
        ? this.world.pens.find((p) => p.speed() === fastest)
        : this._flickerThisTurn;
      if (lead) {
        this.stage.setChaseView({ x: lead.x, z: lead.y },
          this.arena.extent * this._shrink);
      }
    }

    this._settleGrace -= dt;
    if (this._settleGrace <= 0 && this.world.isSettled()) {
      audio.setSlide(0, 0);
      this._endTurn();
    }
  }

  _handleEvents() {
    const events = this.world.drainEvents();
    for (const e of events) {
      switch (e.type) {
        case 'impact': {
          audio.clack(e.strength, this._panFor(e.x));
          hapticImpact(e.strength);
          this.stage.impactFX.impact(e.x, e.y, e.strength);
          this.stage.shake(e.strength * 0.03);
          this.recorder.noteImpact(e.x, e.y, e.strength);
          break;
        }
        case 'obstacle':
          audio.clack(e.strength * 0.75, this._panFor(e.x));
          this.stage.impactFX.impact(e.x, e.y, e.strength * 0.7);
          break;
        case 'fall': {
          audio.fall(this._panFor(e.x));
          this.stage.impactFX.fallPuff(e.x, e.y);
          this.stage.impactFX.knockout(e.x, e.y,
            e.pen.owner === 'player' ? 0x24e8c6 : 0xff4655);
          this.stage.shake(0.02);
          this.recorder.noteFall(e.pen);
          if (e.pen === this._flickerThisTurn) this._selfWasSafe = false;
          // Drop into slow motion for the moment of the knockout. At full speed a
          // pen crosses the lip in about three frames, which is why it was
          // impossible to tell whose went over.
          this._slowmo = 1.15;
          this._knockPoint = { x: e.x, z: e.y };
          hapticKnockout(e.pen.owner === 'player');
          this.emit('knockout', {
            owner: e.pen.owner,
            pen: e.pen.spec.name,
            mine: e.pen.owner === 'player',
          });
          break;
        }
        default:
          break;
      }
    }
  }

  _endTurn() {
    const playerOut = !this.playerPen.alive || this.playerPen.falling;
    const cpuOut = !this.cpuPen.alive || this.cpuPen.falling;

    // Opening break: neither side can be eliminated on their own first flick of a
    // round. Covering only the opener's turn (turn 0) would hand a systematic
    // advantage to whoever goes second — they'd get the first shot that can
    // actually score, at a target that has already committed.
    if (this._turnInRound <= 1 && (playerOut || cpuOut)) {
      if (playerOut) this._rescue(this.playerPen);
      if (cpuOut) this._rescue(this.cpuPen);
      this.emit('toast', {
        title: 'Opening break',
        body: 'Neither side can be knocked out on their opening flick. Pen returned to the rim.',
      });
      this._advanceTurn();
      return;
    }

    if (playerOut && cpuOut) {
      this.emit('toast', { title: 'Both over', body: 'Dead heat — round replayed.' });
      this.roundNumber--;               // replay, no score
      this.state = STATE.ROUND_OVER;
      this._timer = 0;
      this.emit('roundover', { winner: null, score: this.score });
      return;
    }

    if (playerOut || cpuOut) {
      const winner = playerOut ? 'cpu' : 'player';
      this.score[winner]++;
      const clean = !!(this._selfWasSafe && this._flickerThisTurn
        && this._flickerThisTurn.owner === winner);
      if (clean) this.cleanKnocks[winner]++;
      this._pendingResult = { winner, clean, score: this.score };

      // A clean knock the player made earns the cinematic; everything else goes
      // straight to the round card.
      if (winner === 'player' && clean && this.recorder.frames > 8) {
        this._startReplay();
      } else {
        this._showRoundResult();
      }
      return;
    }

    this._advanceTurn();
  }

  _startReplay() {
    const pens = this.world.pens;
    const hero = pens.indexOf(this.playerPen);
    const victim = pens.indexOf(this.cpuPen);
    this.replay = new ReplayDirector(this.recorder, hero, victim,
      this.arena.extent * this._shrink);
    this.state = STATE.REPLAY;
    this._hideAim();
    audio.setSlide(0, 0);
    this.emit('replay', { on: true });
  }

  /** Cut the cinematic short and go to the round card. */
  skipReplay() {
    if (this.state !== STATE.REPLAY) return;
    this.replay = null;
    this.emit('replay', { on: false });
    this._showRoundResult();
  }

  _showRoundResult() {
    const r = this._pendingResult;
    this._pendingResult = null;
    this.state = STATE.ROUND_OVER;
    this._timer = 0;
    if (r) this.emit('roundover', r);
  }

  _updateReplay(dt) {
    const d = this.replay;
    if (!d) { this._showRoundResult(); return; }
    const pens = this.world.pens;
    d.update(dt, {
      stage: this.stage,
      setPose: (i, pose) => {
        const p = pens[i];
        if (!p) return;
        p.x = pose.x; p.y = pose.y; p.a = pose.a;
        p.height = pose.height; p.tumble = pose.tumble;
        // state 2 = mid-fall: keep it visible so we can watch it drop.
        p.falling = pose.state === 2;
        p.alive = pose.state !== 0 || p.falling;
      },
      friction: (x, z, intensity, dx, dz, step) => {
        this.stage.impactFX.friction(x, z, intensity, dx, dz, step, 150);
      },
      onImpact: (x, z, strength) => {
        this.stage.impactFX.impact(x, z, Math.max(0.7, strength));
        this.stage.shake(0.03);
        audio.clack(Math.max(0.75, strength), this._panFor(x));
      },
    });
    if (d.done) {
      this.replay = null;
      this.emit('replay', { on: false });
      this._showRoundResult();
    }
  }

  /**
   * Round ran to the cap: award it to the pen nearer the middle, as a fraction of
   * the local radius rather than raw distance — the arena is not a circle.
   */
  _decideOnCentreControl() {
    const exposure = (pen) => {
      const r = Math.hypot(pen.x, pen.y);
      return r / Math.max(1e-6, this.world.edgeRadius(pen.x, pen.y));
    };
    const mine = exposure(this.playerPen);
    const theirs = exposure(this.cpuPen);
    const winner = mine <= theirs ? 'player' : 'cpu';
    this.score[winner]++;
    this._pendingResult = { winner, clean: false, score: this.score, onCentre: true };
    this.emit('toast', {
      title: 'Ledge collapsed',
      body: winner === 'player'
        ? 'You held the middle. Round yours.'
        : 'They held the middle. Round theirs.',
    });
    this._showRoundResult();
  }

  _rescue(pen) {
    const theta = Math.atan2(pen.y, pen.x);
    const R = this.world.boundary(theta) * 0.80;
    pen.setPose(Math.cos(theta) * R, Math.sin(theta) * R, theta + Math.PI / 2);
    pen.alive = true;
    pen.falling = false;
    pen.height = 0;
    pen.vHeight = 0;
    pen.tumble = 0;
    const v = this.visuals.get(pen);
    if (v) { v.built.group.visible = true; v.shadow.visible = true; }
  }

  _advanceTurn() {
    this._turnInRound++;

    if (this._turnInRound >= MAX_TURNS_PER_ROUND) {
      this._decideOnCentreControl();
      return;
    }

    if (this._turnInRound >= CRUMBLE_AFTER_TURNS) {
      const next = Math.max(MIN_SHRINK, this._shrink * CRUMBLE_PER_TURN);
      if (next !== this._shrink) {
        this._setShrink(next);
        this.stage.shake(0.02);
        audio.clack(0.5, 0);
        if (this._turnInRound === CRUMBLE_AFTER_TURNS) {
          this.emit('toast', {
            title: 'The ledge is going',
            body: 'The rock is crumbling inward. Room to miss is running out.',
          });
        }
        this.emit('shrink', { scale: next });
      }
    }
    this._turnOwner = this._turnOwner === 'player' ? 'cpu' : 'player';
    this._beginTurn();
  }

  // -------------------------------------------------------------- visuals ---

  _syncVisuals(dt) {
    this._pulse = (this._pulse || 0) + dt;
    const onTurn = this.state === STATE.AIM ? 'player'
      : this.state === STATE.CPU_THINK ? 'cpu' : null;

    for (const [pen, v] of this.visuals) {
      const g = v.built.group;
      if (!pen.alive && pen.falling) {
        g.visible = false;
        v.shadow.visible = false;
        v.marker.visible = false;
        continue;
      }
      g.position.set(pen.x, v.rest - pen.height, pen.y);
      g.rotation.order = 'YZX';
      g.rotation.y = -pen.a;
      g.rotation.z = pen.tumble;

      if (pen.falling) {
        // Once it is well below the lip it is off-camera anyway; hiding it keeps
        // the beacon as the single thing marking the spot.
        g.visible = pen.height < 0.55;
        v.shadow.visible = false;
        v.marker.visible = false;
      } else {
        v.shadow.visible = true;
        v.shadow.position.set(pen.x, 0.0025, pen.y);
        v.shadow.rotation.y = -pen.a;

        v.marker.visible = true;
        v.marker.position.set(pen.x, 0.0035, pen.y);
        const active = onTurn === pen.owner;
        const pulse = active ? 0.5 + 0.5 * Math.sin(this._pulse * 3.4) : 0;
        v.marker.material.opacity = active ? 0.42 + pulse * 0.45 : 0.22;
        const s = active ? 1 + pulse * 0.10 : 1;
        v.marker.scale.set(s, 1, s);
      }
    }
  }

  // ---------------------------------------------------------------- input ---

  _buildAimHelpers() {
    // A THREE.Line is always one device pixel wide in WebGL — on a phone at DPR 2
    // that is a half-pixel hairline you cannot see against rock. Points give real
    // screen-space size, and reading as a dotted trail suits the game better anyway.
    const geo = new THREE.BufferGeometry();
    const n = AIM_MAX_POINTS;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n).fill(0.016), 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n).fill(0.9), 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);

    this._aimLine = glowPoints(geo);
    this._aimLine.renderOrder = 5;
    this._aimLine.material.depthTest = false;
    this._aimLine.visible = false;

    // Ghost marker showing where the pen is predicted to come to rest.
    const ring = new THREE.RingGeometry(0.018, 0.028, 24);
    ring.rotateX(-Math.PI / 2);
    this._aimGhost = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9,
      depthTest: false, depthWrite: false,
    }));
    this._aimGhost.renderOrder = 6;
    this._aimGhost.visible = false;
  }

  /**
   * A bead on the barrel showing exactly where the flick will land.
   *
   * Without it an off-centre strike reads as the physics being erratic rather than
   * as a choice the player made — the whole mechanic depends on seeing the contact
   * point before committing.
   */
  _buildStrikeMarker() {
    const geo = new THREE.SphereGeometry(0.011, 16, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x24e8c6,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 7;
    mesh.visible = false;
    this._strikeMarker = mesh;
    return mesh;
  }

  _showStrikePoint(offset) {
    const m = this._strikeMarker;
    if (!m) return;
    const p = this.playerPen;
    m.position.set(
      p.x + Math.cos(p.a) * offset,
      restHeight(p.spec) + p.rad * 0.9,
      p.y + Math.sin(p.a) * offset,
    );
    m.visible = true;
  }

  _hideStrikePoint() {
    if (this._strikeMarker) this._strikeMarker.visible = false;
  }

  attachAimHelpers(scene) {
    this._attachedScene = scene;
    scene.add(this._aimLine);
    scene.add(this._aimGhost);
    scene.add(this._buildStrikeMarker());
  }

  /**
   * Remove and free everything this match put into the shared scene.
   *
   * A Match owns scene objects but does not own the scene, so starting a new one
   * without this leaves the previous match's pens, markers, contact shadows and aim
   * helpers behind — you get a ledge littered with ghost pens after one rematch.
   */
  dispose() {
    this.cancelDrag();
    const scene = this._attachedScene;

    for (const v of this.visuals.values()) {
      this.stage.scene.remove(v.built.group);
      this.stage.scene.remove(v.shadow);
      this.stage.scene.remove(v.marker);
      v.shadow.geometry.dispose();
      v.shadow.material.dispose();
      v.marker.geometry.dispose();
      v.marker.material.dispose();
      v.built.dispose();
    }
    this.visuals.clear();

    if (scene) {
      scene.remove(this._aimLine);
      scene.remove(this._aimGhost);
    }
    this._aimLine.geometry.dispose();
    this._aimLine.material.dispose();
    this._aimGhost.geometry.dispose();
    this._aimGhost.material.dispose();
    if (this._strikeMarker) {
      scene?.remove(this._strikeMarker);
      this._strikeMarker.geometry.dispose();
      this._strikeMarker.material.dispose();
      this._strikeMarker = null;
    }

    this.world.reset();
    this.listeners = {};
  }

  /** Screen-space drag → a world-space aim, using the camera's ground basis. */
  /**
   * Where you put your finger on the barrel is where you strike it.
   *
   * The solver has always been able to take an off-centre impulse — it applies
   * r x J and gets the rotation right — but the player had no way to ask for one,
   * so every human flick was dead-centre while the opponent was free to use the
   * whole barrel. Projecting the touch onto the pen's own axis closes that gap:
   * catch it near the cap and the cap end leads, catch it mid-barrel and it drives
   * straight.
   */
  beginDrag(x, y) {
    if (this.state !== STATE.AIM) return false;
    const pen = this.playerPen;
    let offset = 0;
    if (this.stage.screenToGround(x, y, _v)) {
      // Component of (touch - pen centre) along the barrel, clamped to its length.
      const along = (_v.x - pen.x) * Math.cos(pen.a) + (_v.z - pen.y) * Math.sin(pen.a);
      offset = Math.max(-pen.half, Math.min(pen.half, along));
      // A dead-centre strike is the one thing you can never quite hit by hand, so
      // give the middle a small snap — otherwise every shot carries a little spin
      // the player did not ask for.
      if (Math.abs(offset) < pen.half * 0.16) offset = 0;
    }
    this._drag = { x0: x, y0: y, x, y, power: 0, angle: 0, offset };
    this._showStrikePoint(offset);
    audio.chargeStart();
    return true;
  }

  moveDrag(x, y) {
    if (!this._drag) return null;
    this._drag.x = x; this._drag.y = y;

    const dx = x - this._drag.x0;
    const dy = y - this._drag.y0;
    const maxDrag = Math.min(window.innerWidth, window.innerHeight) * 0.40;
    const dist = Math.hypot(dx, dy);
    const power = Math.max(0, Math.min(1, dist / maxDrag));

    // Ground-plane basis from the camera, so "pull toward yourself" always means
    // "send the pen away from the camera", whatever angle we are viewing from.
    this.stage.camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _right.set(-_fwd.z, 0, _fwd.x);

    // Slingshot: the pen flies opposite the drag.
    _v.set(0, 0, 0)
      .addScaledVector(_right, -dx)
      .addScaledVector(_fwd, dy);
    const angle = Math.atan2(_v.z, _v.x);

    this._drag.power = power;
    this._drag.angle = angle;
    audio.chargeUpdate(power);
    this._pendingPredict = true;
    return { power, angle, overcharged: power > OVERCHARGE_AT };
  }

  _runPredict() {
    this._pendingPredict = false;
    this._predictThrottle = 0.05;
    const d = this._drag;
    if (!d || d.power < 0.04) { this._hideAim(); return; }

    const result = this.ai.predictPath(this.playerPen, d.angle, d.power, d.offset || 0);
    const pts = result.path;
    const n = Math.min(AIM_MAX_POINTS, pts.length / 2);

    // The trail tells the truth, including when the truth is "this kills you".
    const danger = result.selfOut;
    const good = result.targetOut;
    const col = danger ? 0xff4655 : good ? 0x4df2a1 : 0xffffff;
    _aimColor.setHex(col, THREE.SRGBColorSpace);

    const geo = this._aimLine.geometry;
    const pos = geo.attributes.position;
    const size = geo.attributes.aSize;
    const alpha = geo.attributes.aAlpha;
    const colour = geo.attributes.aColor;
    for (let i = 0; i < n; i++) {
      pos.array[i * 3] = pts[i * 2];
      pos.array[i * 3 + 1] = 0.012;
      pos.array[i * 3 + 2] = pts[i * 2 + 1];
      // Taper along the path so the trail reads directionally.
      const t = n > 1 ? i / (n - 1) : 0;
      size.array[i] = 0.030 - t * 0.013;
      alpha.array[i] = 0.95 - t * 0.45;
      colour.array[i * 3] = _aimColor.r;
      colour.array[i * 3 + 1] = _aimColor.g;
      colour.array[i * 3 + 2] = _aimColor.b;
    }
    pos.needsUpdate = true;
    size.needsUpdate = true;
    alpha.needsUpdate = true;
    colour.needsUpdate = true;
    geo.setDrawRange(0, n);
    this._aimLine.visible = n > 1;

    this._aimGhost.material.color.copy(_aimColor);

    if (n > 1 && !danger) {
      this._aimGhost.position.set(pts[(n - 1) * 2], 0.006, pts[(n - 1) * 2 + 1]);
      this._aimGhost.visible = true;
    } else {
      this._aimGhost.visible = false;
    }

    this.emit('aim', {
      power: d.power, overcharged: d.power > OVERCHARGE_AT,
      selfOut: result.selfOut, targetOut: result.targetOut, hits: result.hits,
    });
  }

  endDrag() {
    if (!this._drag) return;
    const { power, angle, offset } = this._drag;
    this._drag = null;
    audio.chargeStop();
    this._hideStrikePoint();
    if (power < 0.06) { this._hideAim(); this.emit('aim', null); return; }
    this.flick(angle, power, offset || 0);
    this.emit('aim', null);
  }

  cancelDrag() {
    if (!this._drag) return;
    this._drag = null;
    audio.chargeStop();
    this._hideStrikePoint();
    this._hideAim();
    this.emit('aim', null);
  }

  _hideAim() {
    this._aimLine.visible = false;
    this._aimGhost.visible = false;
  }
}
