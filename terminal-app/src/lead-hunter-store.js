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
const CHECK_KEYS = ['identity', 'industry', 'location', 'website', 'contact', 'duplicate'];
const MAX_RESULT_BYTES = 32 * 1024;
function validateValidationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['goal', 'provider', 'model', 'candidateIds', 'criteria'].includes(k))) fail('Invalid validation request.');
  if (input.provider !== undefined && input.provider !== 'codex') fail('Unsupported validation provider.');
  if (!Array.isArray(input.candidateIds) || !input.candidateIds.length || input.candidateIds.length > 100 || new Set(input.candidateIds).size !== input.candidateIds.length) fail('Choose 1–100 distinct discovery candidates.');
  for (const id of input.candidateIds) text(id, 128, true);
  const c = input.criteria;
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !['industry', 'region', 'city', 'website', 'contact', 'checkDuplicates'].includes(k))) fail('Invalid validation criteria.');
  const criteria = { industry: text(c.industry ?? '', 120), region: text(c.region ?? '', 80), city: text(c.city ?? '', 80), website: c.website ?? 'any', contact: c.contact ?? 'any', checkDuplicates: c.checkDuplicates ?? true };
  if (!['any', 'found', 'not_observed'].includes(criteria.website) || !['any', 'email', 'phone', 'form', 'not_required'].includes(criteria.contact) || typeof criteria.checkDuplicates !== 'boolean') fail('Invalid validation criteria.');
  return { goal: text(input.goal, 240, true), provider: 'codex', model: validateModel(input.model), candidateIds: [...input.candidateIds], criteria };
}
function validationChecksRequired(criteria) {
  return { identity: true, industry: !!criteria.industry, location: !!(criteria.region || criteria.city), website: criteria.website !== 'any', contact: ['email', 'phone', 'form'].includes(criteria.contact), duplicate: criteria.checkDuplicates };
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function candidateDigest(candidate) { return crypto.createHash('sha256').update(canonical(candidate)).digest('hex'); }
function date(value) { text(value, 80, true); if (!Number.isFinite(Date.parse(value))) fail('Invalid validation timestamp.'); }
function validateValidationResult(result, job, target) {
  const allowed = ['id', 'taskId', 'candidateId', 'inputDigest', 'model', 'checkedAt', 'overall', 'checks', 'sources', 'duplicate'];
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(k => !allowed.includes(k))) fail('Invalid validation result.');
  if (!uuid(result.id) || result.taskId !== job.id || result.candidateId !== target.candidateId || result.inputDigest !== target.inputDigest || result.model !== job.model) fail('Validation result does not match the submitted snapshot.');
  date(result.checkedAt);
  if (!Array.isArray(result.sources) || result.sources.length > 20 || !Array.isArray(result.checks) || result.checks.length !== CHECK_KEYS.length) fail('Invalid validation evidence.');
  const { safePublicUrl } = require('./lead-hunter-candidates'), sourceUrls = new Set();
  for (const source of result.sources) {
    if (!source || typeof source !== 'object' || Object.keys(source).some(k => !['url', 'label', 'observedAt', 'finalUrl'].includes(k))) fail('Invalid validation source.');
    text(source.url, 2048, true); text(source.label ?? '', 240); date(source.observedAt);
    if (!safePublicUrl(source.url) || (source.finalUrl !== undefined && (typeof source.finalUrl !== 'string' || source.finalUrl.length > 2048 || !safePublicUrl(source.finalUrl))) || sourceUrls.has(source.url)) fail('Invalid validation source URL.');
    sourceUrls.add(source.url);
  }
  const required = validationChecksRequired(job.criteria), keys = new Set();
  for (const check of result.checks) {
    if (!check || typeof check !== 'object' || Object.keys(check).some(k => !['key', 'status', 'required', 'explanation', 'sourceUrls', 'observedAt'].includes(k)) || !CHECK_KEYS.includes(check.key) || keys.has(check.key) || !['passed', 'failed', 'unknown', 'not_requested'].includes(check.status) || check.required !== required[check.key]) fail('Invalid validation check.');
    keys.add(check.key); text(check.explanation, 1000, true); date(check.observedAt);
    if (!Array.isArray(check.sourceUrls) || check.sourceUrls.length > 20 || new Set(check.sourceUrls).size !== check.sourceUrls.length || check.sourceUrls.some(url => !sourceUrls.has(url))) fail('Validation check references unobserved evidence.');
    if (check.required && check.status === 'not_requested') fail('Required validation check was skipped.');
    if (check.key !== 'duplicate' && ['passed', 'failed'].includes(check.status) && !check.sourceUrls.length) fail('Conclusive validation check requires evidence.');
    const skipped = check.key === 'industry' && !job.criteria.industry || check.key === 'location' && !(job.criteria.region || job.criteria.city) || check.key === 'website' && job.criteria.website === 'any' || check.key === 'contact' && job.criteria.contact === 'not_required' || check.key === 'duplicate' && !job.criteria.checkDuplicates;
    if (skipped && check.status !== 'not_requested') fail('Unrequested validation check must be skipped.');
    if (check.key === 'website' && job.criteria.website === 'not_observed' && check.status === 'passed') fail('No observed website cannot establish website absence.');
  }
  const duplicate = result.duplicate;
  if (!duplicate || typeof duplicate !== 'object' || Object.keys(duplicate).some(k => !['kind', 'recordIds'].includes(k)) || !['none', 'possible', 'confident'].includes(duplicate.kind) || !Array.isArray(duplicate.recordIds) || duplicate.recordIds.length > 100 || new Set(duplicate.recordIds).size !== duplicate.recordIds.length) fail('Invalid validation duplicate observation.');
  for (const id of duplicate.recordIds) text(id, 128, true);
  if ((duplicate.kind === 'none') !== (duplicate.recordIds.length === 0)) fail('Invalid validation duplicate IDs.');
  const duplicateCheck = result.checks.find(c => c.key === 'duplicate');
  if (job.criteria.checkDuplicates && duplicateCheck.status !== ({ none: 'passed', possible: 'unknown', confident: 'failed' })[duplicate.kind]) fail('Validation duplicate check disagrees with its records.');
  const requested = result.checks.filter(c => c.required);
  const overall = requested.some(c => c.status === 'failed') ? 'failed' : requested.some(c => c.status === 'unknown') ? 'needs_review' : 'passed';
  if (result.overall !== overall || Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) fail('Invalid validation outcome or result size.');
}
const ENRICH_FIELD_KEYS = ['description', 'services', 'products', 'email', 'phone', 'contact_form', 'brand_name', 'tagline', 'website_url', 'website_observations'];
const ENRICH_GROUPS = { offerings: ['description', 'services', 'products'], contacts: ['email', 'phone', 'contact_form'], branding: ['brand_name', 'tagline'], website: ['website_url', 'website_observations'], brief: [] };
function validateEnrichmentInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['goal', 'provider', 'model', 'candidateIds', 'groups'].includes(k))) fail('Invalid enrichment request.');
  if (input.provider !== undefined && input.provider !== 'codex') fail('Unsupported enrichment provider.');
  if (!Object.hasOwn(input, 'model') || typeof input.model !== 'string') fail('Choose an enrichment model.');
  if (!Array.isArray(input.candidateIds) || !input.candidateIds.length || input.candidateIds.length > 100 || new Set(input.candidateIds).size !== input.candidateIds.length) fail('Choose 1–100 distinct validated candidates.');
  for (const id of input.candidateIds) text(id, 128, true);
  const groups = input.groups;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups) || Object.keys(groups).some(k => !Object.hasOwn(ENRICH_GROUPS, k)) || Object.keys(ENRICH_GROUPS).some(k => typeof groups[k] !== 'boolean') || !Object.values(groups).some(Boolean)) fail('Choose at least one research group.');
  return { goal: text(input.goal, 240, true), provider: 'codex', model: validateModel(input.model), candidateIds: [...input.candidateIds], groups: { ...groups } };
}
function enrichmentFieldsRequired(groups) { return Object.fromEntries(ENRICH_FIELD_KEYS.map(key => [key, Object.entries(ENRICH_GROUPS).some(([group, fields]) => groups[group] && fields.includes(key))])); }
function validateEnrichmentResult(result, job, target) {
  const allowed = ['id', 'taskId', 'candidateId', 'inputDigest', 'validationResultId', 'model', 'enrichedAt', 'status', 'identity', 'fields', 'sources', 'brief'];
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(k => !allowed.includes(k)) || !uuid(result.id) || result.taskId !== job.id || result.candidateId !== target.candidateId || result.inputDigest !== target.inputDigest || result.validationResultId !== target.validationResultId || result.model !== job.model) fail('Enrichment result does not match its submitted snapshot.');
  date(result.enrichedAt);
  const { safePublicUrl } = require('./lead-hunter-candidates'), urls = new Set();
  if (!Array.isArray(result.sources) || result.sources.length > 5) fail('Invalid enrichment sources.');
  for (const source of result.sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(k => !['url', 'label', 'observedAt', 'finalUrl'].includes(k))) fail('Invalid enrichment source.');
    text(source.url, 2048, true); text(source.label ?? '', 240); date(source.observedAt);
    if (!safePublicUrl(source.url) || urls.has(source.url) || source.finalUrl !== undefined && (typeof source.finalUrl !== 'string' || source.finalUrl.length > 2048 || !safePublicUrl(source.finalUrl))) fail('Invalid enrichment source URL.');
    urls.add(source.url);
  }
  const refs = values => { if (!Array.isArray(values) || values.length > 20 || new Set(values).size !== values.length || values.some(url => !urls.has(url))) fail('Enrichment references unobserved evidence.'); };
  const identity = result.identity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) || Object.keys(identity).some(k => !['state', 'explanation', 'sourceUrls'].includes(k)) || !['observed', 'unknown'].includes(identity.state)) fail('Invalid enrichment identity.');
  text(identity.explanation, 1000, true); refs(identity.sourceUrls); if (identity.state === 'observed' && !identity.sourceUrls.length) fail('Fresh identity requires acquired evidence.');
  if (!Array.isArray(result.fields) || result.fields.length !== ENRICH_FIELD_KEYS.length) fail('Invalid enrichment fields.');
  const required = enrichmentFieldsRequired(job.groups), keys = new Set();
  for (const field of result.fields) {
    if (!field || typeof field !== 'object' || Array.isArray(field) || Object.keys(field).some(k => !['key', 'state', 'values', 'explanation'].includes(k)) || !ENRICH_FIELD_KEYS.includes(field.key) || keys.has(field.key) || !['observed', 'unknown', 'not_requested'].includes(field.state) || !Array.isArray(field.values) || field.values.length > 12) fail('Invalid enrichment field.');
    keys.add(field.key); text(field.explanation, 1000, true);
    if (!required[field.key] && field.state !== 'not_requested' || required[field.key] && field.state === 'not_requested' || identity.state === 'unknown' && field.state === 'observed') fail('Enrichment field disagrees with requested research or identity.');
    if (field.state === 'observed' ? !field.values.length : field.values.length) fail('Unsupported enrichment values must remain empty.');
    const unique = new Set();
    for (const value of field.values) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['value', 'sourceUrls'].includes(k))) fail('Invalid enrichment value.');
      text(value.value, field.key === 'phone' ? 80 : 240, true); refs(value.sourceUrls);
      if (!value.sourceUrls.length || unique.has(value.value)) fail('Observed enrichment values need distinct acquired evidence.'); unique.add(value.value);
      if (['contact_form', 'website_url'].includes(field.key) && !safePublicUrl(value.value)) fail('Invalid enrichment contact or website URL.');
      if (field.key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.value)) fail('Invalid enrichment email.');
    }
  }
  const brief = result.brief;
  if (!brief || typeof brief !== 'object' || Array.isArray(brief) || Object.keys(brief).some(k => !['state', 'summary', 'suggestions'].includes(k)) || brief.state !== (job.groups.brief ? 'draft' : 'not_requested') || !Array.isArray(brief.suggestions) || brief.suggestions.length > 12) fail('Invalid enrichment brief.');
  text(brief.summary, 1000, job.groups.brief); for (const suggestion of brief.suggestions) text(suggestion, 500, true);
  if (!job.groups.brief && (brief.summary || brief.suggestions.length)) fail('Unrequested brief must remain empty.');
  const status = identity.state === 'unknown' ? 'needs_review' : result.fields.some(field => required[field.key] && field.state === 'unknown') ? 'partial' : 'ready';
  if (result.status !== status || Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) fail('Invalid enrichment status or result size.');
}
function reservedResultBytes(data) {
  return data.jobs.filter(job => ['validate', 'enrich'].includes(job.kind) && !['completed', 'cancelled', 'failed'].includes(job.status)).reduce((sum, job) => sum + (job.targetCandidateIds.length - (job.kind === 'validate' ? job.validationResultIds : job.enrichmentResultIds).length) * MAX_RESULT_BYTES, 0);
}
class HunterStore {
  constructor(dir, options = {}) { this.file = path.join(dir, 'lead-hunter.json'); this.now = options.now || (() => new Date().toISOString()); this.maxBytes = Math.min(options.maxBytes ?? MAX_BYTES, MAX_BYTES); this.maxJobs = Math.min(options.maxJobs ?? 100, 100); }
  read() {
    let raw;
    try { const stat = fs.statSync(this.file); if (stat.size > this.maxBytes) fail('Discovery storage exceeds its size limit.'); raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { version: 3, paused: false, jobs: [], candidates: [], validationResults: [], enrichmentResults: [] }; if (e.code !== 'HUNTER_INVALID') throw e; fail('Discovery storage could not be read. Your data was kept unchanged; recover the file or its .bak copy before saving.', 'HUNTER_CORRUPT'); }
    try {
      const data = JSON.parse(raw), ids = new Set(), candidateIds = new Set();
      if (![1, 2, 3].includes(data.version) || typeof data.paused !== 'boolean' || !Array.isArray(data.jobs) || data.jobs.length > this.maxJobs || !Array.isArray(data.candidates) || data.candidates.length > this.maxJobs * 500) fail('Invalid discovery storage.');
      for (const job of data.jobs) {
        if (data.version === 1 && (job.kind !== undefined && job.kind !== 'discover' || job.targetCandidateIds !== undefined || job.targetSnapshots !== undefined || job.validationResultIds !== undefined || job.enrichmentResultIds !== undefined)) fail('Invalid legacy task kind.');
        const kind = data.version === 1 ? 'discover' : job.kind;
        if (!(data.version < 3 ? ['discover', 'validate'] : ['discover', 'validate', 'enrich']).includes(kind)) fail('Invalid task kind.');
        if (data.version >= 2 && (!Object.hasOwn(job, 'model') || typeof job.model !== 'string')) fail('Version 2 and 3 tasks require their saved model.');
        const validated = kind === 'discover' ? validateInput({ goal: job.goal, filters: job.filters, provider: job.provider, model: job.model }) : kind === 'validate' ? validateValidationInput({ goal: job.goal, criteria: job.criteria, candidateIds: job.targetCandidateIds, provider: job.provider, model: job.model }) : validateEnrichmentInput({ goal: job.goal, groups: job.groups, candidateIds: job.targetCandidateIds, provider: job.provider, model: job.model });
        job.model = validated.model;
        if (kind === 'discover' && JSON.stringify(validated.filters) !== JSON.stringify(job.filters) || kind === 'validate' && JSON.stringify(validated.criteria) !== JSON.stringify(job.criteria) || kind === 'enrich' && canonical(validated.groups) !== canonical(job.groups)) fail('Invalid persisted criteria snapshot.');
        job.kind = kind;
        if (!uuid(job.id) || !uuid(job.revision) || (job.checkpointId !== null && !uuid(job.checkpointId))) fail('Invalid discovery UUID.');
        if (ids.has(job.id) || !STATES.includes(job.status) || !Array.isArray(job.seenKeys) || job.seenKeys.length > 5000 || !Array.isArray(job.candidateIds) || job.candidateIds.length > 500 || !Number.isInteger(job.completedBatches) || job.completedBatches < 0 || job.completedBatches > 10 || !Number.isInteger(job.noNewBatches) || job.noNewBatches < 0 || !Number.isInteger(job.retries) || job.retries < 0 || job.retries > 3 || !job.createdAt || !job.updatedAt) fail('Invalid discovery job.');
        if (job.attemptId !== null && !uuid(job.attemptId)) fail('Invalid attempt UUID.'); if (job.status === 'running' && !job.attemptId) fail('Missing discovery attempt.');
        if (new Set(job.candidateIds).size !== job.candidateIds.length || (job.kind === 'discover' && job.candidateIds.length > job.filters.limit) || !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.updatedAt))) fail('Invalid discovery checkpoint.');
        for (const key of ['deadlineAt', 'nextRetryAt']) if (job[key] !== null && (!Number.isFinite(job[key]) || job[key] < 0)) fail('Invalid discovery deadline.');
        if (job.errorCode !== null) text(job.errorCode, 40, true);
        for (const key of job.seenKeys) text(key, 2048, true);
        for (const id of job.candidateIds) text(id, 128, true);
        text(job.reason, 1000); ids.add(job.id);
        if (job.kind === 'enrich') {
          if (job.candidateIds.length || job.seenKeys.length || job.noNewBatches || !Array.isArray(job.targetSnapshots) || job.targetSnapshots.length !== job.targetCandidateIds.length || !Array.isArray(job.enrichmentResultIds) || job.enrichmentResultIds.length > job.targetCandidateIds.length || new Set(job.enrichmentResultIds).size !== job.enrichmentResultIds.length) fail('Invalid enrichment checkpoint.');
          const { observationDigest } = require('./lead-hunter-enrichment-targets');
          for (const [index, target] of job.targetSnapshots.entries()) {
            if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(k => !['candidateId', 'discoveryJobId', 'inputDigest', 'candidate', 'validationResultId', 'validationTaskId', 'validationDigest', 'validatedAt'].includes(k)) || target.candidateId !== job.targetCandidateIds[index] || target.candidate?.id !== target.candidateId || target.candidate?.jobId !== target.discoveryJobId || target.inputDigest !== observationDigest(target.candidate) || !uuid(target.validationResultId) || !uuid(target.validationTaskId) || !/^[a-f0-9]{64}$/.test(target.validationDigest)) fail('Invalid enrichment snapshot.');
            validateCandidate(target.candidate); date(target.validatedAt);
          }
        }
        if (job.kind === 'validate') {
          if (job.candidateIds.length || job.seenKeys.length || job.noNewBatches || !Array.isArray(job.targetSnapshots) || job.targetSnapshots.length !== job.targetCandidateIds.length || !Array.isArray(job.validationResultIds) || job.validationResultIds.length > job.targetCandidateIds.length || new Set(job.validationResultIds).size !== job.validationResultIds.length) fail('Invalid validation checkpoint.');
          for (const [index, target] of job.targetSnapshots.entries()) {
            if (!target || typeof target !== 'object' || Object.keys(target).some(k => !['candidateId', 'discoveryJobId', 'inputDigest', 'candidate'].includes(k)) || target.candidateId !== job.targetCandidateIds[index] || target.candidate?.id !== target.candidateId || target.candidate?.jobId !== target.discoveryJobId || target.inputDigest !== candidateDigest(target.candidate)) fail('Invalid validation snapshot.');
            validateCandidate(target.candidate);
          }
        }
      }
      for (const candidate of data.candidates) { validateCandidate(candidate); if (candidateIds.has(candidate.id) || !ids.has(candidate.jobId)) fail('Invalid discovery candidate identity.'); candidateIds.add(candidate.id); }
      const jobMap = new Map(data.jobs.map(j => [j.id, j])), candidateMap = new Map(data.candidates.map(c => [c.id, c]));
      for (const job of data.jobs) for (const id of job.candidateIds) if (candidateMap.get(id)?.jobId !== job.id) fail('Missing discovery candidate.');
      for (const candidate of data.candidates) if (jobMap.get(candidate.jobId).kind !== 'discover') fail('Validation task owns discovery candidate.');
      if (data.version === 1) { if (data.validationResults !== undefined && (!Array.isArray(data.validationResults) || data.validationResults.length)) fail('Unexpected legacy validation data.'); data.validationResults = []; }
      if (!Array.isArray(data.validationResults) || data.validationResults.length > this.maxJobs * 100) fail('Invalid historical validation results.');
      const resultMap = new Map(), resultPairs = new Set();
      for (const job of data.jobs.filter(j => j.kind === 'validate')) for (const target of job.targetSnapshots) if (!candidateMap.has(target.candidateId) || candidateMap.get(target.candidateId).jobId !== target.discoveryJobId || jobMap.get(target.discoveryJobId)?.kind !== 'discover') fail('Missing validation target.');
      for (const result of data.validationResults) {
        const job = jobMap.get(result.taskId), target = job?.targetSnapshots?.find(s => s.candidateId === result.candidateId), pair = result.taskId + ':' + result.candidateId;
        if (!job || job.kind !== 'validate' || !target || resultMap.has(result.id) || resultPairs.has(pair) || !job.validationResultIds.includes(result.id)) fail('Invalid historical validation identity.');
        validateValidationResult(result, job, target); resultMap.set(result.id, result); resultPairs.add(pair);
      }
      for (const job of data.jobs.filter(j => j.kind === 'validate')) for (const id of job.validationResultIds) if (resultMap.get(id)?.taskId !== job.id) fail('Missing historical validation result.');
      if (data.version < 3) { if (data.enrichmentResults !== undefined && (!Array.isArray(data.enrichmentResults) || data.enrichmentResults.length) || data.jobs.some(job => job.enrichmentResultIds !== undefined)) fail('Unexpected legacy enrichment data.'); data.enrichmentResults = []; }
      if (!Array.isArray(data.enrichmentResults) || data.enrichmentResults.length > this.maxJobs * 100) fail('Invalid historical enrichment results.');
      const { canonicalDigest, observationDigest } = require('./lead-hunter-enrichment-targets'), enrichmentMap = new Map(), enrichmentPairs = new Set();
      const priorValidation = new Map();
      for (const job of data.jobs) {
        if (job.kind === 'validate') for (const target of job.targetSnapshots) priorValidation.set(target.candidateId, job.id);
        if (job.kind !== 'enrich') continue;
        for (const target of job.targetSnapshots) {
          const validation = resultMap.get(target.validationResultId), validationJob = jobMap.get(target.validationTaskId), validationTarget = validationJob?.targetSnapshots?.find(value => value.candidateId === target.candidateId);
          if (priorValidation.get(target.candidateId) !== target.validationTaskId || !candidateMap.has(target.candidateId) || candidateMap.get(target.candidateId).jobId !== target.discoveryJobId || jobMap.get(target.discoveryJobId)?.kind !== 'discover' || !validation || validation.overall !== 'passed' || validation.taskId !== target.validationTaskId || validation.candidateId !== target.candidateId || canonicalDigest(validation) !== target.validationDigest || validation.checkedAt !== target.validatedAt || !validationTarget || observationDigest(validationTarget.candidate) !== target.inputDigest || data.jobs.indexOf(validationJob) >= data.jobs.indexOf(job)) fail('Missing or inconsistent enrichment validation history.');
        }
      }
      for (const result of data.enrichmentResults) {
        const job = jobMap.get(result.taskId), target = job?.targetSnapshots?.find(value => value.candidateId === result.candidateId), pair = result.taskId + ':' + result.candidateId;
        if (!job || job.kind !== 'enrich' || !target || resultMap.has(result.id) || enrichmentMap.has(result.id) || enrichmentPairs.has(pair) || !job.enrichmentResultIds.includes(result.id)) fail('Invalid historical enrichment identity.');
        validateEnrichmentResult(result, job, target); enrichmentMap.set(result.id, result); enrichmentPairs.add(pair);
      }
      for (const job of data.jobs.filter(job => job.kind === 'enrich')) for (const id of job.enrichmentResultIds) if (enrichmentMap.get(id)?.taskId !== job.id) fail('Missing historical enrichment result.');
      data.version = 3;
      return data;
    } catch { fail('Discovery storage could not be read. Your data was kept unchanged; recover the file or its .bak copy before saving.', 'HUNTER_CORRUPT'); }
  }
  snapshot() { return this.read(); }
  write(data) { const reserved = reservedResultBytes(data); if (Buffer.byteLength(JSON.stringify(data)) + reserved > this.maxBytes) fail('Discovery storage is full. Export a backup before continuing.', 'HUNTER_FULL'); atomic(this.file, data, true); }
  enqueue(input) {
    const value = validateInput(input), data = this.read(); if (data.jobs.length >= this.maxJobs) fail('Discovery queue is full. Export a backup before adding more tasks.', 'HUNTER_FULL');
    const now = this.now(), job = { ...value, kind: 'discover', id: crypto.randomUUID(), revision: crypto.randomUUID(), status: 'queued', reason: '', attemptId: null, checkpointId: null, seenKeys: [], candidateIds: [], completedBatches: 0, noNewBatches: 0, retries: 0, deadlineAt: null, nextRetryAt: null, errorCode: null, createdAt: now, updatedAt: now };
    data.jobs.push(job); this.write(data); return clone(job);
  }
  enqueueValidation(input) {
    const value = validateValidationInput(input), data = this.read();
    if (data.jobs.length >= this.maxJobs) fail('Agent queue is full. Export a backup before adding more tasks.', 'HUNTER_FULL');
    const candidates = new Map(data.candidates.map(c => [c.id, c]));
    const targetSnapshots = value.candidateIds.map(id => {
      const original = candidates.get(id); if (!original) fail('Selected discovery candidate is unavailable. Refresh and choose again.', 'HUNTER_MISSING');
      const candidate = clone(original); return { candidateId: id, discoveryJobId: candidate.jobId, inputDigest: candidateDigest(candidate), candidate };
    });
    const now = this.now(), job = { goal: value.goal, provider: value.provider, model: value.model, criteria: value.criteria, kind: 'validate', targetCandidateIds: value.candidateIds, targetSnapshots, validationResultIds: [], id: crypto.randomUUID(), revision: crypto.randomUUID(), status: 'queued', reason: '', attemptId: null, checkpointId: null, seenKeys: [], candidateIds: [], completedBatches: 0, noNewBatches: 0, retries: 0, deadlineAt: null, nextRetryAt: null, errorCode: null, createdAt: now, updatedAt: now };
    data.jobs.push(job);
    // Reserve worst-case result space before a provider is launched, including other queued work.
    const reserved = reservedResultBytes(data);
    if (Buffer.byteLength(JSON.stringify(data)) + reserved > this.maxBytes) fail('Validation storage is full. Export a backup before adding more targets.', 'HUNTER_FULL');
    this.write(data); return clone(job);
  }
  enqueueEnrichment(input) {
    const value = validateEnrichmentInput(input), data = this.read();
    if (data.jobs.length >= this.maxJobs) fail('Agent queue is full. Export a backup before adding more tasks.', 'HUNTER_FULL');
    const { enrichmentEligibility, latestValidationMap, canonicalDigest, observationDigest } = require('./lead-hunter-enrichment-targets');
    const lookup = { candidates: new Map(data.candidates.map(candidate => [candidate.id, candidate])), latest: latestValidationMap(data) };
    const targetSnapshots = value.candidateIds.map(candidateId => {
      const eligible = enrichmentEligibility(data, candidateId, lookup);
      if (!eligible.eligible) fail(eligible.reason || 'Refresh and choose a business with latest Passed validation.', 'HUNTER_INELIGIBLE');
      const candidate = clone(eligible.candidate), validation = eligible.validation;
      return { candidateId, discoveryJobId: candidate.jobId, inputDigest: observationDigest(candidate), candidate, validationResultId: validation.id, validationTaskId: eligible.validationTaskId, validationDigest: canonicalDigest(validation), validatedAt: validation.checkedAt };
    });
    const now = this.now(), job = { goal: value.goal, provider: value.provider, model: value.model, groups: value.groups, kind: 'enrich', targetCandidateIds: value.candidateIds, targetSnapshots, enrichmentResultIds: [], id: crypto.randomUUID(), revision: crypto.randomUUID(), status: 'queued', reason: '', attemptId: null, checkpointId: null, seenKeys: [], candidateIds: [], completedBatches: 0, noNewBatches: 0, retries: 0, deadlineAt: null, nextRetryAt: null, errorCode: null, createdAt: now, updatedAt: now };
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
    if (job.kind !== 'discover') fail('Expected a Discover task.');
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
  commitValidationBatch(id, attemptId, batch) {
    const data = this.read(), job = data.jobs.find(j => j.id === id);
    if (!job || job.status !== 'running' || job.attemptId !== attemptId) fail('Validation attempt is no longer active.', 'HUNTER_STALE');
    if (job.kind !== 'validate' || !batch || !Array.isArray(batch.results) || !batch.results.length || batch.results.length > 10) fail('Invalid validation batch.');
    const targetMap = new Map(job.targetSnapshots.map(s => [s.candidateId, s])), pairs = new Set(), newResults = [];
    for (const raw of batch.results) {
      const result = clone(raw), target = targetMap.get(result.candidateId);
      if (!target || pairs.has(result.candidateId)) fail('Duplicate or foreign validation target.');
      pairs.add(result.candidateId); validateValidationResult(result, job, target);
      const prior = data.validationResults.find(r => r.taskId === id && r.candidateId === result.candidateId);
      if (prior) { if (canonical(prior) !== canonical(result)) fail('Validation target already has a different result.', 'HUNTER_CONFLICT'); continue; }
      if (data.validationResults.some(r => r.id === result.id) || data.enrichmentResults.some(r => r.id === result.id) || newResults.some(r => r.id === result.id)) fail('Validation result ID is already used.');
      newResults.push(result);
    }
    // Exact retries are idempotent, including the checkpoint and batch budget.
    if (!newResults.length) return clone(job);
    if (job.completedBatches >= 10) fail('Validation batch budget reached.', 'HUNTER_FULL');
    job.validationResultIds.push(...newResults.map(r => r.id)); data.validationResults.push(...newResults);
    job.completedBatches++; job.checkpointId = crypto.randomUUID(); job.revision = crypto.randomUUID(); job.updatedAt = this.now(); job.reason = text(batch.summary ?? '', 1000);
    this.write(data); return clone(job);
  }
  commitEnrichmentBatch(id, attemptId, batch) {
    const data = this.read(), job = data.jobs.find(value => value.id === id);
    if (!job || job.status !== 'running' || job.attemptId !== attemptId) fail('Enrichment attempt is no longer active.', 'HUNTER_STALE');
    if (job.kind !== 'enrich' || !batch || !Array.isArray(batch.results) || !batch.results.length || batch.results.length > 10) fail('Invalid enrichment batch.');
    const targets = new Map(job.targetSnapshots.map(target => [target.candidateId, target])), pairs = new Set(), results = [];
    for (const raw of batch.results) {
      const result = clone(raw), target = targets.get(result.candidateId);
      if (!target || pairs.has(result.candidateId)) fail('Duplicate or foreign enrichment target.');
      pairs.add(result.candidateId); validateEnrichmentResult(result, job, target);
      const prior = data.enrichmentResults.find(value => value.taskId === id && value.candidateId === result.candidateId);
      if (prior) { if (canonical(prior) !== canonical(result)) fail('Enrichment target already has a different result.', 'HUNTER_CONFLICT'); continue; }
      if (data.enrichmentResults.some(value => value.id === result.id) || data.validationResults.some(value => value.id === result.id) || results.some(value => value.id === result.id)) fail('Enrichment result ID is already used.');
      results.push(result);
    }
    if (!results.length) return clone(job);
    if (job.completedBatches >= 10) fail('Enrichment batch budget reached.', 'HUNTER_FULL');
    job.enrichmentResultIds.push(...results.map(result => result.id)); data.enrichmentResults.push(...results);
    job.completedBatches++; job.checkpointId = crypto.randomUUID(); job.revision = crypto.randomUUID(); job.updatedAt = this.now(); job.reason = text(batch.summary ?? '', 1000);
    this.write(data); return clone(job);
  }
  setPaused(paused) { if (typeof paused !== 'boolean') fail('Invalid discovery pause.'); const data = this.read(); data.paused = paused; this.write(data); return this.snapshot(); }
  markImported(candidateId, leadId) { text(leadId, 128, true); const data = this.read(), candidate = data.candidates.find(c => c.id === candidateId); if (!candidate) fail('Discovery candidate is unavailable.', 'HUNTER_MISSING'); if (candidate.importedLeadId && candidate.importedLeadId !== leadId) fail('Discovery candidate was already imported.', 'HUNTER_CONFLICT'); candidate.importedLeadId = leadId; this.write(data); return clone(candidate); }
}
module.exports = { HunterStore, validateInput, validateValidationInput, validationChecksRequired, validateValidationResult, candidateDigest, CHECK_KEYS, ENRICH_FIELD_KEYS, enrichmentFieldsRequired, validateEnrichmentInput, validateEnrichmentResult, MAX_RESULT_BYTES, STATES };
