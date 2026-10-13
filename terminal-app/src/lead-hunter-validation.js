'use strict';
const crypto = require('crypto');
const { safePublicUrl, duplicateMatch, matchesIndustry } = require('./lead-hunter-candidates');
const error = message => Object.assign(new Error(message), { code: 'OUTPUT' });
const clean = (value, max = 500) => typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, max) : '';
const fold = value => clean(value, 262144).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const contains = (span, value) => !!fold(value) && fold(span).includes(fold(value));
const same = (a, b) => !!fold(a) && fold(a) === fold(b);
const named = (span, company) => {
    const words = value => clean(value, 262144).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return !!words(company) && (' ' + words(span) + ' ').includes(' ' + words(company) + ' ');
};
const ownershipTitle = (source, company) => {
    const title = clean(source.pageTitle, 300).normalize('NFKC').toLowerCase();
    const name = clean(company, 160).normalize('NFKC').toLowerCase();
    const prefix = title.slice(0, title.indexOf(name)).replace(/[|:–—\-]+/g, ' ').trim();
    const businessHeading = title.startsWith(name) || title.includes(name) && /^(?:contact(?: us)?|about(?: us)?|home|official website|enquiries|locations?)$/.test(prefix);
    return businessHeading && named(title, company) && !/directory|listing|reviews|companies|businesses|registered consultants|senarai|perunding/i.test(title) && named(source.text, company);
};
function validateValidationOutput(output, targets) {
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    const fields = (value, limits) => object(value) && Object.keys(value).length === Object.keys(limits).length && Object.entries(limits).every(([key, max]) => typeof value[key] === 'string' && value[key].length <= max);
    if (!Array.isArray(targets) || !targets.length || targets.length > 10 || new Set(targets.map(t => t.candidateId)).size !== targets.length || targets.some(t => !t.candidateId || !object(t.candidate))) throw error('Invalid validation targets.');
    if (!object(output) || Object.keys(output).length !== 1 || !Array.isArray(output.observations) || output.observations.length > 10) throw error('Malformed validation output.');
    const ids = new Set();
    for (const item of output.observations) {
        if (!object(item) || Object.keys(item).length !== 9 || !fields(Object.fromEntries(['candidateId', 'company', 'industry', 'region', 'city', 'address'].map(k => [k, item[k]])), { candidateId: 160, company: 160, industry: 120, region: 80, city: 80, address: 500 }) || !fields(item.website, { state: 20, url: 2048 }) || !['found', 'not_observed', 'unknown'].includes(item.website.state) || !fields(item.contact, { email: 240, phone: 80, form: 2048 }) || !Array.isArray(item.sources) || item.sources.length > 5 || item.sources.some(s => !fields(s, { url: 2048, label: 240 }))) throw error('Malformed validation observation.');
        if (!targets.some(t => t.candidateId === item.candidateId) || ids.has(item.candidateId)) throw error('Foreign or duplicate validation target.');
        ids.add(item.candidateId);
    }
    return output;
}
function aggregate(checks) {
    const requested = checks.filter(c => c.required);
    return requested.some(c => c.status === 'failed') ? 'failed' : requested.some(c => c.status !== 'passed') ? 'needs_review' : 'passed';
}
function duplicateFor(target, existing) {
    const exclude = r => r.id !== target.candidate.importedLeadId && r.discovery?.candidateId !== target.candidateId;
    const duplicate = duplicateMatch(target.candidate, { leads: (existing.leads || []).filter(exclude), clients: (existing.clients || []).filter(exclude) });
    return { ...duplicate, recordIds: duplicate.recordIds.slice(0, 100) };
}
function duplicateCheck(target, criteria, existing, observedAt) {
    const duplicate = criteria.checkDuplicates === false ? { kind: 'none', recordIds: [] } : duplicateFor(target, existing);
    return { duplicate, check: { key: 'duplicate', status: criteria.checkDuplicates === false ? 'not_requested' : duplicate.kind === 'confident' ? 'failed' : duplicate.kind === 'possible' ? 'unknown' : 'passed', required: criteria.checkDuplicates !== false, explanation: criteria.checkDuplicates === false ? 'Local duplicate check was not requested.' : duplicate.kind === 'confident' ? 'A current local Lead or Client matches this business and branch.' : duplicate.kind === 'possible' ? 'A possible local match needs review.' : 'No matching current local Lead or Client was found; the candidate’s own imported Lead was excluded.', sourceUrls: [], observedAt } };
}
function refreshDuplicates(results, targets, criteria = {}, existing = {}) {
    return results.map(result => {
        const target = targets.find(t => t.candidateId === result.candidateId);
        if (!target) throw error('Foreign validation result.');
        const { duplicate, check } = duplicateCheck(target, criteria, existing, new Date().toISOString());
        const checks = result.checks.filter(c => c.key !== 'duplicate').concat(check);
        return { ...result, checks, duplicate, overall: aggregate(checks) };
    });
}
function spansOf(evidence) {
    if (Array.isArray(evidence.blocks) && evidence.blocks.length) return evidence.blocks.filter(b => typeof b === 'string' && b.trim() && b.length <= 1500);
    const addresses = evidence.text.match(/\d+[^@.!?]{0,45}\b(?:road|street|jalan|jln|avenue|lane|rd)\b/gi) || [];
    return evidence.text.length <= 1500 && addresses.length <= 1 ? [evidence.text] : [];
}
const directory = host => /(?:^|\.)(?:bizmalay\.com|yellowpages\.(?:com\.)?my|yelp\.com|tripadvisor\.com|hotfrog\.com\.my|streetdirectory\.com|malaysiabizdir\.com)$/.test(host);
function associatedSpans(candidate, sources) {
    const associations = [];
    for (const source of sources) {
        const host = new URL(source.finalUrl).hostname.replace(/^www\./, '');
        const titleOwned = ownershipTitle(source, candidate.company) && !directory(host);
        const spans = spansOf(source);
        for (const span of spans) {
            const locality = candidate.address ? contains(span, candidate.address) : [candidate.city, candidate.region].filter(Boolean).every(value => contains(span, value));
            const hasAnchor = !!(candidate.address || candidate.city || candidate.region);
            const nestedDifferentBranch = spans.some(child => child !== span && child.length < span.length && span.includes(child) && /\b(?:branch|outlet|address|jalan|jln|road|street)\b/i.test(child) && ![candidate.address || candidate.city || candidate.region].every(value => contains(child, value)));
            if (hasAnchor && locality && !nestedDifferentBranch && (named(span, candidate.company) || titleOwned)) associations.push({ source, span });
        }
    }
    return associations;
}
function normalizeValidationBatch(output, evidence = [], { job, targets, existing = {} } = {}) {
    validateValidationOutput(output, targets);
    const acquired = new Map(), now = new Date().toISOString(), criteria = job.criteria || {};
    for (const item of evidence) {
        const url = safePublicUrl(item?.requestedUrl || item?.url), finalUrl = safePublicUrl(item?.finalUrl || item?.url);
        if (!url || !finalUrl || typeof item.text !== 'string' || !item.text.trim()) continue;
        const entry = { ...item, url, finalUrl, text: item.text.slice(0, 262144), label: clean(item.label, 240), observedAt: /^\d{4}-\d\d-\d\dT/.test(item.observedAt || '') ? item.observedAt : now };
        acquired.set(url, entry); acquired.set(finalUrl, entry);
    }
    return targets.map(target => {
        const candidate = target.candidate, raw = output.observations.find(o => o.candidateId === target.candidateId);
        const sources = [...new Map((raw?.sources || []).map(s => acquired.get(safePublicUrl(s.url))).filter(Boolean).map(s => [s.url, s])).values()];
        const associations = associatedSpans(candidate, sources);
        const checks = [];
        const add = (key, status, required, explanation, supported = []) => checks.push({ key, status, required, explanation, sourceUrls: [...new Set(supported.map(a => a.source.url))], observedAt: supported[0]?.source.observedAt || now });
        const identity = !!associations.length;
        add('identity', identity ? 'passed' : 'unknown', true, identity ? 'Acquired public evidence identifies this business and recorded branch.' : 'The exact business and branch could not be corroborated from acquired public evidence.', associations);
        const fieldCheck = (key, fields, requested) => {
            if (!requested) return add(key, 'not_requested', false, 'No ' + key + ' requirement was set.');
            const supported = associations.filter(a => fields.every(field => !raw?.[field] || contains(a.span, raw[field])) && fields.some(field => !!raw?.[field]));
            const complete = raw && fields.every(field => !criteria[field] || raw[field] && supported.some(a => contains(a.span, raw[field])));
            const matches = complete && fields.every(field => !criteria[field] || (field === 'industry' ? matchesIndustry(raw[field], criteria[field]) : same(raw[field], criteria[field])));
            add(key, complete ? matches ? 'passed' : 'failed' : 'unknown', true, complete ? matches ? 'Requested ' + key + ' matches the observed branch evidence.' : 'Observed ' + key + ' contradicts the requested literal criteria.' : 'The requested ' + key + ' could not be corroborated.', supported);
        };
        fieldCheck('industry', ['industry'], !!criteria.industry);
        fieldCheck('location', ['region', 'city'], !!(criteria.region || criteria.city));
        const websiteUrl = safePublicUrl(raw?.website?.url);
        const owned = associations.filter(a => websiteUrl && ownershipTitle(a.source, candidate.company) && new URL(websiteUrl).hostname === new URL(a.source.finalUrl).hostname && !directory(new URL(a.source.finalUrl).hostname) && (a.source.finalUrl === websiteUrl || a.source.url === websiteUrl));
        const websiteRequired = ['found', 'not_observed'].includes(criteria.website);
        add('website', !websiteRequired ? 'not_requested' : owned.length ? criteria.website === 'not_observed' ? 'failed' : 'passed' : 'unknown', websiteRequired, !websiteRequired ? 'No website requirement was set.' : owned.length ? criteria.website === 'not_observed' ? 'An acquired website belonging to this branch was found, contradicting no website observed.' : 'The website was acquired and associated with this business and branch.' : 'No owned website was corroborated. Search absence or blocked pages cannot prove that no website exists.', owned);
        const contact = criteria.contact || 'any';
        if (contact === 'not_required') add('contact', 'not_requested', false, 'Public contact inspection was not requested.');
        else {
            const keys = contact === 'any' ? ['email', 'phone', 'form'] : [contact];
            const supported = associations.filter(a => !/\b(?:branches|locations|stores|directory)\b/i.test(a.span) && (a.span.match(/(?:\+\d{1,3}[ –-]*)?\d[\d ()–-]{6,}\d/g) || []).length <= 1 && keys.some(key => {
                const value = clean(raw?.contact?.[key], 2048);
                // A parent listing cannot lend a neighbouring or footer-only contact to this branch.
                const childContact = spansOf(a.source).some(child => child !== a.span && child.length < a.span.length && a.span.includes(child) && contains(child, value) && (!named(child, candidate.company) || !contains(child, candidate.address || candidate.city || candidate.region)));
                if (childContact) return false;
                const valid = key === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) : key === 'phone' ? value.replace(/\D/g, '').length >= 5 : !!safePublicUrl(value) && /contact|enquir|inquir|form/i.test(a.span);
                const literal = key === 'email' ? (a.span.match(/[^\s<>"'(),;:@]+@[^\s<>"'(),;:@]+\.[^\s<>"'(),;:@]+/g) || []).some(email => email.replace(/[.!?]+$/, '').toLowerCase() === value.toLowerCase()) : key === 'form' ? a.span.includes(safePublicUrl(value)) : (a.span.match(/(?:\+\d{1,3}[ –-]*)?\d[\d ()–-]{4,}\d/g) || []).some(phone => phone.replace(/\D/g, '') === value.replace(/\D/g, ''));
                return valid && literal;
            }));
            add('contact', supported.length ? 'passed' : 'unknown', contact !== 'any', supported.length ? 'A public contact is observed and associated with this branch; email deliverability is not checked.' : 'No requested public contact could be associated confidently with this exact branch.', supported);
        }
        const { duplicate, check } = duplicateCheck(target, criteria, existing, now); checks.push(check);
        const hash = crypto.createHash('sha256').update(job.id + ':' + target.candidateId).digest('hex');
        const id = hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-5' + hash.slice(13, 16) + '-8' + hash.slice(17, 20) + '-' + hash.slice(20, 32);
        return { id, taskId: job.id, candidateId: target.candidateId, inputDigest: target.inputDigest, model: job.model, checkedAt: now, overall: aggregate(checks), checks, sources: sources.map(({ url, finalUrl, label, observedAt }) => ({ url, finalUrl, label, observedAt })), duplicate };
    });
}
module.exports = { validateValidationOutput, normalizeValidationBatch, refreshDuplicates, associatedSpans, spansOf, named, contains };
