'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeValidationBatch, refreshDuplicates, validateValidationOutput } = require('../src/lead-hunter-validation');
const { validateValidationResult } = require('../src/lead-hunter-store');
const url = 'https://alpha.example.com/contact';
const candidate = { id: 'candidate-1', company: 'Alpha Workshop', industry: 'Auto repair', region: 'Selangor', city: 'Shah Alam', address: '12 Jalan Mawar', website: { state: 'found', url }, contact: { email: 'hello@alpha.example.com', phone: '', form: '' }, sources: [{ url }], importedLeadId: 'own-lead' };
const target = { candidateId: candidate.id, discoveryJobId: 'discover-1', inputDigest: 'a'.repeat(64), candidate };
const job = { id: 'validation-task', model: 'gpt-6.1-sol', criteria: { industry: 'Auto repair', region: 'Selangor', city: 'Shah Alam', website: 'found', contact: 'email', checkDuplicates: true } };
const raw = { candidateId: candidate.id, company: candidate.company, industry: candidate.industry, region: candidate.region, city: candidate.city, address: candidate.address, website: { ...candidate.website }, contact: { ...candidate.contact }, sources: [{ url, label: 'Official' }] };
const text = 'Alpha Workshop Auto repair 12 Jalan Mawar Shah Alam Selangor hello@alpha.example.com';
const evidence = [{ url, finalUrl: url, label: 'alpha.example.com', text, blocks: [text], pageTitle: 'Alpha Workshop', observedAt: '2026-10-13T01:00:00Z' }];
const run = (output = { observations: [raw] }, acquired = evidence, options = {}) => normalizeValidationBatch(output, acquired, { job, targets: [target], ...options });
const check = (result, key) => result.checks.find(c => c.key === key);
test('exact branch observations pass requested checks and satisfy persisted result contract', () => {
    const [result] = run(); assert.equal(result.overall, 'passed'); assert.equal(result.checks.length, 6); assert.ok(result.checks.every(c => c.status === 'passed'));
    validateValidationResult(result, job, target); assert.equal(run()[0].id, result.id); assert.ok(check(result, 'contact').explanation.includes('deliverability is not checked'));
});
test('provider assertions and forged/private URLs are never evidence', () => {
    for (const sources of [[{ url, label: 'Claims' }], [{ url: 'http://127.0.0.1', label: 'Private' }]]) {
        const [result] = run({ observations: [{ ...raw, sources }] }, []); assert.equal(result.overall, 'needs_review'); assert.equal(check(result, 'identity').status, 'unknown'); assert.deepEqual(result.sources, []);
    }
    const [result] = run({ observations: [raw] }, [{ ...evidence[0], finalUrl: 'http://192.168.1.1' }]); assert.equal(check(result, 'identity').status, 'unknown');
});
test('missing observations retain an explicit Unknown result for every target', () => {
    const second = { ...target, candidateId: 'candidate-2', candidate: { ...candidate, id: 'candidate-2' } };
    const results = run({ observations: [] }, [], { targets: [target, second] }); assert.equal(results.length, 2); assert.ok(results.every(r => r.overall === 'needs_review')); assert.ok(results.every(r => check(r, 'identity').status === 'unknown'));
});
test('foreign IDs, duplicate IDs, extra claims, and malformed output fail typed', () => {
    for (const output of [{ observations: [{ ...raw, candidateId: 'foreign' }] }, { observations: [raw, raw] }, { observations: [raw], verdict: 'passed' }, { observations: [{ ...raw, verdict: 'passed' }] }, { observations: [{ ...raw, contact: {} }] }]) assert.throws(() => validateValidationOutput(output, [target]), { code: 'OUTPUT' });
});
test('another branch cannot supply identity or contacts to this branch', () => {
    const other = 'Alpha Workshop Auto repair 8 Jalan Bunga Johor Bahru Johor hello@alpha.example.com';
    const [result] = run({ observations: [raw] }, [{ ...evidence[0], text: other, blocks: [other] }]); assert.equal(check(result, 'identity').status, 'unknown'); assert.equal(check(result, 'contact').status, 'unknown');
    const combined = 'Alpha Workshop branches ' + text + ' ' + other;
    const [nested] = run({ observations: [raw] }, [{ ...evidence[0], text: combined, blocks: [combined, text, other] }]); assert.equal(check(nested, 'identity').status, 'passed'); assert.equal(check(nested, 'contact').status, 'passed');
    const footer = 'Contact hello@alpha.example.com';
    const [footerResult] = run({ observations: [raw] }, [{ ...evidence[0], text: text.replace(' hello@alpha.example.com', '') + ' ' + footer, blocks: [text.replace(' hello@alpha.example.com', ''), footer] }]); assert.equal(check(footerResult, 'identity').status, 'passed'); assert.equal(check(footerResult, 'contact').status, 'unknown');
});
test('not observed website stays inconclusive and owned acquired website contradicts it', () => {
    const changedJob = { ...job, criteria: { ...job.criteria, website: 'not_observed' } };
    const [unknown] = run({ observations: [{ ...raw, website: { state: 'not_observed', url: '' } }] }, evidence, { job: changedJob }); assert.equal(check(unknown, 'website').status, 'unknown'); assert.equal(unknown.overall, 'needs_review');
    const [failed] = run(undefined, undefined, { job: changedJob }); assert.equal(check(failed, 'website').status, 'failed'); assert.equal(failed.overall, 'failed');
});
test('a directory link does not establish acquisition and ownership of the advertised site', () => {
    const directoryUrl = 'https://bizmalay.com/alpha';
    const [result] = run({ observations: [{ ...raw, sources: [{ url: directoryUrl, label: 'Directory' }] }] }, [{ ...evidence[0], url: directoryUrl, finalUrl: directoryUrl, text: text + ' ' + url }]); assert.equal(check(result, 'identity').status, 'passed'); assert.equal(check(result, 'website').status, 'unknown');
});
test('optional and skipped checks do not prevent passed identity-only validation', () => {
    const changedJob = { ...job, criteria: { industry: '', region: '', city: '', website: 'any', contact: 'any', checkDuplicates: false } };
    const [result] = run({ observations: [{ ...raw, contact: { email: '', phone: '', form: '' } }] }, evidence, { job: changedJob }); assert.equal(result.overall, 'passed'); assert.equal(check(result, 'contact').status, 'unknown'); assert.equal(check(result, 'contact').required, false);
    for (const key of ['industry', 'location', 'website', 'duplicate']) assert.equal(check(result, key).status, 'not_requested'); validateValidationResult(result, changedJob, target);
    const [skipped] = run(undefined, undefined, { job: { ...changedJob, criteria: { ...changedJob.criteria, contact: 'not_required' } } }); assert.equal(check(skipped, 'contact').status, 'not_requested');
});
test('literal supported industry/location contradictions fail but unsupported claims stay Unknown', () => {
    const changedJob = { ...job, criteria: { ...job.criteria, industry: 'Restaurant', region: 'Johor' } };
    const [result] = run(undefined, undefined, { job: changedJob }); assert.equal(check(result, 'industry').status, 'failed'); assert.equal(check(result, 'location').status, 'failed');
    const [forged] = run({ observations: [{ ...raw, industry: 'Restaurant', region: 'Johor' }] }); assert.equal(check(forged, 'industry').status, 'unknown'); assert.equal(check(forged, 'location').status, 'unknown');
});
test('local duplicate refresh excludes own imports, catches newly imported self and preserves history', () => {
    const [result] = run();
    const own = { ...candidate, id: 'own-lead' }, newlyImported = { ...candidate, id: 'new-self', discovery: { candidateId: candidate.id } };
    const noExternal = refreshDuplicates([result], [target], job.criteria, { leads: [own, newlyImported] })[0]; assert.equal(noExternal.overall, 'passed'); assert.deepEqual(noExternal.duplicate, { kind: 'none', recordIds: [] });
    const duplicate = refreshDuplicates([result], [target], job.criteria, { clients: [{ ...candidate, id: 'another-client' }] })[0]; assert.equal(duplicate.overall, 'failed'); assert.deepEqual(duplicate.duplicate.recordIds, ['another-client']); assert.equal(duplicate.checkedAt, result.checkedAt); assert.equal(duplicate.id, result.id); assert.equal(duplicate.inputDigest, result.inputDigest); assert.deepEqual(result.duplicate, { kind: 'none', recordIds: [] });
    const possible = refreshDuplicates([result], [target], job.criteria, { clients: [{ id: 'possible', company: candidate.company }] })[0]; assert.equal(possible.overall, 'needs_review'); assert.equal(possible.duplicate.kind, 'possible');
});
test('unclassified directory cannot become an owned website merely by repeating the business', () => {
    const directoryUrl = 'https://www.mara.gov.my/consultants';
    const [result] = run({ observations: [{ ...raw, website: { state: 'found', url: directoryUrl }, sources: [{ url: directoryUrl, label: 'Directory' }] }] }, [{ ...evidence[0], url: directoryUrl, finalUrl: directoryUrl, pageTitle: 'Registered Consultants MARA' }]);
    assert.equal(check(result, 'identity').status, 'passed'); assert.equal(check(result, 'website').status, 'unknown');
});
test('a parent block cannot borrow another same-city business contact from an unanchored child', () => {
    const directoryUrl = 'https://listings.example.com/businesses', ownText = 'Alpha Workshop Auto repair 12 Jalan Mawar Shah Alam Selangor', neighbour = 'Beta Studio hello@alpha.example.com';
    const [result] = run({ observations: [{ ...raw, sources: [{ url: directoryUrl, label: 'Directory' }] }] }, [{ ...evidence[0], url: directoryUrl, finalUrl: directoryUrl, pageTitle: 'Business directory', text: ownText + ' ' + neighbour, blocks: [ownText + ' ' + neighbour, ownText, neighbour] }]);
    assert.equal(check(result, 'identity').status, 'passed'); assert.equal(check(result, 'contact').status, 'unknown');
});
test('contact must be the literal public address, not a punctuation-collapsed lookalike or suffix', () => {
    for (const observed of ['helloalphaexamplecom', 'otherhello@alpha.example.com']) {
        const changed = text.replace('hello@alpha.example.com', observed);
        const [result] = run(undefined, [{ ...evidence[0], text: changed, blocks: [changed] }]); assert.equal(check(result, 'contact').status, 'unknown');
    }
});
test('first-party contact headings may place the company after Contact us', () => {
    const [result] = run(undefined, [{ ...evidence[0], pageTitle: 'Contact us | Alpha Workshop' }]); assert.equal(check(result, 'website').status, 'passed');
});
