/**
 * check.mjs — the project's regression harness.
 *
 *   npm run check
 *
 * Everything the game promises that is NOT visible in a screenshot gets verified
 * here, headlessly, in a couple of seconds:
 *
 *   · BALANCE   the rival never fouls, rounds last long enough to be a rally
 *   · PERF      solver and AI stay inside the per-frame budget
 *   · SIZE      the shipped bundle stays under its ceiling
 *   · HYGIENE   no dead imports, no orphaned DOM ids, no stray debug code
 *
 * This is possible because physics.js, ai.js, tuning.js and pens.js are free of
 * any three.js import — the entire simulation runs in Node against the REAL
 * solver and the REAL planner, not a model of them. A balance claim made here is
 * a claim about the shipped game.
 *
 * Exits non-zero on any budget violation, so it can gate a release.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { PenWorld, Pen } from '../src/game/physics.js';
import { AiPlanner } from '../src/game/ai.js';
import { PENS } from '../src/game/pens.js';
import { impulseFor } from '../src/game/tuning.js';
import { Noise } from '../src/render/noise.js';

/*
 * Determinism.
 *
 * A regression gate that returns a different number every run cannot tell a
 * regression from noise — the self-out count alone swung 1..3 across identical
 * code. The planner reaches for Math.random in candidate generation and jitter,
 * and the player model uses it for aim error, so the honest fix is to make the
 * whole process deterministic rather than to seed each site. Same code in, same
 * verdict out; a changed number now means something changed.
 */
let _seed = 0x9e3779b9;
const reseed = (n) => { _seed = (0x9e3779b9 ^ Math.imul(n, 2654435761)) >>> 0 || 1; };
Math.random = () => {
  _seed ^= _seed << 13; _seed ^= _seed >>> 17; _seed ^= _seed << 5;
  return ((_seed >>> 0) / 4294967296);
};

const root = new URL('..', import.meta.url);
const rel = (p) => new URL(p, root);

// --------------------------------------------------------------- budgets ---

const BUDGET = {
  cpuFoulRate: 0,          // self-outs: the rival putting ITSELF over. Must be zero.
  openingKnockouts: 0,     // knocking the player out on the opening flick. Must be zero.
  minAvgTurns: 5.5,        // below this the game is ending in a couple of moves
  maxAvgTurns: 20,         // above this it is a stalemate, not a rally
  maxThinkMs: 16,          // one frame at 60fps — the AI is frame-sliced
  maxStepMs: 4,            // a full solver step at live fidelity
  maxBundleKB: 1100,       // gzipped JS+CSS+HTML
};

let failures = 0;
const ok = (label, detail) => console.log(`  \x1b[32mPASS\x1b[0m  ${label}  ${detail}`);
const bad = (label, detail) => {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}  ${detail}`);
};
const check = (cond, label, detail) => (cond ? ok(label, detail) : bad(label, detail));

// ------------------------------------------------------------ arena setup ---

/**
 * The same periodic radial boundary arena.js builds. Duplicated rather than
 * imported because arena.js pulls in three.js — but it is the same formula, so a
 * pen that survives here survives on the real ledge.
 */
function makeArena(seed) {
  const noise = new Noise(seed);
  let s = seed >>> 0;
  const rnd = () => (((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296));
  const a1 = 0.10 + rnd() * 0.06;
  const a2 = 0.035 + rnd() * 0.030;
  const k1 = 1.7 + rnd() * 1.1;
  const k2 = 4.2 + rnd() * 2.4;
  const phase = rnd() * 10;
  const faceAngle = rnd() * Math.PI * 2;
  const fn = (theta) => {
    const c = Math.cos(theta), sn = Math.sin(theta);
    const face = Math.max(0, Math.cos(theta - faceAngle)) ** 6 * 0.06;
    return 0.62 * (1 + a1 * noise.fbm(c * k1 + phase, sn * k1, 3)
      + a2 * noise.fbm(c * k2, sn * k2 + phase, 2) + face);
  };
  fn.faceAngle = faceAngle;
  return fn;
}

function settle(world, maxSeconds = 12) {
  let t = 0;
  let worstStep = 0;
  while (t < maxSeconds) {
    const t0 = performance.now();
    world.step(1 / 60);
    worstStep = Math.max(worstStep, performance.now() - t0);
    t += 1 / 60;
    if (world.isSettled()) break;
  }
  world.drainEvents();
  return { seconds: t, worstStep };
}

// ---------------------------------------------------------------- balance ---

/**
 * Play real rounds. The rival uses the shipped planner with its clean-play
 * filters; the "player" flicks like a person — roughly at the target, with
 * human-sized error — which is the case the fairness rules have to hold against.
 */
function playRound(seed, playerSpec, cpuSpec, stats) {
  const world = new PenWorld();
  const base = makeArena(seed);
  // match.js: the ledge starts closing in after 8 turns so a round cannot run
  // forever. Without modelling it the harness reports stalemates the real game
  // would never have, and every rally statistic is inflated.
  const CRUMBLE_AFTER_TURNS = 8, CRUMBLE_PER_TURN = 0.94, MIN_SHRINK = 0.30;
  let shrink = 1;
  world.boundary = (theta) => base(theta) * shrink;
  world.boundary.faceAngle = base.faceAngle;

  const player = world.add(new Pen(playerSpec, 'player'));
  const cpu = world.add(new Pen(cpuSpec, 'cpu'));
  const ai = new AiPlanner(world);

  const place = (pen, theta) => {
    const R = world.boundary(theta) * 0.56;
    pen.setPose(Math.cos(theta) * R, Math.sin(theta) * R, theta + Math.PI / 2);
    pen.alive = true;
    pen.falling = false;
  };
  place(player, base.faceAngle);
  place(cpu, base.faceAngle + Math.PI);

  // match.js::_rescue — neither side can be eliminated on their opening flick,
  // and it covers turns 0 AND 1 so going second is not a systematic advantage.
  const rescue = (pen) => {
    const theta = Math.atan2(pen.y, pen.x);
    const R = world.boundary(theta) * 0.80;
    pen.setPose(Math.cos(theta) * R, Math.sin(theta) * R, theta + Math.PI / 2);
    pen.alive = true;
    pen.falling = false;
    pen.height = 0;
    pen.vHeight = 0;
    pen.tumble = 0;
  };

  let turn = 0;
  const MAX_TURNS = 24;
  while (turn < MAX_TURNS && player.alive && cpu.alive) {
    const mine = turn % 2 === 0 ? player : cpu;
    const target = mine === player ? cpu : player;
    const opening = turn <= 1;

    if (mine === cpu) {
      // Frame-sliced exactly as the game does it, and timed the same way.
      const t0 = performance.now();
      // match.js::_beginTurn — plan against the ledge two turns from now.
      let projected = shrink;
      for (let k = 0; k < 2; k++) {
        if (turn + k + 1 >= CRUMBLE_AFTER_TURNS) {
          projected = Math.max(MIN_SHRINK, projected * CRUMBLE_PER_TURN);
        }
      }
      ai.setSafetyMargin(projected / shrink);
      ai.begin(cpu, player, opening);
      let plan = null;
      let slices = 0;
      while (!plan && slices < 400) { plan = ai.step(); slices++; }
      const think = performance.now() - t0;
      stats.thinkMs.push(think);
      if (!plan) { stats.noPlan++; break; }
      cpu.flick(Math.cos(plan.angle), Math.sin(plan.angle),
        impulseFor(cpu.spec, plan.power), plan.offset);
    } else {
      const bearing = Math.atan2(target.y - mine.y, target.x - mine.x);
      const angle = bearing + (Math.random() - 0.5) * 0.42;   // human aim error
      const power = 0.35 + Math.random() * 0.5;
      const offset = (Math.random() - 0.5) * mine.half;
      mine.flick(Math.cos(angle), Math.sin(angle), impulseFor(mine.spec, power), offset);
    }

    const { worstStep } = settle(world);
    stats.worstStep = Math.max(stats.worstStep, worstStep);

    // The two fouls the rival is forbidden from committing. Measured BEFORE the
    // opening rescue, so a rescue can never launder a foul into a pass.
    if (mine === cpu && (!cpu.alive || cpu.falling)) stats.cpuSelfOut++;
    if (mine === cpu && opening && (!player.alive || player.falling)) stats.openingKnockout++;

    if (opening) {
      if (!player.alive || player.falling) { rescue(player); stats.rescues++; }
      if (!cpu.alive || cpu.falling) { rescue(cpu); stats.rescues++; }
    }

    turn++;
    if (turn > CRUMBLE_AFTER_TURNS) {
      shrink = Math.max(MIN_SHRINK, shrink * CRUMBLE_PER_TURN);
      // match.js::_setShrink — the collapsing rim carries pens inward.
      for (const p of world.pens) {
        if (!p.alive || p.falling) continue;
        const edge = world.boundary(Math.atan2(p.y, p.x));
        const r = Math.hypot(p.x, p.y);
        if (r <= edge * CRUMBLE_PER_TURN) continue;
        const pull = (edge * CRUMBLE_PER_TURN * CRUMBLE_PER_TURN * 0.97) / (r || 1);
        p.x *= pull; p.y *= pull; p.wake();
      }
    }
  }
  stats.turns.push(turn);
  stats.finalShrink.push(shrink);
  stats.rounds++;
  if (!player.alive && !cpu.alive) stats.doubleOut++;
  else if (!cpu.alive) stats.playerWins++;
  else if (!player.alive) stats.cpuWins++;
  else stats.timeouts++;
}

/**
 * `--deep` sweeps five independent master seeds instead of one.
 *
 * Worth having as a switch rather than a default: a single seed runs in about a
 * second and is the right gate for an ordinary edit, but a balance claim needs
 * more than one seed behind it. Tuning a number until one seed reads zero is how
 * you overfit a harness — this is what tells the difference.
 */
function balance(rounds = 220) {
  const deep = process.argv.includes('--deep');
  const masters = deep ? [1, 2, 3, 4, 5] : [1];
  const stats = {
    rounds: 0, turns: [], thinkMs: [], worstStep: 0,
    cpuSelfOut: 0, openingKnockout: 0, noPlan: 0, rescues: 0, finalShrink: [],
    playerWins: 0, cpuWins: 0, doubleOut: 0, timeouts: 0,
  };
  for (const master of masters) {
    reseed(master);
    for (let i = 0; i < rounds; i++) {
      const a = PENS[i % PENS.length];
      const b = PENS[(i * 7 + 3) % PENS.length];
      playRound(1000 + i * 97 + master * 7, a, b, stats);
    }
  }
  const avg = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const pct = (a, p) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0;
  };
  const avgTurns = avg(stats.turns);

  console.log(`\n\x1b[1mBALANCE\x1b[0m  ${stats.rounds} rounds across `
    + `${masters.length} seed${masters.length > 1 ? 's' : ''}, real solver + real planner`
    + `${deep ? '' : '   (--deep for 5x)'}`);
  check(stats.cpuSelfOut === BUDGET.cpuFoulRate,
    'rival never knocks itself off ', `${stats.cpuSelfOut} self-outs`);
  check(stats.openingKnockout === BUDGET.openingKnockouts,
    'rival never wins on the open ', `${stats.openingKnockout} opening knockouts`);
  check(stats.noPlan === 0,
    'rival always finds a legal shot', `${stats.noPlan} dead ends`);
  check(avgTurns >= BUDGET.minAvgTurns && avgTurns <= BUDGET.maxAvgTurns,
    'rounds are rallies, not sprints', `avg ${avgTurns.toFixed(1)} turns `
      + `(min ${Math.min(...stats.turns)}, p90 ${pct(stats.turns, 0.9)})`);
  const shortRounds = stats.turns.filter((t) => t <= 2).length / stats.rounds;
  check(shortRounds < 0.05,
    'almost nothing ends by move 2 ', `${(shortRounds * 100).toFixed(1)}% of rounds`);
  console.log(`        record: player ${stats.playerWins} / rival ${stats.cpuWins}`
    + ` / draw ${stats.doubleOut} / hit turn cap ${stats.timeouts}`
    + `  ·  ${stats.rescues} opening rescues`);
  return stats;
}

// ------------------------------------------------------------------- perf ---

/*
 * Timing is judged on p99, not on the single worst sample.
 *
 * The simulation is deterministic but the clock is not: the same code measured
 * 6.0 ms worst three runs in a row on an idle machine and 17.9 ms once while a
 * bundler and a browser were competing for the CPU. Failing a release on one
 * scheduler hiccup teaches people to ignore the gate, which is worse than not
 * having it. p99 still catches a real regression — the AI runs hundreds of plans
 * per run, so a genuine slowdown moves the whole distribution — while surviving
 * one outlier. The worst sample is still printed, just not enforced.
 */
function perf(stats) {
  const avg = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const sorted = [...stats.thinkMs].sort((a, b) => a - b);
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] || 0;
  const worstThink = sorted[sorted.length - 1] || 0;
  console.log('\n\x1b[1mPERF\x1b[0m');
  check(p99 <= BUDGET.maxThinkMs,
    'AI think fits inside a frame  ',
    `avg ${avg(stats.thinkMs).toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, `
      + `worst ${worstThink.toFixed(2)} ms (budget ${BUDGET.maxThinkMs} ms on p99)`);
  check(stats.worstStep <= BUDGET.maxStepMs,
    'solver step inside budget     ',
    `worst ${stats.worstStep.toFixed(2)} ms (budget ${BUDGET.maxStepMs} ms)`);
}

// ------------------------------------------------------------------- size ---

function size() {
  console.log('\n\x1b[1mSIZE\x1b[0m');
  if (!existsSync(rel('dist'))) {
    console.log('  ....  no dist/ — running vite build');
    execSync('npx vite build', { cwd: rel('.'), stdio: 'ignore' });
  }
  let total = 0;
  const rows = [];
  const walk = (dir, prefix = '') => {
    for (const e of readdirSync(new URL(dir + '/', root), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk(p, prefix); continue; }
      if (!/\.(js|css|html)$/.test(e.name)) continue;
      const gz = execSync(`gzip -c "${new URL(p, root).pathname}" | wc -c`).toString().trim();
      const kb = Number(gz) / 1024;
      total += kb;
      rows.push([p.replace('dist/', ''), kb]);
    }
  };
  walk('dist');
  rows.sort((a, b) => b[1] - a[1]);
  for (const [name, kb] of rows.slice(0, 6)) {
    console.log(`        ${name.padEnd(38)} ${kb.toFixed(1)} KB gz`);
  }
  check(total <= BUDGET.maxBundleKB,
    'bundle under ceiling          ',
    `${total.toFixed(1)} KB gzipped (budget ${BUDGET.maxBundleKB} KB)`);
}

// ---------------------------------------------------------------- hygiene ---

/**
 * The failures that cost the most time historically were not logic bugs — they
 * were a getElementById returning null after a refactor, or a leftover console
 * statement shipping to production. Both are mechanically detectable.
 */
function hygiene() {
  console.log('\n\x1b[1mHYGIENE\x1b[0m');
  const html = readFileSync(rel('index.html'), 'utf8');
  const srcFiles = [];
  const walkSrc = (dir) => {
    for (const e of readdirSync(new URL(dir + '/', root), { withFileTypes: true })) {
      if (e.isDirectory()) walkSrc(`${dir}/${e.name}`);
      else if (e.name.endsWith('.js')) srcFiles.push(`${dir}/${e.name}`);
    }
  };
  walkSrc('src');
  const js = srcFiles.map((f) => [f, readFileSync(rel(f), 'utf8')]);
  const allJs = js.map(([, c]) => c).join('\n');

  // Every getElementById target must exist in the markup.
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...allJs.matchAll(/getElementById\('([^']+)'\)|\$\('([^']+)'\)/g)]
    .map((m) => m[1] || m[2])
    .filter((id) => !ids.has(id));
  check(missing.length === 0, 'every DOM lookup resolves     ',
    missing.length ? `missing: ${[...new Set(missing)].join(', ')}` : `${ids.size} ids, all found`);

  // Nothing should import a file that no longer exists.
  const badImports = [];
  for (const [file, content] of js) {
    for (const m of content.matchAll(/from '(\.[^']+)'/g)) {
      const target = new URL(m[1], new URL(file, root));
      if (!existsSync(target)) badImports.push(`${file} -> ${m[1]}`);
    }
  }
  check(badImports.length === 0, 'no imports of deleted modules ',
    badImports.length ? badImports.join(', ') : `${js.length} modules resolve`);

  const debug = js.filter(([, c]) => /console\.(log|debug)\(|debugger;/.test(c))
    .map(([f]) => f);
  check(debug.length === 0, 'no debug code in src          ',
    debug.length ? debug.join(', ') : 'clean');
}

// ------------------------------------------------------------------- main ---

console.log('\x1b[1m\nPen Fight — regression check\x1b[0m');
const stats = balance();
perf(stats);
hygiene();
size();

console.log(failures === 0
  ? '\n\x1b[32mAll checks passed.\x1b[0m\n'
  : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures ? 1 : 0);
