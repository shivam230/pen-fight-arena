/**
 * hud.js — DOM interface layer. No game logic here; it renders state the Match
 * emits and hands input intent back.
 *
 * The loadout screen has no artwork of its own: the pen is a real 3D render in the
 * live scene behind the glass, so what you pick is literally what you get.
 */

import { PENS } from '../game/pens.js';

const STORAGE_KEY = 'penfight.pen';

export class UI {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'),
      title: $('title'),
      result: $('result'),
      boot: $('boot'),
      bootLabel: $('boot-label'),

      playerPips: $('hud-player-pips'),
      cpuPips: $('hud-cpu-pips'),
      playerName: $('hud-player-name'),
      cpuName: $('hud-cpu-name'),
      round: $('hud-round'),
      biome: $('hud-biome'),
      surface: $('hud-surface'),
      toastSlot: $('toast-slot'),

      turnBanner: $('turn-banner'),
      turnTitle: $('turn-title'),
      turnHint: $('turn-hint'),
      power: $('power'),
      powerFill: $('power-fill'),
      powerRead: $('power-read'),

      hero: $('hero'),
      heroBrand: $('hero-brand'),
      heroModel: $('hero-model'),
      swipe: $('swipe-zone'),
      pager: $('pen-pager'),
      prev: $('pen-prev'),
      next: $('pen-next'),
      knockout: $('knockout'),
      knockoutTag: $('knockout-tag'),
      knockoutTitle: $('knockout-title'),
      play: $('btn-play'),

      replay: $('replay'),
      replaySub: $('replay-sub'),
      skip: $('btn-skip'),

      resultKicker: $('result-kicker'),
      resultTitle: $('result-title'),
      resultBody: $('result-body'),
      resultActions: $('result-actions'),
      rematch: $('btn-rematch'),
      change: $('btn-change'),
      sound: $('btn-sound'),
    };

    // Remember the last pen picked — a returning player should not have to hunt
    // for their pen again.
    const saved = localStorage.getItem(STORAGE_KEY);
    this.selectedPen = PENS.some((p) => p.id === saved) ? saved : PENS[0].id;

    this.handlers = {};
    this._pipCount = 2;
    this.index = Math.max(0, PENS.findIndex((p) => p.id === this.selectedPen));
    this._buildPager();
    this._initSwipe();
    this._wire();
    this._renderHero(false);
  }

  on(evt, fn) { this.handlers[evt] = fn; return this; }
  _fire(evt, arg) { if (this.handlers[evt]) this.handlers[evt](arg); }

  get spec() { return PENS.find((p) => p.id === this.selectedPen); }

  // --------------------------------------------------------------- title ---

  _buildPager() {
    const frag = document.createDocumentFragment();
    this.dots = PENS.map((spec, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.setAttribute('role', 'radio');
      dot.setAttribute('aria-checked', String(i === this.index));
      dot.setAttribute('aria-label', spec.name);
      dot.addEventListener('click', () => this.selectIndex(i));
      frag.appendChild(dot);
      return dot;
    });
    this.el.pager.appendChild(frag);
  }

  /**
   * The pen render is the control. A horizontal drag across it steps through the
   * roster; a short drag snaps back. Vertical movement is ignored so the gesture
   * never fights a page scroll.
   */
  _initSwipe() {
    const el = this.el.swipe;
    let x0 = 0, y0 = 0, active = false, decided = false;
    const THRESHOLD = 48;

    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.swipe-arrow')) return;
      active = true;
      decided = false;
      x0 = e.clientX;
      y0 = e.clientY;
      el.classList.add('dragging');
      try { el.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    });

    el.addEventListener('pointermove', (e) => {
      if (!active || decided) return;
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      if (Math.abs(dy) > Math.abs(dx) * 1.4 && Math.abs(dy) > 24) {
        active = false;                  // that was a vertical gesture
        el.classList.remove('dragging');
        return;
      }
      if (Math.abs(dx) >= THRESHOLD) {
        decided = true;
        this.selectIndex(this.index + (dx < 0 ? 1 : -1));
        // Let one continuous swipe keep stepping: rebase and re-arm.
        x0 = e.clientX;
        decided = false;
      }
    });

    const end = () => {
      active = false;
      decided = false;
      el.classList.remove('dragging');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  selectIndex(i, silent = false) {
    // Wraps: stepping past either end rolls round to the other side.
    const next = ((i % PENS.length) + PENS.length) % PENS.length;
    const changed = next !== this.index;
    this.index = next;
    this.selectedPen = PENS[next].id;
    localStorage.setItem(STORAGE_KEY, this.selectedPen);
    this.dots.forEach((d, k) => d.setAttribute('aria-checked', String(k === next)));
    this._renderHero(changed);
    if (changed && !silent) this._fire('select', this.selectedPen);
  }

  /** Kept for callers that know an id rather than a position. */
  selectPen(id, silent = false) {
    const i = PENS.findIndex((p) => p.id === id);
    if (i >= 0) this.selectIndex(i, silent);
  }

  _renderHero(animate) {
    const spec = this.spec;
    this.el.heroBrand.textContent = spec.brand;
    // Drop the brand from the model line so "Reynolds Reynolds 045" never happens.
    const model = spec.name.startsWith(spec.brand)
      ? spec.name.slice(spec.brand.length).trim() : spec.name;
    this.el.heroModel.textContent = model || spec.name;
    if (animate) {
      this.el.hero.classList.remove('swap');
      void this.el.hero.offsetWidth;   // restart the animation
      this.el.hero.classList.add('swap');
    }
  }

  _wire() {
    this.el.prev.addEventListener('click', () => this.selectIndex(this.index - 1));
    this.el.next.addEventListener('click', () => this.selectIndex(this.index + 1));
    this.el.play.addEventListener('click', () => this._fire('play'));
    this.el.rematch.addEventListener('click', () => this._fire('rematch'));
    this.el.change.addEventListener('click', () => this._fire('change'));
    this.el.skip.addEventListener('click', () => this._fire('skip'));
    this.el.sound.addEventListener('click', () => {
      const muted = this.el.sound.classList.toggle('muted');
      this.el.sound.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
      this._fire('mute', muted);
    });
  }

  // ---------------------------------------------------------------- game ---

  showTitle() {
    this.el.title.hidden = false;
    this.el.hud.hidden = true;
    this.el.result.hidden = true;
  }

  showGame() {
    this.el.title.hidden = true;
    this.el.result.hidden = true;
    this.el.hud.hidden = false;
  }

  hideBoot() {
    this.el.boot.classList.add('gone');
    clearTimeout(this._bootTimer);
    this._bootTimer = setTimeout(() => { this.el.boot.hidden = true; }, 620);
  }

  showBoot(label) {
    this.el.bootLabel.textContent = label;
    this.el.boot.hidden = false;
    clearTimeout(this._bootTimer);
    // Force a reflow so removing .gone actually re-runs the fade.
    void this.el.boot.offsetWidth;
    this.el.boot.classList.remove('gone');
  }

  setNames(playerSpec, cpuSpec) {
    this.el.playerName.textContent = playerSpec.name;
    this.el.cpuName.textContent = cpuSpec.name;
  }

  setBiome(biome) {
    this.el.biome.textContent = biome.name;
    this.el.surface.textContent = biome.surface.label;
  }

  setScore(score) {
    const render = (host, n) => {
      host.innerHTML = '';
      for (let i = 0; i < this._pipCount; i++) {
        const d = document.createElement('div');
        d.className = `pip${i < n ? ' on' : ''}`;
        host.appendChild(d);
      }
    };
    render(this.el.playerPips, score.player);
    render(this.el.cpuPips, score.cpu);
  }

  setRound(n) { this.el.round.textContent = `Round ${n}`; }

  setTurn(owner, hint) {
    const b = this.el.turnBanner;
    b.classList.remove('quiet', 'player', 'cpu');
    b.classList.add(owner === 'player' ? 'player' : 'cpu');
    this.el.turnTitle.textContent = owner === 'player' ? 'Your turn' : 'Rival thinking';
    this.el.turnHint.textContent = hint
      || (owner === 'player' ? 'Drag back anywhere, then let go' : 'Reading the angles');
  }

  quietBanner(quiet = true) {
    this.el.turnBanner.classList.toggle('quiet', quiet);
  }

  setPower(state) {
    if (!state) {
      this.el.power.hidden = true;
      return;
    }
    this.el.power.hidden = false;
    const pct = Math.round(state.power * 100);
    this.el.powerFill.style.width = `${pct}%`;
    this.el.powerFill.classList.toggle('over', state.overcharged);
    this.el.powerRead.classList.toggle('over', state.overcharged);
    this.el.powerRead.textContent = state.selfOut ? 'RISK' : `${pct}%`;
  }

  /** Big, unmissable call-out naming whose pen just went over. */
  knockout({ mine, pen }) {
    const el = this.el.knockout;
    // Same colour language as the ground markers: your pen is teal, the rival's is
    // red. Colouring by good/bad outcome instead would contradict the deck.
    el.style.setProperty('--knock-colour', mine ? 'var(--accent)' : 'var(--accent-hot)');
    this.el.knockoutTag.textContent = mine ? 'Your pen' : 'Rival pen';
    this.el.knockoutTitle.textContent = pen;
    el.classList.add('on');
    clearTimeout(this._knockTimer);
    this._knockTimer = setTimeout(() => el.classList.remove('on'), 1900);
  }

  hideKnockout() {
    clearTimeout(this._knockTimer);
    this.el.knockout.classList.remove('on');
  }

  setReplay(on, subtitle) {
    this.el.replay.classList.toggle('on', on);
    if (subtitle) this.el.replaySub.textContent = subtitle;
    // Hide the playing HUD during the cinematic — letterbox plus a scoreboard
    // reads as a bug, not a replay.
    this.el.hud.hidden = on;
  }

  toast(title, body, ms = 3200) {
    const t = document.createElement('div');
    t.className = 'toast glass';
    const s = document.createElement('strong');
    s.textContent = title;
    const p = document.createElement('span');
    p.textContent = body;
    t.append(s, p);
    this.el.toastSlot.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 300);
    }, ms);
  }

  showResult({ kicker, title, body, tone, actions }) {
    this.el.resultKicker.textContent = kicker;
    this.el.resultTitle.textContent = title;
    this.el.resultTitle.className = `card-title${tone ? ` ${tone}` : ''}`;
    this.el.resultBody.textContent = body;
    this.el.resultActions.hidden = !actions;
    this.el.result.hidden = false;
  }

  hideResult() { this.el.result.hidden = true; }
}
