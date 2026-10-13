'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { atomic } = require('./workspace-service');
const STAGES = ['new', 'discussing', 'quoted', 'won', 'lost'];
const TEXT = { title: 160, company: 160, contact: 160, email: 240, phone: 80, source: 240, nextStep: 1000, brief: 50000 };
const LIMIT = 4 * 1024 * 1024;
function fail(message, code = 'LEADS') { throw Object.assign(new Error(message), { code }); }
function validDate(value) { if (value === '') return true; if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(value + 'T00:00:00Z'); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; }
function discovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || value.provider !== 'codex' || Object.keys(value).some(k => !['version', 'candidateId', 'jobId', 'provider', 'discoveredAt', 'sources', 'website', 'location', 'industry'].includes(k))) fail('Invalid discovery provenance.');
  const { safePublicUrl } = require('./lead-hunter-candidates');
  for (const key of ['candidateId', 'jobId']) if (typeof value[key] !== 'string' || !value[key] || value[key].length > 128) fail('Invalid discovery origin.');
  if (typeof value.discoveredAt !== 'string' || value.discoveredAt.length > 80 || !Number.isFinite(Date.parse(value.discoveredAt))) fail('Invalid discovery date.');
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 20) fail('Invalid discovery sources.');
  const sources = value.sources.map(source => {
    if (!source || !safePublicUrl(source.url) || typeof source.label !== 'string' || source.label.length > 240 || typeof source.observedAt !== 'string' || source.observedAt.length > 80 || !Number.isFinite(Date.parse(source.observedAt))) fail('Invalid discovery source.');
    if (source.finalUrl !== undefined && !safePublicUrl(source.finalUrl)) fail('Invalid discovery redirect source.');
    return { url: safePublicUrl(source.url), label: source.label, observedAt: source.observedAt, ...(source.finalUrl === undefined ? {} : { finalUrl: safePublicUrl(source.finalUrl) }) };
  });
  const website = value.website;
  if (!website || !['found', 'not_observed', 'unknown'].includes(website.state) || typeof website.url !== 'string' || (website.url && !safePublicUrl(website.url)) || (website.state === 'found' && !website.url) || (website.state !== 'found' && website.url)) fail('Invalid discovery website observation.');
  const location = value.location;
  if (!location || typeof location !== 'object' || Array.isArray(location) || Object.keys(location).some(k => !['region', 'city', 'address'].includes(k))) fail('Invalid discovery location.');
  for (const key of ['region', 'city', 'address']) if (typeof location[key] !== 'string' || location[key].length > (key === 'address' ? 500 : 80)) fail('Invalid discovery location.');
  if (value.industry !== undefined && (typeof value.industry !== 'string' || value.industry.length > 120)) fail('Invalid discovery industry.');
  return { version: 1, candidateId: value.candidateId, jobId: value.jobId, provider: 'codex', discoveredAt: value.discoveredAt, sources, website: { state: website.state, url: website.url }, location: { ...location }, ...(value.industry === undefined ? {} : { industry: value.industry }) };
}
function fields(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid lead details.');
  const out = {};
  for (const name of Object.keys(input)) {
    const value = input[name];
    if (Object.hasOwn(TEXT, name)) {
      if (typeof value !== 'string' || value.length > TEXT[name]) fail('Invalid ' + name + '.');
      out[name] = value.trim();
    } else if (name === 'discovery') { if (partial) fail('Discovery provenance cannot be overwritten.'); out.discovery = discovery(value); }
    else if (name === 'stage') { if (!STAGES.includes(value)) fail('Invalid lead stage.'); out.stage = value; }
    else if (name === 'clientId') { if (value !== null && (typeof value !== 'string' || !value || value.length > 100)) fail('Invalid linked client.'); out.clientId = value; }
    else if (name === 'followUp') { if (!validDate(value)) fail('Choose a valid follow-up date.'); out.followUp = value; }
    else if (name === 'valueSen') { if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 999999999999)) fail('Enter a valid value in MYR.'); out.valueSen = value; }
    else fail('Unknown lead field: ' + name);
  }
  if (!partial) {
    for (const name of Object.keys(TEXT)) out[name] ??= '';
    out.stage ??= 'new'; out.followUp ??= ''; out.valueSen ??= null; out.clientId ??= null;
  }
  if ((!partial || 'title' in out) && !out.title) fail('Give this lead a name.');
  return out;
}
class LeadsStore {
  constructor(dir) { this.file = path.join(dir, 'freelance-leads.json'); }
  read() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { version: 1, leads: [] }; throw e; }
    try {
      if (Buffer.byteLength(raw) > LIMIT) fail('Lead storage exceeds the size limit.');
      const data = JSON.parse(raw), ids = new Set();
      if (data.version !== 1 || !Array.isArray(data.leads)) fail('Invalid lead storage.');
      for (const lead of data.leads) {
        fields(Object.fromEntries([...Object.keys(TEXT), 'stage', 'followUp', 'valueSen'].map(k => [k, lead[k]])));
        if (lead.discovery !== undefined) discovery(lead.discovery);
        if (typeof lead.id !== 'string' || ids.has(lead.id) || typeof lead.revision !== 'string' || typeof lead.archived !== 'boolean' || !Array.isArray(lead.activity) || !lead.createdAt || !lead.updatedAt) fail('Invalid lead record.');
        ids.add(lead.id);
      }
      return data;
    } catch { fail('Lead storage could not be read. Your data was kept unchanged; recover the file or its .bak copy before saving.', 'LEADS_CORRUPT'); }
  }
  list() { return this.read().leads; }
  findByDiscoveryCandidateId(candidateId) { return this.list().find(lead => lead.discovery?.candidateId === candidateId) || null; }
  write(data) {
    if (Buffer.byteLength(JSON.stringify(data)) > LIMIT) fail('Lead storage is full. Export a backup before adding more records.');
    atomic(this.file, data, true);
  }
  create(input) {
    const value = fields(input), data = this.read(), now = new Date().toISOString();
    const lead = { ...value, id: crypto.randomUUID(), revision: crypto.randomUUID(), createdAt: now, updatedAt: now, archived: false, activity: [{ id: crypto.randomUUID(), at: now, kind: 'created', text: 'Lead created' }] };
    data.leads.unshift(lead); this.write(data); return lead;
  }
  change(id, revision, operation, input) {
    const data = this.read(), lead = data.leads.find(l => l.id === id);
    if (!lead) fail('This lead is no longer available.');
    if (lead.revision !== revision) fail('This lead changed since you opened it. Reopen it before saving; your draft has been kept.', 'LEADS_CONFLICT');
    const now = new Date().toISOString(); let text, kind = operation;
    if (operation === 'update') {
      const patch = fields(input, true), old = lead.stage;
      Object.assign(lead, patch); text = old === lead.stage ? 'Lead details updated' : 'Stage changed from ' + old + ' to ' + lead.stage;
    } else if (operation === 'note') {
      if (typeof input !== 'string' || !input.trim() || input.length > 10000) fail('Enter a note of up to 10,000 characters.');
      text = input.trim();
    } else if (operation === 'archive') {
      if (typeof input !== 'boolean') fail('Invalid archive action.');
      lead.archived = input; text = input ? 'Lead archived' : 'Lead restored';
    } else fail('Invalid lead action.');
    lead.activity.unshift({ id: crypto.randomUUID(), at: now, kind, text });
    lead.updatedAt = now; lead.revision = crypto.randomUUID(); this.write(data); return lead;
  }
}
module.exports = { LeadsStore, STAGES, validDate };
