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
      rail: $('pen-rail'),
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
    this._buildRail();
    this._wire();
    this._renderHero(false);
  }

  on(evt, fn) { this.handlers[evt] = fn; return this; }
  _fire(evt, arg) { if (this.handlers[evt]) this.handlers[evt](arg); }

  get spec() { return PENS.find((p) => p.id === this.selectedPen); }

  // --------------------------------------------------------------- title ---

  /** Short tile label: the model, not the brand — "045", "TRIMAX", "WOODY". */
  static abbr(spec) {
    const words = spec.name.split(' ');
    return (words.length > 1 ? words[words.length - 1] : words[0]).slice(0, 7);
  }

  _buildRail() {
    const frag = document.createDocumentFragment();
    PENS.forEach((spec) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'pen-tile glass';
      tile.setAttribute('role', 'radio');
      tile.setAttribute('aria-checked', String(spec.id === this.selectedPen));
      tile.setAttribute('aria-label', spec.name);
      tile.dataset.id = spec.id;

      // A colour swatch of the actual barrel — enough to recognise the pen at a
      // glance without a second WebGL context or a bitmap.
      const mark = document.createElement('span');
      mark.className = 'tile-mark';
      mark.style.background = `#${spec.body.color.toString(16).padStart(6, '0')}`;
      mark.style.color = `#${spec.accent.toString(16).padStart(6, '0')}`;

      const abbr = document.createElement('span');
      abbr.className = 'tile-abbr';
      abbr.textContent = UI.abbr(spec);

      tile.append(mark, abbr);
      tile.addEventListener('click', () => this.selectPen(spec.id));
      frag.appendChild(tile);
    });
    this.el.rail.appendChild(frag);
  }

  selectPen(id, silent = false) {
    if (id === this.selectedPen && !silent) return;
    this.selectedPen = id;
    localStorage.setItem(STORAGE_KEY, id);
    this.el.rail.querySelectorAll('.pen-tile').forEach((t) => {
      t.setAttribute('aria-checked', String(t.dataset.id === id));
    });
    // Scroll the rail by hand. scrollIntoView() walks every scrollable ancestor,
    // including the document, and will happily shove the whole fixed layout sideways.
    const tile = this.el.rail.querySelector(`[data-id="${id}"]`);
    if (tile) {
      const rail = this.el.rail;
      const target = tile.offsetLeft - (rail.clientWidth - tile.offsetWidth) / 2;
      rail.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
    }
    this._renderHero(true);
    if (!silent) this._fire('select', id);
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
