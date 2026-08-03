'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionManager } = require('../src/session-manager');
const sessionEvents = require('../src/session-events');

// A spawn stub that records each created term (no node-pty needed).
function capturingSpawn() {
  const terms = [];
  const spawn = () => {
    const term = {
      killed: false,
      written: [],
      write(d) { this.written.push(d); },
      resize() {},
      kill() { this.killed = true; },
    };
    terms.push(term);
    return { ok: true, term };
  };
  return { spawn, terms };
}

test('create assigns unique ids and tracks size', () => {
  const { spawn } = capturingSpawn();
  const m = new SessionManager({ spawn });
  const a = m.create({ cwd: '/a' });
  const b = m.create({ cwd: '/b' });
  assert.ok(a.ok && b.ok);
  assert.notStrictEqual(a.id, b.id);
  assert.strictEqual(m.size, 2);
  assert.ok(m.has(a.id) && m.has(b.id));
});

test('create echoes back resolved label and cwd', () => {
  const { spawn } = capturingSpawn();
  const m = new SessionManager({ spawn });
  const r = m.create({ cwd: '/x', label: 'bluebird' });
  assert.strictEqual(r.label, 'bluebird');
  assert.strictEqual(r.cwd, '/x');
});

test('write targets the right session term', () => {
  const { spawn, terms } = capturingSpawn();
  const m = new SessionManager({ spawn });
  const a = m.create({});
  const b = m.create({});
  m.write(a.id, 'to-a');
  assert.deepStrictEqual(terms[0].written, ['to-a']);
  assert.deepStrictEqual(terms[1].written, []);
});

test('close removes one session and kills its term', () => {
  const { spawn, terms } = capturingSpawn();
  const m = new SessionManager({ spawn });
  const a = m.create({});
  const b = m.create({});
  m.close(a.id);
  assert.strictEqual(m.size, 1);
  assert.ok(!m.has(a.id) && m.has(b.id));
  assert.ok(terms[0].killed && !terms[1].killed);
});

test('closeAll kills everything and empties the map', () => {
  const { spawn, terms } = capturingSpawn();
  const m = new SessionManager({ spawn });
  m.create({});
  m.create({});
  m.create({});
  m.closeAll();
  assert.strictEqual(m.size, 0);
  assert.ok(terms.every((t) => t.killed));
});

test('create returns ok:false when spawn fails (and adds nothing)', () => {
  const m = new SessionManager({ spawn: () => ({ ok: false, reason: 'claude-not-found' }) });
  const r = m.create({});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'claude-not-found');
  assert.strictEqual(m.size, 0);
});

test('write/resize/close on an unknown id are no-ops', () => {
  const { spawn } = capturingSpawn();
  const m = new SessionManager({ spawn });
  assert.doesNotThrow(() => {
    m.write('nope', 'x');
    m.resize('nope', 80, 24);
    m.close('nope');
  });
  assert.strictEqual(m.size, 0);
});

function fakeTerm() {
  return { write() {}, resize() {}, kill() {}, onData() {}, onExit() {} };
}

test('create() records the harness and mints a sidecar token', () => {
  const seen = [];
  const sm = new SessionManager({ spawn: (o) => { seen.push(o); return { ok: true, term: fakeTerm() }; } });
  const r = sm.create({ cwd: 'C:/p', harness: 'codex' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.harness, 'codex');
  assert.strictEqual(seen[0].harness, 'codex', 'passed through to the spawner');
  assert.match(sm.tokenFor(r.id), /^[0-9a-f-]{36}$/, 'a uuid token for sidecar correlation');
});

test('create() defaults to claude when no harness is given', () => {
  const sm = new SessionManager({ spawn: () => ({ ok: true, term: fakeTerm() }) });
  assert.strictEqual(sm.create({ cwd: 'C:/p' }).harness, 'claude');
});

test('a shell pane never gets a harness or a token', () => {
  const sm = new SessionManager({ spawnShell: () => ({ ok: true, term: fakeTerm() }) });
  const r = sm.create({ cwd: 'C:/p', kind: 'shell' });
  assert.strictEqual(r.kind, 'shell');
  assert.strictEqual(r.harness, null);
  assert.strictEqual(sm.tokenFor(r.id), null);
});

test('idForToken resolves a live token, null for an unknown token, null for a shell pane', () => {
  const sm = new SessionManager({
    spawn: () => ({ ok: true, term: fakeTerm() }),
    spawnShell: () => ({ ok: true, term: fakeTerm() }),
  });
  const mavis = sm.create({ cwd: 'C:/p' });
  const shell = sm.create({ cwd: 'C:/p', kind: 'shell' });
  const token = sm.tokenFor(mavis.id);
  assert.strictEqual(sm.idForToken(token), mavis.id, 'resolves the live token back to its session id');
  assert.strictEqual(sm.idForToken('not-a-real-token'), null, 'unknown token → null');
  // a shell pane never gets a token (tokenFor(shell.id) is null); idForToken must degrade to null
  // rather than throw or match the wrong session.
  assert.strictEqual(sm.tokenFor(shell.id), null);
  assert.strictEqual(sm.idForToken(sm.tokenFor(shell.id)), null, 'shell pane → null');
});

test('close(id) removes that session\'s sidecar files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-session-manager-'));
  const prevUserData = process.env.MAVIS_USER_DATA;
  process.env.MAVIS_USER_DATA = dir;
  try {
    sessionEvents.ensure(dir);
    const sm = new SessionManager({ spawn: () => ({ ok: true, term: fakeTerm() }) });
    const r = sm.create({ cwd: 'C:/p' });
    const token = sm.tokenFor(r.id);
    const sidecarFile = path.join(sessionEvents.eventsDir(dir), token + '.jsonl');
    fs.writeFileSync(sidecarFile, JSON.stringify({ state: 'done', at: Date.now() }) + '\n');
    assert.ok(fs.existsSync(sidecarFile), 'fixture file exists before close');
    sm.close(r.id);
    assert.ok(!fs.existsSync(sidecarFile), 'close() cleaned up the sidecar file');
  } finally {
    process.env.MAVIS_USER_DATA = prevUserData;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autorun writes the command, then a SEPARATE Enter after the settle', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const terms = [];
  const spawn = ({ onData }) => {
    const term = { written: [], _fire: onData, write(d) { this.written.push(d); }, resize() {}, kill() {} };
    terms.push(term);
    return { ok: true, term };
  };
  const m = new SessionManager({ spawn });
  m.create({ cwd: '/x', label: 'bb', autorun: { command: '/mavis bb', delayMs: 1000, enterDelayMs: 200 } });
  terms[0]._fire('first output'); // the CLI's first output arms the autorun timer
  t.mock.timers.tick(1000);
  assert.deepStrictEqual(terms[0].written, ['/mavis bb']); // command typed, NOT yet submitted
  t.mock.timers.tick(200);
  assert.deepStrictEqual(terms[0].written, ['/mavis bb', '\r']); // Enter sent on its own
});
