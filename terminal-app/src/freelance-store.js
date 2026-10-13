'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { atomic } = require('./workspace-service'), { dateOK } = require('./quotation-document');
const TEXT = {
  clients: { name: 240, company: 240, contact: 160, email: 240, phone: 80, address: 2000, notes: 10000 },
  jobs: { title: 240, scope: 20000, notes: 10000, workspaceId: 100, quotationId: 100 },
  expenses: { description: 500, category: 100, notes: 3000 }
};
const JOB_STAGES = ['planned', 'active', 'on-hold', 'completed'];
function fail(message, code = 'FREELANCE') { throw Object.assign(Error(message), { code }); }
function optionalId(v) { return v === null || typeof v === 'string' && !!v && v.length <= 100; }
function validate(kind, input) {
  if (!Object.hasOwn(TEXT, kind) || !input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid freelance record.');
  const extra = { clients: [], jobs: ['clientId', 'budgetSen', 'dueDate', 'stage', 'milestones'], expenses: ['clientId', 'jobId', 'amountSen', 'date'] }[kind], out = {};
  for (const key of Object.keys(input)) if (![...Object.keys(TEXT[kind]), ...extra].includes(key)) fail('Unknown ' + kind + ' field: ' + key);
  for (const [key, max] of Object.entries(TEXT[kind])) { const v = input[key] ?? ''; if (typeof v !== 'string' || v.length > max) fail('Invalid ' + key + '.'); out[key] = v.trim(); }
  if (!(kind === 'clients' ? out.name : kind === 'jobs' ? out.title : out.description)) fail('Give this record a name.');
  if (kind !== 'clients') { if (!optionalId(input.clientId ?? null)) fail('Invalid linked client.'); out.clientId = input.clientId ?? null; }
  if (kind === 'jobs') {
    if (!JOB_STAGES.includes(input.stage)) fail('Choose a valid project stage.'); out.stage = input.stage;
    if (input.budgetSen !== null && (!Number.isSafeInteger(input.budgetSen) || input.budgetSen < 0 || input.budgetSen > 999999999999)) fail('Enter a valid project budget.'); out.budgetSen = input.budgetSen;
    if (input.dueDate !== '' && !dateOK(input.dueDate)) fail('Choose a valid project deadline.'); out.dueDate = input.dueDate;
    if (!Array.isArray(input.milestones) || input.milestones.length > 100) fail('A project supports up to 100 tasks.');
    const ids = new Set(); out.milestones = input.milestones.map(m => {
      if (!m || typeof m.id !== 'string' || !m.id || m.id.length > 100 || ids.has(m.id) || typeof m.title !== 'string' || !m.title.trim() || m.title.length > 240 || typeof m.done !== 'boolean' || m.dueDate !== '' && !dateOK(m.dueDate)) fail('Enter a title and valid date for each task.'); ids.add(m.id);
      return { id: m.id, title: m.title.trim(), dueDate: m.dueDate, done: m.done };
    });
  }
  if (kind === 'expenses') {
    if (!optionalId(input.jobId ?? null)) fail('Invalid linked job.'); out.jobId = input.jobId ?? null;
    if (!Number.isSafeInteger(input.amountSen) || input.amountSen <= 0 || input.amountSen > 999999999999) fail('Enter a positive expense amount.'); out.amountSen = input.amountSen;
    if (!dateOK(input.date)) fail('Choose a valid expense date.'); out.date = input.date;
  }
  return out;
}
class FreelanceStore {
  constructor(dir) { this.file = path.join(dir, 'freelance-records.json'); }
  read() {
    let raw; try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { version: 1, clients: [], jobs: [], expenses: [] }; throw e; }
    try {
      if (Buffer.byteLength(raw) > 12 * 1024 * 1024) throw Error(); const data = JSON.parse(raw);
      if (data.version !== 1) throw Error();
      for (const kind of Object.keys(TEXT)) {
        if (!Array.isArray(data[kind])) throw Error(); const ids = new Set();
        for (const r of data[kind]) { validate(kind, r.values); if (!r.id || ids.has(r.id) || typeof r.revision !== 'string' || !r.revision || typeof r.archived !== 'boolean' || !r.createdAt || !r.updatedAt) throw Error(); ids.add(r.id); }
      }
      return data;
    } catch { fail('Freelance records could not be read. Your data was kept unchanged; recover the file or its .bak copy before saving.', 'FREELANCE_CORRUPT'); }
  }
  list(kind) { if (!Object.hasOwn(TEXT, kind)) fail('Unknown freelance record type.'); return this.read()[kind]; }
  get(kind, id) { const r = this.list(kind).find(r => r.id === id); if (!r) fail('This ' + kind + ' record is no longer available.'); return r; }
  write(data) { if (Buffer.byteLength(JSON.stringify(data)) > 12 * 1024 * 1024) fail('Freelance storage is full. Export a backup before adding records.'); atomic(this.file, data, true); }
  save(kind, id, revision, input) {
    const values = validate(kind, input), data = this.read(); let r;
    if (values.clientId && !data.clients.some(c => c.id === values.clientId)) fail('The linked client is no longer available.');
    if (values.jobId && !data.jobs.some(j => j.id === values.jobId)) fail('The linked project is no longer available.');
    if (id) { r = data[kind].find(r => r.id === id); if (!r || r.revision !== revision) fail('This record changed since you opened it. Reopen it before saving; your draft was kept.', 'FREELANCE_CONFLICT'); r.values = values; }
    else { r = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), archived: false, values }; data[kind].unshift(r); }
    r.updatedAt = new Date().toISOString(); r.revision = crypto.randomUUID(); this.write(data); return r;
  }
  archive(kind, id, revision, archived) {
    if (!Object.hasOwn(TEXT, kind) || typeof archived !== 'boolean') fail('Invalid archive action.'); const data = this.read(), r = data[kind].find(r => r.id === id);
    if (!r || r.revision !== revision) fail('This record changed since you opened it. Reopen it before archiving.', 'FREELANCE_CONFLICT');
    r.archived = archived; r.updatedAt = new Date().toISOString(); r.revision = crypto.randomUUID(); this.write(data); return r;
  }
}
module.exports = { FreelanceStore, validate, JOB_STAGES };
