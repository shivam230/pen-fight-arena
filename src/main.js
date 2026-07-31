/**
 * main.js — bootstrap, input plumbing and the frame loop.
 */

import { Stage } from './render/stage.js';
import { Match, STATE } from './game/match.js';
import { PENS, PEN_BY_ID } from './game/pens.js';
import { UI } from './ui/hud.js';
import { audio } from './audio/sfx.js';

const canvas = document.getElementById('stage');
const stage = new Stage(canvas);
stage.applyTier(stage.detectTier());

const ui = new UI();
let match = null;
let running = false;

// --------------------------------------------------------------- helpers ---

/** The rival picks a different pen, weighted toward one that counters yours. */
function pickCpuPen(playerId) {
  const mine = PEN_BY_ID[playerId];
  const pool = PENS.filter((p) => p.id !== playerId);
  // Light pens get answered by heavy ones and vice versa — the rival turns up
  // with a plausible counter rather than a coin flip.
  pool.sort((a, b) => {
    const da = Math.abs((a.massG - mine.massG) + (a.glide - mine.glide) * 8);
    const db = Math.abs((b.massG - mine.massG) + (b.glide - mine.glide) * 8);
    return db - da;
  });
  const top = pool.slice(0, 4);
  return top[(Math.random() * top.length) | 0].id;
}

function newMatch() {
  // The outgoing match still owns pens, markers and aim helpers inside the shared
  // scene. Tear it down before building the next one or they pile up.
  if (match) {
    match.dispose();
    match = null;
  }
  const cpuId = pickCpuPen(ui.selectedPen);
  match = new Match(stage, {
    difficulty: ui.difficulty,
    playerPen: ui.selectedPen,
    cpuPen: cpuId,
  });
  match.attachAimHelpers(stage.scene);
  wireMatch(match, cpuId);
  return match.newMatch((Math.random() * 1e9) | 0);
}

function wireMatch(m, cpuId) {
  ui.setNames(PEN_BY_ID[ui.selectedPen], PEN_BY_ID[cpuId]);
  ui.setScore(m.score);

  m.on('biome', (biome) => {
    ui.setBiome(biome);
    ui.toast(biome.name, biome.subtitle, 4200);
  });

  m.on('round', ({ round, score, opener }) => {
    ui.hideResult();
    ui.setRound(round);
    ui.setScore(score);
    ui.setTurn(opener);
    ui.quietBanner(false);
  });

  m.on('turn', ({ owner, turn }) => {
    ui.quietBanner(false);
    if (owner === 'player') {
      ui.setTurn('player', turn === 0
        ? 'Opening break — nobody can be knocked out yet'
        : 'Drag back anywhere, then let go');
    } else {
      ui.setTurn('cpu');
    }
  });

  m.on('aim', (state) => {
    ui.setPower(state);
    ui.quietBanner(!!state);
  });

  m.on('toast', ({ title, body }) => ui.toast(title, body));

  m.on('roundover', ({ winner, clean, score }) => {
    ui.setScore(score);
    ui.setPower(null);
    ui.quietBanner(true);
    if (!winner) {
      ui.showResult({
        kicker: `Round ${m.roundNumber + 1}`,
        title: 'Dead heat',
        body: 'Both pens went over together. Nobody scores — set them up again.',
      });
      return;
    }
    const won = winner === 'player';
    ui.showResult({
      kicker: `Round ${m.roundNumber}`,
      title: won ? (clean ? 'Clean knock' : 'Round won') : 'Round lost',
      tone: won ? 'win' : 'lose',
      body: won
        ? (clean
          ? 'Straight off the ledge, and your pen never wobbled. That is the whole game.'
          : 'Their pen is somewhere in the valley. Reset and go again.')
        : 'Yours went over. Watch the power meter — past the mark you are gambling.',
    });
  });

  m.on('matchover', ({ won, score, clean }) => {
    ui.setPower(null);
    ui.quietBanner(true);
    const flair = clean.player > 0
      ? ` ${clean.player} clean knock${clean.player > 1 ? 's' : ''}.`
      : '';
    ui.showResult({
      kicker: 'Match',
      title: won ? 'You win' : 'You lose',
      tone: won ? 'win' : 'lose',
      body: `${score.player}–${score.cpu}.${won ? flair : ''} `
        + (won
          ? 'Next arena is already generating.'
          : 'The rival read the angles better. Try a heavier pen, or ease off the power.'),
      actions: true,
    });
  });
}

// ----------------------------------------------------------------- input ---

let pointerId = null;

function onDown(e) {
  audio.unlock();
  if (!match || match.state !== STATE.AIM) return;
  // A pointerup can go missing — a swallowed event, an interrupted gesture, a
  // browser gesture takeover. Recovering here instead of bailing out means a lost
  // event costs one flick, not the rest of the match.
  if (pointerId !== null && pointerId !== e.pointerId) match.cancelDrag();
  pointerId = e.pointerId;
  // Capture is an optimisation, not a requirement — it throws for any pointer the
  // browser doesn't consider active, and that must never cost us the flick.
  try { canvas.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
  match.beginDrag(e.clientX, e.clientY);
  e.preventDefault();
}

function onMove(e) {
  if (pointerId !== e.pointerId || !match) return;
  match.moveDrag(e.clientX, e.clientY);
  e.preventDefault();
}

function onUp(e) {
  if (pointerId !== e.pointerId || !match) return;
  pointerId = null;
  match.endDrag();
  e.preventDefault();
}

function onCancel(e) {
  if (pointerId !== e.pointerId || !match) return;
  pointerId = null;
  match.cancelDrag();
}

canvas.addEventListener('pointerdown', onDown, { passive: false });
canvas.addEventListener('pointermove', onMove, { passive: false });
canvas.addEventListener('pointerup', onUp, { passive: false });
canvas.addEventListener('pointercancel', onCancel);
canvas.addEventListener('lostpointercapture', onCancel);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// Belt and braces: if the pointer is released anywhere outside the canvas, the
// canvas listener may never fire, so clear the drag from the window too.
window.addEventListener('pointerup', (e) => {
  if (pointerId === e.pointerId) onUp(e);
});

window.addEventListener('resize', () => stage.resize());
window.addEventListener('orientationchange', () => setTimeout(() => stage.resize(), 250));

document.addEventListener('visibilitychange', () => {
  // Losing the tab mid-drag would otherwise leave the aim line stuck on screen.
  if (document.hidden && match) match.cancelDrag();
});

// ------------------------------------------------------------------- UI ---

ui.on('select', () => audio.tick(1400, 0.05));
ui.on('difficulty', () => audio.confirm());
ui.on('mute', (muted) => audio.setMuted(muted));

ui.on('play', async () => {
  audio.unlock();
  audio.confirm();
  ui.setBoot('Carving the ledge…');
  ui.el.boot.classList.remove('gone');
  document.body.appendChild(ui.el.boot);
  await newMatch();
  ui.showGame();
  ui.hideBoot();
});

ui.on('rematch', async () => {
  ui.hideResult();
  ui.setBoot('Finding new ground…');
  ui.el.boot.classList.remove('gone');
  document.body.appendChild(ui.el.boot);
  await newMatch();
  ui.showGame();
  ui.hideBoot();
});

ui.on('change', () => {
  ui.hideResult();
  ui.showTitle();
});

// ----------------------------------------------------------------- loop ---

let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  // Clamp so a backgrounded tab doesn't resume with a giant integration step.
  if (dt > 0.1) dt = 0.1;

  if (match) match.update(dt);
  stage.render(dt);
}

// Boot: show the title over a quietly rendering arena so the first thing on
// screen is the game itself, not an empty background.
(async function boot() {
  ui.setBoot('Warming the shaders…');
  await new Promise((r) => requestAnimationFrame(r));
  ui.showTitle();
  ui.hideBoot();
  running = true;
  requestAnimationFrame(frame);
}());

// Handy for poking at the running game from the console.
if (import.meta.env?.DEV) {
  Object.assign(window, { __stage: stage, __ui: ui, __match: () => match });
}

export { stage, ui };
