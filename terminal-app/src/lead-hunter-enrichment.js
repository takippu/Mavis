'use strict';
const crypto = require('crypto');
const { safePublicUrl } = require('./lead-hunter-candidates');
const { validateValidationOutput, normalizeValidationBatch, associatedSpans, spansOf, named, contains } = require('./lead-hunter-validation');
const FIELD_KEYS = Object.freeze(['description', 'services', 'products', 'email', 'phone', 'contact_form', 'brand_name', 'tagline', 'website_url', 'website_observations']);
const FIELD_GROUPS = Object.freeze({ offerings: Object.freeze(['description', 'services', 'products']), contacts: Object.freeze(['email', 'phone', 'contact_form']), branding: Object.freeze(['brand_name', 'tagline']), website: Object.freeze(['website_url', 'website_observations']), brief: Object.freeze([]) });
const error = message => Object.assign(new Error(message), { code: 'OUTPUT' });
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, max) => typeof value === 'string' && value.length <= max;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const compact = value => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const literal = (span, value) => {
    const text = compact(span), needle = compact(value);
    if (!needle) return false;
    let start = text.indexOf(needle);
    while (start !== -1) {
        const before = text[start - 1] || '', after = text[start + needle.length] || '';
        if (!(/^[\p{L}\p{N}]/u.test(needle) && /[\p{L}\p{N}]/u.test(before)) && !(/[\p{L}\p{N}]$/u.test(needle) && /[\p{L}\p{N}]/u.test(after))) return true;
        start = text.indexOf(needle, start + 1);
    }
    return false;
};
function validateEnrichmentOutput(output, targets) {
    if (!exact(output, ['observations']) || !Array.isArray(output.observations) || output.observations.length > 10) throw error('Malformed enrichment output.');
    const base = { observations: output.observations.map(item => {
        if (!exact(item, ['candidateId', 'company', 'industry', 'region', 'city', 'address', 'website', 'contact', 'sources', 'facts']) || !Array.isArray(item.sources) || !Array.isArray(item.facts) || item.facts.length > 60) throw error('Malformed enrichment observation.');
        if (item.sources.some(source => !safePublicUrl(source?.url)) || item.website?.url && !safePublicUrl(item.website.url) || item.contact?.form && !safePublicUrl(item.contact.form)) throw error('Unsafe enrichment observation URL.');
        const seen = new Set();
        for (const fact of item.facts) {
            if (!exact(fact, ['key', 'value', 'sourceUrl']) || !FIELD_KEYS.includes(fact.key) || !bounded(fact.value, fact.key === 'phone' ? 80 : 240) || !fact.value.trim() || !bounded(fact.sourceUrl, 2048) || !safePublicUrl(fact.sourceUrl) || !item.sources?.some(source => safePublicUrl(source?.url) === safePublicUrl(fact.sourceUrl))) throw error('Malformed or uncited enrichment fact.');
            const identity = JSON.stringify([fact.key, fact.value, safePublicUrl(fact.sourceUrl)]);
            if (seen.has(identity)) throw error('Duplicate enrichment fact.');
            seen.add(identity);
        }
        const { facts, ...observation } = item;
        return observation;
    }) };
    validateValidationOutput(base, targets);
    if (targets.some(target => !bounded(target.discoveryJobId, 160) || !target.discoveryJobId || !/^[a-f0-9]{64}$/.test(target.inputDigest || '') || !bounded(target.validationResultId, 160) || !target.validationResultId || !bounded(target.validationTaskId, 160) || !target.validationTaskId || !/^[a-f0-9]{64}$/.test(target.validationDigest || '') || !bounded(target.validatedAt, 80) || !Number.isFinite(Date.parse(target.validatedAt)))) throw error('Invalid frozen enrichment target references.');
    return output;
}
function validateEnrichmentGroups(groups) {
    if (!object(groups) || Object.keys(groups).length !== 5 || Object.keys(FIELD_GROUPS).some(key => typeof groups[key] !== 'boolean') || !Object.values(groups).some(Boolean)) throw error('Invalid enrichment groups.');
    return groups;
}
function acquiredSources(evidence, now) {
    const acquired = new Map();
    for (const item of evidence) {
        const url = safePublicUrl(item?.requestedUrl || item?.url), finalUrl = safePublicUrl(item?.finalUrl || item?.url);
        if (!url || !finalUrl || typeof item.text !== 'string' || !item.text.trim()) continue;
        const date = typeof item.observedAt === 'string' && Number.isFinite(Date.parse(item.observedAt)) && item.observedAt.length <= 80 ? item.observedAt : now;
        const entry = { ...item, url, finalUrl, text: item.text.slice(0, 262144), label: typeof item.label === 'string' ? item.label.slice(0, 240) : '', observedAt: date };
        acquired.set(url, entry); acquired.set(finalUrl, entry);
    }
    return acquired;
}
function supportedLiteral(association, value, candidate) {
    if (!literal(association.span, value)) return false;
    // An encompassing directory/branch container cannot lend a neighbour's wording.
    const anchors = candidate.address ? [candidate.address] : [candidate.city, candidate.region].filter(Boolean);
    const borrowedChild = spansOf(association.source).some(child => child !== association.span && child.length < association.span.length && association.span.includes(child) && literal(child, value) && (!named(child, candidate.company) || !anchors.every(anchor => contains(child, anchor))));
    return !borrowedChild;
}
function validationFor(raw, target, evidence, job, criteria) {
    const { facts, ...observation } = raw;
    return normalizeValidationBatch({ observations: [observation] }, evidence, { targets: [target], job: { ...job, criteria: { industry: '', region: '', city: '', website: 'any', contact: 'not_required', checkDuplicates: false, ...criteria } } })[0];
}
function contactSupported(key, fact, raw, target, source, job) {
    const contactKey = key === 'contact_form' ? 'form' : key;
    const observation = { ...raw, sources: [{ url: source.url, label: source.label }], contact: { email: '', phone: '', form: '', [contactKey]: fact.value } };
    return validationFor(observation, target, [source], job, { contact: contactKey }).checks.find(check => check.key === 'contact').status === 'passed';
}
function ownedWebsite(fact, raw, target, source, job) {
    const url = safePublicUrl(fact.value);
    if (!url) return false;
    const location = new URL(source.finalUrl);
    if (/\b(?:directory|listings?|companies|businesses|consultants|perunding|senarai)\b/i.test(location.pathname.replace(/[-_]/g, ' ')) || /(?:directory|listing|bizdir)/i.test(location.hostname)) return false;
    const observation = { ...raw, sources: [{ url: source.url, label: source.label }], website: { state: 'found', url } };
    return validationFor(observation, target, [source], job, { website: 'found' }).checks.find(check => check.key === 'website').status === 'passed';
}
function draftBrief(identity, fields, requested) {
    if (!requested) return { state: 'not_requested', summary: '', suggestions: [] };
    const values = key => fields.find(field => field.key === key).values.map(value => value.value);
    const fragments = ['Draft mockup brief.', identity.state === 'observed' ? 'The exact business and branch were corroborated.' : 'Business identity and branch: Unknown.'];
    for (const [label, keys] of [['Business wording', ['description', 'brand_name', 'tagline']], ['Offerings', ['services', 'products']], ['Public contacts', ['email', 'phone', 'contact_form']], ['Website', ['website_url', 'website_observations']]]) {
        const observed = keys.flatMap(values);
        fragments.push(label + ': ' + (observed.length ? observed.join('; ').slice(0, 170) : 'Unknown; confirm before using.') + '.');
    }
    const suggestions = ['Proposal: use a clear introduction and contact section; confirm all Unknown details before publication.', 'Proposal: request approved brand assets and design preferences before producing a mockup.'];
    if (values('services').length || values('products').length) suggestions.push('Proposal: include an offerings section using only the observed services and products.');
    if (values('email').length || values('phone').length || values('contact_form').length) suggestions.push('Proposal: provide a contact action using the observed public contact details; availability and email delivery remain untested.');
    return { state: 'draft', summary: fragments.join(' ').slice(0, 1000), suggestions };
}
function normalizeEnrichmentBatch(output, evidence = [], { job, targets } = {}) {
    validateEnrichmentOutput(output, targets);
    if (!object(job)) throw error('Invalid enrichment job.');
    validateEnrichmentGroups(job.groups);
    const now = new Date().toISOString(), acquired = acquiredSources(evidence, now);
    const enabled = new Set(Object.entries(FIELD_GROUPS).filter(([group]) => job.groups[group]).flatMap(([, fields]) => fields));
    return targets.map(target => {
        const raw = output.observations.find(item => item.candidateId === target.candidateId);
        const sources = [...new Map((raw?.sources || []).map(source => acquired.get(safePublicUrl(source.url))).filter(Boolean).map(source => [source.url, source])).values()];
        const associations = associatedSpans(target.candidate, sources);
        const identity = { state: associations.length ? 'observed' : 'unknown', explanation: associations.length ? 'Acquired public evidence identifies this exact business and recorded branch.' : 'The exact business and branch could not be corroborated from acquired public evidence.', sourceUrls: [...new Set(associations.map(association => association.source.url))] };
        const fields = FIELD_KEYS.map(key => {
            const values = new Map();
            if (enabled.has(key) && identity.state === 'observed') for (const fact of raw?.facts || []) {
                if (fact.key !== key) continue;
                if (key === 'brand_name' && !named(fact.value, target.candidate.company) && !named(target.candidate.company, fact.value)) continue;
                const source = acquired.get(safePublicUrl(fact.sourceUrl));
                if (!source || !sources.includes(source)) continue;
                const supports = associations.filter(association => association.source === source && supportedLiteral(association, fact.value, target.candidate));
                const supported = ['email', 'phone', 'contact_form'].includes(key) ? supports.length > 0 && (key !== 'contact_form' || supports.some(association => /\bform\b/i.test(association.span))) && contactSupported(key, fact, raw, target, source, job) : key === 'website_url' ? ownedWebsite(fact, raw, target, source, job) : supports.length > 0;
                // A website observation must come from an acquired owned site, not search absence or a directory claim.
                if (!supported || key === 'website_observations' && !ownedWebsite({ value: source.url }, raw, target, source, job)) continue;
                const value = fact.value.trim(), prior = values.get(value);
                if (prior) { if (!prior.sourceUrls.includes(source.url)) prior.sourceUrls.push(source.url); }
                else if (values.size < 12) values.set(value, { value, sourceUrls: [source.url] });
            }
            const observed = [...values.values()];
            return { key, state: !enabled.has(key) ? 'not_requested' : observed.length ? 'observed' : 'unknown', values: observed, explanation: !enabled.has(key) ? 'This field was not requested.' : observed.length ? ['email', 'phone', 'contact_form'].includes(key) ? 'Literal public contact associated with this exact branch; email deliverability is not checked.' : 'Literal wording corroborated in acquired evidence for this exact branch.' : 'No literal supported observation could be associated confidently with this exact branch.' };
        });
        const hash = crypto.createHash('sha256').update(job.id + ':' + target.candidateId).digest('hex');
        const id = hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-5' + hash.slice(13, 16) + '-8' + hash.slice(17, 20) + '-' + hash.slice(20, 32);
        const result = { id, taskId: job.id, candidateId: target.candidateId, inputDigest: target.inputDigest, validationResultId: target.validationResultId, model: job.model, enrichedAt: now, status: 'needs_review', identity, fields, sources: sources.map(({ url, finalUrl, label, observedAt }) => ({ url, finalUrl, label, observedAt })), brief: draftBrief(identity, fields, job.groups.brief) };
        // Result reservations are finite. Drop observations, never shorten evidence URLs or turn omission into a negative fact.
        if (Buffer.byteLength(JSON.stringify(result)) > 32768) for (const source of result.sources) delete source.finalUrl;
        while (Buffer.byteLength(JSON.stringify(result)) > 32768) {
            const largest = fields.filter(field => field.values.length).sort((a, b) => Buffer.byteLength(JSON.stringify(b.values)) - Buffer.byteLength(JSON.stringify(a.values)))[0];
            if (!largest) throw error('Enrichment evidence exceeds the reserved result size.');
            largest.values.pop(); if (!largest.values.length) { largest.state = 'unknown'; largest.explanation = 'Supported observations were omitted to keep this research profile within its storage bound.'; }
            result.brief = draftBrief(identity, fields, job.groups.brief);
        }
        result.status = identity.state !== 'observed' ? 'needs_review' : fields.some(field => enabled.has(field.key) && field.state !== 'observed') ? 'partial' : 'ready';
        return result;
    });
}
module.exports = { FIELD_KEYS, FIELD_GROUPS, ENRICH_FIELD_KEYS: FIELD_KEYS, validateEnrichmentGroups, validateEnrichmentOutput, normalizeEnrichmentBatch };
