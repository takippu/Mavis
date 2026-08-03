'use strict';

// Brain rot monitor: spawns the brain's own scripts/lint-brain.mjs and caches its JSON report.
// Read-only -- this module never edits brain files; it shells out to the brain's scripts and
// renders what they say. (Repair is a separate, explicitly gated flow.)
//
// TWO THINGS THAT LOOK LIKE BUGS AND ARE NOT:
//
// 1. Exit code 1 is SUCCESS. lint-brain.mjs exits 1 whenever any FAIL-severity flag exists, so a
//    non-zero exit WITH parseable stdout is a valid report. The real brain currently reports 30
//    fails -- treating exit 1 as an error would leave the health card permanently empty. Exit 2
//    means the lint itself could not run: that IS an error and is surfaced as one.
//
// 2. lint-brain.mjs SELF-LOCATES its brain root from import.meta.url and ignores cwd, so the
//    scriptPath -- not the cwd -- decides which brain gets linted. The default below derives the
//    script from brainRoot precisely so the two can never disagree. cwd is still set to brainRoot
//    for the child's benefit, but it is not what makes the lint target correct.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Spawn options for every brain-script child.
 *
 * ELECTRON_RUN_AS_NODE IS LOAD-BEARING, NOT A TWEAK. In the packaged app `process.execPath` is
 * electron.exe, not node. `electron.exe some-script.mjs` does not run it as a Node script -- it
 * boots a full Electron app using that file as the entry, and the Electron event loop then keeps
 * the process alive FOREVER unless the script calls process.exit() itself. That is why this bug
 * hid: lint-brain.mjs ends with an unconditional `process.exit(fail ? 1 : 0)` so it always
 * terminates, while brain-repair.mjs only exits explicitly on its ERROR paths -- its two SUCCESS
 * paths just console.log and fall off the end. Result: repair preview/apply hung forever in the
 * real app (callback never fires) while every unit test passed, because tests run under plain
 * `node` where execPath is node.exe and falling off the end exits cleanly.
 *
 * This flag makes electron.exe behave as plain Node, which is what these scripts actually are.
 * Do not rely on the child's explicit process.exit() instead: that is the accident that made
 * lint look fine, and process.exit() straight after a console.log to a pipe can truncate stdout.
 */
function spawnOpts(brainRoot, maxBuffer) {
  return {
    cwd: brainRoot,
    windowsHide: true,
    maxBuffer,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  };
}

function runLint(brainRoot, opts, cb) {
  const script = (opts && opts.scriptPath) || path.join(brainRoot, 'scripts', 'lint-brain.mjs');
  execFile(
    process.execPath,
    [script, '--json'],
    spawnOpts(brainRoot, 8 * 1024 * 1024),
    (err, stdout) => {
      // exit 1 + stdout = FAIL flags present = a real report. Anything else non-zero is an error.
      if (err && !(err.code === 1 && stdout)) return cb(err);
      let report;
      try {
        report = JSON.parse(stdout);
      } catch (e) {
        return cb(e);
      }
      cb(null, report);
    }
  );
}

function createHealthMonitor({ brainRoot, scriptPath, debounceMs = 2000, onUpdate, onError } = {}) {
  let last = null;
  let timer = null;
  let running = false;
  let pending = false;

  function run() {
    // COALESCE, never drop. `if (running) return` would silently discard the newest request and
    // leave a stale report on screen -- exactly the 2026-07-17 git-badge lag bug. Mark pending
    // and re-run on land instead, so the last brain edit always wins.
    if (running) {
      pending = true;
      return;
    }
    running = true;
    runLint(brainRoot, { scriptPath }, (err, report) => {
      running = false;
      if (err) {
        if (onError) onError(err);
      } else {
        last = report;
        if (onUpdate) onUpdate(report);
      }
      if (pending) {
        pending = false;
        run();
      }
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
    if (timer.unref) timer.unref(); // never hold the event loop open on quit
  }

  return { run, schedule, last: () => last };
}

// ---------------------------------------------------------------------------
// Repair: the gated Fix flow. THE ONLY PATH IN THIS APP THAT CAN REWRITE THE BRAIN.
//
// The brain's personal data is GITIGNORED -- git will not bring it back. The safety model is
// four layers, and every one of them is load-bearing:
//
//   1. VALIDATE BEFORE SPAWN (this file). The renderer is not a trust boundary: it never supplies
//      a path, and `command`/`project` are checked here, in main, before any process exists.
//   2. DRY-RUN FIRST. A repair is planned and rendered as a diff before anything is written.
//   3. EXPLICIT APPLY. createRepairGate refuses to apply a plan that was never previewed, so no
//      code path -- present or future -- can reach a write without a human seeing the diff first.
//   4. THE SCRIPT BACKS UP. brain-repair.mjs copies every original to _backup/repair-<stamp>/
//      before the first write, and writes atomically. The app never edits brain files itself.
//
// WHY APPLY REPLAYS THE PREVIEWED PLAN (--plan=-) INSTEAD OF RE-PLANNING:
// re-planning at apply time would read the tree a SECOND time, so the diff the human approved and
// the diff that actually ran would be two different reads of a tree other sessions also write to.
// Feeding the approved plan back means applyPlan verifies each `before` against disk and refuses a
// stale plan outright -- an edit that lands between preview and apply becomes a refusal, not a
// silent clobber. brain-repair.mjs's own header calls this out as the preferred flow.

// Exactly the two repairs brain-repair.mjs implements. An allowlist, never a pattern: the value
// goes into an argv slot, and "looks harmless" is not a security property.
const REPAIR_COMMANDS = new Set(['rotate', 'shard-notes']);
// Mirrors brain-repair.mjs's own project regex. No separators, no drive letters, and it cannot
// start with '.', so '..' and every traversal spelling die here rather than at path.join.
const PROJECT_RE = /^[a-z0-9][a-z0-9._-]*$/;

function badRequest(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Validate a repair request against the brain on disk. Returns an Error (never throws) so both
 * callers can decide how to surface it. This runs BEFORE any spawn -- that ordering IS the
 * trust boundary, not a nicety.
 */
function validateRepair(brainRoot, command, project) {
  if (typeof command !== 'string' || !REPAIR_COMMANDS.has(command)) {
    return badRequest('EBADCMD', `unsupported repair command: ${JSON.stringify(command)}`);
  }
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) {
    return badRequest('EBADPROJ', `invalid project name: ${JSON.stringify(project)}`);
  }
  // The name must resolve to a real directory DIRECTLY under <brainRoot>/projects/. Main derives
  // this path itself; the renderer only ever names a slug.
  const projectsDir = path.resolve(brainRoot, 'projects');
  const dir = path.resolve(projectsDir, project);
  if (path.dirname(dir) !== projectsDir) {
    // Unreachable while PROJECT_RE holds (it admits no separators) -- kept as a second, independent
    // check so a future loosening of the regex cannot quietly become a traversal.
    return badRequest('EBADPROJ', `project escapes the projects directory: ${JSON.stringify(project)}`);
  }
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return badRequest('EBADPROJ', `no such project: ${project}`);
  }
  if (!st.isDirectory()) return badRequest('EBADPROJ', `not a project directory: ${project}`);
  return null;
}

/**
 * Spawn the brain's own scripts/brain-repair.mjs.
 *
 * runRepair(brainRoot, { command, project, apply, plan, scriptPath }, cb)
 *   - apply falsy  -> `--dry-run --json`, cb(null, plan). Writes nothing.
 *   - apply truthy -> `--apply --json --plan=-` with `plan` piped to stdin,
 *                     cb(null, { applied, summary, backupDir }).
 *
 * Unlike lint-brain.mjs (which self-locates its root from import.meta.url), brain-repair.mjs takes
 * its root from process.cwd() -- so `cwd` here is what decides which brain gets written. It is not
 * cosmetic.
 */
function runRepair(brainRoot, opts, cb) {
  const o = opts || {};
  const bad = validateRepair(brainRoot, o.command, o.project);
  if (bad) return void cb(bad); // reject BEFORE spawning: nothing has run at this point

  const script = o.scriptPath || path.join(brainRoot, 'scripts', 'brain-repair.mjs');
  const apply = !!o.apply;
  if (apply && (!o.plan || !Array.isArray(o.plan.writes))) {
    return void cb(badRequest('ENOPLAN', 'apply requires the plan returned by a dry-run preview'));
  }

  const args = [script, o.command, o.project];
  args.push(apply ? '--apply' : '--dry-run', '--json');
  if (apply) args.push('--plan=-');

  const child = execFile(
    process.execPath,
    args,
    spawnOpts(brainRoot, 32 * 1024 * 1024),
    (err, stdout, stderr) => {
      if (err) {
        // brain-repair exits 1 with a human-readable reason on stderr (a drifted plan, an
        // already-sharded notes.md). Surface THAT, not execFile's generic "Command failed".
        const detail = String(stderr || '').trim() || (err && err.message) || 'repair failed';
        return cb(badRequest('EREPAIR', detail));
      }
      try {
        cb(null, JSON.parse(stdout));
      } catch (e) {
        cb(badRequest('EREPAIR', `could not parse repair output: ${e.message}`));
      }
    }
  );
  if (apply) {
    // A plan is ~100KB+, so this write is buffered and the child may die before draining it.
    // Without this handler an EPIPE would surface as an unhandled 'error' event and take the
    // main process down; the execFile callback already reports the real failure.
    child.stdin.on('error', () => { /* the callback above surfaces the actual failure */ });
    child.stdin.end(JSON.stringify(o.plan));
  }
}

/**
 * The preview -> approve -> apply gate. Owns the previewed plans so that APPLY CANNOT HAPPEN
 * WITHOUT A PREVIEW: main hands the renderer a plan to render, and the renderer names a repair to
 * apply -- it never hands back content. That keeps the renderer out of the trust boundary even
 * though the applied bytes are exactly the previewed ones.
 *
 * Plans are held in a per-key Map, not a single slot: previewing project B then applying project A
 * must still work (a one-entry cache thrashes on A -> B -> A).
 *
 * Both methods resolve to an { error } sentinel rather than rejecting -- the same posture as the
 * git:* handlers, so an IPC caller never has to care about throw-vs-return.
 */
function createRepairGate({ brainRoot, scriptPath } = {}) {
  const plans = new Map(); // `${command}:${project}` -> plan from the last preview

  const key = (c, p) => `${c}:${p}`;
  const sentinel = (e) => ({ error: `${e.code || 'EREPAIR'}: ${e.message}` });

  function preview({ command, project } = {}) {
    return new Promise((resolve) => {
      runRepair(brainRoot, { command, project, scriptPath }, (err, plan) => {
        if (err) return resolve(sentinel(err));
        plans.set(key(command, project), plan);
        resolve(plan);
      });
    });
  }

  function apply({ command, project } = {}) {
    return new Promise((resolve) => {
      const bad = validateRepair(brainRoot, command, project);
      if (bad) return resolve(sentinel(bad));
      const k = key(command, project);
      const plan = plans.get(k);
      if (!plan) {
        return resolve(sentinel(badRequest('ENOPLAN', 'preview this repair before applying it')));
      }
      // Consume the plan up front. It describes a pre-image that this apply is about to destroy,
      // so it is single-use whatever happens: on success it is stale by definition, and on failure
      // re-previewing is the only honest way back (a retry against an unknown tree is not).
      plans.delete(k);
      runRepair(brainRoot, { command, project, apply: true, plan, scriptPath }, (err, res) => {
        resolve(err ? sentinel(err) : res);
      });
    });
  }

  return { preview, apply, forget: () => plans.clear() };
}

module.exports = { runLint, createHealthMonitor, runRepair, createRepairGate, validateRepair, spawnOpts };
