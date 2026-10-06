'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceService } = require('../src/workspace-service');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-workspaces-')); const a = path.join(dir, 'a'), b = path.join(dir, 'b'), data = path.join(dir, 'state'); fs.mkdirSync(a); fs.mkdirSync(b); fs.mkdirSync(data); fs.writeFileSync(path.join(a, 'same.txt'), 'alpha\r\n'); fs.writeFileSync(path.join(b, 'same.txt'), 'beta'); const svc = new WorkspaceService(data); t.after(() => { svc.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); }); return { svc, a, b, data, dir }; }
test('canonical project identity deduplicates aliases and confines paths', async t => { const { svc, a, b, dir } = fixture(t); const wa = svc.open(a), wb = svc.open(b); assert.notEqual(wa.id, wb.id); assert.equal(svc.open(path.join(a, '.')).id, wa.id); assert.equal((await svc.read(wa.id, 'same.txt')).text, 'alpha\r\n'); assert.equal((await svc.read(wb.id, 'same.txt')).text, 'beta'); await assert.rejects(svc.read(wa.id, '../b/same.txt')); fs.symlinkSync(b, path.join(a, 'escape')); await assert.rejects(svc.read(wa.id, 'escape/same.txt')); svc.close(wa.id); assert.throws(() => svc.get(wa.id)); });
test('revision save rejects external change and preserves BOM/CRLF', async t => { const { svc, a } = fixture(t); fs.writeFileSync(path.join(a, 'bom.txt'), '\ufeffhello\r\n'); const w = svc.open(a), read = await svc.read(w.id, 'bom.txt'); assert.equal(read.bom, true); assert.equal(read.eol, 'CRLF'); fs.writeFileSync(path.join(a, 'bom.txt'), 'external'); const stale = await svc.save(w.id, 'bom.txt', 'local', read.revision); assert.equal(stale.code, 'CONFLICT'); assert.equal(fs.readFileSync(path.join(a, 'bom.txt'), 'utf8'), 'external'); const now = await svc.read(w.id, 'bom.txt'); const saved = await svc.save(w.id, 'bom.txt', 'next\r\n', now.revision, { bom: true, modelVersion: 4 }); assert.equal(saved.ok, true); assert.equal(saved.modelVersion, 4); assert.equal(fs.readFileSync(path.join(a, 'bom.txt'), 'utf8'), '\ufeffnext\r\n'); });
test('serialized simultaneous saves acknowledge only one matching revision', async t => { const { svc, a } = fixture(t); const w = svc.open(a), read = await svc.read(w.id, 'same.txt'); const results = await Promise.all([svc.save(w.id, 'same.txt', 'first', read.revision), svc.save(w.id, 'same.txt', 'second', read.revision)]); assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results[1].code, 'CONFLICT'); });
test('recovery and metadata survive corruption and retain project identities', async t => { const { svc, a, data } = fixture(t); const w = svc.open(a); const state = { version: 3, activeId: w.id, workspaces: [w] }; svc.persist(state); svc.persist({ ...state, marker: 2 }); fs.writeFileSync(path.join(data, 'workspace-state.json'), '{'); assert.equal(svc.load().activeId, w.id); svc.recovery(w.id, 'same.txt', { text: 'unsaved', revision: 'old' }); assert.equal(svc.recovery(w.id, 'same.txt').text, 'unsaved'); svc.recovery(w.id, 'same.txt', null); assert.equal(svc.recovery(w.id, 'same.txt'), null); assert.throws(() => svc.recovery('../../', 'x', { text: 'bad' })); });
test('legacy migration merges duplicate roots and retains terminal cwd overrides', t => { const { svc, a, b, data } = fixture(t); fs.writeFileSync(path.join(data, 'session-state.json'), JSON.stringify({ version: 2, activeCwd: a, sessions: [{ cwd: a, label: 'A', harness: 'codex', layout: { leaf: { kind: 'mavis', cwd: b, label: 'Cross project' } } }, { cwd: a, label: 'A shell', layout: { leaf: { kind: 'shell' } } }] })); const migrated = svc.load(); assert.equal(migrated.workspaces.length, 1); assert.equal(migrated.workspaces[0].terminals.length, 2); assert.equal(migrated.workspaces[0].terminals[0].cwd, b); assert.equal(migrated.workspaces[0].terminals[0].kind, 'codex'); assert.ok(fs.existsSync(path.join(data, 'session-state.pre-workspace.json'))); assert.deepEqual(svc.load(), migrated); });
test('file mutations refuse overwrite and binary/invalid UTF8 stay unsupported', async t => { const { svc, a } = fixture(t); const w = svc.open(a); assert.equal((await svc.mutate(w.id, { operation: 'file', rel: 'same.txt' })).code, 'CONFLICT'); await svc.mutate(w.id, { operation: 'folder', rel: 'new' }); await svc.mutate(w.id, { operation: 'file', rel: 'new/file.txt' }); await svc.mutate(w.id, { operation: 'rename', rel: 'new/file.txt', to: 'new/renamed.txt' }); assert.ok(fs.existsSync(path.join(a, 'new/renamed.txt'))); fs.writeFileSync(path.join(a, 'binary'), Buffer.from([0, 1])); fs.writeFileSync(path.join(a, 'invalid'), Buffer.from([255, 254])); assert.ok((await svc.read(w.id, 'binary')).unsupported); assert.ok((await svc.read(w.id, 'invalid')).unsupported); });
test('images use their byte signature and text saves cannot overwrite previews', async t => {
  const { svc, a } = fixture(t), w = svc.open(a);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJosAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(a, 'misleading.txt'), png);
  const image = await svc.read(w.id, 'misleading.txt');
  assert.equal(image.preview.kind, 'image'); assert.equal(image.preview.mime, 'image/png');
  assert.deepEqual(Buffer.from(image.preview.dataUrl.split(',')[1], 'base64'), png);
  await assert.rejects(svc.save(w.id, 'misleading.txt', '', image.revision), { code: 'READ_ONLY' });
  assert.deepEqual(fs.readFileSync(path.join(a, 'misleading.txt')), png);
  fs.writeFileSync(path.join(a, 'plain.png'), 'this is actually text'); assert.equal((await svc.read(w.id, 'plain.png')).text, 'this is actually text');
});
test('byte previews are bounded and oversized images do not allocate full data URLs', async t => {
  const { svc, a } = fixture(t), w = svc.open(a);
  fs.writeFileSync(path.join(a, 'large.bin'), Buffer.alloc(3 * 1024 * 1024, 255));
  const bin = await svc.read(w.id, 'large.bin'); assert.equal(bin.preview.kind, 'binary'); assert.equal(bin.preview.shown, 65536); assert.equal(bin.preview.truncated, true); assert.match(bin.preview.text, /^00000000  ff ff/);
  const file = path.join(a, 'large.png'); fs.writeFileSync(file, Buffer.from([137,80,78,71,13,10,26,10])); fs.truncateSync(file, 3 * 1024 * 1024);
  assert.equal((await svc.read(w.id, 'large.png')).preview.kind, 'image');
  fs.truncateSync(file, 21 * 1024 * 1024);
  const oversized = await svc.read(w.id, 'large.png'); assert.equal(oversized.preview.kind, 'binary'); assert.match(oversized.unsupported, /20 MiB/); assert.equal(oversized.preview.dataUrl, undefined);
});
