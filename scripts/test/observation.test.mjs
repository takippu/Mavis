// Tests for the observation system.
//
// The tests that matter most here are the NEGATIVE ones. Detection and counting are easy to get
// right and easy to eyeball; the restraint is the part that silently regresses, because the way
// this feature fails is not "the numbers are wrong" but "six months from now someone adds a field
// for debugging and the log quietly contains every command line ever run". So the sensitive-data
// tests below assert on the SERIALISED LINE, not on the object: a field added by a future spread
// would pass an object-shape assertion and fail these.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OBSERVATION_DIR,
  resolveObservationDir,
  DEFAULT_RETENTION_DAYS,
  PRIVATE_AREAS,
  shortSession,
  deriveFileShape,
  deriveVerb,
  deriveRecord,
  formatLine,
  parseLines,
  appendObservation,
  listDayFiles,
  readObservations,
  filesToPrune,
  pruneObservations,
  computeStats,
  detectPatterns,
} from '../lib/observation-core.mjs';

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOOK = path.join(repoRoot, 'scripts', 'hooks', 'observe-tool.mjs');
const CLI = path.join(repoRoot, 'scripts', 'observe.mjs');

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `mavis-obs-${label}-`));
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

// A synthetic brain root. Only the directory shape matters -- deriveFileShape never reads files.
function fakeBrain() {
  const root = tmp('brain');
  for (const d of ['scripts/lib', 'skills/bluebird', 'projects/acme-portal', 'identity']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  return root;
}

const at = (iso) => new Date(iso);

// ---------------------------------------------------------------------------------------------
// 1. JSONL append shape
// ---------------------------------------------------------------------------------------------

test('a tool call appends exactly one compact JSON line to a per-day file', () => {
  const dir = tmp('append');
  try {
    const rec = deriveRecord(
      { session_id: 'A1B2C3D4-e5f6-7890-abcd-ef1234567890', tool_name: 'Edit', tool_input: { file_path: 'scripts/observe.mjs' } },
      { brainRoot: repoRoot, now: at('2026-08-03T09:12:33.101Z') }
    );
    const res = appendObservation(dir, rec);
    assert.equal(res.written, true);
    assert.equal(res.newDay, true, 'first write of a day reports newDay so rotation can hook it');
    assert.equal(path.basename(res.file), '2026-08-03.jsonl');

    const body = fs.readFileSync(res.file, 'utf8');
    assert.equal(body.split('\n').filter(Boolean).length, 1, 'exactly one line');
    assert.ok(body.endsWith('\n'), 'newline-terminated so the next append cannot fuse lines');

    const parsed = JSON.parse(body.trim());
    assert.deepEqual(parsed, {
      t: '2026-08-03T09:12:33.101Z',
      s: 'a1b2c3d4',
      tool: 'Edit',
      ext: '.mjs',
      area: 'scripts',
      pub: 1,
    });

    // A second append on the same day goes to the same file and is no longer a new day.
    const res2 = appendObservation(dir, { ...rec, tool: 'Read' });
    assert.equal(res2.newDay, false);
    assert.equal(fs.readFileSync(res.file, 'utf8').split('\n').filter(Boolean).length, 2);
  } finally {
    rm(dir);
  }
});

test('records from different days land in different files', () => {
  const dir = tmp('days');
  try {
    for (const day of ['2026-07-01', '2026-07-02', '2026-08-03']) {
      appendObservation(dir, { t: `${day}T10:00:00.000Z`, s: 'aaaa1111', tool: 'Read' });
    }
    assert.deepEqual(listDayFiles(dir), ['2026-07-01.jsonl', '2026-07-02.jsonl', '2026-08-03.jsonl']);
  } finally {
    rm(dir);
  }
});

test('a torn final line costs one record, not the whole file', () => {
  const dir = tmp('torn');
  try {
    const file = path.join(dir, '2026-08-03.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      '{"t":"2026-08-03T01:00:00.000Z","s":"aaaa1111","tool":"Read"}\n' +
        '\n' +
        '{"t":"2026-08-03T01:00:01.000Z","s":"aaaa1111","tool":"Ed'
    );
    const { records } = readObservations(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, 'Read');
  } finally {
    rm(dir);
  }
});

test('a day file past its byte cap stops growing instead of growing forever', () => {
  const dir = tmp('cap');
  try {
    const rec = { t: '2026-08-03T10:00:00.000Z', s: 'aaaa1111', tool: 'Bash', verb: 'node' };
    assert.equal(appendObservation(dir, rec, { maxDayBytes: 200 }).written, true);
    let guard = 0;
    let last = { written: true };
    while (last.written && guard < 50) {
      last = appendObservation(dir, rec, { maxDayBytes: 200 });
      guard += 1;
    }
    assert.equal(last.written, false);
    assert.equal(last.reason, 'day-file-full');
    assert.ok(fs.statSync(path.join(dir, '2026-08-03.jsonl')).size < 400, 'bounded, not unbounded');
  } finally {
    rm(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. The sensitive-data restraint -- the reason this feature is allowed to exist
// ---------------------------------------------------------------------------------------------

test('a Bash command records the first word only -- no arguments reach the line', () => {
  const brain = fakeBrain();
  try {
    // The credential is ASSEMBLED rather than written as a literal. A test that hardcodes a
    // secret-shaped string trips this repo's own leak guard on every commit, and a test that
    // teaches its owner to bypass the leak guard is worse than no test.
    const fakeToken = 'sk-' + 'ant-' + 'NOTAREALTOKEN00';
    const command =
      `curl -H "Authorization: Bearer ${fakeToken}" https://internal.northwind.example/api/customers?name=Grace`;
    const rec = deriveRecord({ session_id: 'sess', tool_name: 'Bash', tool_input: { command } }, { brainRoot: brain });
    const line = formatLine(rec);

    assert.equal(rec.verb, 'curl');
    // Assert on the SERIALISED line: an object-level check would pass even if a future field
    // carried the raw command along beside the verb.
    for (const forbidden of [
      'Authorization',
      'Bearer',
      fakeToken,
      'internal.northwind.example',
      'customers',
      'Grace',
      '-H',
      'https',
    ]) {
      assert.ok(!line.includes(forbidden), `"${forbidden}" must never appear in an observation line`);
    }
    assert.deepEqual(Object.keys(rec).sort(), ['s', 't', 'tool', 'verb']);
  } finally {
    rm(brain);
  }
});

test('a first word that is not a program name is discarded rather than recorded', () => {
  // Everything here is a fragment of something structured -- an inline env assignment, a quoted
  // path with spaces, a connection string, a heredoc, a substitution. Recording any of them
  // verbatim is the leak.
  //
  // REGRESSION. The first two of these shipped broken and this test caught it. Reducing the token
  // to a basename BEFORE validating it split the env assignment on the `/` inside the secret and
  // recorded `k7mdeng` -- a chunk of an AWS secret key -- as the verb; the quoted path recorded
  // the first directory component, which on a real machine is a client name. Both now reject
  // whole. Do not reorder the checks in deriveVerb.
  assert.equal(deriveVerb('AWS_SECRET_ACCESS_KEY=wJalrXUtn/K7MDENG git push'), '(other)');
  assert.equal(deriveVerb('"C:/Program Files/Acme Portal/tool.exe" --token abc'), '(other)');
  assert.equal(deriveVerb('<<EOF cat'), '(other)');
  assert.equal(deriveVerb('psql://user:pw@dbhost/northwind'), '(other)');
  assert.equal(deriveVerb('$(cat /run/secrets/token) deploy'), '(other)');
  assert.equal(deriveVerb('TOKEN=abcdefghijkl npm publish'), '(other)');
});

test('a program name is normalised to a bare basename', () => {
  assert.equal(deriveVerb('node --test "scripts/test/*.test.mjs"'), 'node');
  assert.equal(deriveVerb('C:/Program/nodejs/node.exe --version'), 'node');
  assert.equal(deriveVerb('/usr/local/bin/npm run build'), 'npm');
  assert.equal(deriveVerb('  git   commit -m "secret client name"'), 'git');
  assert.equal(deriveVerb('pwsh.exe -Command Get-ChildItem'), 'pwsh');
  assert.equal(deriveVerb(''), null);
});

test('a file path records the first segment only -- never the project slug', () => {
  const brain = fakeBrain();
  try {
    const shape = deriveFileShape(path.join(brain, 'projects/acme-portal/notes.md'), brain);
    assert.equal(shape.area, 'projects', 'the category, not the slug');
    assert.equal(shape.ext, '.md');
    assert.equal(shape.pub, 0, 'a private brain directory is tagged private');

    const rec = deriveRecord(
      { session_id: 's', tool_name: 'Write', tool_input: { file_path: path.join(brain, 'projects/acme-portal/notes.md') } },
      { brainRoot: brain }
    );
    assert.ok(!formatLine(rec).includes('acme-portal'), 'the slug must not survive into the record');
  } finally {
    rm(brain);
  }
});

test('Grep patterns, WebFetch urls and Task prompts are not read at all', () => {
  const brain = fakeBrain();
  try {
    const cases = [
      { tool_name: 'Grep', tool_input: { pattern: 'acme-portal|Ada Lovelace', path: '/home/ada/clients' } },
      { tool_name: 'WebFetch', tool_input: { url: 'https://northwind.example/invoices/8891', prompt: 'summarise Ada invoice' } },
      { tool_name: 'Task', tool_input: { prompt: 'migrate the bluebird client database', description: 'bluebird migration' } },
      { tool_name: 'mcp__pm__read_task', tool_input: { task_id: 'ACME-1234', title: 'Ada onboarding' } },
    ];
    for (const c of cases) {
      const line = formatLine(deriveRecord({ session_id: 's', ...c }, { brainRoot: brain }));
      for (const forbidden of ['acme-portal', 'Ada', 'northwind', 'bluebird', 'invoices', 'ACME-1234', 'onboarding', 'clients']) {
        assert.ok(!line.includes(forbidden), `${c.tool_name}: "${forbidden}" leaked into ${line}`);
      }
    }
  } finally {
    rm(brain);
  }
});

test('file CONTENT never reaches the record', () => {
  const brain = fakeBrain();
  try {
    const rec = deriveRecord(
      {
        session_id: 's',
        tool_name: 'Write',
        tool_input: {
          file_path: path.join(brain, 'scripts/lib/thing.mjs'),
          content: 'const CLIENT = "Northwind"; // Ada asked for this',
        },
        tool_response: { filePath: path.join(brain, 'scripts/lib/thing.mjs') },
      },
      { brainRoot: brain }
    );
    const line = formatLine(rec);
    assert.ok(!line.includes('Northwind'));
    assert.ok(!line.includes('Ada'));
    assert.ok(!line.includes('const'));
    assert.deepEqual(Object.keys(rec).sort(), ['area', 'ext', 'pub', 's', 't', 'tool']);
  } finally {
    rm(brain);
  }
});

test('the recorded key set is a closed allowlist', () => {
  // A regression guard with teeth: if someone adds a passthrough field, this fails immediately
  // rather than after a month of logging it.
  const brain = fakeBrain();
  try {
    const allowed = new Set(['t', 's', 'tool', 'ext', 'area', 'pub', 'verb', 'err']);
    const payloads = [
      { tool_name: 'Edit', tool_input: { file_path: path.join(brain, 'scripts/x.mjs'), old_string: 'a', new_string: 'b' } },
      { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'run the northwind suite' }, tool_response: { exit_code: 1 } },
      { tool_name: 'Read', tool_input: { file_path: '/somewhere/else/secret.env' } },
      { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' }, cwd: '/home/ada/clients/northwind' },
    ];
    for (const p of payloads) {
      const rec = deriveRecord({ session_id: 'zz', ...p }, { brainRoot: brain });
      for (const k of Object.keys(rec)) assert.ok(allowed.has(k), `unexpected key "${k}" in an observation record`);
    }
  } finally {
    rm(brain);
  }
});

test('a path outside the brain records as external with no publicity claim', () => {
  const brain = fakeBrain();
  const other = tmp('other');
  try {
    const shape = deriveFileShape(path.join(other, 'clients/northwind/secrets.ts'), brain);
    assert.equal(shape.area, '(external)');
    assert.equal(shape.pub, null);
    const rec = deriveRecord(
      { session_id: 's', tool_name: 'Read', tool_input: { file_path: path.join(other, 'clients/northwind/secrets.ts') } },
      { brainRoot: brain }
    );
    assert.equal(rec.area, '(external)');
    assert.ok(!('pub' in rec));
    assert.ok(!formatLine(rec).includes('northwind'));
  } finally {
    rm(brain);
    rm(other);
  }
});

test('session ids are shortened and normalised, and a missing one is not fatal', () => {
  assert.equal(shortSession('A1B2C3D4-e5f6-7890'), 'a1b2c3d4');
  assert.equal(shortSession(undefined), 'unknown');
  assert.equal(shortSession(''), 'unknown');
  const rec = deriveRecord({ tool_name: 'Read' }, { brainRoot: repoRoot });
  assert.equal(rec.s, 'unknown');
});

test('a payload with no tool name produces no record', () => {
  assert.equal(deriveRecord({}, {}), null);
  assert.equal(deriveRecord(null, {}), null);
  assert.equal(deriveRecord({ tool_name: 42 }, {}), null);
});

test('the private-area set covers the gitignored brain directories', () => {
  for (const d of ['identity', 'projects', 'daily-memories', 'preferences', 'rules', 'topics']) {
    assert.ok(PRIVATE_AREAS.has(d), `${d} must be tagged private`);
  }
  assert.ok(PRIVATE_AREAS.has(OBSERVATION_DIR), 'the log must not count its own writes as public');
  assert.ok(!PRIVATE_AREAS.has('scripts'));
  assert.ok(!PRIVATE_AREAS.has('skills'));
});

// ---------------------------------------------------------------------------------------------
// 3. Fail-open
// ---------------------------------------------------------------------------------------------

test('an unwritable observation directory fails open instead of throwing', () => {
  const root = tmp('unwritable');
  try {
    // Portable "cannot create this directory": a FILE already occupies the path. chmod is a no-op
    // on Windows, so this is the shape that actually reproduces everywhere CI runs.
    const blocked = path.join(root, OBSERVATION_DIR);
    fs.writeFileSync(blocked, 'not a directory');

    let res;
    assert.doesNotThrow(() => {
      res = appendObservation(blocked, { t: '2026-08-03T10:00:00.000Z', s: 'aaaa1111', tool: 'Read' });
    });
    assert.equal(res.written, false);
    assert.equal(res.reason, 'error');
    assert.ok(res.code, 'the errno is captured for anyone who goes looking');

    // Reading it back is equally quiet.
    assert.deepEqual(listDayFiles(blocked), []);
    assert.deepEqual(readObservations(blocked).records, []);
    assert.deepEqual(pruneObservations(blocked, { days: 1 }), []);
  } finally {
    rm(root);
  }
});

test('a bad timestamp is refused rather than creating a garbage file', () => {
  const dir = tmp('badstamp');
  try {
    const res = appendObservation(dir, { t: 'not-a-date', s: 'a', tool: 'Read' });
    assert.equal(res.written, false);
    assert.equal(res.reason, 'bad-timestamp');
    assert.deepEqual(listDayFiles(dir), []);
  } finally {
    rm(dir);
  }
});

test('the hook is silent, exits 0, and writes the record (end to end)', () => {
  const dir = tmp('hook');
  try {
    const payload = JSON.stringify({
      session_id: 'deadbeef-1111-2222-3333-444455556666',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test -- --grep "Northwind onboarding"' },
      tool_response: { exit_code: 0 },
    });
    const out = execFileSync(process.execPath, [HOOK], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, MAVIS_OBSERVATIONS_DIR: dir },
    });
    // ZERO TOKENS: a PostToolUse hook only reaches the model by printing. This one prints nothing.
    assert.equal(out, '', 'the hook must emit nothing at all -- output is what costs tokens');

    const files = listDayFiles(dir);
    assert.equal(files.length, 1);
    const body = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    const rec = JSON.parse(body.trim());
    assert.equal(rec.tool, 'Bash');
    assert.equal(rec.verb, 'npm');
    assert.equal(rec.s, 'deadbeef');
    assert.ok(!body.includes('Northwind'), 'arguments must not survive the hook either');
  } finally {
    rm(dir);
  }
});

test('the hook exits 0 and stays silent on garbage stdin and on an unwritable directory', () => {
  const root = tmp('hookfail');
  try {
    const blocked = path.join(root, 'blocked');
    fs.writeFileSync(blocked, 'not a directory');
    for (const input of ['', 'not json at all', '{"tool_name":', '{}']) {
      const out = execFileSync(process.execPath, [HOOK], {
        input,
        encoding: 'utf8',
        env: { ...process.env, MAVIS_OBSERVATIONS_DIR: blocked },
      });
      assert.equal(out, '');
    }
  } finally {
    rm(root);
  }
});

// ---------------------------------------------------------------------------------------------
// 4. Pruning by age
// ---------------------------------------------------------------------------------------------

test('filesToPrune selects strictly by the date in the filename', () => {
  const names = ['2026-06-01.jsonl', '2026-07-03.jsonl', '2026-07-04.jsonl', '2026-08-03.jsonl', 'notes.md', 'README'];
  const doomed = filesToPrune(names, { days: 30, now: at('2026-08-03T00:00:00.000Z') });
  assert.deepEqual(doomed, ['2026-06-01.jsonl', '2026-07-03.jsonl']);
  // 2026-07-04 is exactly the cutoff day and is kept: retention means "N days back", inclusive.
  assert.ok(!doomed.includes('2026-07-04.jsonl'));
  // Non-observation files in the directory are never candidates for deletion.
  assert.ok(!doomed.includes('notes.md'));
  assert.ok(!doomed.includes('README'));
});

test('prune deletes the out-of-window files and leaves the rest', () => {
  const dir = tmp('prune');
  try {
    for (const day of ['2026-05-01', '2026-06-15', '2026-07-20', '2026-08-03']) {
      appendObservation(dir, { t: `${day}T10:00:00.000Z`, s: 'aaaa1111', tool: 'Read' });
    }
    const removed = pruneObservations(dir, { days: 30, now: at('2026-08-03T12:00:00.000Z') });
    assert.deepEqual(removed, ['2026-05-01.jsonl', '2026-06-15.jsonl']);
    assert.deepEqual(listDayFiles(dir), ['2026-07-20.jsonl', '2026-08-03.jsonl']);
  } finally {
    rm(dir);
  }
});

test('a dry-run prune reports without deleting', () => {
  const dir = tmp('prunedry');
  try {
    appendObservation(dir, { t: '2026-01-01T10:00:00.000Z', s: 'aaaa1111', tool: 'Read' });
    const removed = pruneObservations(dir, { days: 30, now: at('2026-08-03T12:00:00.000Z'), dryRun: true });
    assert.deepEqual(removed, ['2026-01-01.jsonl']);
    assert.deepEqual(listDayFiles(dir), ['2026-01-01.jsonl'], 'still there');
  } finally {
    rm(dir);
  }
});

test('the default retention window is 30 days', () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 30);
});

test('the first append of a new day triggers rotation through the hook', () => {
  const dir = tmp('rotate');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), '{"t":"2020-01-01T00:00:00.000Z","s":"old","tool":"Read"}\n');
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: 'ffff0000', tool_name: 'Read', tool_input: { file_path: 'AGENTS.md' } }),
      encoding: 'utf8',
      env: { ...process.env, MAVIS_OBSERVATIONS_DIR: dir },
    });
    const files = listDayFiles(dir);
    assert.ok(!files.includes('2020-01-01.jsonl'), 'the ancient file is swept on the first write of a new day');
    assert.equal(files.length, 1, 'only today remains');
  } finally {
    rm(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// 5. Stats and pattern detection on a synthetic log
// ---------------------------------------------------------------------------------------------

// Two sessions of a plausible working day: read, edit, verify with npm, occasionally fail.
function syntheticLog() {
  const recs = [];
  let ms = Date.parse('2026-08-01T09:00:00.000Z');
  const push = (s, tool, extra = {}) => {
    ms += 15000;
    recs.push({ t: new Date(ms).toISOString(), s, tool, ...extra });
  };
  for (const s of ['sess0001', 'sess0002']) {
    for (let i = 0; i < 6; i++) {
      push(s, 'Read', { ext: '.mjs', area: 'scripts', pub: 1 });
      push(s, 'Edit', { ext: '.mjs', area: 'scripts', pub: 1 });
      push(s, 'Bash', { verb: 'npm', ...(i % 3 === 0 ? { err: 1 } : {}) });
    }
    push(s, 'Bash', { verb: 'git' });
    push(s, 'Write', { ext: '.md', area: 'daily-memories', pub: 0 });
  }
  return recs;
}

test('stats counts by tool, by day, by verb and by session', () => {
  const recs = syntheticLog();
  const stats = computeStats(recs, [{ bytes: 1234 }]);
  assert.equal(stats.total, 40);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.days, 1);
  assert.equal(stats.bytes, 1234);
  assert.equal(stats.errors, 4);
  assert.deepEqual(stats.byTool[0], ['Bash', 14]);
  assert.deepEqual(stats.byVerb[0], ['npm', 12]);
  assert.deepEqual(stats.byArea[0], ['scripts', 24]);
});

test('patterns finds the dominant shell verb with its session spread', () => {
  const { candidates, sessionCount } = detectPatterns(syntheticLog());
  assert.equal(sessionCount, 2);
  const npm = candidates.find((c) => c.id === 'shell-verb:npm');
  assert.ok(npm, 'npm surfaces as a candidate');
  assert.equal(npm.count, 12);
  assert.equal(npm.sessions, 2, 'seen in both sessions, so it is a habit and not one frantic afternoon');
  assert.match(npm.observation, /86% of all shell calls/);
  assert.equal(npm.proposal, 'prefers-npm-for-shell-work');

  // git ran twice, below the threshold, so it is not proposed as a preference.
  assert.ok(!candidates.some((c) => c.id === 'shell-verb:git'));
});

test('patterns finds the repeated Edit -> Bash transition', () => {
  const { candidates } = detectPatterns(syntheticLog());
  const seq = candidates.find((c) => c.id === 'sequence:Edit -> Bash');
  assert.ok(seq, 'the verify-after-edit habit is detected');
  assert.equal(seq.count, 12);
  assert.equal(seq.sessions, 2);
  assert.equal(seq.proposal, 'always-bash-after-edit');
});

test('patterns flags a command that keeps failing', () => {
  const { candidates } = detectPatterns(syntheticLog());
  const fail = candidates.find((c) => c.id === 'failing-verb:npm');
  assert.ok(fail);
  assert.equal(fail.count, 4);
  assert.match(fail.observation, /failed 4 of 12 run\(s\) \(33%\)/);
  assert.equal(fail.proposal, 'correct-invocation-for-npm');
});

test('patterns reports the memory-write cadence from what happened, not from what was claimed', () => {
  const { candidates } = detectPatterns(syntheticLog());
  const cadence = candidates.find((c) => c.id === 'memory-cadence');
  assert.ok(cadence);
  assert.equal(cadence.count, 2, 'two writes landed in private brain directories');
  assert.match(cadence.observation, /2 of 14 write\/edit operations \(14%\)/);

  // The zero case is the one worth catching: real work, no memory writes at all.
  const noMemory = syntheticLog().filter((r) => r.pub !== 0);
  const bare = detectPatterns(noMemory).candidates.find((c) => c.id === 'memory-cadence');
  assert.equal(bare.count, 0);
  assert.equal(bare.proposal, 'memory-writes-are-not-happening');
});

test('patterns stays quiet on a thin log rather than inventing rules', () => {
  const thin = [
    { t: '2026-08-01T09:00:00.000Z', s: 'a', tool: 'Read', ext: '.md', area: 'skills', pub: 1 },
    { t: '2026-08-01T09:00:10.000Z', s: 'a', tool: 'Bash', verb: 'ls' },
  ];
  const { candidates } = detectPatterns(thin);
  assert.deepEqual(candidates, [], 'two tool calls is not evidence of anything');
});

test('the threshold is adjustable', () => {
  const thin = [];
  let ms = Date.parse('2026-08-01T09:00:00.000Z');
  for (let i = 0; i < 3; i++) {
    ms += 1000;
    thin.push({ t: new Date(ms).toISOString(), s: 'a', tool: 'Bash', verb: 'cargo' });
  }
  assert.equal(detectPatterns(thin).candidates.length, 0);
  const loosened = detectPatterns(thin, { minCount: 3 }).candidates;
  assert.ok(loosened.some((c) => c.id === 'shell-verb:cargo'));
});

// ---------------------------------------------------------------------------------------------
// 6. The CLI
// ---------------------------------------------------------------------------------------------

function writeSynthetic(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const byDay = new Map();
  for (const r of syntheticLog()) {
    const day = r.t.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(formatLine(r));
  }
  for (const [day, lines] of byDay) fs.writeFileSync(path.join(dir, `${day}.jsonl`), lines.join('\n') + '\n');
}

const runCli = (args, dir) =>
  execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, MAVIS_OBSERVATIONS_DIR: dir } });

test('the CLI reports stats and patterns from a real directory', () => {
  const dir = tmp('cli');
  try {
    writeSynthetic(dir);
    const stats = JSON.parse(runCli(['stats', '--json'], dir));
    assert.equal(stats.total, 40);
    assert.equal(stats.sessions, 2);

    const text = runCli(['stats'], dir);
    assert.match(text, /40 tool call\(s\)/);
    assert.match(text, /By shell verb/);

    const patterns = runCli(['patterns'], dir);
    assert.match(patterns, /prefers-npm-for-shell-work/);
    // The refusal to write must be in the OUTPUT, not only in a code comment -- the output is the
    // part anyone reads.
    assert.match(patterns, /These are candidates, not entries\. This command writes nothing\./);
    assert.match(patterns, /Nothing under preferences\/ has been created/);
  } finally {
    rm(dir);
  }
});

test('the CLI prunes and dry-runs', () => {
  const dir = tmp('cliprune');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), '{"t":"2020-01-01T00:00:00.000Z","s":"a","tool":"Read"}\n');
    const dry = runCli(['prune', '--dry-run'], dir);
    assert.match(dry, /Would delete 1 of 1 day file/);
    assert.deepEqual(listDayFiles(dir), ['2020-01-01.jsonl']);

    const real = runCli(['prune'], dir);
    assert.match(real, /Deleted 1 day file/);
    assert.deepEqual(listDayFiles(dir), []);
  } finally {
    rm(dir);
  }
});

test('an empty log explains how to wire the hook instead of printing nothing', () => {
  const dir = tmp('cliempty');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const out = runCli(['stats'], dir);
    assert.match(out, /No observations yet/);
    assert.match(out, /PostToolUse/);
    assert.match(out, /hooks\.json/);
  } finally {
    rm(dir);
  }
});

test('an unknown command is a usage error, not a silent default', () => {
  const dir = tmp('cliusage');
  try {
    fs.mkdirSync(dir, { recursive: true });
    assert.throws(
      () => execFileSync(process.execPath, [CLI, 'summarise'], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, MAVIS_OBSERVATIONS_DIR: dir } }),
      (err) => err.status === 2
    );
  } finally {
    rm(dir);
  }
});

// ---------------------------------------------------------------------------------------------
// 7. On-disk growth -- the number the design has to justify
// ---------------------------------------------------------------------------------------------

test('100 tool calls cost well under 15 KB on disk', () => {
  const dir = tmp('growth');
  try {
    const brain = fakeBrain();
    const payloads = [
      { tool_name: 'Read', tool_input: { file_path: path.join(brain, 'scripts/lib/observation-core.mjs') } },
      { tool_name: 'Edit', tool_input: { file_path: path.join(brain, 'scripts/observe.mjs') } },
      { tool_name: 'Bash', tool_input: { command: 'node --test "scripts/test/*.test.mjs"' } },
      { tool_name: 'Grep', tool_input: { pattern: 'anything' } },
    ];
    let ms = Date.parse('2026-08-03T09:00:00.000Z');
    for (let i = 0; i < 100; i++) {
      ms += 1000;
      const rec = deriveRecord(
        { session_id: 'aabbccdd-eeff', ...payloads[i % payloads.length] },
        { brainRoot: brain, now: new Date(ms) }
      );
      appendObservation(dir, rec);
    }
    rm(brain);

    const bytes = fs.statSync(path.join(dir, '2026-08-03.jsonl')).size;
    assert.ok(bytes < 15 * 1024, `100 records took ${bytes} bytes, expected under 15 KB`);
    assert.equal(readObservations(dir).records.length, 100);
    // Printed so the measured figure in the report can be regenerated by anyone.
    console.log(`      [growth] 100 tool calls = ${bytes} bytes (${(bytes / 100).toFixed(1)} B/record)`);
  } finally {
    rm(dir);
  }
});

test('parseLines ignores anything that is not a record', () => {
  const recs = parseLines('# a comment\n[]\nnull\n{"tool":"Read","t":"2026-08-03T00:00:00.000Z"}\n{"no":"tool"}\n');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].tool, 'Read');
});

// ---- directory override must be absolute ----
//
// Regression: a caller passing `undefined` for the override put the LITERAL STRING "undefined"
// into the env, path.join turned it into a relative directory, and the hook wrote
// `undefined/lat/2026-08-03.jsonl` into the repository root. Telemetry that scatters itself
// across the filesystem when a variable is unset is worse than no telemetry.

test('a non-absolute or malformed dir override falls back to the brain directory', () => {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-obsdir-'));
  const fallback = path.join(brain, OBSERVATION_DIR);
  try {
    for (const bad of [undefined, null, '', 'undefined', 'relative/path', './here', '..']) {
      assert.equal(resolveObservationDir(brain, bad), fallback, `override ${JSON.stringify(bad)} must fall back`);
    }
    const good = path.join(os.tmpdir(), 'mavis-obs-explicit');
    assert.equal(resolveObservationDir(brain, good), good, 'an absolute override is honoured');
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});
