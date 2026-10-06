'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const browser = require('./fs-browser');
const { imageMime, bytePreview, BYTE_LIMIT, IMAGE_LIMIT } = require('./file-preview');
const MAX = 2 * 1024 * 1024;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const key = p => process.platform === 'win32' ? p.toLowerCase() : p;
function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
function atomic(file, value, backup = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  if (backup && fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.renameSync(temp, file);
}

class WorkspaceService {
  constructor(dir, { onChange = () => {}, trash = null } = {}) {
    this.dir = dir; this.registry = new Map(); this.locks = new Map(); this.searches = new Map(); this.onChange = onChange; this.trash = trash;
  }
  open(root, metadata = {}) {
    const real = fs.realpathSync(root);
    if (!fs.statSync(real).isDirectory() || real === path.parse(real).root) fail('ROOT', 'Choose a project folder, not a filesystem root.');
    for (const rec of this.registry.values()) if (key(rec.root) === key(real)) return this.public(rec);
    const id = metadata.id && /^[a-zA-Z0-9-]{1,80}$/.test(metadata.id) && !this.registry.has(metadata.id) ? metadata.id : crypto.randomUUID();
    const rec = { id, root: real, name: metadata.name || path.basename(real), slug: metadata.slug || null, watcher: null };
    this.registry.set(id, rec);
    try {
      let timer;
      rec.watcher = fs.watch(real, { recursive: true }, (_type, rel) => {
        if (rel && rel.split(path.sep).some(x => ['node_modules', '.git', 'dist', 'build'].includes(x))) return;
        clearTimeout(timer); timer = setTimeout(() => this.onChange({ workspaceId: id, rel: rel || null }), 150);
      });
      rec.watcher.on('error', () => this.onChange({ workspaceId: id, reconcile: true }));
      rec.cancel = () => clearTimeout(timer);
    } catch { /* focus reconciliation also covers unsupported recursive watchers */ }
    return this.public(rec);
  }
  public(rec) { return { id: rec.id, root: rec.root, name: rec.name, slug: rec.slug }; }
  get(id) {
    const rec = this.registry.get(id); if (!rec) fail('ROOT', 'Project is not open.');
    if (!fs.existsSync(rec.root)) fail('ROOT_MISSING', 'Project folder is unavailable.');
    return rec;
  }
  close(id) { this.cancelSearch(id); const r = this.registry.get(id); if (r) { r.cancel?.(); r.watcher?.close(); this.registry.delete(id); } }
  closeAll() { for (const id of this.registry.keys()) this.close(id); }
  roots() { return [...this.registry.values()].map(r => r.root); }
  list(id, rel = '.') { return browser.listDir(this.get(id).root, rel); }
  cancelSearch(id) { this.searches.get(id)?.abort(); this.searches.delete(id); }
  async search(id, query, mode) { this.cancelSearch(id); const controller = new AbortController(); this.searches.set(id, controller); try { return await browser.searchFiles(this.get(id).root, query, { mode, signal: controller.signal }); } finally { if (this.searches.get(id) === controller) this.searches.delete(id); } }
  async read(id, rel) {
    const target = browser.safeResolve(this.get(id).root, rel);
    const st = await fsp.stat(target); if (!st.isFile()) fail('NOT_FILE', 'Not a regular file.');
    if (st.size > MAX) {
      const handle = await fsp.open(target, 'r');
      let head;
      try { const buffer = Buffer.alloc(BYTE_LIMIT); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); head = buffer.subarray(0, bytesRead); } finally { await handle.close(); }
      const mime = imageMime(head);
      if (mime && st.size <= IMAGE_LIMIT) {
        const bytes = await fsp.readFile(target);
        return { preview: { kind: 'image', mime, dataUrl: 'data:' + mime + ';base64,' + bytes.toString('base64') }, size: bytes.length, revision: hash(bytes) };
      }
      return { unsupported: mime ? 'Image exceeds the 20 MiB preview limit.' : 'File exceeds the 2 MiB text editor limit.', preview: bytePreview(head, st.size), size: st.size, revision: hash(head) + ':' + st.size + ':' + st.mtimeMs };
    }
    const b = await fsp.readFile(target);
    const mime = imageMime(b);
    if (mime) return { preview: { kind: 'image', mime, dataUrl: 'data:' + mime + ';base64,' + b.toString('base64') }, size: b.length, revision: hash(b) };
    const binary = reason => ({ unsupported: reason, preview: bytePreview(b, b.length), size: b.length, revision: hash(b) });
    if (b.includes(0)) return binary('Binary file. Read-only byte preview.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b); } catch { return binary('Unsupported text encoding. Read-only byte preview.'); }
    const bom = text.charCodeAt(0) === 0xfeff; if (bom) text = text.slice(1);
    return { text, revision: hash(b), bom, eol: text.includes('\r\n') ? 'CRLF' : 'LF', size: b.length };
  }
  async exclusive(file, action) {
    const prev = this.locks.get(file) || Promise.resolve();
    const next = prev.catch(() => {}).then(action); this.locks.set(file, next);
    try { return await next; } finally { if (this.locks.get(file) === next) this.locks.delete(file); }
  }
  async save(id, rel, text, expectedRevision, options = {}) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX) fail('TOO_LARGE', 'Editable files must be smaller than 2 MiB.');
    const root = this.get(id).root; const target = browser.safeResolve(root, rel);
    return this.exclusive(target, async () => {
      const current = await this.read(id, rel).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (current?.preview) fail('READ_ONLY', 'Image and byte previews cannot be saved as text.');
      let before = null, mode = 0o644;
      try { before = await fsp.readFile(target); mode = (await fsp.stat(target)).mode; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const revision = before === null ? null : hash(before);
      if (revision !== expectedRevision) return { ok: false, code: 'CONFLICT', message: 'The file changed on disk. Compare before saving.', disk: await this.read(id, rel).catch(() => ({ text: '', revision: null, missing: true })) };
      const bytes = Buffer.from((options.bom ? '\ufeff' : '') + text, 'utf8');
      const temp = target + '.' + crypto.randomUUID() + '.tmp';
      try {
        await fsp.writeFile(temp, bytes, { flag: 'wx', mode });
        browser.safeResolve(root, rel);
        let check = null; try { check = hash(await fsp.readFile(target)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (check !== revision) return { ok: false, code: 'CONFLICT', message: 'File changed during save. Retry after comparing.' };
        if (before) {
          const recovery = path.join(this.dir, 'workspace-overwritten'); await fsp.mkdir(recovery, { recursive: true, mode: 0o700 });
          await fsp.writeFile(path.join(recovery, hash(Buffer.from(target)) + '.previous'), before, { mode: 0o600 });
        }
        await fsp.rename(temp, target);
        return { ok: true, revision: hash(bytes), modelVersion: options.modelVersion };
      } finally { await fsp.unlink(temp).catch(() => {}); }
    });
  }
  async mutate(id, { operation, rel, to }) {
    const root = this.get(id).root; const source = browser.safeResolve(root, rel);
    if (source === root) fail('PATH', 'The project root cannot be changed here.');
    if (operation === 'file') return this.save(id, rel, '', null);
    if (operation === 'folder') { await fsp.mkdir(source); return { ok: true }; }
    if (operation === 'rename') {
      const dest = browser.safeResolve(root, to); if (fs.existsSync(dest)) fail('EXISTS', 'Destination already exists.');
      await fsp.rename(source, dest); return { ok: true };
    }
    if (operation === 'trash' && this.trash) { await this.trash(source); return { ok: true }; }
    fail('OPERATION', 'Unsupported file operation.');
  }
  stateFile() { return path.join(this.dir, 'workspace-state.json'); }
  load() {
    for (const file of [this.stateFile(), this.stateFile() + '.bak']) {
      try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); if (s.version === 3 && Array.isArray(s.workspaces)) return s; } catch {}
    }
    try {
      const old = JSON.parse(fs.readFileSync(path.join(this.dir, 'session-state.json'), 'utf8'));
      const groups = new Map();
      function leaves(node, out = []) { if (node?.leaf) out.push(node.leaf); else for (const child of node?.children || []) leaves(child, out); return out; }
      for (const s of old.sessions || []) {
        if (typeof s.cwd !== 'string') continue;
        let root = s.cwd; try { root = fs.realpathSync(root); } catch {}
        let w = groups.get(key(root));
        if (!w) { w = { id: crypto.randomUUID(), root, name: s.label || path.basename(root), view: 'files', documents: [], terminals: [], legacyLayouts: [] }; groups.set(key(root), w); }
        w.legacyLayouts.push(s.layout);
        for (const leaf of leaves(s.layout || { leaf: { kind: 'mavis' } })) w.terminals.push({ id: crypto.randomUUID(), kind: leaf.kind === 'shell' ? 'shell' : (s.harness || 'claude'), label: leaf.label || (leaf.kind === 'shell' ? 'Shell' : s.label), cwd: leaf.cwd || s.cwd, restored: true });
      }
      let activeRoot = old.activeCwd; try { activeRoot = fs.realpathSync(activeRoot); } catch {}
      const state = { version: 3, workspaces: [...groups.values()], activeId: [...groups.values()].find(w => key(w.root) === key(activeRoot || ''))?.id || null, migrated: true };
      fs.copyFileSync(path.join(this.dir, 'session-state.json'), path.join(this.dir, 'session-state.pre-workspace.json'));
      this.persist(state); return state;
    } catch { return { version: 3, workspaces: [] }; }
  }
  persist(state) {
    if (state?.version !== 3 || !Array.isArray(state.workspaces) || Buffer.byteLength(JSON.stringify(state)) > 4 * MAX) fail('STATE', 'Invalid workspace state.');
    atomic(this.stateFile(), state, true); return { ok: true };
  }
  recoveryFile(id, rel) { if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) fail('STATE', 'Invalid workspace ID.'); return path.join(this.dir, 'workspace-recovery', id, hash(Buffer.from(String(rel))) + '.json'); }
  recovery(id, rel, snapshot) {
    const file = this.recoveryFile(id, rel);
    if (snapshot === null) { fs.rmSync(file, { force: true }); return { ok: true }; }
    if (snapshot === undefined) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
    if (typeof snapshot.text !== 'string' || Buffer.byteLength(snapshot.text) > MAX) fail('STATE', 'Invalid recovery snapshot.');
    atomic(file, { ...snapshot, rel, workspaceId: id, timestamp: Date.now() }); return { ok: true };
  }
}
module.exports = { WorkspaceService, atomic };
