'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBatch, duplicateMatch, safePublicUrl } = require('../src/lead-hunter-candidates');
const url = 'https://example.com/shops/alpha';
const raw = { company: 'Alpha Workshop', industry: 'Auto repair', region: 'Selangor', city: 'Shah Alam', address: '', website: { state: 'unknown', url: '' }, contact: { email: '', phone: '', form: '' }, sources: [{ url, label: 'Directory' }] };
const evidence = [{ url, label: 'Directory', text: 'Alpha Workshop. Auto repair. Shah Alam, Selangor. Public email hello@alpha.com. Phone +60 12 345 6789.', observedAt: '2026-10-13T00:00:00.000Z' }];
test('unobserved and forged source claims are rejected', () => {
    assert.deepEqual(normalizeBatch({ candidates: [raw] }, []), []);
    assert.deepEqual(normalizeBatch({ candidates: [{ ...raw, company: 'Invented' }] }, evidence), []);
});
test('normalization retains observed data and removes unsupported claims', () => {
    const [c] = normalizeBatch({ candidates: [{ ...raw, address: 'Invented', contact: { email: 'hello@alpha.com', phone: '+60 12 345 6789', form: 'https://forged.test/contact' } }] }, evidence);
    assert.equal(c.contact.email, 'hello@alpha.com');
    assert.equal(c.address, '');
    assert.equal(c.contact.form, '');
    assert.equal(c.website.state, 'unknown');
    assert.equal(c.id, normalizeBatch({ candidates: [raw] }, evidence)[0].id);
});
test('found website requires acquired source evidence; strict unknown filters do not match', () => {
    assert.equal(normalizeBatch({ candidates: [raw], filters: { website: 'not_observed' } }, evidence).length, 0);
    const [c] = normalizeBatch({ candidates: [{ ...raw, website: { state: 'found', url: 'https://forged.test' } }] }, evidence);
    assert.equal(c.website.state, 'unknown');
});
test('same source repeats collapse but corporate domains preserve branches', () => {
    assert.equal(normalizeBatch({ candidates: [raw, raw] }, evidence).length, 1);
    const other = { ...raw, city: 'Klang', sources: [{ url: 'https://example.com/shops/klang' }], website: { state: 'found', url: 'https://brand.test' } };
    assert.equal(duplicateMatch(other, { candidates: [{ ...raw, website: { state: 'found', url: 'https://brand.test' } }] }).kind, 'possible');
    assert.equal(duplicateMatch(raw, { leads: [{ id: 'lead', company: 'Alpha Workshop', city: 'Shah Alam', region: 'Selangor' }] }).kind, 'confident');
});
test('source URL policy rejects credentials and private literals including mapped IPv6', () => {
    for (const u of ['file:///etc/passwd', 'https://u:p@public.test', 'http://127.0.0.1', 'http://[::ffff:7f00:1]', 'http://10.0.0.1', 'http://localhost', 'http://169.254.1.2'])
        assert.equal(safePublicUrl(u), '');
    assert.equal(safePublicUrl(url), url);
});
test('lead discovery metadata participates in duplicate matching', () => {
    assert.equal(duplicateMatch(raw, { leads: [{ id: 'lead', company: raw.company, discovery: { location: { region: raw.region, city: raw.city }, sources: raw.sources } }] }).kind, 'confident');
});
test('strict place/industry/source filters reject unknown or mismatched observations', () => {
    for (const filters of [{ region: 'Penang' }, { city: 'Klang' }, { industry: 'Restaurant' }, { sources: 'directories' }, { sources: 'business_sites' }])
        assert.equal(normalizeBatch({ candidates: [raw], filters }, evidence).length, 0);
    assert.equal(normalizeBatch({ candidates: [raw], filters: { region: 'selangor', city: 'shah alam', industry: 'auto repair', sources: 'public_web' } }, evidence).length, 1);
});
test('real nested Freelance client contacts are possible matches, never silently skipped', () => {
    const c = { ...raw, contact: { email: 'hello@alpha.com', phone: '', form: '' } };
    assert.deepEqual(duplicateMatch(c, { clients: [{ id: 'client', values: { company: 'Alpha Workshop', name: 'Owner', email: 'hello@alpha.com', phone: '', address: 'Different branch' } }] }), { kind: 'possible', recordIds: ['client'] });
});
test('another branch contact cannot pass a strict public contact filter', () => {
    const mixed = [{ ...evidence[0], text: 'Alpha Workshop Auto repair. Shah Alam, Selangor. 10 Main Road. Phone +603 111 2222. Johor Bahru branch. Johor. Email johor@alpha.com. Phone +607 333 4444.' }];
    const forged = { ...raw, address: '10 Main Road', contact: { email: 'johor@alpha.com', phone: '+607 333 4444', form: '' } };
    const [c] = normalizeBatch({ candidates: [forged] }, mixed);
    assert.equal(c.contact.email, '');
    assert.equal(c.contact.phone, '');
    assert.deepEqual(normalizeBatch({ candidates: [forged], filters: { contact: 'email' } }, mixed), []);
});
test('branch-local acquired blocks associate contacts and do not borrow sibling observations', () => {
    const blocks = ['Alpha Workshop Auto repair Shah Alam Selangor 10 Main Road Phone +603 111 2222', 'Beta Workshop Auto repair Johor Bahru Johor 22 Other Road Email johor@alpha.com Phone +607 333 4444'];
    const ev = [{ ...evidence[0], text: blocks.join(' '), blocks }];
    const c = { ...raw, address: '10 Main Road', contact: { email: 'johor@alpha.com', phone: '+603 111 2222', form: '' } };
    const [n] = normalizeBatch({ candidates: [c] }, ev);
    assert.equal(n.contact.phone, '+603 111 2222');
    assert.equal(n.contact.email, '');
    assert.deepEqual(normalizeBatch({ candidates: [{ ...c, company: 'Beta Workshop' }] }, ev), []);
});
test('redirect aliases match citation while preserving actual source destination', () => {
    const ev = [{ ...evidence[0], url: 'https://www.example.com/shops/alpha', requestedUrl: url, finalUrl: 'https://www.example.com/shops/alpha', redirectChain: [url, 'https://www.example.com/shops/alpha'] }];
    const [n] = normalizeBatch({ candidates: [raw] }, ev);
    assert.ok(n);
    assert.equal(n.sources[0].url, url);
    assert.equal(n.sources[0].finalUrl, ev[0].finalUrl);
});
test('malformed nested output is rejected with OUTPUT instead of native TypeError', () => {
    for (const c of [null, { ...raw, sources: [null] }, { ...raw, company: 12 }, { ...raw, website: { state: 'bogus', url: '' } }, { ...raw, contact: 'x' }, { ...raw, sources: 'x' }])
        assert.throws(() => normalizeBatch({ candidates: [c] }, evidence), { code: 'OUTPUT' });
});
test('model cannot turn an unknown directory into corporate brand evidence by claiming it as website', () => {
    const ev = [{ ...evidence[0], pageTitle: 'Business directory', blocks: ['Alpha Workshop Auto repair Shah Alam Selangor 10 Main Road', 'Beta Workshop Auto repair Johor Bahru Johor 22 Other Road'], text: 'Alpha Workshop Auto repair Shah Alam Selangor 10 Main Road Beta Workshop Auto repair Johor Bahru Johor 22 Other Road' }];
    const forged = { ...raw, company: 'Beta Workshop', website: { state: 'found', url }, address: '10 Main Road' };
    assert.deepEqual(normalizeBatch({ candidates: [forged] }, ev), []);
});
test('actual corporate page title permits global brand while industry and contact stay branch-bound', () => {
    const ev = [{ ...evidence[0], pageTitle: 'Locations - Alpha Workshop', blocks: ['Shah Alam Selangor 10 Main Road Auto repair Phone +603 111 2222', 'Johor Bahru Johor 22 Other Road Auto repair Email johor@alpha.com Phone +607 333 4444'], text: 'Alpha Workshop Auto repair Shah Alam Selangor 10 Main Road Phone +603 111 2222 Johor Bahru Johor 22 Other Road Email johor@alpha.com Phone +607 333 4444' }];
    const [c] = normalizeBatch({ candidates: [{ ...raw, website: { state: 'found', url }, address: '10 Main Road', contact: { email: 'johor@alpha.com', phone: '+603 111 2222', form: '' } }] }, ev);
    assert.equal(c.contact.phone, '+603 111 2222');
    assert.equal(c.contact.email, '');
});
test('mixed parent block cannot associate another branch contact even with corporate branding', () => {
    const children = ['Shah Alam Selangor 10 Main Road Auto repair', 'Johor Bahru Johor 22 Other Road Auto repair Email johor@alpha.com Phone +607 333 4444'];
    const ev = [{ ...evidence[0], pageTitle: 'Locations - Alpha Workshop', blocks: [...children, children.join(' ')], text: 'Alpha Workshop Auto repair ' + children.join(' ') }];
    const [c] = normalizeBatch({ candidates: [{ ...raw, address: '10 Main Road', website: { state: 'found', url }, contact: { email: 'johor@alpha.com', phone: '+607 333 4444', form: '' } }] }, ev);
    assert.equal(c.contact.email, '');
    assert.equal(c.contact.phone, '');
});
test('mixed parent cannot borrow contact from a different address in the same city', () => {
    const children = ['Shah Alam Selangor 10 Main Road Auto repair', 'Shah Alam Selangor 22 Other Road Email other@alpha.com Phone +603 333 4444'];
    const ev = [{ ...evidence[0], pageTitle: 'Locations - Alpha Workshop', blocks: [...children, children.join(' ')], text: 'Alpha Workshop Auto repair ' + children.join(' ') }];
    const [c] = normalizeBatch({ candidates: [{ ...raw, address: '10 Main Road', website: { state: 'found', url }, contact: { email: 'other@alpha.com', phone: '+603 333 4444', form: '' } }] }, ev);
    assert.equal(c.contact.email, '');
    assert.equal(c.contact.phone, '');
});
test('industry matching uses observed literal tokens and simple plural stems', () => {
    const { matchesIndustry } = require('../src/lead-hunter-candidates');
    assert.equal(matchesIndustry('Bakery & Patisserie', 'Bakery'), true);
    assert.equal(matchesIndustry('Clinics', 'Clinic'), true);
    assert.equal(matchesIndustry('Clinic', 'Clinics'), true);
    assert.equal(matchesIndustry('Bakery & Patisserie', 'Auto'), false);
    const [c] = normalizeBatch({ candidates: [{ ...raw, industry: 'Auto repairs' }], filters: { industry: 'Auto repair' } }, [{ ...evidence[0], text: evidence[0].text.replace('Auto repair', 'Auto repairs') }]);
    assert.equal(c.industry, 'Auto repairs');
});
test('corporate title never transfers a sibling branch industry to another locality', () => {
    const source = 'https://example.com/locations';
    const blocks = ['Shah Alam Selangor 10 Main Road Furniture showroom Email furniture@alpha.com', 'Johor Bahru Johor 22 Other Road Auto repair Email johor@alpha.com'];
    const ev = [{ url: source, finalUrl: source, pageTitle: 'Locations - Alpha Workshop', label: 'Official', observedAt: '2026-10-13T00:00:00Z', blocks, text: 'Alpha Workshop ' + blocks.join(' ') }];
    const candidate = { ...raw, address: '10 Main Road', website: { state: 'found', url: source }, contact: { email: 'furniture@alpha.com', phone: '', form: '' }, sources: [{ url: source, label: 'Official' }] };
    assert.deepEqual(normalizeBatch({ candidates: [candidate], filters: { industry: 'Auto repair', city: 'Shah Alam', region: 'Selangor', contact: 'email' } }, ev), []);
});
test('flattened multi-address corporate evidence cannot borrow sibling industry', () => {
    const ev = [{ ...evidence[0], pageTitle: 'Locations - Alpha Workshop', text: 'Alpha Workshop. Shah Alam Selangor 10 Main Road Furniture showroom. Johor Bahru Johor 22 Other Road Auto repair.' }];
    assert.deepEqual(normalizeBatch({ candidates: [{ ...raw, address: '10 Main Road', website: { state: 'found', url } }] }, ev), []);
});
