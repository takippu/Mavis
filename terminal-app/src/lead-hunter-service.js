'use strict';
const { DEFAULT_MODEL, validateModel, listModels } = require('./lead-hunter-models');
// One main-process service owns discovery. Renderer mounts and window recreation never own it.
function createHunterService({ dir, onChange = () => {}, powerMonitor, store, runner, queue, leadsStore, clientsStore, getModels = listModels } = {}) {
  store ||= new (require('./lead-hunter-store').HunterStore)(dir);
  runner ||= new (require('./lead-hunter-codex').CodexRunner)({ dir });
  leadsStore ||= new (require('./leads-store').LeadsStore)(dir);
  clientsStore ||= new (require('./freelance-store').FreelanceStore)(dir);
  let lastActivity;
  const status = () => {
    const snapshot = { ...(queue?.snapshot ? queue.snapshot() : store.snapshot()), models: getModels(), defaultModel: DEFAULT_MODEL };
    return lastActivity && snapshot.jobs.some(job => job.id === lastActivity.jobId && job.attemptId === lastActivity.attemptId && job.status === 'running') ? { ...snapshot, activity: lastActivity } : snapshot;
  };
  const publish = (_snapshot, event) => {
    if (event && ['search', 'source'].includes(event.type)) {
      const job = store.snapshot().jobs.find(job => job.status === 'running');
      if (job) lastActivity = { type: event.type, jobId: job.id, attemptId: job.attemptId, at: new Date().toISOString(), label: event.type === 'source' ? String(event.label || 'Public source').slice(0, 120) : 'Searching public sources' };
    }
    onChange(status());
  };
  queue ||= new (require('./lead-hunter-queue').HunterQueue)({ store, runner, onChange: publish,
    getExisting: () => ({ leads: leadsStore.list(), clients: clientsStore.list('clients') }) });
  let stopping = false, shutdownPromise;
  const ready = Promise.resolve().then(() => queue.recover());
  // Avoid an unobserved rejection when startup happens before a renderer attaches.
  ready.catch(() => {});
  const available = async () => { if (stopping) throw new Error('Discover is shutting down.'); try { await ready; } catch { await queue.recover(); } };
  const suspended = () => { queue.pause('Machine went to sleep. Resume Discover when you are ready.').catch(() => {}); };
  const awakened = () => { try { publish(); } catch {} };
  powerMonitor?.on('suspend', suspended);
  powerMonitor?.on('resume', awakened);
  return {
    store, queue, runner, ready,
    snapshot: status,
    submit: async input => {
      await available();
      const model = validateModel(input?.model), choice = getModels().find(m => m.id === model);
      if (!choice?.available) throw Object.assign(new Error(choice?.reason || 'This model is unavailable for Discover. Choose another model.'), { code: 'HUNTER_MODEL_UNAVAILABLE' });
      return queue.submit({ ...input, model });
    },
    pause: async () => { await available(); await queue.pause(); return status(); },
    resume: async () => { await available(); await queue.resume(); return status(); },
    cancel: async id => { await available(); await queue.cancel(id); return status(); },
    importSelected: async input => {
      await available();
      const result = require('./lead-hunter-import').importSelected({ ...input, store, leadsStore, clients: clientsStore.list('clients') });
      publish(); return result;
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      stopping = true;
      powerMonitor?.removeListener('suspend', suspended);
      powerMonitor?.removeListener('resume', awakened);
      shutdownPromise = ready.catch(() => {}).then(async () => {
        let checkpointError;
        try { await queue.shutdown(); } catch (error) { checkpointError = error; }
        // A failed worker may still own a process group even after the queue promise settles.
        await runner.shutdown?.();
        if (checkpointError) throw checkpointError;
      }).catch(error => { shutdownPromise = null; throw error; });
      return shutdownPromise;
    },
  };
}
module.exports = { createHunterService };
