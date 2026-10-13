'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { atomic } = require('./workspace-service'), document = require('./quotation-document');
const LIMIT = 8 * 1024 * 1024;
function fail(message, code = 'QUOTATIONS') { throw Object.assign(new Error(message), { code }); }
class QuotationsStore {
  constructor(dir) { this.file = path.join(dir, 'freelance-quotations.json'); }
  read() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { version: 1, counters: {}, quotations: [] }; throw e; }
    try {
      if (Buffer.byteLength(raw) > LIMIT) throw Error();
      const data = JSON.parse(raw), ids = new Set(), numbers = new Set();
      if (data.version !== 1 || !Array.isArray(data.quotations) || !data.counters || typeof data.counters !== 'object' || Array.isArray(data.counters)) throw Error();
      for (const [year, counter] of Object.entries(data.counters)) if (!/^\d{4}$/.test(year) || !Number.isSafeInteger(counter) || counter < 1) throw Error();
      for (const q of data.quotations) {
        document.validate(q.values);
        if (typeof q.id !== 'string' || !q.id || ids.has(q.id) || typeof q.revision !== 'string' || !q.revision || !/^QTN-\d{4}-\d{3,}$/.test(q.number) || numbers.has(q.number) || typeof q.archived !== 'boolean' || !q.createdAt || !q.updatedAt) throw Error();
        const [, year, n] = q.number.split('-'); if (!(data.counters[year] >= Number(n))) throw Error();
        ids.add(q.id); numbers.add(q.number);
      }
      return data;
    } catch { fail('Quotation storage could not be read. Your data was kept unchanged; recover the file or its .bak copy before saving.', 'QUOTATIONS_CORRUPT'); }
  }
  list() { return this.read().quotations; }
  write(data) { if (Buffer.byteLength(JSON.stringify(data)) > LIMIT) fail('Quotation storage is full. Export a backup before adding more drafts.'); atomic(this.file, data, true); }
  get(id, revision) {
    const q = this.list().find(q => q.id === id);
    if (!q) fail('This quotation is no longer available.');
    if (revision !== q.revision) fail('This quotation changed since you opened it. Your draft was kept; reopen the saved quotation before saving.', 'QUOTATIONS_CONFLICT');
    return q;
  }
  save(id, revision, input) {
    const values = document.validate(input), data = this.read(), now = new Date().toISOString();
    let q;
    if (id) {
      q = data.quotations.find(q => q.id === id);
      if (!q) fail('This quotation is no longer available.');
      if (revision !== q.revision) fail('This quotation changed since you opened it. Your draft was kept; reopen the saved quotation before saving.', 'QUOTATIONS_CONFLICT');
      q.values = values; q.updatedAt = now; q.revision = crypto.randomUUID();
    } else {
      const year = values.issueDate.slice(0, 4), n = (data.counters[year] || 0) + 1;
      if (!Number.isSafeInteger(n)) fail('Quotation numbering limit reached.');
      data.counters[year] = n;
      q = { id: crypto.randomUUID(), revision: crypto.randomUUID(), number: 'QTN-' + year + '-' + String(n).padStart(3, '0'), values, archived: false, createdAt: now, updatedAt: now };
      data.quotations.unshift(q);
    }
    this.write(data); return q;
  }
  archive(id, revision, archived) {
    if (typeof archived !== 'boolean') fail('Invalid archive action.');
    const data = this.read(), q = data.quotations.find(q => q.id === id);
    if (!q) fail('This quotation is no longer available.');
    if (revision !== q.revision) fail('This quotation changed since you opened it. Reopen it before archiving.', 'QUOTATIONS_CONFLICT');
    q.archived = archived; q.updatedAt = new Date().toISOString(); q.revision = crypto.randomUUID(); this.write(data); return q;
  }
}
module.exports = { QuotationsStore };
