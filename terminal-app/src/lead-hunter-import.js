'use strict';
const { duplicateMatch } = require('./lead-hunter-candidates');
function importSelected({ candidateIds, store, leadsStore, clients = [], acknowledgePossibleDuplicates = false }) {
  if (!Array.isArray(candidateIds) || candidateIds.length > 500 || candidateIds.some(id => typeof id !== 'string' || !id || id.length > 128) || typeof acknowledgePossibleDuplicates !== 'boolean') throw Object.assign(new Error('Choose valid discovery candidates.'), { code: 'HUNTER_INVALID' });
  const result = { createdLeadIds: [], existingLeadIds: [], rejected: [] };
  const clientRecords = Array.isArray(clients) ? clients : clients.list('clients');
  // All storage operations are synchronous in the main process: competing IPC calls cannot interleave writes.
  for (const candidateId of new Set(candidateIds)) {
    const candidate = store.snapshot().candidates.find(c => c.id === candidateId);
    if (!candidate) { result.rejected.push({ candidateId, reason: 'Candidate is no longer available.' }); continue; }
    // Check the durable Leads origin first, including archived leads. This heals a crash between the two writes.
    const origin = leadsStore.findByDiscoveryCandidateId(candidateId);
    if (origin) { store.markImported(candidateId, origin.id); result.existingLeadIds.push(origin.id); continue; }
    if (candidate.importedLeadId) { result.rejected.push({ candidateId, reason: 'The imported lead is unavailable. Restore it before importing again.' }); continue; }
    const currentLeads = leadsStore.list();
    const match = duplicateMatch(candidate, { leads: currentLeads, clients: clientRecords, candidates: [] });
    if (match.kind === 'confident') { result.existingLeadIds.push(...match.recordIds.filter(id => currentLeads.some(lead => lead.id === id))); result.rejected.push({ candidateId, reason: 'An existing Lead or Client already matches this business.' }); continue; }
    if ((match.kind === 'possible' || candidate.duplicate.kind === 'possible') && !acknowledgePossibleDuplicates) { result.rejected.push({ candidateId, reason: 'Review and acknowledge the possible duplicate before importing.' }); continue; }
    const source = candidate.sources[0]?.url || '';
    const lead = leadsStore.create({ title: candidate.company, company: candidate.company, email: candidate.contact.email, phone: candidate.contact.phone, source: source.slice(0, 240), stage: 'new', nextStep: 'Validation pending: review the business, website and public contact evidence.', brief: 'Discovered from public sources. Observations have not been independently validated.', discovery: { version: 1, candidateId, jobId: candidate.jobId, provider: 'codex', discoveredAt: candidate.discoveredAt, sources: candidate.sources, website: candidate.website, location: { region: candidate.region, city: candidate.city, address: candidate.address }, industry: candidate.industry } });
    store.markImported(candidateId, lead.id); result.createdLeadIds.push(lead.id);
  }
  result.existingLeadIds = [...new Set(result.existingLeadIds)]; return result;
}
module.exports = { importSelected };
