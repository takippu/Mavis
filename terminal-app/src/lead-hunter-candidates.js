'use strict';
const crypto = require('crypto');
const net = require('net');
function publicAddress(host) {
    const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
    if (net.isIP(h) === 4) {
        const [a, b, c] = h.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113 || a === 192 && b === 88 && c === 99);
    }
    if (net.isIP(h) === 6)
        return /^[23][0-9a-f]{3}:/.test(h) && !/^2001:(?:db8|0):/.test(h);
    return false;
}
function safePublicUrl(value) {
    if (typeof value !== 'string' || value.length > 2048)
        return '';
    try {
        const u = new URL(value), h = u.hostname.toLowerCase().replace(/\.$/, '');
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !h || u.port && !['80', '443'].includes(u.port))
            return '';
        if (net.isIP(h.replace(/^\[|\]$/g, '')) && !publicAddress(h))
            return '';
        if (!net.isIP(h.replace(/^\[|\]$/g, '')) && (!h.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(h)))
            return '';
        u.hash = '';
        return u.href;
    }
    catch {
        return '';
    }
}
function text(v, max = 160) { return typeof v === 'string' ? v.trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, max) : ''; }
function folded(v) { return text(v, 20000).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
function sourcesOf(c) { return Array.isArray(c.sources) ? c.sources.map(s => safePublicUrl(typeof s === 'string' ? s : s?.url)).filter(Boolean) : []; }
function identityKeys(c) {
    const location = [c.region, c.city, c.address].map(folded).filter(Boolean).join(':');
    const keys = sourcesOf(c).map(u => 'source:' + crypto.createHash('sha256').update(u.replace(/\/$/, '') + ':branch:' + folded(c.company) + ':' + location).digest('hex'));
    if (c.company && location)
        keys.push('business:' + folded(c.company) + ':' + location);
    return [...new Set(keys)];
}
const DIRECTORY_HOSTS = ['yellowpages.my', 'yellowpages.com.my', 'yelp.com', 'tripadvisor.com', 'hotfrog.com.my', 'streetdirectory.com', 'bizmalay.com', 'malaysiabizdir.com'];
function sourceScope(candidate) {
    const hosts = candidate.sources.map(s => new URL(s.url).hostname.replace(/^www\./, ''));
    if (hosts.some(h => DIRECTORY_HOSTS.some(d => h === d || h.endsWith('.' + d))))
        return 'directories';
    if (candidate.website.state === 'found') {
        const h = new URL(candidate.website.url).hostname.replace(/^www\./, '');
        if (hosts.includes(h))
            return 'business_sites';
    }
    return 'unknown';
}
function outputError() { return Object.assign(new Error('Malformed structured candidate output'), { code: 'OUTPUT' }); }
function validateOutput(output, { strict = false } = {}) {
    const obj = v => v && typeof v === 'object' && !Array.isArray(v);
    const strings = (o, fields) => obj(o) && Object.entries(fields).every(([k, max]) => typeof o[k] === 'string' && o[k].length <= max);
    if (!obj(output) || !Array.isArray(output.candidates) || output.candidates.length > 10 || (strict && typeof output.exhausted !== 'boolean') || (output.exhausted !== undefined && typeof output.exhausted !== 'boolean'))
        throw outputError();
    if (strict && Object.keys(output).some(k => !['candidates', 'exhausted'].includes(k)))
        throw outputError();
    for (const c of output.candidates) {
        if (!strings(c, { company: 160, industry: 120, region: 80, city: 80, address: 500 }) || !c.company.trim() || !c.region.trim() || !c.industry.trim() || !strings(c.website, { state: 20, url: 2048 }) || !['found', 'not_observed', 'unknown'].includes(c.website.state) || !strings(c.contact, { email: 240, phone: 80, form: 2048 }) || !Array.isArray(c.sources) || !c.sources.length || c.sources.length > 5 || c.sources.some(o => !strings(o, { url: 2048, label: 240 }) || !o.url.trim()))
            throw outputError();
        if (strict && (Object.keys(c).some(k => !['company', 'industry', 'region', 'city', 'address', 'website', 'contact', 'sources'].includes(k)) || Object.keys(c.website).some(k => !['state', 'url'].includes(k)) || Object.keys(c.contact).some(k => !['email', 'phone', 'form'].includes(k)) || c.sources.some(o => Object.keys(o).some(k => !['url', 'label'].includes(k)))))
            throw outputError();
    }
    return output;
}
function contains(span, value) { return !!value && folded(span).includes(folded(value)); }
function localSpans(o) {
    if (Array.isArray(o.blocks) && o.blocks.length)
        return o.blocks.filter(v => typeof v === 'string' && v.length <= 1500);
    // Flattened multi-location pages have lost listing boundaries: never infer a local contact from them.
    const addresses = o.text.match(/\d+[^@.!?]{0,45}\b(?:road|street|jalan|jln|avenue|lane|boulevard|rd)\b/gi) || [];
    if (o.text.length > 1500 || addresses.length > 1)
        return [];
    return o.text.split(/(?<=[.!?])\s+(?=[^.!?\n]{0,70}\b(?:branch|outlet)\b)/i).filter(v => v.trim());
}
function ambiguousContact(span) {
    const phones = span.match(/(?:\+\d{1,3}[ –-]*)?\d[\d ()–-]{6,}\d/g) || [];
    return phones.length > 1 || /\b(?:branches|locations|stores|directory)\b/i.test(span);
}
function conflictingPlace(span, o, raw) {
    const place = b => /\b(?:branch|outlet|address|Selangor|Johor|Penang|Kedah|Kelantan|Melaka|Negeri Sembilan|Pahang|Perak|Perlis|Sabah|Sarawak|Terengganu)\b/i.test(b) || /\d+[^@]{0,45}\b(?:road|street|jalan|jln|avenue|lane|boulevard|rd)\b/i.test(b);
    return (o.blocks || []).some(b => typeof b === 'string' && b !== span && b.length < span.length && span.includes(b) && place(b) && (!contains(b, raw.region) || raw.city && !contains(b, raw.city) || raw.address && !contains(b, raw.address)));
}
// Match literal industry wording; never infer a semantic category or rewrite the observed field.
function matchesIndustry(observed, requested) {
    const tokens = value => (typeof value === 'string' ? value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [] : []).map(t => t.length > 4 && t.endsWith('ies') ? t.slice(0, -3) + 'y' : t.length > 4 && t.endsWith('sses') ? t.slice(0, -2) : t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
    const target = tokens(requested), actual = new Set(tokens(observed));
    return target.every(t => actual.has(t));
}
function normalizeBatch(output, evidence = []) {
    validateOutput(output);
    const observed = new Map();
    for (const o of Array.isArray(evidence) ? evidence : []) {
        if (!o || typeof o.text !== 'string' || !o.text.trim())
            continue;
        const finalUrl = safePublicUrl(o.finalUrl || o.url), requestedUrl = safePublicUrl(o.requestedUrl || o.url);
        if (!finalUrl || !requestedUrl)
            continue;
        const entry = { ...o, url: requestedUrl, requestedUrl, finalUrl, label: text(o.label), text: o.text.slice(0, 262144), observedAt: text(o.observedAt, 40) || new Date().toISOString() };
        observed.set(requestedUrl, entry);
        observed.set(finalUrl, entry);
    }
    const result = [], seen = new Set();
    for (const raw of output.candidates) {
        const company = text(raw.company), region = text(raw.region, 80), industry = text(raw.industry, 120), city = text(raw.city, 80);
        const acquired = sourcesOf(raw).map(u => { const o = observed.get(u); return o ? { ...o, url: u } : null; }).filter(Boolean);
        const site = safePublicUrl(raw.website.url);
        const associations = [];
        for (const o of acquired) {
            const corporate = site && contains(o.pageTitle || '', company) && !/(?:directory|listing|reviews|businesses|companies)/i.test(o.pageTitle || '') && new URL(site).hostname === new URL(o.finalUrl).hostname && !DIRECTORY_HOSTS.some(d => new URL(o.finalUrl).hostname.endsWith(d));
            if (corporate && (!contains(o.text, company) || !contains(o.text, industry)))
                continue;
            const spans = localSpans(o).filter(span => !conflictingPlace(span, o, raw) && contains(span, region) && (!city || contains(span, city)) && contains(span, industry) && (corporate || !ambiguousContact(span) && contains(span, company)));
            if (spans.length)
                associations.push({ o, spans });
        }
        if (!associations.length)
            continue;
        const primary = associations.map(a => a.o);
        const local = associations.flatMap(a => a.spans);
        const supported = (v, max = 160) => { v = text(v, max); return local.some(span => contains(span, v)) ? v : ''; };
        const address = supported(raw.address, 500);
        const contacts = associations.flatMap(a => a.spans.filter(span => !ambiguousContact(span) && (!address || contains(span, address))));
        const contactValue = (v, max) => { v = text(v, max); return contacts.some(span => contains(span, v)) ? v : ''; };
        const email = contactValue(raw.contact.email, 240).toLowerCase(), phone = contactValue(raw.contact.phone, 80);
        let website = { state: 'unknown', url: '' };
        if (raw.website.state === 'found' && site && primary.some(o => o.url === site || o.finalUrl === site || o.text.includes(site)))
            website = { state: 'found', url: site };
        else if (raw.website.state === 'not_observed' && !site)
            website = { state: 'not_observed', url: '' };
        const form = safePublicUrl(raw.contact.form);
        const candidate = { company, industry, region, city: supported(city, 80), address, website, contact: { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '', phone: /\d{5}/.test(phone.replace(/\D/g, '')) ? phone : '', form: form && contacts.some(span => span.includes(form) && /contact|enquir|inquir|form/i.test(span)) ? form : '' }, sources: primary.map(({ url, finalUrl, label, observedAt }) => ({ url, finalUrl, label, observedAt })), duplicate: { kind: 'none', recordIds: [] }, discoveredAt: primary[0].observedAt };
        candidate.sourceScope = sourceScope({ ...candidate, sources: candidate.sources.map(s => ({ ...s, url: s.finalUrl })) });
        candidate.identityKeys = identityKeys(candidate);
        candidate.id = 'hunter-' + crypto.createHash('sha256').update('business:' + folded(company) + ':' + folded(region) + ':' + folded(candidate.city) + ':' + folded(candidate.address)).digest('hex').slice(0, 32);
        const filters = output.filters || {};
        if (!matchesIndustry(candidate.industry, filters.industry || ''))
            continue;
        if (['region', 'city'].some(k => filters[k] && folded(filters[k]) !== folded(candidate[k])))
            continue;
        if (filters.sources && filters.sources !== 'public_web' && filters.sources !== candidate.sourceScope)
            continue;
        if (filters.website && filters.website !== 'any' && filters.website !== website.state)
            continue;
        if (['email', 'phone', 'form'].includes(filters.contact) && !candidate.contact[filters.contact])
            continue;
        if (result.some(c => duplicateMatch(candidate, { candidates: [c] }).kind === 'confident') || seen.has(candidate.id))
            continue;
        seen.add(candidate.id);
        result.push(candidate);
        if (result.length >= Math.min(10, Number.isInteger(filters.limit) ? filters.limit : 10))
            break;
    }
    return result;
}
function duplicateMatch(candidate, { leads = [], clients = [], candidates = [] } = {}) {
    const matches = [], possible = [];
    const keys = identityKeys(candidate), company = folded(candidate.company);
    const records = [...leads, ...clients, ...candidates].map(r => ({ ...r, ...(r.values || {}), ...(r.discovery?.location || {}), sources: r.sources || r.discovery?.sources, website: r.website || r.discovery?.website }));
    for (const r of records) {
        const name = folded(r.company || r.companyName || r.businessName || r.name), other = identityKeys(r);
        const samePlace = folded(candidate.region) && folded(candidate.region) === folded(r.region) && folded(candidate.city) === folded(r.city);
        const differentBranch = (candidate.city && r.city && folded(candidate.city) !== folded(r.city)) || (candidate.address && r.address && folded(candidate.address) !== folded(r.address));
        const sameSource = keys.some(k => k.startsWith('source:') && other.includes(k));
        if ((sameSource && !differentBranch) || (company && company === name && samePlace && !differentBranch))
            matches.push(r.id);
        else {
            let domain = '', otherDomain = '';
            try {
                domain = new URL(candidate.website?.url || candidate.website || '').hostname;
                otherDomain = new URL(r.website?.url || r.website || '').hostname;
            }
            catch { }
            const sameContact = ['email', 'phone'].some(k => candidate.contact?.[k] && folded(candidate.contact[k]) === folded(r.contact?.[k] || r[k]));
            if (company && company === name || domain && domain === otherDomain || sameContact)
                possible.push(r.id);
        }
    }
    return { kind: matches.length ? 'confident' : possible.length ? 'possible' : 'none', recordIds: [...new Set((matches.length ? matches : possible).filter(Boolean))] };
}
module.exports = { matchesIndustry, validateOutput, normalizeBatch, duplicateMatch, identityKeys, safePublicUrl, publicAddress };
