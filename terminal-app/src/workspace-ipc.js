'use strict';
const path = require('path');
const fs = require('fs');
const { WorkspaceService } = require('./workspace-service');
function install({ ipcMain, dialog, shell, clipboard, getWindow, dir, getProjects, getSessions, send, autorunFor }) {
  const service = new WorkspaceService(dir, { onChange: p => send('workspace:changed', p), trash: p => shell.trashItem(p) });
  const owned = new Map();
  let savedState = service.load();
  const projectFoldersFile = path.join(dir, 'workspace-project-folders.json');
  const projectFolders = Object.create(null);
  try { const parsed = JSON.parse(fs.readFileSync(projectFoldersFile, 'utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(projectFolders, parsed); } catch {}
  service.projectFolder = slug => projectFolders[slug] || null;
  const legacyCwds = new Map(savedState.workspaces.map(w => [w.id, new Set((w.terminals || []).map(t => t.cwd))]));
  service.releaseTerminal = id => owned.delete(id);
  const handle = (name, fn) => ipcMain.handle('workspace:' + name, async (e, p = {}) => {
    if (!getWindow() || e.sender !== getWindow().webContents || (e.senderFrame && e.senderFrame !== getWindow().webContents.mainFrame)) return { error: 'Invalid sender' };
    try { return await fn(p); } catch (err) { return { error: err.message, code: err.code || 'IO' }; }
  });
  handle('load', () => savedState);
  handle('persist', p => {
    if (!Array.isArray(p.workspaces)) throw new Error('Invalid workspace state');
    const workspaces = p.workspaces.map(w => {
      const authorized = service.registry.has(w.id) ? service.public(service.get(w.id)) : savedState.workspaces.find(s => s.id === w.id);
      if (!authorized) throw new Error('Cannot persist an unauthorized project');
      const terminals = (w.terminals || []).map(t => { if (t.cwd && t.cwd !== authorized.root && !legacyCwds.get(w.id)?.has(t.cwd)) throw new Error('Unauthorized terminal directory'); return t; });
      return { ...w, id: authorized.id, root: authorized.root, name: authorized.name, slug: authorized.slug || null, terminals };
    });
    const next = { ...p, workspaces }; const result = service.persist(next); savedState = next; return result;
  });
  handle('open', async p => {
    let root;
    if (p.restore) { const saved = savedState.workspaces.find(w => w.id === p.restore); if (!saved) throw new Error('Unknown saved project'); root = saved.root; p = saved; }
    else if (p.slug) {
      const project = getProjects().find(x => x.slug === p.slug);
      if (!project) throw new Error('Project is not registered.');
      root = projectFolders[p.slug] || project.dir;
      if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) {
        const picked = await dialog.showOpenDialog(getWindow(), { title: 'Choose local folder for ' + (project.name || p.slug), properties: ['openDirectory'] });
        if (picked.canceled || !picked.filePaths?.[0]) return { cancelled: true };
        root = picked.filePaths[0];
        const opened = service.open(root, { slug: p.slug, name: project.name || p.slug });
        projectFolders[p.slug] = opened.root;
        require('./workspace-service').atomic(projectFoldersFile, projectFolders, true);
        return opened;
      }
      p.name = project.name || p.slug;
    }
    else { const picked = await dialog.showOpenDialog(getWindow(), { title: 'Open project folder', properties: ['openDirectory'] }); if (picked.canceled) return { cancelled: true }; root = picked.filePaths[0]; }
    return service.open(root, p);
  });
  handle('close', p => { for (const [id, owner] of owned) if (owner === p.id) { getSessions().close(id); owned.delete(id); } service.close(p.id); return { ok: true }; });
  handle('list', p => service.list(p.id, p.rel)); handle('read', p => service.read(p.id, p.rel));
  handle('location', p => {
    if (!['resolve', 'reveal', 'copyFull', 'copyRelative'].includes(p.action)) throw new Error('Invalid location action');
    let root;
    if (p.id) root = service.get(p.id).root;
    else {
      const project = getProjects().find(x => x.slug === p.slug);
      if (!project) throw new Error('Project is not registered.');
      root = projectFolders[p.slug] || project.dir;
      if (!root || !path.isAbsolute(root) || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        if (p.action === 'resolve') return { available: false };
        throw new Error('Open this project and choose its local folder first.');
      }
      root = fs.realpathSync(root);
    }
    const target = require('./fs-browser').safeResolve(root, p.rel || '.');
    if (p.action === 'reveal') { fs.statSync(target); shell.showItemInFolder(target); }
    if (p.action === 'copyFull' || p.action === 'copyRelative') clipboard.writeText(p.action === 'copyFull' ? target : path.relative(root, target) || '.');
    return { ok: true, available: true, path: target };
  });
  handle('save', p => service.save(p.id, p.rel, p.text, p.revision, p));
  handle('mutate', p => service.mutate(p.id, p)); handle('search', p => service.search(p.id, p.query, p.mode));
  handle('cancelSearch', p => { service.cancelSearch(p.id); return { ok: true }; });
  handle('recovery', p => { service.get(p.id); return service.recovery(p.id, p.rel, p.snapshot); });
  handle('saveAs', async p => {
    const w = service.get(p.id); const picked = await dialog.showSaveDialog(getWindow(), { defaultPath: path.join(w.root, p.rel), title: 'Save file in this project' });
    if (picked.canceled) return { cancelled: true };
    const rel = path.relative(w.root, picked.filePath); require('./fs-browser').safeResolve(w.root, rel);
    let revision = null; if (fs.existsSync(picked.filePath)) revision = (await service.read(p.id, rel)).revision;
    return { ...await service.save(p.id, rel, p.text, revision, p), rel };
  });
  handle('terminal', p => {
    const w = service.get(p.id); const cwd = p.cwd || w.root;
    if (cwd !== w.root && !legacyCwds.get(p.id)?.has(cwd)) throw new Error('Terminal directory is not authorized.');
    const kind = p.kind === 'shell' ? 'shell' : 'mavis'; const registry = require('./harness');
    if (kind === 'mavis' && !registry.available().includes(p.kind)) return { error: p.kind + ' is not installed. Install its CLI and log in, then retry.' };
    const result = getSessions().create({ cwd, kind, harness: kind === 'shell' ? null : p.kind, label: p.label, cols: p.cols, rows: p.rows });
    if (result.ok) owned.set(result.id, p.id); return { ...result, autorun: kind === 'shell' ? null : autorunFor?.(p.kind, w.slug) };
  });
  handle('terminalClose', p => { if (owned.get(p.terminalId) !== p.id) throw new Error('Terminal belongs to another project.'); getSessions().close(p.terminalId); owned.delete(p.terminalId); return { ok: true }; });
  handle('git', async p => {
    const w = service.get(p.id); const git = require('./git-repo'); const repo = await git.resolveRepo(w.root); if (!repo.root || repo.error) return repo;
    if (p.action === 'resolve') return repo;
    if (p.action === 'versions') return { ...await git.fileVersions(repo.root, p.rel, p.staged), repositoryRoot: repo.root };
    const actions = { status: () => git.status(repo.root), diff: () => git.diffFile(repo.root, p.rel, !!p.staged), stage: () => git.stage(repo.root, p.rels), unstage: () => git.unstage(repo.root, p.rels), discard: () => git.discard(repo.root, p.rels), commit: () => git.commit(repo.root, p.message), push: () => git.push(repo.root), branches: () => git.branches(repo.root), checkout: () => git.checkout(repo.root, p.name) };
    if (!actions[p.action]) throw new Error('Invalid Git action'); return { ...await actions[p.action](), repositoryRoot: repo.root };
  });
  return service;
}
module.exports = { install };
