'use strict';
const crypto = require('crypto');
const DEFAULT_POLICY = { maxBatches: 10, taskTimeoutMs: 15 * 60 * 1000, batchTimeoutMs: 2 * 60 * 1000, noNewBatchLimit: 2, retryDelaysMs: [15000, 60000, 180000] };
const TERMINAL = ['completed', 'cancelled', 'failed'];
class HunterQueue {
  constructor({ store, runner, clock = {}, onChange = () => {}, policy = {}, getExisting = () => ({ leads: [], clients: [] }) }) {
    this.store = store; this.runner = runner; this.clock = { now: clock.now ? () => clock.now() : () => Date.now(), setTimeout: clock.setTimeout ? (fn, ms) => clock.setTimeout(fn, ms) : setTimeout, clearTimeout: clock.clearTimeout ? id => clock.clearTimeout(id) : clearTimeout };
    this.onChange = onChange; this.getExisting = getExisting; this.policy = { ...DEFAULT_POLICY, ...policy };
    this.policy.maxBatches = Math.max(1, Math.min(10, this.policy.maxBatches)); this.policy.taskTimeoutMs = Math.max(1, Math.min(DEFAULT_POLICY.taskTimeoutMs, this.policy.taskTimeoutMs)); this.policy.batchTimeoutMs = Math.max(1, Math.min(DEFAULT_POLICY.batchTimeoutMs, this.policy.batchTimeoutMs)); this.policy.retryDelaysMs = this.policy.retryDelaysMs.slice(0, 3); this.policy.noNewBatchLimit = Math.max(1, Math.min(2, this.policy.noNewBatchLimit));
    this.runtimeError = null; this.started = false; this.stopping = false; this.active = null; this.pumping = null; this.retryTimer = null;
  }
  snapshot() { const snapshot = this.store.snapshot(); return this.runtimeError ? { ...snapshot, error: { ...this.runtimeError } } : snapshot; }
  notify(event) { try { this.onChange(this.snapshot(), event); } catch { /* UI listeners cannot alter scheduling. */ } }
  submit(input) { if (this.stopping) throw Object.assign(new Error('Discovery is shutting down.'), { code: 'HUNTER_STOPPED' }); const job = this.store.enqueue(input); this.notify(); this.schedule(); return job; }
  clearRetry() { if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer); this.retryTimer = null; }
  recordError(error) {
    this.started = false; this.clearRetry(); this.runtimeError = { code: error.code || 'HUNTER', message: error.message };
    this.active?.controller.abort(); this.notify({ type: 'error', ...this.runtimeError });
  }
  fenceInterrupted() {
    let interrupted = false;
    for (const job of this.snapshot().jobs) if (job.status === 'running' && !(this.active?.id === job.id && this.active.attemptId === job.attemptId)) {
      this.store.transition(job.id, job.revision, 'paused', 'Interrupted when the app stopped. Resume to continue.', { errorCode: 'INTERRUPTED' }); interrupted = true;
    }
    if (interrupted) this.store.setPaused(true);
  }
  async recover() {
    if (this.started) return this.snapshot();
    try {
      if (this.pumping) await this.pumping;
      this.fenceInterrupted(); this.runtimeError = null; this.started = true; this.notify(); this.schedule(); return this.snapshot();
    } catch (error) { this.recordError(error); throw error; }
  }
  schedule() {
    if (!this.started || this.stopping || this.pumping) return;
    this.pumping = Promise.resolve().then(() => this.pump()).catch(error => {
      // Storage failures are recoverable: preserve files and stop automatic work.
      this.recordError(error);
    }).finally(() => { this.pumping = null; if (this.started && !this.stopping && !this.snapshot().paused && this.retryTimer === null && this.hasEligible()) this.schedule(); });
  }
  hasEligible() { if (this.snapshot().jobs.some(j => j.status === 'waiting' && ['AUTH', 'QUOTA'].includes(j.errorCode))) return false; return this.snapshot().jobs.some(j => j.status === 'queued' || (j.status === 'waiting' && j.errorCode === 'NETWORK' && j.nextRetryAt !== null)); }
  transition(job, state, reason, patch = {}) { const updated = this.store.transition(job.id, job.revision, state, reason, patch); this.notify(); return updated; }
  current(id) { return this.snapshot().jobs.find(j => j.id === id); }
  async pump() {
    this.clearRetry();
    while (this.started && !this.stopping) {
      const state = this.snapshot(); if (state.paused || state.jobs.some(j => j.status === 'waiting' && ['AUTH', 'QUOTA'].includes(j.errorCode))) return;
      let job = state.jobs.find(j => j.status === 'queued' || (j.status === 'waiting' && j.errorCode === 'NETWORK'));
      if (!job) return;
      if (job.status === 'waiting' && job.nextRetryAt > this.clock.now()) { this.retryTimer = this.clock.setTimeout(() => { this.retryTimer = null; this.schedule(); }, job.nextRetryAt - this.clock.now()); return; }
      if (job.deadlineAt !== null && this.clock.now() >= job.deadlineAt) { this.transition(job, 'completed', 'Task time budget reached; saved results are available.', { nextRetryAt: null }); continue; }
      if (job.completedBatches >= this.policy.maxBatches || job.candidateIds.length >= job.filters.limit || job.noNewBatches >= this.policy.noNewBatchLimit) { this.transition(job, 'completed', this.finishReason(job)); continue; }
      const attemptId = crypto.randomUUID();
      job = this.transition(job, 'running', 'Searching public sources.', { attemptId, deadlineAt: job.deadlineAt ?? this.clock.now() + this.policy.taskTimeoutMs, nextRetryAt: null, errorCode: null });
      const controller = new AbortController(), active = { id: job.id, attemptId, controller, timedOut: false, promise: null };
      this.active = active;
      const timer = this.clock.setTimeout(() => { active.timedOut = true; controller.abort(); }, Math.max(1, Math.min(this.policy.batchTimeoutMs, job.deadlineAt - this.clock.now())));
      active.promise = Promise.resolve().then(() => this.runner.run({ job, attemptId, checkpoint: { id: job.checkpointId, seenKeys: [...job.seenKeys], completedBatches: job.completedBatches }, signal: controller.signal, onEvent: event => {
        try { const current = this.current(job.id); if (current?.status === 'running' && current.attemptId === attemptId && !controller.signal.aborted) this.notify(event); }
        catch (error) { this.recordError(error); }
      } }));
      try {
        const result = await active.promise;
        let current = this.current(job.id);
        if (!current || current.status !== 'running' || current.attemptId !== attemptId || controller.signal.aborted || this.stopping) {
          if (active.timedOut && current?.status === 'running' && current.attemptId === attemptId) this.transition(current, 'failed', 'Search batch timed out. Saved results were kept.', { errorCode: 'TIMEOUT' });
          return;
        }
        const prepared = this.prepareCandidates(result, current);
        current = this.store.commitBatch(job.id, attemptId, { candidates: prepared.candidates, seenKeys: prepared.seenKeys, summary: prepared.summary }); this.notify();
        if (result.exhausted || current.candidateIds.length >= current.filters.limit || current.completedBatches >= this.policy.maxBatches || current.noNewBatches >= this.policy.noNewBatchLimit || this.clock.now() >= current.deadlineAt) this.transition(current, 'completed', result.exhausted ? 'Sources exhausted; saved results are available.' : this.finishReason(current));
        else this.transition(current, 'queued', 'Continuing from the saved batch.', { errorCode: null, nextRetryAt: null });
      } catch (error) {
        const current = this.current(job.id);
        if (!current || current.status !== 'running' || current.attemptId !== attemptId || this.stopping || (controller.signal.aborted && !active.timedOut)) return;
        const code = active.timedOut ? 'TIMEOUT' : error.code || 'PROCESS';
        if (code === 'NETWORK' && current.retries < this.policy.retryDelaysMs.length && this.clock.now() + this.policy.retryDelaysMs[current.retries] < current.deadlineAt) {
          const delay = this.policy.retryDelaysMs[current.retries]; this.transition(current, 'waiting', 'Network unavailable. Retry ' + (current.retries + 1) + ' scheduled in ' + Math.ceil(delay / 1000) + ' seconds.', { errorCode: code, retries: current.retries + 1, nextRetryAt: this.clock.now() + delay });
        } else if (code === 'AUTH' || code === 'QUOTA') this.transition(current, 'waiting', code === 'AUTH' ? 'Codex login is required. Sign in, then Resume.' : 'Codex quota is unavailable. Resolve it, then Resume.', { errorCode: code, nextRetryAt: null });
        else this.transition(current, 'failed', String(error.message || 'Discovery search failed.').slice(0, 900) + ' Saved results were kept.', { errorCode: code, nextRetryAt: null });
      } finally { this.clock.clearTimeout(timer); if (this.active === active) this.active = null; }
      return;
    }
  }
  prepareCandidates(result, job) {
    if (!result || !Array.isArray(result.candidates) || result.candidates.length > 10) throw Object.assign(new Error('Invalid discovery batch output.'), { code: 'OUTPUT' });
    const { duplicateMatch, matchesIndustry } = require('./lead-hunter-candidates');
    const existing = this.getExisting() || {}, prior = this.snapshot().candidates, accepted = [], seenKeys = [];
    for (const candidate of result.candidates) {
      const folded = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const filters = job.filters;
      if (filters.region && !folded(candidate.region).includes(folded(filters.region)) || filters.city && !folded(candidate.city).includes(folded(filters.city)) || filters.industry && !matchesIndustry(candidate.industry, filters.industry) || filters.website !== 'any' && candidate.website?.state !== filters.website || ['email', 'phone', 'form'].includes(filters.contact) && !candidate.contact?.[filters.contact]) continue;
      const keys = candidate.identityKeys || []; seenKeys.push(...keys);
      if (job.seenKeys.some(key => !key.startsWith('source:') && keys.includes(key)) || prior.some(c => c.id === candidate.id) || accepted.some(c => c.id === candidate.id)) continue;
      const priorMatch = duplicateMatch(candidate, { leads: [], clients: [], candidates: [...prior, ...accepted] });
      if (priorMatch.kind === 'confident') continue;
      const match = duplicateMatch(candidate, { leads: existing.leads || [], clients: existing.clients || [], candidates: [] });
      if (job.filters.skipExisting && match.kind === 'confident') continue;
      const duplicate = match.kind !== 'none' ? match : priorMatch;
      if (accepted.length < job.filters.limit - job.candidateIds.length) accepted.push({ ...candidate, duplicate });
    }
    return { candidates: accepted, seenKeys: [...new Set(seenKeys)], summary: accepted.length ? accepted.length + ' new candidates saved. Validation is pending.' : 'No new matching candidates in this batch.' };
  }
  finishReason(job) {
    if (job.candidateIds.length >= job.filters.limit) return 'Requested maximum reached. Validation is pending.';
    if (job.noNewBatches >= this.policy.noNewBatchLimit) return 'Two batches found no new matching candidates. Saved results are available.';
    if (job.completedBatches >= this.policy.maxBatches) return 'Batch budget reached; saved results are available.';
    return 'Task time budget reached; saved results are available.';
  }
  async checkpointAndStop(reason, errorCode) {
    // Persistence can fail, but process ownership and teardown cannot depend on a write succeeding.
    this.started = false; this.clearRetry();
    let failure;
    try {
      this.store.setPaused(true);
      for (const job of this.snapshot().jobs) if (job.status === 'running') this.transition(job, 'paused', reason, { errorCode });
    } catch (error) { failure = error; this.recordError(error); }
    finally {
      this.active?.controller.abort();
      if (this.pumping) await this.pumping;
      this.started = false;
    }
    if (failure) throw failure;
    this.notify(); return this.snapshot();
  }
  async pause(reason = 'Paused by you. Resume to continue.') {
    return this.checkpointAndStop(reason, 'PAUSED');
  }
  async resume() {
    if (this.stopping) throw Object.assign(new Error('Discovery is shutting down.'), { code: 'HUNTER_STOPPED' });
    if ((this.runtimeError || this.active?.controller.signal.aborted) && this.pumping) await this.pumping;
    this.started = false;
    try {
      // A failed checkpoint may have left durable running state with no living child. Fence it first.
      this.fenceInterrupted();
      for (const job of this.snapshot().jobs) if (job.status === 'paused' || (job.status === 'waiting' && ['AUTH', 'QUOTA'].includes(job.errorCode))) this.transition(job, 'queued', 'Ready to continue.', { nextRetryAt: null, errorCode: null });
      this.store.setPaused(false); this.runtimeError = null; this.started = true; this.notify(); this.schedule(); return this.snapshot();
    } catch (error) {
      this.recordError(error); if (this.pumping) await this.pumping; throw error;
    }
  }
  async cancel(id) {
    try {
      const job = this.current(id); if (!job) throw Object.assign(new Error('Discovery task is unavailable.'), { code: 'HUNTER_MISSING' });
      if (TERMINAL.includes(job.status)) return this.snapshot();
      this.transition(job, 'cancelled', 'Cancelled. Saved results were kept.', { nextRetryAt: null }); this.clearRetry();
    } catch (error) {
      if (error.code !== 'HUNTER_MISSING') { this.recordError(error); if (this.pumping) await this.pumping; }
      throw error;
    }
    if (this.active?.id === id) { this.active.controller.abort(); if (this.pumping) await this.pumping; }
    this.schedule(); return this.snapshot();
  }
  async shutdown() {
    this.stopping = true;
    return this.checkpointAndStop('App stopped. Resume to continue.', 'INTERRUPTED');
  }
}
module.exports = { HunterQueue, DEFAULT_POLICY };
