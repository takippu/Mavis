'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { HunterStore } = require('../src/lead-hunter-store'), { HunterQueue } = require('../src/lead-hunter-queue');
const input = extra => ({ goal: 'Find workshops', filters: { region: 'Selangor', ...extra } });
function candidate(id) { return { id, company: id, industry: 'Workshops', region: 'Selangor', city: '', address: '', website: { state: 'unknown', url: '' }, contact: { email: '', phone: '', form: '' }, sources: [{ url: 'https://business.example/' + id, label: '', observedAt: '2026-10-13T01:00:00Z' }], identityKeys: ['business:' + id], duplicate: { kind: 'none', recordIds: [] }, discoveredAt: '2026-10-13T01:00:00Z' }; }
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-queue-')), store = new HunterStore(dir), calls = []; let active = 0, peak = 0;
  const runner = { run(args) { active++; peak = Math.max(peak, active); return new Promise((resolve, reject) => calls.push({ ...args, resolve: result => { active--; resolve(result); }, reject: error => { active--; reject(error); } })); } };
  const queue = new HunterQueue({ store, runner, ...options }); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return { store, queue, calls, peak: () => peak };
}
function fakeClock() { let now = 0, seq = 0; const timers = new Map(); return { now: () => now, setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout(id) { timers.delete(id); }, advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } }, count: () => timers.size }; }
test('constructor is inert; FIFO rapid submissions retain filters and peak one runner', async t => {
  const f = fixture(t), a = f.queue.submit(input({ city: 'A' })), b = f.queue.submit(input({ city: 'B' })); await tick(); assert.equal(f.calls.length, 0);
  await f.queue.recover(); await tick(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].job.id, a.id); assert.equal(f.calls[0].job.filters.city, 'A');
  f.calls[0].resolve({ candidates: [], exhausted: true }); await tick(); assert.equal(f.calls[1].job.id, b.id); assert.equal(f.calls[1].job.filters.city, 'B');
  f.calls[1].resolve({ candidates: [], exhausted: true }); await tick(); assert.equal(f.peak(), 1); assert.ok(f.store.snapshot().jobs.every(j => j.status === 'completed')); await f.queue.shutdown();
});
test('cancel fences late success and waits for teardown before launching next task', async t => {
  const f = fixture(t); await f.queue.recover(); const a = f.queue.submit(input()), b = f.queue.submit(input()); await tick();
  const cancelling = f.queue.cancel(a.id); await tick(); assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls.length, 1);
  f.calls[0].resolve({ candidates: [candidate('late')], exhausted: true }); await cancelling; await tick(); assert.equal(f.store.snapshot().candidates.length, 0); assert.equal(f.calls[1].job.id, b.id);
  f.calls[1].resolve({ candidates: [], exhausted: true }); await tick(); assert.equal(f.peak(), 1); await f.queue.shutdown();
});
test('pause and repeated resume do not double launch; completed batch retained on suspend', async t => {
  const f = fixture(t); await f.queue.recover(); f.queue.submit(input()); await tick(); f.calls[0].resolve({ candidates: [candidate('saved')], exhausted: false }); await tick();
  assert.equal(f.calls.length, 2); const pausing = f.queue.pause('Machine went to sleep.'); const resuming = f.queue.resume(); const twice = f.queue.resume(); await tick(); assert.equal(f.calls.length, 2);
  f.calls[1].resolve({ candidates: [candidate('late')], exhausted: true }); await Promise.all([pausing, resuming, twice]); await tick(); assert.equal(f.calls.length, 3); assert.equal(f.store.snapshot().candidates.length, 1);
  f.calls[2].resolve({ candidates: [], exhausted: true }); await tick(); assert.equal(f.peak(), 1); await f.queue.shutdown();
});
test('startup running attempt becomes paused and no worker starts without Resume', async t => {
  const f = fixture(t), job = f.store.enqueue(input()); f.store.transition(job.id, job.revision, 'running', '', { attemptId: crypto.randomUUID() });
  await f.queue.recover(); await f.queue.recover(); await tick(); assert.equal(f.calls.length, 0); assert.equal(f.store.snapshot().jobs[0].status, 'paused');
  await f.queue.resume(); await tick(); assert.equal(f.calls.length, 1); f.calls[0].resolve({ candidates: [], exhausted: true }); await tick(); await f.queue.shutdown();
});
test('network retries use 15/60/180 seconds then fail; auth and quota require explicit Resume', async t => {
  const clock = fakeClock(), f = fixture(t, { clock }); await f.queue.recover(); f.queue.submit(input()); await tick();
  for (const delay of [15000, 60000, 180000]) { const call = f.calls.at(-1); call.reject(Object.assign(new Error('offline'), { code: 'NETWORK' })); await tick(); const count = f.calls.length; clock.advance(delay - 1); await tick(); assert.equal(f.calls.length, count); clock.advance(1); await tick(); assert.equal(f.calls.length, count + 1); }
  f.calls.at(-1).reject(Object.assign(new Error('offline'), { code: 'NETWORK' })); await tick(); assert.equal(f.store.snapshot().jobs[0].status, 'failed');
  f.queue.submit(input()); await tick(); f.calls.at(-1).reject(Object.assign(new Error('login'), { code: 'AUTH' })); await tick(); const count = f.calls.length; clock.advance(50000); await tick(); assert.equal(f.calls.length, count); assert.equal(f.store.snapshot().jobs[1].status, 'waiting');
  await f.queue.resume(); await tick(); f.calls.at(-1).reject(Object.assign(new Error('quota'), { code: 'QUOTA' })); await tick(); clock.advance(50000); await tick(); assert.equal(f.store.snapshot().jobs[1].errorCode, 'QUOTA'); await f.queue.shutdown(); assert.equal(clock.count(), 0);
});
test('batch timeout and shutdown await child teardown and reject late output', async t => {
  const clock = fakeClock(), f = fixture(t, { clock, policy: { batchTimeoutMs: 50 } }); await f.queue.recover(); f.queue.submit(input()); await tick(); clock.advance(50); await tick(); assert.equal(f.calls[0].signal.aborted, true);
  f.calls[0].resolve({ candidates: [candidate('late')], exhausted: true }); await tick(); assert.equal(f.store.snapshot().jobs[0].errorCode, 'TIMEOUT'); assert.equal(f.store.snapshot().candidates.length, 0);
  f.queue.submit(input()); await tick(); let finished = false; const shutdown = f.queue.shutdown().then(() => { finished = true; }); await tick(); assert.equal(finished, false);
  f.calls[1].resolve({ candidates: [candidate('late-two')], exhausted: true }); await shutdown; assert.equal(f.store.snapshot().jobs[1].status, 'paused'); assert.equal(f.store.snapshot().candidates.length, 0); assert.equal(clock.count(), 0);
});
test('duplicate repeats and two no-new batches stop honestly below maximum', async t => {
  const f = fixture(t); await f.queue.recover(); f.queue.submit(input()); await tick(); f.calls[0].resolve({ candidates: [candidate('same')], exhausted: false }); await tick();
  f.calls[1].resolve({ candidates: [candidate('same')], exhausted: false }); await tick(); f.calls[2].resolve({ candidates: [candidate('same')], exhausted: false }); await tick();
  assert.equal(f.calls.length, 3); assert.equal(f.store.snapshot().candidates.length, 1); assert.equal(f.store.snapshot().jobs[0].completedBatches, 3); assert.match(f.store.snapshot().jobs[0].reason, /no new/); await f.queue.shutdown();
});
test('auth blocks the entire queue until explicit recovery, including newly submitted jobs', async t => {
  const f = fixture(t); await f.queue.recover(); f.queue.submit(input()); f.queue.submit(input()); await tick();
  f.calls[0].reject(Object.assign(new Error('Sign in'), { code: 'AUTH' })); await tick(); f.queue.submit(input()); await tick(); assert.equal(f.calls.length, 1);
  await f.queue.resume(); await tick(); assert.equal(f.calls.length, 2); f.calls[1].resolve({ candidates: [], exhausted: true }); await tick(); assert.equal(f.calls.length, 3);
  const stopping = f.queue.shutdown(); f.calls[2].resolve({ candidates: [], exhausted: true }); await stopping;
});
test('expired deadline after a long pause completes without invalid transitions or a new worker', async t => {
  const clock = fakeClock(), f = fixture(t, { clock, policy: { taskTimeoutMs: 1000 } }); await f.queue.recover(); f.queue.submit(input()); await tick();
  const pause = f.queue.pause(); f.calls[0].resolve({ candidates: [], exhausted: true }); await pause; clock.advance(2000); await f.queue.resume(); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.store.snapshot().jobs[0].status, 'completed'); assert.match(f.store.snapshot().jobs[0].reason, /time budget/); await f.queue.shutdown();
});
test('interrupted restart retains FIFO globally paused, including queued work', async t => {
  const f = fixture(t), job = f.store.enqueue(input()); f.store.enqueue(input()); f.store.transition(job.id, job.revision, 'running', '', { attemptId: crypto.randomUUID() });
  await f.queue.recover(); await tick(); assert.equal(f.calls.length, 0); assert.equal(f.store.snapshot().paused, true);
  await f.queue.resume(); await tick(); assert.equal(f.calls[0].job.id, job.id); const stopping = f.queue.shutdown(); f.calls[0].resolve({ candidates: [], exhausted: true }); await stopping;
});
test('original strict filters reject unknown websites, absent contacts and wrong locations', async t => {
  const f = fixture(t); await f.queue.recover(); f.queue.submit(input({ website: 'not_observed', contact: 'email' })); await tick();
  const unknown = candidate('unknown'), noContact = { ...candidate('noContact'), website: { state: 'not_observed', url: '' } }, wrongLocation = { ...noContact, id: 'elsewhere', region: 'Johor', contact: { email: 'public@business.example', phone: '', form: '' } };
  f.calls[0].resolve({ candidates: [unknown, noContact, wrongLocation], exhausted: true }); await tick(); assert.equal(f.store.snapshot().candidates.length, 0); await f.queue.shutdown();
});
test('shared corporate source URL does not collapse distinct branches across batches', async t => {
  const f = fixture(t); await f.queue.recover(); f.queue.submit(input()); await tick();
  const first = { ...candidate('branch-a'), company: 'Branch brand', city: 'Shah Alam', address: 'Street A', sources: [{ url: 'https://brand.example/', label: '', observedAt: '2026-10-13T01:00:00Z' }], identityKeys: ['source:https://brand.example/', 'business:branchbrand:selangor:shahalam:streeta'] };
  const second = { ...first, id: 'branch-b', city: 'Klang', address: 'Street B', identityKeys: ['source:https://brand.example/', 'business:branchbrand:selangor:klang:streetb'] };
  f.calls[0].resolve({ candidates: [first], exhausted: false }); await tick(); f.calls[1].resolve({ candidates: [second], exhausted: true }); await tick(); assert.equal(f.store.snapshot().candidates.length, 2); await f.queue.shutdown();
});
test('hard batch budget stops partial results and storage-full failures remain visible', async t => {
  const f = fixture(t, { policy: { maxBatches: 1 } }); await f.queue.recover(); f.queue.submit(input()); await tick(); f.calls[0].resolve({ candidates: [candidate('one')], exhausted: false }); await tick(); assert.match(f.store.snapshot().jobs[0].reason, /Batch budget/); assert.equal(f.calls.length, 1); await f.queue.shutdown();
  const g = fixture(t); await g.queue.recover(); g.queue.submit(input()); await tick(); g.store.maxBytes = fs.statSync(g.store.file).size + 300;
  g.calls[0].resolve({ candidates: [candidate('too-big')], exhausted: false }); await tick(); assert.equal(g.store.snapshot().candidates.length, 0); assert.equal(g.store.snapshot().jobs[0].status, 'failed'); assert.equal(g.store.snapshot().jobs[0].errorCode, 'HUNTER_FULL'); await g.queue.shutdown();
});
test('pause write failure still aborts and reaps the child before rejecting, preserving the file', async t => {
  const f = fixture(t); await f.queue.recover(); f.queue.submit(input()); await tick(); const bytes = fs.readFileSync(f.store.file), write = f.store.write.bind(f.store);
  f.store.write = () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); };
  let settled = false; const pause = f.queue.pause().then(() => { settled = true; }, error => { settled = true; throw error; }); const checked = assert.rejects(pause, { code: 'ENOSPC' });
  await tick(); assert.equal(f.calls[0].signal.aborted, true); assert.equal(settled, false); assert.deepEqual(fs.readFileSync(f.store.file), bytes);
  f.calls[0].resolve({ candidates: [candidate('late')], exhausted: true }); await checked; assert.equal(f.store.snapshot().candidates.length, 0); assert.equal(f.queue.runtimeError.code, 'ENOSPC');
  f.store.write = write; await f.queue.shutdown();
});
test('shutdown corrupt checkpoint still reaps before rejecting and never overwrites either file', async t => {
  const f = fixture(t); await f.queue.recover(); f.queue.submit(input()); await tick(); const valid = fs.readFileSync(f.store.file), backup = fs.readFileSync(f.store.file + '.bak'); fs.writeFileSync(f.store.file, '{broken');
  let settled = false; const shutdown = f.queue.shutdown().then(() => { settled = true; }, error => { settled = true; throw error; }); const checked = assert.rejects(shutdown, { code: 'HUNTER_CORRUPT' });
  await tick(); assert.equal(f.calls[0].signal.aborted, true); assert.equal(settled, false); assert.equal(fs.readFileSync(f.store.file, 'utf8'), '{broken'); assert.deepEqual(fs.readFileSync(f.store.file + '.bak'), backup);
  f.calls[0].resolve({ candidates: [candidate('late')], exhausted: true }); await checked; assert.equal(f.queue.active, null); assert.equal(fs.readFileSync(f.store.file, 'utf8'), '{broken');
  fs.writeFileSync(f.store.file, valid); await f.queue.shutdown(); assert.equal(f.store.snapshot().jobs[0].status, 'paused');
});
test('runtime transition failure stops scheduling; Resume fences stranded running state before clearing error', async t => {
  const f = fixture(t); await f.queue.recover(); const first = f.queue.submit(input()), second = f.queue.submit(input()); await tick();
  const write = f.store.write.bind(f.store); f.store.write = () => { throw Object.assign(new Error('Disk unavailable'), { code: 'EIO' }); };
  f.calls[0].resolve({ candidates: [candidate('not-saved')], exhausted: true }); await tick(); assert.equal(f.calls.length, 1); assert.equal(f.store.snapshot().jobs[0].status, 'running'); assert.equal(f.queue.runtimeError.code, 'EIO');
  await assert.rejects(f.queue.resume(), { code: 'EIO' }); await tick(); assert.equal(f.calls.length, 1); assert.equal(f.queue.runtimeError.code, 'EIO');
  f.store.write = write; await f.queue.resume(); await tick(); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].job.id, first.id); assert.equal(f.store.snapshot().jobs.filter(j => j.status === 'running').length, 1); assert.equal(f.queue.runtimeError, null);
  f.calls[1].resolve({ candidates: [], exhausted: true }); await tick(); assert.equal(f.calls[2].job.id, second.id); assert.equal(f.peak(), 1); const stopping = f.queue.shutdown(); f.calls[2].resolve({ candidates: [], exhausted: true }); await stopping;
});
test('shutdown full-storage rejection reaps first and retry checkpoints once storage is restored', async t => {
  const f = fixture(t); await f.queue.recover(); f.queue.submit(input()); await tick(); const bytes = fs.readFileSync(f.store.file), write = f.store.write.bind(f.store);
  f.store.write = () => { throw Object.assign(new Error('Discovery storage full'), { code: 'HUNTER_FULL' }); };
  let settled = false; const shutdown = f.queue.shutdown().then(() => { settled = true; }, error => { settled = true; throw error; }); const checked = assert.rejects(shutdown, { code: 'HUNTER_FULL' });
  await tick(); assert.equal(f.calls[0].signal.aborted, true); assert.equal(settled, false); f.calls[0].reject(Object.assign(new Error('Stopped'), { code: 'PROCESS' })); await checked;
  assert.deepEqual(fs.readFileSync(f.store.file), bytes); assert.equal(f.queue.active, null); assert.equal(f.queue.started, false); assert.equal(f.queue.runtimeError.code, 'HUNTER_FULL');
  f.store.write = write; await f.queue.shutdown(); assert.equal(f.store.snapshot().jobs[0].status, 'paused'); assert.equal(f.store.snapshot().paused, true);
});
test('cancel checkpoint failure cannot keep its child alive or launch a queued successor', async t => {
  const f = fixture(t); await f.queue.recover(); const first = f.queue.submit(input()); f.queue.submit(input()); await tick(); const write = f.store.write.bind(f.store);
  f.store.write = () => { throw Object.assign(new Error('Read-only disk'), { code: 'EROFS' }); };
  const checked = assert.rejects(f.queue.cancel(first.id), { code: 'EROFS' }); await tick(); assert.equal(f.calls[0].signal.aborted, true); f.calls[0].resolve({ candidates: [candidate('late')], exhausted: true }); await checked; await tick(); assert.equal(f.calls.length, 1); assert.equal(f.store.snapshot().candidates.length, 0);
  f.store.write = write; await f.queue.shutdown();
});
