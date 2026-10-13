'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { CodexRunner, ENRICHMENT_SCHEMA } = require('../src/lead-hunter-codex');
const url = 'https://alpha.example.com/contact', text = 'Alpha Workshop Auto repair Shah Alam Selangor Brake repairs hello@alpha.example.com';
const candidate = { company: 'Alpha Workshop', industry: 'Auto repair', region: 'Selangor', city: 'Shah Alam', address: '', website: { state: 'found', url }, contact: { email: 'hello@alpha.example.com', phone: '', form: '' } };
const target = { candidateId: 'candidate-1', discoveryJobId: 'discover-1', inputDigest: 'a'.repeat(64), candidate, validationResultId: 'validation-1', validationTaskId: 'validate-job', validationDigest: 'b'.repeat(64), validatedAt: '2026-10-13T00:00:00Z' };
const observation = { candidateId: target.candidateId, ...candidate, sources: [{ url, label: 'Official' }], facts: [{ key: 'services', value: 'Brake repairs', sourceUrl: url }, { key: 'email', value: 'hello@alpha.example.com', sourceUrl: url }] };
const job = { id: 'enrich-job', kind: 'enrich', model: 'gpt-6.1-sol', goal: 'Research this validated workshop', groups: { offerings: true, contacts: true, branding: true, website: true, brief: true } };
const search = { type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'Alpha Workshop Shah Alam' } } };
function setup(t, output, { events = [search], fetchSource = async requested => ({ url: requested, finalUrl: requested, text, blocks: [text], pageTitle: 'Alpha Workshop', observedAt: '2026-10-13T00:00:00Z' }) } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-enrichment-runner-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let captured;
    const runner = new CodexRunner({ dir, binPath: '/mock-codex', preflight: false, fetchSource, killGroup: () => false, spawn: (bin, args, options) => {
        const child = new EventEmitter(); child.pid = 987654321; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => { setImmediate(() => child.emit('close', null)); return true; };
        captured = { bin, args, options, prompt: '', schema: JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8')) };
        child.stdin.on('data', part => { captured.prompt += part.toString(); });
        setImmediate(() => { for (const event of [...events, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }, { type: 'turn.completed', usage: { input_tokens: 40, output_tokens: 20 } }]) child.stdout.write(JSON.stringify(event) + '\n'); child.stdout.end(); child.emit('close', 0); }); return child;
    } });
    return { runner, captured: () => captured };
}
test('Enrich dispatches native strict web-only search with frozen model, validation and selected groups', async t => {
    const s = setup(t, { observations: [observation] }), events = [];
    const result = await s.runner.run({ job, targets: [target], attemptId: 'attempt-1', onEvent: event => events.push(event) });
    assert.equal(result.enrichmentResults.length, 1); assert.equal(result.enrichmentResults[0].status, 'partial'); assert.equal(result.enrichmentResults[0].validationResultId, target.validationResultId); assert.equal(result.enrichmentResults[0].model, job.model); assert.equal(result.usage.input_tokens, 40); assert.equal(s.runner.active, false); assert.equal(s.runner.ownedPids.size, 0);
    assert.equal(result.validationResults, undefined); assert.equal(result.candidates, undefined);
    const captured = s.captured(); assert.deepEqual(captured.schema, ENRICHMENT_SCHEMA); assert.equal(captured.schema.additionalProperties, false); assert.equal(captured.schema.properties.observations.items.additionalProperties, false); assert.equal(captured.schema.properties.observations.items.properties.facts.items.additionalProperties, false);
    for (const value of ['--ignore-user-config', '--ignore-rules', '--ephemeral', 'read-only', 'computer_use', 'browser_use', 'shell_tool', 'plugins', 'hooks', 'features.code_mode.direct_only_tool_namespaces=["web"]']) assert.ok(captured.args.includes(value));
    assert.equal(captured.options.shell, false); assert.equal(captured.options.detached, true); assert.ok(captured.prompt.includes(target.validationResultId)); assert.ok(captured.prompt.includes(target.validationDigest)); assert.ok(captured.prompt.includes('SMTP')); assert.ok(captured.prompt.includes('Do not generate a mockup brief')); assert.ok(captured.prompt.includes(JSON.stringify(job.groups))); assert.equal(events.filter(event => event.type === 'source').length, 1);
});
test('missing observations and unavailable extraction preserve all Unknown profiles', async t => {
    for (const observations of [[], [observation]]) {
        const s = setup(t, { observations }, { fetchSource: async () => null }), result = await s.runner.run({ job, targets: [target] });
        assert.equal(result.enrichmentResults.length, 1); assert.equal(result.enrichmentResults[0].status, 'needs_review'); assert.ok(result.enrichmentResults[0].fields.every(field => !field.values.length));
    }
});
test('genuine native search remains mandatory and nonweb execution or asserted brief is rejected', async t => {
    for (const [events, output, code] of [[[], { observations: [observation] }, 'OUTPUT'], [[{ type: 'item.started', item: { type: 'command_execution', command: 'curl' } }], { observations: [observation] }, 'PROCESS'], [[search], { observations: [{ ...observation, status: 'ready' }] }, 'OUTPUT'], [[search], { observations: [{ ...observation, candidateId: 'foreign' }] }, 'OUTPUT'], [[search], { observations: [observation], brief: 'Marketing' }, 'OUTPUT']]) {
        const s = setup(t, output, { events }); await assert.rejects(s.runner.run({ job, targets: [target] }), { code }); assert.equal(s.runner.active, false);
    }
});
test('safe schema URLs are independently acquired once; private fact URLs reject before acquisition', async t => {
    const fetched = [];
    const s = setup(t, { observations: [{ ...observation, sources: [observation.sources[0], observation.sources[0]] }] }, { fetchSource: async value => { fetched.push(value); return { url: value, finalUrl: value, text, blocks: [text], pageTitle: 'Alpha Workshop' }; } });
    await s.runner.run({ job, targets: [target] }); assert.deepEqual(fetched, [url]);
    const bad = setup(t, { observations: [{ ...observation, facts: [{ key: 'services', value: 'Brake repairs', sourceUrl: 'http://127.0.0.1/' }] }] }, { fetchSource: async () => { assert.fail('private source acquisition'); } }); await assert.rejects(bad.runner.run({ job, targets: [target] }), { code: 'OUTPUT' });
});
test('target cap and unknown future kind reject without starting a provider process', async t => {
    const s = setup(t, { observations: [] });
    await assert.rejects(s.runner.run({ job, targets: Array.from({ length: 11 }, (_, index) => ({ ...target, candidateId: String(index) })) }), { code: 'OUTPUT' });
    await assert.rejects(s.runner.run({ job: { ...job, kind: 'mockup' }, targets: [target] }), { code: 'OUTPUT' }); assert.equal(s.captured(), undefined);
    await assert.rejects(s.runner.run({ job, targets: [{ ...target, validationResultId: undefined }] }), { code: 'OUTPUT' });
    await assert.rejects(s.runner.run({ job: { ...job, groups: {} }, targets: [target] }), { code: 'OUTPUT' }); assert.equal(s.captured(), undefined);
});
test('typed network errors and late cancellation do not complete enrichment targets', async t => {
    const network = setup(t, { observations: [observation] }, { fetchSource: async () => { throw new Error('network failed'); } }); await assert.rejects(network.runner.run({ job, targets: [target] }), { code: 'NETWORK' });
    const controller = new AbortController(), aborted = setup(t, { observations: [observation] }, { fetchSource: async () => { controller.abort(); return null; } }); await assert.rejects(aborted.runner.run({ job, targets: [target], signal: controller.signal }), { code: 'PROCESS' }); assert.equal(aborted.runner.active, false);
});
test('gpt-5.5 enrichment retains its supported isolation path without silently selecting a model', async t => {
    const s = setup(t, { observations: [] }); await s.runner.run({ job: { ...job, model: 'gpt-5.5' }, targets: [target] });
    assert.equal(s.captured().args[s.captured().args.indexOf('--model') + 1], 'gpt-5.5'); assert.ok(!s.captured().args.includes('features.code_mode.direct_only_tool_namespaces=["web"]'));
});
