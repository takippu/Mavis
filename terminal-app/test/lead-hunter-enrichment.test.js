'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { FIELD_KEYS, normalizeEnrichmentBatch, validateEnrichmentOutput } = require('../src/lead-hunter-enrichment');
const { validateEnrichmentResult } = require('../src/lead-hunter-store');
const url = 'https://alpha.example.com/contact';
const candidate = { company: 'Alpha Workshop', industry: 'Auto repair', region: 'Selangor', city: 'Shah Alam', address: '12 Jalan Mawar', website: { state: 'found', url }, contact: { email: 'hello@alpha.example.com', phone: '', form: '' } };
const target = { candidateId: 'candidate-1', discoveryJobId: 'discovery-1', candidate, inputDigest: 'a'.repeat(64), validationResultId: 'validation-1', validationTaskId: 'validate-task', validationDigest: 'b'.repeat(64), validatedAt: '2026-10-13T00:00:00Z' };
const groups = { offerings: true, contacts: true, branding: true, website: true, brief: true };
const job = { id: 'enrichment-task', kind: 'enrich', model: 'gpt-6.1-sol', groups };
const fact = (key, value, sourceUrl = url) => ({ key, value, sourceUrl });
const facts = [fact('description', 'Auto repair'), fact('services', 'Brake repairs'), fact('products', 'Engine oil'), fact('email', 'hello@alpha.example.com'), fact('phone', '03 5512 3344'), fact('contact_form', url), fact('brand_name', 'Alpha Workshop'), fact('tagline', 'Care for your car'), fact('website_url', url), fact('website_observations', 'Contact us')];
const raw = { candidateId: target.candidateId, ...candidate, sources: [{ url, label: 'Official' }], facts };
const text = 'Alpha Workshop Auto repair 12 Jalan Mawar Shah Alam Selangor Brake repairs Engine oil hello@alpha.example.com 03 5512 3344 Contact us Contact form https://alpha.example.com/contact Care for your car';
const evidence = [{ url, finalUrl: url, pageTitle: 'Contact us | Alpha Workshop', text, blocks: [text], label: 'Official', observedAt: '2026-10-13T01:00:00Z' }];
const run = (output = { observations: [raw] }, acquired = evidence, options = {}) => normalizeEnrichmentBatch(output, acquired, { job, targets: [target], ...options });
const field = (result, key) => result.fields.find(value => value.key === key);
test('observed exact branch facts create fixed bounded fields and deterministic grounded draft', () => {
    const [result] = run(); assert.equal(result.status, 'ready'); assert.equal(result.identity.state, 'observed'); assert.deepEqual(result.fields.map(value => value.key), FIELD_KEYS); assert.ok(result.fields.every(value => value.state === 'observed'));
    assert.equal(result.validationResultId, target.validationResultId); assert.equal(result.inputDigest, target.inputDigest); assert.equal(result.model, job.model); assert.equal(run()[0].id, result.id); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
    validateEnrichmentResult(result, job, target);
    assert.ok(result.brief.summary.includes('Brake repairs')); assert.ok(result.brief.suggestions.every(value => value.startsWith('Proposal:'))); assert.ok(field(result, 'email').explanation.includes('deliverability is not checked'));
});
test('missing observations and blocked evidence preserve a result for every target with blank Unknown fields', () => {
    const second = { ...target, candidateId: 'candidate-2' };
    for (const output of [{ observations: [] }, { observations: [raw] }]) {
        const results = run(output, [], { targets: [target, second] }); assert.equal(results.length, 2);
        for (const result of results) { assert.equal(result.status, 'needs_review'); assert.equal(result.identity.state, 'unknown'); assert.ok(result.fields.every(value => value.state === 'unknown' && !value.values.length)); assert.ok(result.brief.summary.includes('Unknown')); assert.ok(!result.brief.summary.includes('Brake repairs')); }
    }
});
test('unsupported inferred values and manufactured website gaps remain Unknown', () => {
    const invented = { ...raw, facts: [fact('services', 'Web development'), fact('website_observations', 'Missing online booking'), fact('email', 'guess@alpha.example.com')] };
    const [result] = run({ observations: [invented] }); assert.equal(result.status, 'partial'); assert.equal(result.identity.state, 'observed'); assert.ok(result.fields.every(value => value.state === 'unknown' && value.values.length === 0));
    assert.ok(!result.brief.summary.includes('Missing online booking')); assert.ok(!result.brief.summary.includes('Web development')); assert.ok(!result.brief.suggestions.some(value => /booking/.test(value)));
});
test('unrequested fields remain empty and a brief-only task does not silently research contacts', () => {
    const [result] = run(undefined, undefined, { job: { ...job, groups: { offerings: false, contacts: false, branding: false, website: false, brief: true } } });
    assert.equal(result.status, 'ready'); assert.ok(result.fields.every(value => value.state === 'not_requested' && !value.values.length)); assert.ok(!result.brief.summary.includes('hello@alpha')); assert.equal(result.brief.state, 'draft');
    const [withoutBrief] = run(undefined, undefined, { job: { ...job, groups: { ...groups, brief: false } } }); assert.deepEqual(withoutBrief.brief, { state: 'not_requested', summary: '', suggestions: [] });
});
test('malformed, foreign, duplicate and uncited facts fail typed before normalization', () => {
    const invalid = [{ observations: [raw, raw] }, { observations: [{ ...raw, candidateId: 'foreign' }] }, { observations: [{ ...raw, facts: [fact('colors', 'blue')] }] }, { observations: [{ ...raw, facts: [fact('services', 'Brake repairs'), fact('services', 'Brake repairs')] }] }, { observations: [{ ...raw, facts: [{ ...facts[0], invented: true }] }] }, { observations: [{ ...raw, facts: [fact('services', 'x'.repeat(241))] }] }, { observations: [{ ...raw, facts: [fact('services', 'Brake repairs', 'https://other.example.com/')] }] }, { observations: [{ ...raw, facts: [fact('services', 'Brake repairs', 'http://127.0.0.1/')] }] }, { observations: [{ ...raw, sources: {} }] }, { observations: [{ ...raw, verdict: 'ready' }] }, { observations: [raw], brief: 'Marketing copy' }];
    for (const output of invalid) assert.throws(() => validateEnrichmentOutput(output, [target]), { code: 'OUTPUT' });
    for (const badGroups of [{}, { ...groups, other: true }, Object.fromEntries(Object.keys(groups).map(key => [key, false]))]) assert.throws(() => run(undefined, undefined, { job: { ...job, groups: badGroups } }), { code: 'OUTPUT' });
});
test('foreign branch and unsafe redirect cannot establish business facts', () => {
    for (const acquired of [[{ ...evidence[0], text: text.replace('12 Jalan Mawar', '9 Jalan Bunga'), blocks: [text.replace('12 Jalan Mawar', '9 Jalan Bunga')] }], [{ ...evidence[0], finalUrl: 'http://192.168.0.1/' }]]) {
        const [result] = run(undefined, acquired); assert.equal(result.identity.state, 'unknown'); assert.equal(result.status, 'needs_review'); assert.ok(result.fields.every(value => !value.values.length));
    }
});
test('directory or footer neighbours cannot lend offerings, branding or contacts', () => {
    const own = 'Alpha Workshop Auto repair 12 Jalan Mawar Shah Alam Selangor';
    const other = 'Beta Studio Web development hello@alpha.example.com Care for your car';
    const combined = own + ' ' + other, directoryUrl = 'https://listings.example.com/companies';
    const borrowed = { ...raw, sources: [{ url: directoryUrl, label: 'Directory' }], facts: [fact('services', 'Web development', directoryUrl), fact('email', 'hello@alpha.example.com', directoryUrl), fact('tagline', 'Care for your car', directoryUrl)] };
    const [result] = run({ observations: [borrowed] }, [{ ...evidence[0], url: directoryUrl, finalUrl: directoryUrl, pageTitle: 'Business directory', text: combined, blocks: [combined, own, other] }]);
    assert.equal(result.identity.state, 'observed'); assert.ok(result.fields.every(value => !value.values.length)); assert.equal(result.status, 'partial');
});
test('directory page can support branch facts but cannot prove website ownership or owned-site gaps', () => {
    const directoryUrl = 'https://www.mara.gov.my/consultants';
    const observation = { ...raw, website: { state: 'found', url: directoryUrl }, sources: [{ url: directoryUrl, label: 'Directory' }], facts: [fact('services', 'Brake repairs', directoryUrl), fact('website_url', directoryUrl, directoryUrl), fact('website_observations', 'Contact us', directoryUrl)] };
    const [result] = run({ observations: [observation] }, [{ ...evidence[0], url: directoryUrl, finalUrl: directoryUrl, pageTitle: 'Registered Consultants MARA' }]);
    assert.equal(result.identity.state, 'observed'); assert.equal(field(result, 'services').state, 'observed'); assert.equal(field(result, 'website_url').state, 'unknown'); assert.equal(field(result, 'website_observations').state, 'unknown');
    const unknownDirectory = 'https://localguide.example.com/listings/alpha', unfamiliar = { ...observation, sources: [{ url: unknownDirectory, label: 'Guide' }], facts: [fact('website_url', unknownDirectory, unknownDirectory), fact('website_observations', 'Contact us', unknownDirectory)] };
    const [unfamiliarResult] = run({ observations: [unfamiliar] }, [{ ...evidence[0], url: unknownDirectory, finalUrl: unknownDirectory, pageTitle: 'Alpha Workshop' }]); assert.equal(field(unfamiliarResult, 'website_url').state, 'unknown'); assert.equal(field(unfamiliarResult, 'website_observations').state, 'unknown');
});
test('contacts need exact literal address and short local association rather than punctuation lookalikes', () => {
    for (const observed of ['helloalphaexamplecom', 'otherhello@alpha.example.com']) {
        const changed = text.replace('hello@alpha.example.com', observed), [result] = run(undefined, [{ ...evidence[0], text: changed, blocks: [changed] }]); assert.equal(field(result, 'email').state, 'unknown');
    }
    const own = text.replace('hello@alpha.example.com', ''), footer = 'Contact hello@alpha.example.com';
    const [result] = run(undefined, [{ ...evidence[0], text: own + ' ' + footer, blocks: [own, footer] }]); assert.equal(field(result, 'email').state, 'unknown');
    const noForm = text.replace('Contact form', '');
    const [pageOnly] = run(undefined, [{ ...evidence[0], text: noForm, blocks: [noForm] }]); assert.equal(field(pageOnly, 'contact_form').state, 'unknown');
});
test('literal offerings cannot be accepted as a substring inside unrelated longer wording', () => {
    const [result] = run({ observations: [{ ...raw, facts: [fact('services', 'oil')] }] }); assert.equal(field(result, 'services').state, 'observed');
    const changed = text.replace('Engine oil', 'Boilers'), [lookalike] = run({ observations: [{ ...raw, facts: [fact('services', 'oil')] }] }, [{ ...evidence[0], text: changed, blocks: [changed] }]); assert.equal(field(lookalike, 'services').state, 'unknown');
});
test('only independently acquired cited sources can support facts; duplicate wording merges citations', () => {
    const secondUrl = 'https://alpha.example.com/about', second = { ...evidence[0], url: secondUrl, finalUrl: secondUrl };
    const observation = { ...raw, sources: [...raw.sources, { url: secondUrl, label: 'About' }], facts: [fact('services', 'Brake repairs'), fact('services', 'Brake repairs', secondUrl)] };
    const [result] = run({ observations: [observation] }, [...evidence, second]); assert.equal(field(result, 'services').values.length, 1); assert.deepEqual(field(result, 'services').values[0].sourceUrls, [url, secondUrl]);
    const [unacquired] = run({ observations: [observation] }, [second]); assert.deepEqual(field(unacquired, 'services').values[0].sourceUrls, [secondUrl]); assert.deepEqual(unacquired.sources.map(source => source.url), [secondUrl]);
});
test('field list cap and storage reservation never manufacture negative or truncated source claims', () => {
    const many = Array.from({ length: 30 }, (_, index) => fact('services', 'Service ' + index));
    const expanded = text + ' ' + many.map(value => value.value).join(' '), [result] = run({ observations: [{ ...raw, facts: many }] }, [{ ...evidence[0], text: expanded, blocks: [expanded] }]);
    assert.equal(field(result, 'services').values.length, 12); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
});
test('large citation URLs retain exact sources while bounded omissions also update the draft brief', () => {
    const longUrls = Array.from({ length: 5 }, (_, index) => 'https://alpha.example.com/research' + index + '?q=' + 'x'.repeat(1900));
    const largeFacts = Array.from({ length: 60 }, (_, index) => fact(['description', 'services', 'products', 'brand_name', 'tagline'][Math.floor(index / 12)], 'Observed wording ' + index + ' ' + 'a'.repeat(200), longUrls[index % 5]));
    const acquired = longUrls.map(sourceUrl => ({ ...evidence[0], url: sourceUrl, finalUrl: sourceUrl, blocks: largeFacts.map(value => 'Alpha Workshop 12 Jalan Mawar Shah Alam Selangor ' + value.value), text: text + ' ' + largeFacts.map(value => value.value).join(' ') }));
    const observation = { ...raw, sources: longUrls.map(sourceUrl => ({ url: sourceUrl, label: 'Official' })), facts: largeFacts };
    const [result] = run({ observations: [observation] }, acquired); validateEnrichmentResult(result, job, target); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768); assert.deepEqual(result.sources.map(source => source.url), longUrls);
    assert.ok(result.fields.flatMap(value => value.values).length < 60); assert.equal(result.status, 'partial');
    const kept = result.fields.flatMap(value => value.values).map(value => value.value);
    for (const value of largeFacts) if (!kept.includes(value.value)) assert.ok(!result.brief.summary.includes(value.value));
});
