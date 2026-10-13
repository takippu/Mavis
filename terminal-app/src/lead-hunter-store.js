'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { atomic } = require('./workspace-service');
const { validateModel } = require('./lead-hunter-models');
const STATES = ['queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled'];
const NEXT = { queued: ['running', 'paused', 'cancelled', 'failed', 'completed'], running: ['queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled'], waiting: ['queued', 'running', 'paused', 'cancelled', 'failed', 'completed'], paused: ['queued', 'cancelled', 'failed', 'completed'], completed: [], failed: ['queued', 'cancelled'], cancelled: [] };
const MAX_BYTES = 20 * 1024 * 1024;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
function fail(message, code = 'HUNTER_INVALID') { throw Object.assign(new Error(message), { code }); }
function text(value, length, required = false) { if (typeof value !== 'string' || value.length > length || (required && !value.trim())) fail('Invalid discovery details.'); return value.trim(); }
function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['goal', 'filters', 'provider', 'model'].includes(k))) fail('Invalid discovery request.');
  const f = input.filters;
  if (!f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some(k => !['industry', 'region', 'location', 'city', 'website', 'contact', 'sources', 'limit', 'skipExisting'].includes(k))) fail('Invalid discovery filters.');
  if (input.provider !== undefined && input.provider !== 'codex') fail('Unsupported discovery provider.');
  if (f.region !== undefined && f.location !== undefined && f.region !== f.location) fail('Conflicting discovery region.');
  const filters = { industry: text(f.industry ?? '', 120), region: text(f.region ?? f.location, 80, true), city: text(f.city ?? '', 80), website: f.website ?? 'any', contact: f.contact ?? 'any', sources: f.sources ?? 'public_web', limit: f.limit ?? 50, skipExisting: f.skipExisting ?? true };
  if (!['any', 'found', 'not_observed'].includes(filters.website) || !['any', 'email', 'phone', 'form', 'not_required'].includes(filters.contact) || !['public_web', 'business_sites', 'directories'].includes(filters.sources) || !Number.isInteger(filters.limit) || filters.limit < 1 || filters.limit > 500 || typeof filters.skipExisting !== 'boolean') fail('Invalid discovery filters.');
  return { goal: text(input.goal, 240, true), provider: 'codex', model: validateModel(input.model), filters };
}
function validateCandidate(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail('Invalid discovery candidate.');
  text(c.id, 128, true); text(c.jobId, 128, true); text(c.company, 160, true);
  for (const key of ['industry', 'region', 'city', 'address']) text(c[key] ?? '', key === 'address' ? 500 : key === 'industry' ? 120 : 80);
  const { safePublicUrl } = require('./lead-hunter-candidates');
  if (!c.website || !['found', 'not_observed', 'unknown'].includes(c.website.state)) fail('Invalid website observation.');
  text(c.website.url ?? '', 2048); if ((c.website.url && !safePublicUrl(c.website.url)) || (c.website.state !== 'found' && c.website.url)) fail('Invalid website observation URL.'); if (c.website.state === 'found' && !c.website.url) fail('Found website requires an observed URL.');
  if (!c.contact || typeof c.contact !== 'object') fail('Invalid contact observation.');
  for (const key of ['email', 'phone', 'form']) text(c.contact[key] ?? '', key === 'phone' ? 80 : key === 'email' ? 240 : 2048);
  if (c.contact.form && !safePublicUrl(c.contact.form)) fail('Invalid contact form URL.');
  if (!Array.isArray(c.sources) || !c.sources.length || c.sources.length > 20) fail('Candidate sources are required.');
  for (const source of c.sources) { text(source.url, 2048, true); text(source.label ?? '', 240); text(source.observedAt, 80, true); if (!safePublicUrl(source.url) || !Number.isFinite(Date.parse(source.observedAt))) fail('Invalid discovery source observation.'); }
  if (!Array.isArray(c.identityKeys) || c.identityKeys.length > 20) fail('Invalid candidate identity keys.');
  for (const key of c.identityKeys) text(key, 2048, true);
  if (!c.duplicate || !['none', 'possible', 'confident'].includes(c.duplicate.kind) || !Array.isArray(c.duplicate.recordIds) || c.duplicate.recordIds.length > 100) fail('Invalid duplicate observation.');
  for (const id of c.duplicate.recordIds) text(id, 128, true);
  text(c.discoveredAt, 80, true); if (!Number.isFinite(Date.parse(c.discoveredAt))) fail('Invalid discovery timestamp.'); if (c.importedLeadId !== undefined) text(c.importedLeadId, 128, true);
  if (Buffer.byteLength(JSON.stringify(c)) > 64 * 1024) fail('Discovery candidate exceeds its size limit.');
}
class HunterStore {
  constructor(dir, options = {}) { this.file = path.join(dir, 'lead-hunter.json'); this.now = options.now || (() => new Date().toISOString()); this.maxBytes = Math.min(options.maxBytes ?? MAX_BYTES, MAX_BYTES); this.maxJobs = Math.min(options.maxJobs ?? 100, 100); }
  read() {
    let raw;
    try { const stat = fs.statSync(this.file); if (stat.size > this.maxBytes) fail('Discovery storage exceeds its size limit.'); raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { version: 1, paused: false, jobs: [], candidates: [] }; if (e.code !== 'HUNTER_INVALID') throw e; fail('Discovery storage could not be read. Your data was kept unchanged; recover the file or its .bak copy before saving.', 'HUNTER_CORRUPT'); }
    try {
      const data = JSON.parse(raw), ids = new Set(), candidateIds = new Set();
      if (data.version !== 1 || typeof data.paused !== 'boolean' || !Array.isArray(data.jobs) || data.jobs.length > this.maxJobs || !Array.isArray(data.candidates)) fail('Invalid discovery storage.');
      for (const job of data.jobs) {
        const validated = validateInput({ goal: job.goal, filters: job.filters, provider: job.provider, model: job.model });
        job.model = validated.model;
        if (JSON.stringify(validated.filters) !== JSON.stringify(job.filters)) fail('Invalid persisted filter snapshot.');
        if (!uuid(job.id) || !uuid(job.revision) || (job.checkpointId !== null && !uuid(job.checkpointId))) fail('Invalid discovery UUID.');
        if (ids.has(job.id) || !STATES.includes(job.status) || !Array.isArray(job.seenKeys) || job.seenKeys.length > 5000 || !Array.isArray(job.candidateIds) || job.candidateIds.length > 500 || !Number.isInteger(job.completedBatches) || job.completedBatches < 0 || job.completedBatches > 10 || !Number.isInteger(job.noNewBatches) || job.noNewBatches < 0 || !Number.isInteger(job.retries) || job.retries < 0 || job.retries > 3 || !job.createdAt || !job.updatedAt) fail('Invalid discovery job.');
        if (job.attemptId !== null && !uuid(job.attemptId)) fail('Invalid attempt UUID.'); if (job.status === 'running' && !job.attemptId) fail('Missing discovery attempt.');
        if (new Set(job.candidateIds).size !== job.candidateIds.length || job.candidateIds.length > job.filters.limit || !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.updatedAt))) fail('Invalid discovery checkpoint.');
        for (const key of ['deadlineAt', 'nextRetryAt']) if (job[key] !== null && (!Number.isFinite(job[key]) || job[key] < 0)) fail('Invalid discovery deadline.');
        if (job.errorCode !== null) text(job.errorCode, 40, true);
        for (const key of job.seenKeys) text(key, 2048, true);
        for (const id of job.candidateIds) text(id, 128, true);
        text(job.reason, 1000); ids.add(job.id);
      }
      for (const candidate of data.candidates) { validateCandidate(candidate); if (candidateIds.has(candidate.id) || !ids.has(candidate.jobId)) fail('Invalid discovery candidate identity.'); candidateIds.add(candidate.id); }
      for (const job of data.jobs) for (const id of job.candidateIds) if (!data.candidates.some(c => c.id === id && c.jobId === job.id)) fail('Missing discovery candidate.');
      return data;
    } catch { fail('Discovery storage could not be read. Your data was kept unchanged; recover the file or its .bak copy before saving.', 'HUNTER_CORRUPT'); }
  }
  snapshot() { return this.read(); }
  write(data) { if (Buffer.byteLength(JSON.stringify(data)) > this.maxBytes) fail('Discovery storage is full. Export a backup before continuing.', 'HUNTER_FULL'); atomic(this.file, data, true); }
  enqueue(input) {
    const value = validateInput(input), data = this.read(); if (data.jobs.length >= this.maxJobs) fail('Discovery queue is full. Export a backup before adding more tasks.', 'HUNTER_FULL');
    const now = this.now(), job = { ...value, id: crypto.randomUUID(), revision: crypto.randomUUID(), status: 'queued', reason: '', attemptId: null, checkpointId: null, seenKeys: [], candidateIds: [], completedBatches: 0, noNewBatches: 0, retries: 0, deadlineAt: null, nextRetryAt: null, errorCode: null, createdAt: now, updatedAt: now };
    data.jobs.push(job); this.write(data); return clone(job);
  }
  transition(id, expectedRevision, status, reason = '', patch = {}) {
    const data = this.read(), job = data.jobs.find(j => j.id === id);
    if (!job) fail('Discovery task is unavailable.', 'HUNTER_MISSING');
    if (job.revision !== expectedRevision) fail('Discovery task changed; refresh its status.', 'HUNTER_CONFLICT');
    if (!NEXT[job.status].includes(status)) fail('Invalid discovery task transition.');
    text(reason, 1000);
    for (const key of Object.keys(patch)) if (!['attemptId', 'deadlineAt', 'nextRetryAt', 'errorCode', 'retries'].includes(key)) fail('Invalid discovery task update.');
    if ('attemptId' in patch && patch.attemptId !== null && !uuid(patch.attemptId)) fail('Invalid attempt UUID.');
    for (const key of ['deadlineAt', 'nextRetryAt']) if (key in patch && patch[key] !== null && (!Number.isFinite(patch[key]) || patch[key] < 0)) fail('Invalid discovery deadline.');
    if ('retries' in patch && (!Number.isInteger(patch.retries) || patch.retries < 0 || patch.retries > 3)) fail('Invalid discovery retry count.');
    if ('errorCode' in patch && patch.errorCode !== null) text(patch.errorCode, 40, true);
    Object.assign(job, patch, { status, reason: reason.trim(), revision: crypto.randomUUID(), updatedAt: this.now() });
    if (status !== 'running') job.attemptId = null;
    if (status === 'running' && !job.attemptId) fail('Discovery task requires an attempt ID.');
    this.write(data); return clone(job);
  }
  commitBatch(id, attemptId, batch) {
    const data = this.read(), job = data.jobs.find(j => j.id === id);
    if (!job || job.status !== 'running' || job.attemptId !== attemptId) fail('Discovery attempt is no longer active.', 'HUNTER_STALE');
    if (!batch || !Array.isArray(batch.candidates) || batch.candidates.length > 10 || !Array.isArray(batch.seenKeys) || batch.seenKeys.length > 200) fail('Invalid discovery batch.');
    if (job.completedBatches >= 10) fail('Discovery batch budget reached.', 'HUNTER_FULL');
    const newCandidates = [];
    for (const candidate of batch.candidates) { const c = { ...clone(candidate), jobId: id }; validateCandidate(c); if (!data.candidates.some(old => old.id === c.id) && !newCandidates.some(old => old.id === c.id) && job.candidateIds.length + newCandidates.length < job.filters.limit) newCandidates.push(c); }
    for (const key of batch.seenKeys) text(key, 2048, true);
    const seenKeys = [...new Set([...job.seenKeys, ...batch.seenKeys])]; if (seenKeys.length > 5000) fail('Discovery identity storage is full.', 'HUNTER_FULL');
    job.seenKeys = seenKeys; job.completedBatches++; job.noNewBatches = newCandidates.length ? 0 : job.noNewBatches + 1;
    job.candidateIds.push(...newCandidates.map(c => c.id)); data.candidates.push(...newCandidates);
    job.checkpointId = crypto.randomUUID(); job.revision = crypto.randomUUID(); job.updatedAt = this.now(); job.reason = text(batch.summary ?? '', 1000);
    this.write(data); return clone(job);
  }
  setPaused(paused) { if (typeof paused !== 'boolean') fail('Invalid discovery pause.'); const data = this.read(); data.paused = paused; this.write(data); return this.snapshot(); }
  markImported(candidateId, leadId) { text(leadId, 128, true); const data = this.read(), candidate = data.candidates.find(c => c.id === candidateId); if (!candidate) fail('Discovery candidate is unavailable.', 'HUNTER_MISSING'); if (candidate.importedLeadId && candidate.importedLeadId !== leadId) fail('Discovery candidate was already imported.', 'HUNTER_CONFLICT'); candidate.importedLeadId = leadId; this.write(data); return clone(candidate); }
}
module.exports = { HunterStore, validateInput, STATES };
