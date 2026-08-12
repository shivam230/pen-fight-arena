/**
 * deploy.mjs — publish dist/ to the gh-pages branch.
 *
 *   npm run deploy
 *
 * GitHub Pages for this repo is configured the "legacy" way: it serves whatever
 * is at the root of the `gh-pages` branch, at
 * https://shivam230.github.io/pen-fight-arena/. So deploying is literally
 * "replace that branch's contents with a fresh build and push".
 *
 * Done through a git worktree rather than by checking branches out in place. A
 * plain `git checkout gh-pages` in the working directory would drop the source
 * tree on the floor mid-deploy and leave the repo on the wrong branch if
 * anything failed halfway. A worktree keeps the two completely separate, and the
 * `finally` below removes it whatever happens.
 *
 * The branch history is intentionally NOT preserved — each deploy is a single
 * commit replacing the last (`--force` on an orphan). Build output has no
 * meaningful history and keeping it would grow the repo forever.
 */

import { execSync } from 'node:child_process';
import { rmSync, mkdtempSync, writeFileSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const run = (cmd, cwd = root) =>
  execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const log = (m) => console.log(`\x1b[36m·\x1b[0m ${m}`);

// --- refuse to deploy something that is not committed ------------------------
// Publishing a build made from uncommitted edits produces a live site that no
// commit in the repo can reproduce. If it is worth shipping it is worth committing.
const dirty = run('git status --porcelain');
if (dirty) {
  console.error('\x1b[31mWorking tree is dirty.\x1b[0m Commit or stash first:\n');
  console.error(dirty);
  process.exit(1);
}

const sha = run('git rev-parse --short HEAD');
const branch = run('git rev-parse --abbrev-ref HEAD');
log(`deploying ${branch} @ ${sha}`);

// --- gate on the regression harness -----------------------------------------
// The whole point of `npm run check` is that it knows things a screenshot does
// not. Running it anywhere except immediately before a deploy makes it optional.
log('running checks…');
try {
  execSync('node tools/check.mjs', { cwd: root, stdio: 'inherit' });
} catch {
  console.error('\x1b[31mChecks failed — not deploying.\x1b[0m');
  process.exit(1);
}

log('building…');
run('npx vite build');

const dist = join(root, 'dist');
if (!existsSync(dist) || !readdirSync(dist).length) {
  console.error('\x1b[31mdist/ is empty after build.\x1b[0m');
  process.exit(1);
}

const wt = mkdtempSync(join(tmpdir(), 'pf-ghpages-'));
try {
  log('staging gh-pages worktree…');
  // Orphan: no parent, so the branch never accumulates build history.
  run(`git worktree add --force --detach "${wt}"`);
  run('git checkout --orphan gh-pages-deploy', wt);
  run('git rm -rf --cached . || true', wt);
  for (const entry of readdirSync(wt)) {
    if (entry === '.git') continue;
    rmSync(join(wt, entry), { recursive: true, force: true });
  }

  cpSync(dist, wt, { recursive: true });
  // Without this, Pages runs the output through Jekyll, which silently drops any
  // file or directory whose name starts with an underscore.
  writeFileSync(join(wt, '.nojekyll'), '');

  run('git add -A', wt);
  run(`git -c user.name="$(git config user.name)" `
    + `-c user.email="$(git config user.email)" `
    + `commit -q -m "deploy ${sha}"`, wt);
  log('pushing to gh-pages…');
  run('git push --force origin HEAD:gh-pages', wt);
} finally {
  run(`git worktree remove --force "${wt}" || true`);
  rmSync(wt, { recursive: true, force: true });
}

console.log('\n\x1b[32mLive:\x1b[0m https://shivam230.github.io/pen-fight-arena/');
console.log('(Pages usually takes 30-60s to serve the new build.)\n');
