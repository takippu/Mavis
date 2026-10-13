'use strict';
const path = require('path');
const fs = require('fs');
const { WorkspaceService } = require('./workspace-service');
function install({ ipcMain, dialog, shell, clipboard, getWindow, dir, getProjects, getSessions, send, autorunFor, hunterService }) {
  const service = new WorkspaceService(dir, { onChange: p => send('workspace:changed', p), trash: p => shell.trashItem(p) });
  const owned = new Map();
  const leads = new (require('./leads-store').LeadsStore)(dir);
  const quotations = new (require('./quotations-store').QuotationsStore)(dir);
  const quotationDocument = require('./quotation-document');
  const invoices = new (require('./invoices-store').InvoicesStore)(dir);
  const invoiceDocument = require('./invoice-document');
  const freelance = new (require('./freelance-store').FreelanceStore)(dir);
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
  const hunter = () => { if (!hunterService) throw new Error('Discover is unavailable in this session.'); return hunterService; };
  const payload = p => { if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid Discover request.'); return p; };
  const identifier = id => { if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new Error('Invalid Discover identifier.'); return id; };
  handle('hunter-status', () => hunter().snapshot());
  handle('hunter-submit', p => hunter().submit(payload(p)));
  handle('hunter-pause', () => hunter().pause());
  handle('hunter-resume', () => hunter().resume());
  handle('hunter-cancel', p => hunter().cancel(identifier(payload(p).id)));
  handle('hunter-results', p => {
    payload(p); if (p.jobId != null) identifier(p.jobId);
    return { candidates: hunter().snapshot().candidates.filter(c => !p.jobId || c.jobId === p.jobId) };
  });
  handle('hunter-import', p => {
    payload(p);
    if (!Array.isArray(p.candidateIds) || !p.candidateIds.length || p.candidateIds.length > 500) throw new Error('Select between 1 and 500 results.');
    p.candidateIds.forEach(identifier);
    if (p.acknowledgePossibleDuplicates != null && typeof p.acknowledgePossibleDuplicates !== 'boolean') throw new Error('Invalid duplicate acknowledgment.');
    return hunter().importSelected({ candidateIds: [...new Set(p.candidateIds)], acknowledgePossibleDuplicates: p.acknowledgePossibleDuplicates === true });
  });
  handle('hunter-open-source', async p => {
    payload(p); const raw = p.url;
    if (typeof raw !== 'string' || raw.length > 2048) throw new Error('Invalid public source URL.');
    const safeUrl = require('./lead-hunter-candidates').safePublicUrl(raw);
    if (!safeUrl) throw new Error('Choose a public HTTP or HTTPS source.');
    const known = hunter().snapshot().candidates.some(c => (c.sources || []).some(s => s.url === raw) || c.website?.url === raw || c.contact?.form === raw);
    if (!known) throw new Error('This URL is not a source in your Discover results.');
    await shell.openExternal(safeUrl); return { ok: true };
  });

  const checkClient = values => { if (values?.clientId) freelance.get('clients', values.clientId); };
  const protectBackup = file => { if ([freelance.file, invoices.file, quotations.file, leads.file, hunterService?.store.file].filter(Boolean).flatMap(p => [p, p + '.bak']).some(p => path.resolve(p) === path.resolve(file))) throw new Error('Choose a different file for the backup.'); };
  handle('freelance-list', () => {
    const records = freelance.read(), inv = invoices.list(), quotes = quotations.list();
    return { ...records, invoices: inv, quotations: quotes, leads: leads.list(), money: require('./freelance-money').overview({ invoices: inv, quotations: quotes, expenses: records.expenses }), workspaces: [...new Map([...savedState.workspaces, ...[...service.registry.values()].map(w => service.public(w))].map(w => [w.id, { id: w.id, name: w.name }])).values()] };
  });
  handle('freelance-save', p => {
    if (p.kind === 'jobs') {
      if (p.values?.workspaceId && !service.registry.has(p.values.workspaceId) && !savedState.workspaces.some(w => w.id === p.values.workspaceId)) throw new Error('Choose an existing coding workspace.');
      if (p.values?.quotationId && !quotations.list().some(q => q.id === p.values.quotationId)) throw new Error('The linked quotation is no longer available.');
    }
    return freelance.save(p.kind, p.id, p.revision, p.values);
  });
  handle('freelance-archive', p => freelance.archive(p.kind, p.id, p.revision, p.archived));
  handle('freelance-backup', async () => {
    const snapshot = { version: 1, exportedAt: new Date().toISOString(), records: freelance.read(), invoices: invoices.read(), quotations: quotations.read(), leads: leads.read(), hunter: hunterService?.snapshot() || null };
    const picked = await dialog.showSaveDialog(getWindow(), { title: 'Export freelance backup', defaultPath: 'trlabs-freelance.json', filters: [{ name: 'JSON backup', extensions: ['json'] }] });
    if (picked.canceled || !picked.filePath) return { cancelled: true }; protectBackup(picked.filePath);
    fs.writeFileSync(picked.filePath, JSON.stringify(snapshot, null, 2), { mode: 0o600 }); return { ok: true };
  });
  handle('invoices-list', () => ({ invoices: invoices.list(), clients: freelance.list('clients') }));
  handle('invoices-start', p => {
    if (p.quotationId) {
      const q = quotations.get(p.quotationId, p.quotationRevision);
      if (q.archived) throw new Error('Restore the quotation before creating an invoice from it.');
      return { values: invoiceDocument.fromQuote(q, p.basisPoints ?? 10000, p.billingLabel || ''), quotationId: q.id, quotationNumber: q.number, quotationRevision: q.revision };
    }
    const values = invoiceDocument.defaults();
    if (p.clientId) { const c = freelance.get('clients', p.clientId).values; Object.assign(values, { clientId: p.clientId, customerName: c.company || c.name, customerAddress: [c.address, c.contact, c.email, c.phone].filter(Boolean).join('\n') }); }
    return { values };
  });
  handle('invoices-save', p => {
    checkClient(p.values); const source = !p.id && p.quotationId ? quotations.get(p.quotationId, p.quotationRevision) : null;
    if (source?.archived) throw new Error('Restore the quotation before saving an invoice linked to it.');
    return invoices.save(p.id, p.revision, p.values, source);
  });
  handle('invoices-issue', p => invoices.issue(p.id, p.revision));
  handle('invoices-payment', p => invoices.payment(p.id, p.revision, p.values));
  handle('invoices-reverse', p => invoices.reverse(p.id, p.revision, p.paymentId, p.reason));
  handle('invoices-void', p => invoices.void(p.id, p.revision));
  handle('invoices-receipt', async p => {
    const template = require('./receipt-document'), record = invoices.get(p.id, p.revision); template.checkRecord(record);
    const picked = await dialog.showSaveDialog(getWindow(), { title: 'Export receipt PDF', defaultPath: template.number(record) + '.pdf', filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
    if (picked.canceled || !picked.filePath) return { cancelled: true };
    const bytes = await require('./quotation-pdf').createPDF(record, template);
    invoices.get(p.id, p.revision);
    const file = /\.pdf$/i.test(picked.filePath) ? picked.filePath : picked.filePath + '.pdf'; protectBackup(file);
    fs.writeFileSync(file, bytes, { mode: 0o600 }); return { ok: true, file };
  });
  handle('invoices-export', async p => {
    const record = invoices.get(p.id, p.revision); if (record.status !== 'issued') throw new Error('Finalise this invoice before exporting its PDF.'); invoiceDocument.ready(record.values);
    const picked = await dialog.showSaveDialog(getWindow(), { title: 'Export invoice PDF', defaultPath: record.number + '.pdf', filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
    if (picked.canceled || !picked.filePath) return { cancelled: true }; invoices.get(p.id, p.revision);
    const file = /\.pdf$/i.test(picked.filePath) ? picked.filePath : picked.filePath + '.pdf';
    fs.writeFileSync(file, await require('./quotation-pdf').createPDF(record, invoiceDocument), { mode: 0o600 }); return { ok: true, file };
  });
  handle('quotations-list', () => ({ quotations: quotations.list(), defaults: quotationDocument.defaults(), clients: freelance.list('clients') }));
  handle('quotations-start', p => {
    const lead = p.leadId ? leads.list().find(l => l.id === p.leadId) : null;
    if (p.leadId && !lead) throw new Error('This lead is no longer available.');
    const values = quotationDocument.defaults(lead);
    if (p.clientId) { const c = freelance.get('clients', p.clientId).values; Object.assign(values, { clientId: p.clientId, customerName: c.company || c.name, customerAddress: [c.address, c.contact, c.email, c.phone].filter(Boolean).join('\n') }); }
    return { values };
  });
  handle('quotations-save', p => {
    checkClient(p.values);
    if (p.values?.leadId && !leads.list().some(l => l.id === p.values.leadId)) throw new Error('This lead is no longer available.');
    return quotations.save(p.id, p.revision, p.values);
  });
  handle('quotations-archive', p => quotations.archive(p.id, p.revision, p.archived));
  handle('quotations-export', async p => {
    const record = quotations.get(p.id, p.revision);
    if (record.archived) throw new Error('Restore this quotation before exporting.');
    quotationDocument.ready(record.values);
    const picked = await dialog.showSaveDialog(getWindow(), { title: 'Export quotation PDF', defaultPath: record.number + '.pdf', filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
    if (picked.canceled || !picked.filePath) return { cancelled: true };
    quotations.get(p.id, p.revision);
    const file = /\.pdf$/i.test(picked.filePath) ? picked.filePath : picked.filePath + '.pdf';
    const bytes = await require('./quotation-pdf').createPDF(record);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return { ok: true, file };
  });
  handle('quotations-backup', async () => {
    const snapshot = quotations.read();
    const picked = await dialog.showSaveDialog(getWindow(), { title: 'Export quotation backup', defaultPath: 'trlabs-quotations.json', filters: [{ name: 'JSON backup', extensions: ['json'] }] });
    if (picked.canceled || !picked.filePath) return { cancelled: true };
    const file = path.resolve(picked.filePath);
    protectBackup(file);
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), { mode: 0o600 }); return { ok: true };
  });
  handle('leads-list', () => ({ leads: leads.list() }));
  handle('leads-create', p => { if (p.values && Object.hasOwn(p.values, 'discovery')) throw new Error('Only selected Discover results can create discovery provenance.'); checkClient(p.values); return leads.create(p.values); });
  handle('leads-update', p => { checkClient(p.values); return leads.change(p.id, p.revision, 'update', p.values); });
  handle('leads-note', p => leads.change(p.id, p.revision, 'note', p.text));
  handle('leads-archive', p => leads.change(p.id, p.revision, 'archive', p.archived));
  handle('leads-export', async () => {
    const snapshot = leads.read();
    const picked = await dialog.showSaveDialog(getWindow(), { title: 'Export freelance leads', defaultPath: 'trlabs-leads.json', filters: [{ name: 'JSON backup', extensions: ['json'] }] });
    if (picked.canceled || !picked.filePath) return { cancelled: true };
    protectBackup(picked.filePath);
    fs.writeFileSync(picked.filePath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    return { ok: true };
  });
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
