/**
 * hud.js — DOM interface layer. No game logic lives here; it renders state the
 * Match emits and hands input intent back.
 *
 * The pen swatches on the loadout screen are drawn to a 2D canvas from the same
 * catalog entries the 3D builder uses, so the thing you pick looks like the thing
 * you get, for a couple of kilobytes instead of a second WebGL context.
 */

import { PENS, penStats, FINISH } from '../game/pens.js';
import { DIFFICULTY } from '../game/ai.js';

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

function rounded(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Side elevation of a pen, drawn from its catalog entry. */
export function drawPenSwatch(canvas, spec, cssWidth = 112, cssHeight = 46) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const pad = 5;
  const L = cssWidth - pad * 2;
  const x0 = pad;
  const thick = Math.max(6, Math.min(11, cssHeight * 0.21));
  const cy = cssHeight * 0.60;
  const top = cy - thick / 2;
  const at = (t) => x0 + t * L;

  const translucent = spec.body.finish === FINISH.CLEAR
    || spec.body.finish === FINISH.FROSTED;

  // Barrel
  ctx.save();
  rounded(ctx, at(0), top, L * 0.985, thick, thick * 0.45);
  ctx.clip();

  ctx.globalAlpha = translucent ? 0.55 : 1;
  const grad = ctx.createLinearGradient(0, top, 0, top + thick);
  const base = hex(spec.body.color);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.16, base);
  grad.addColorStop(0.72, base);
  grad.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = base;
  ctx.fillRect(at(0), top, L, thick);
  ctx.fillStyle = grad;
  ctx.globalAlpha = translucent ? 0.4 : 0.85;
  ctx.fillRect(at(0), top, L, thick);
  ctx.globalAlpha = 1;

  if (spec.body.twoTone !== undefined) {
    ctx.fillStyle = hex(spec.body.twoTone);
    ctx.fillRect(at(0), top, L * 0.42, thick);
  }
  // Cap section
  ctx.fillStyle = hex(spec.cap.color);
  ctx.globalAlpha = spec.cap.translucent ? 0.6 : 1;
  ctx.fillRect(at(0), top, L * spec.cap.length, thick);
  ctx.globalAlpha = 1;

  // Grip
  if (spec.grip) {
    ctx.fillStyle = hex(spec.grip.color);
    ctx.globalAlpha = spec.grip.translucent ? 0.65 : 1;
    ctx.fillRect(at(spec.grip.from), top - 0.5,
      L * (spec.grip.to - spec.grip.from), thick + 1);
    ctx.globalAlpha = 1;
    if (spec.grip.style === 'ribbed' || spec.grip.style === 'wave') {
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      const n = 7;
      for (let i = 0; i < n; i++) {
        const t = spec.grip.from + ((i + 0.5) / n) * (spec.grip.to - spec.grip.from);
        ctx.fillRect(at(t) - 0.7, top - 0.5, 1.4, thick + 1);
      }
    }
  }
  // Machined ribs
  if (spec.ribs) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    for (let i = 0; i < spec.ribs.count; i++) {
      const t = spec.ribs.from
        + ((i + 0.5) / spec.ribs.count) * (spec.ribs.to - spec.ribs.from);
      ctx.fillRect(at(t) - 0.5, top, 1, thick);
    }
  }
  if (spec.inkWindow) {
    ctx.fillStyle = hex(spec.accent);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(at(spec.inkWindow.from), top + thick * 0.25,
      L * (spec.inkWindow.to - spec.inkWindow.from), thick * 0.5);
    ctx.globalAlpha = 1;
  }
  // Specular streak — sells "moulded plastic" in two lines of code.
  ctx.fillStyle = 'rgba(255,255,255,0.34)';
  ctx.fillRect(at(0.02), top + thick * 0.17, L * 0.94, Math.max(1, thick * 0.13));
  ctx.restore();

  // Front taper + metal tip
  ctx.fillStyle = hex(spec.body.color);
  ctx.beginPath();
  ctx.moveTo(at(0.945), top);
  ctx.lineTo(at(0.985), cy - thick * 0.16);
  ctx.lineTo(at(0.985), cy + thick * 0.16);
  ctx.lineTo(at(0.945), top + thick);
  ctx.closePath();
  ctx.globalAlpha = translucent ? 0.6 : 1;
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.strokeStyle = hex(spec.tip.color);
  ctx.lineWidth = Math.max(1.2, thick * 0.20);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(at(0.985), cy);
  ctx.lineTo(at(1.0), cy);
  ctx.stroke();

  // Clip
  ctx.fillStyle = hex(spec.clip.color);
  ctx.globalAlpha = spec.clip.translucent ? 0.7 : 1;
  const clipLen = spec.clip.style === 'wide' ? 0.20 : 0.17;
  rounded(ctx, at(0.03), top - thick * 0.42, L * clipLen,
    Math.max(2, thick * 0.30), 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Contact shadow
  const sh = ctx.createLinearGradient(0, cy + thick / 2, 0, cy + thick / 2 + 7);
  sh.addColorStop(0, 'rgba(0,0,0,0.34)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh;
  ctx.fillRect(at(0.02), cy + thick / 2, L * 0.95, 7);
}

const STAT_LABELS = {
  power: 'Power', speed: 'Range', stability: 'Stability', reach: 'Reach',
};

export class UI {
  constructor() {
    this.el = {
      hud: document.getElementById('hud'),
      title: document.getElementById('title'),
      result: document.getElementById('result'),
      boot: document.getElementById('boot'),
      bootLabel: document.getElementById('boot-label'),

      playerPips: document.getElementById('hud-player-pips'),
      cpuPips: document.getElementById('hud-cpu-pips'),
      playerName: document.getElementById('hud-player-name'),
      cpuName: document.getElementById('hud-cpu-name'),
      round: document.getElementById('hud-round'),
      biome: document.getElementById('hud-biome'),
      surface: document.getElementById('hud-surface'),
      toastSlot: document.getElementById('toast-slot'),

      turnBanner: document.getElementById('turn-banner'),
      turnTitle: document.getElementById('turn-title'),
      turnHint: document.getElementById('turn-hint'),
      power: document.getElementById('power'),
      powerFill: document.getElementById('power-fill'),
      powerRead: document.getElementById('power-read'),

      rail: document.getElementById('pen-rail'),
      detail: document.getElementById('pen-detail'),
      difficulty: document.getElementById('difficulty'),
      play: document.getElementById('btn-play'),
      playSub: document.getElementById('play-sub'),

      resultKicker: document.getElementById('result-kicker'),
      resultTitle: document.getElementById('result-title'),
      resultBody: document.getElementById('result-body'),
      resultActions: document.getElementById('result-actions'),
      rematch: document.getElementById('btn-rematch'),
      change: document.getElementById('btn-change'),
      sound: document.getElementById('btn-sound'),
    };

    this.selectedPen = PENS[0].id;
    this.difficulty = 'normal';
    this.handlers = {};
    this._buildRail();
    this._buildDifficulty();
    this._wire();
    this._pipCount = 2;
  }

  on(evt, fn) { this.handlers[evt] = fn; return this; }
  _fire(evt, arg) { if (this.handlers[evt]) this.handlers[evt](arg); }

  // --------------------------------------------------------------- title ---

  _buildRail() {
    const frag = document.createDocumentFragment();
    PENS.forEach((spec) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'pen-card';
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(spec.id === this.selectedPen));
      card.dataset.id = spec.id;

      const cv = document.createElement('canvas');
      card.appendChild(cv);
      const b = document.createElement('b');
      b.textContent = spec.name;
      card.appendChild(b);
      const i = document.createElement('i');
      i.textContent = spec.brand;
      card.appendChild(i);

      card.addEventListener('click', () => {
        this.selectPen(spec.id);
        this._fire('select', spec.id);
      });
      frag.appendChild(card);
      // Draw after layout so the canvas picks up its real CSS width.
      requestAnimationFrame(() => drawPenSwatch(cv, spec, cv.clientWidth || 112, 46));
    });
    this.el.rail.appendChild(frag);
    this._renderDetail();
  }

  selectPen(id) {
    this.selectedPen = id;
    this.el.rail.querySelectorAll('.pen-card').forEach((c) => {
      c.setAttribute('aria-checked', String(c.dataset.id === id));
    });
    const card = this.el.rail.querySelector(`[data-id="${id}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    this._renderDetail();
  }

  _renderDetail() {
    const spec = PENS.find((p) => p.id === this.selectedPen);
    const stats = penStats(spec);
    const el = this.el.detail;
    el.innerHTML = '';

    const top = document.createElement('div');
    top.className = 'pd-top';
    const h3 = document.createElement('h3');
    h3.textContent = spec.name;
    const tag = document.createElement('div');
    tag.className = 'pd-tag';
    tag.textContent = spec.tagline;
    top.append(h3, tag);

    const p = document.createElement('p');
    p.textContent = spec.blurb;

    const grid = document.createElement('div');
    grid.className = 'stat-grid';
    for (const key of ['power', 'speed', 'stability', 'reach']) {
      const row = document.createElement('div');
      row.className = 'stat';
      const label = document.createElement('span');
      label.textContent = STAT_LABELS[key];
      const bar = document.createElement('div');
      bar.className = 'stat-bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.round(stats[key] * 100)}%`;
      bar.appendChild(fill);
      row.append(label, bar);
      grid.appendChild(row);
    }

    const spec2 = document.createElement('div');
    spec2.className = 'pd-spec';
    spec2.textContent =
      `${spec.lengthMm} mm · ⌀${spec.diameterMm} mm · ${spec.massG} g`
      + `${spec.estimated ? ' (est.)' : ''} · ${spec.profile} barrel`;

    el.append(top, p, grid, spec2);
  }

  _buildDifficulty() {
    Object.entries(DIFFICULTY).forEach(([key, cfg]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(key === this.difficulty));
      b.dataset.key = key;
      const strong = document.createElement('span');
      strong.textContent = cfg.label;
      const em = document.createElement('em');
      em.textContent = key;
      b.append(strong, em);
      b.addEventListener('click', () => {
        this.difficulty = key;
        this.el.difficulty.querySelectorAll('button').forEach((x) => {
          x.setAttribute('aria-checked', String(x.dataset.key === key));
        });
        this._fire('difficulty', key);
      });
      this.el.difficulty.appendChild(b);
    });
  }

  _wire() {
    this.el.play.addEventListener('click', () => this._fire('play'));
    this.el.rematch.addEventListener('click', () => this._fire('rematch'));
    this.el.change.addEventListener('click', () => this._fire('change'));
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
    setTimeout(() => { this.el.boot.remove(); }, 600);
  }

  setBoot(label) { this.el.bootLabel.textContent = label; }

  setNames(playerSpec, cpuSpec) {
    this.el.playerName.textContent = playerSpec.name;
    this.el.cpuName.textContent = cpuSpec.name;
  }

  setBiome(biome) {
    this.el.biome.textContent = biome.name;
    this.el.surface.textContent = biome.surface.label;
  }

  setScore(score) {
    const render = (host, n, count) => {
      host.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const d = document.createElement('div');
        d.className = `pip${i < n ? ' on' : ''}`;
        host.appendChild(d);
      }
    };
    render(this.el.playerPips, score.player, this._pipCount);
    render(this.el.cpuPips, score.cpu, this._pipCount);
  }

  setRound(n) { this.el.round.textContent = `Round ${n}`; }

  setTurn(owner, hint) {
    const b = this.el.turnBanner;
    b.classList.remove('quiet', 'player', 'cpu');
    b.classList.add(owner === 'player' ? 'player' : 'cpu');
    this.el.turnTitle.textContent = owner === 'player' ? 'Your turn' : 'Rival thinking';
    this.el.turnHint.textContent = hint
      || (owner === 'player' ? 'Drag back anywhere, then let go' : 'Reading the angles…');
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

  toast(title, body, ms = 3200) {
    const t = document.createElement('div');
    t.className = 'toast';
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
