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
      carousel: $('pen-carousel'),
      track: $('pen-track'),
      prev: $('pen-prev'),
      next: $('pen-next'),
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
    this._buildCarousel();
    this._wire();
    this._renderHero(false);
    window.addEventListener('resize', () => this._layout());
  }

  on(evt, fn) { this.handlers[evt] = fn; return this; }
  _fire(evt, arg) { if (this.handlers[evt]) this.handlers[evt](arg); }

  get spec() { return PENS.find((p) => p.id === this.selectedPen); }

  // --------------------------------------------------------------- title ---

  /** Card label: the model, not the brand — "045", "TRIMAX", "FIBERPOINT". */
  static abbr(spec) {
    const words = spec.name.split(' ');
    return words.length > 1 ? words[words.length - 1] : words[0];
  }

  _buildCarousel() {
    const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
    const frag = document.createDocumentFragment();

    this.cards = PENS.map((spec, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'pen-card';
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(i === this.index));
      card.setAttribute('aria-label', spec.name);
      card.dataset.id = spec.id;

      // A CSS-drawn pen silhouette: cheaper and sharper at any size than a bitmap,
      // and it stays in sync with the catalog colours automatically.
      const glyph = document.createElement('span');
      glyph.className = 'pen-glyph';
      glyph.style.setProperty('--body', hex(spec.body.color));
      glyph.style.setProperty('--cap', hex(spec.cap.color));
      glyph.style.setProperty('--tip', hex(spec.tip.color));
      glyph.style.setProperty('--clip', hex(spec.clip.color));

      const label = document.createElement('b');
      label.textContent = UI.abbr(spec);

      card.append(glyph, label);
      card.addEventListener('click', () => this.selectIndex(i));
      frag.appendChild(card);
      return card;
    });

    this.el.track.appendChild(frag);
    this._initDrag();
    requestAnimationFrame(() => this._layout(false));
  }

  /** Metrics come from the rendered card so CSS stays the single source of size. */
  _metrics() {
    const card = this.cards[0];
    const w = card.offsetWidth || 74;
    return { pitch: w + 34, w };
  }

  /** Signed distance from a to b on a ring of n — always the short way round. */
  static ringDelta(a, b, n) {
    let d = a - b;
    d -= Math.round(d / n) * n;
    return d;
  }

  /**
   * Place every card relative to the centred one. Positions wrap around the ring,
   * so the first and last pens still have neighbours either side instead of the
   * strip dead-ending against an empty gap.
   */
  _layout(animate = true) {
    if (!this.cards || !this.cards.length) return;
    const n = this.cards.length;
    const { pitch, w } = this._metrics();
    const centre = this.el.carousel.clientWidth / 2;
    const fractional = this.index - (this._dragOffset || 0) / pitch;
    const ease = 'transform 380ms cubic-bezier(0.16, 1, 0.3, 1), opacity 300ms ease';

    this.cards.forEach((card, i) => {
      const d = UI.ringDelta(i, fractional, n);
      const ad = Math.abs(d);
      const visible = ad < 3.2;
      card.style.transition = this._dragging || !animate ? 'none' : ease;
      card.style.visibility = visible ? 'visible' : 'hidden';
      if (!visible) return;
      const scale = Math.max(0.46, 1 - ad * 0.26);
      const x = centre + d * pitch - w / 2;
      card.style.transform = `translateX(${x.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      card.style.opacity = Math.max(0.18, 1 - ad * 0.36).toFixed(2);
      card.style.zIndex = String(20 - Math.round(ad * 4));
    });
  }

  _initDrag() {
    const el = this.el.carousel;
    let startX = 0, startIndex = 0, active = false, moved = 0;

    const down = (e) => {
      active = true;
      moved = 0;
      startX = e.clientX;
      startIndex = this.index;
      this._dragging = true;
      el.classList.add('dragging');
      el.setPointerCapture?.(e.pointerId);
    };
    const move = (e) => {
      if (!active) return;
      this._dragOffset = e.clientX - startX;
      moved = Math.abs(this._dragOffset);
      this._layout(false);
    };
    const up = () => {
      if (!active) return;
      active = false;
      this._dragging = false;
      el.classList.remove('dragging');
      const { pitch } = this._metrics();
      const shift = Math.round(-(this._dragOffset || 0) / pitch);
      this._dragOffset = 0;
      const next = startIndex + shift;
      if (((next % PENS.length) + PENS.length) % PENS.length !== this.index) {
        this.selectIndex(next);
      } else {
        this._layout(true);
      }
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    // A drag that crossed a card must not also fire that card's click.
    el.addEventListener('click', (e) => {
      if (moved > 8) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  selectIndex(i, silent = false) {
    // Wraps: stepping past either end rolls round to the other side.
    const next = ((i % PENS.length) + PENS.length) % PENS.length;
    const changed = next !== this.index;
    this.index = next;
    this.selectedPen = PENS[next].id;
    localStorage.setItem(STORAGE_KEY, this.selectedPen);
    this.cards.forEach((c, k) => c.setAttribute('aria-checked', String(k === next)));
    this._layout(true);
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
    // Widths measure as 0 while the screen is display:none, so re-run the layout
    // once it is actually on screen.
    requestAnimationFrame(() => this._layout(false));
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
