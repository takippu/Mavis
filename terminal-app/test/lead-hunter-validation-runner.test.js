'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { CodexRunner, VALIDATION_SCHEMA } = require('../src/lead-hunter-codex');
const url = 'https://alpha.example.com/contact', text = 'Alpha Workshop Auto repair Shah Alam Selangor hello@alpha.example.com';
const candidate = { company: 'Alpha Workshop', industry: 'Auto repair', region: 'Selangor', city: 'Shah Alam', address: '', website: { state: 'found', url }, contact: { email: 'hello@alpha.example.com', phone: '', form: '' } };
const target = { candidateId: 'candidate-1', discoveryJobId: 'discover-1', inputDigest: 'a'.repeat(64), candidate };
const observation = { candidateId: target.candidateId, ...candidate, sources: [{ url, label: 'Official' }] };
const job = { id: 'validate-job', kind: 'validate', model: 'gpt-6.1-sol', goal: 'Check selected workshop', criteria: { industry: 'Auto repair', region: 'Selangor', city: 'Shah Alam', website: 'found', contact: 'email', checkDuplicates: true } };
const search = { type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'Alpha Workshop Shah Alam' } } };
function setup(t, output, { events = [search], fetchSource = async requested => ({ url: requested, finalUrl: requested, text, blocks: [text], pageTitle: 'Alpha Workshop Contact', observedAt: '2026-10-13T00:00:00Z' }) } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-validation-runner-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let captured;
    const runner = new CodexRunner({ dir, binPath: '/mock-codex', preflight: false, fetchSource, killGroup: () => false, spawn: (bin, args, options) => {
        const child = new EventEmitter(); child.pid = 987654321; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => { setImmediate(() => child.emit('close', null)); return true; };
        captured = { bin, args, options, prompt: '', schema: JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8')) };
        child.stdin.on('data', part => { captured.prompt += part.toString(); });
        setImmediate(() => { for (const event of [...events, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }, { type: 'turn.completed', usage: { input_tokens: 40, output_tokens: 20 } }]) child.stdout.write(JSON.stringify(event) + '\n'); child.stdout.end(); child.emit('close', 0); }); return child;
    } });
    return { runner, captured: () => captured };
}
test('Validate dispatches native strict web-only search with frozen model/snapshots and acquired evidence', async t => {
    const s = setup(t, { observations: [observation] }), events = [];
    const result = await s.runner.run({ job, targets: [target], attemptId: 'attempt-1', onEvent: e => events.push(e) });
    assert.equal(result.validationResults.length, 1); assert.equal(result.validationResults[0].overall, 'passed'); assert.equal(result.validationResults[0].model, job.model); assert.equal(result.usage.input_tokens, 40); assert.equal(s.runner.active, false); assert.equal(s.runner.ownedPids.size, 0);
    const c = s.captured(); assert.equal(c.args[c.args.indexOf('--model') + 1], job.model); assert.deepEqual(c.schema, VALIDATION_SCHEMA); assert.equal(c.schema.additionalProperties, false); assert.equal(c.schema.properties.observations.items.additionalProperties, false);
    for (const value of ['--ignore-user-config', '--ignore-rules', '--ephemeral', 'read-only', 'computer_use', 'browser_use', 'shell_tool', 'plugins', 'hooks', 'features.code_mode.direct_only_tool_namespaces=["web"]']) assert.ok(c.args.includes(value));
    assert.equal(c.options.shell, false); assert.equal(c.options.detached, true); assert.ok(c.prompt.includes(target.inputDigest)); assert.ok(c.prompt.includes('SMTP')); assert.ok(c.prompt.includes('Do not return verdicts')); assert.equal(events.filter(e => e.type === 'source').length, 1);
});
test('schema-valid missing observations and blocked sources remain business Unknown', async t => {
    for (const observations of [[], [observation]]) {
        const s = setup(t, { observations }, { fetchSource: async () => null });
        const result = await s.runner.run({ job, targets: [target] }); assert.equal(result.validationResults.length, 1); assert.equal(result.validationResults[0].overall, 'needs_review'); assert.equal(result.validationResults[0].checks.find(c => c.key === 'identity').status, 'unknown');
    }
});
test('validation still requires genuine native search and rejects nonweb tools or provider verdicts', async t => {
    for (const [events, output, code] of [[[], { observations: [observation] }, 'OUTPUT'], [[{ type: 'item.started', item: { type: 'command_execution', command: 'curl' } }], { observations: [observation] }, 'PROCESS'], [[search], { observations: [{ ...observation, overall: 'passed' }] }, 'OUTPUT'], [[search], { observations: [{ ...observation, candidateId: 'foreign' }] }, 'OUTPUT']]) {
        const s = setup(t, output, { events }); await assert.rejects(s.runner.run({ job, targets: [target] }), { code }); assert.equal(s.runner.active, false);
    }
});
test('unsafe source URLs never reach page acquisition', async t => {
    let fetched = 0;
    const s = setup(t, { observations: [{ ...observation, sources: [{ url: 'http://127.0.0.1/private', label: 'Private' }] }] }, { fetchSource: async () => { fetched++; return null; } });
    const result = await s.runner.run({ job, targets: [target] }); assert.equal(fetched, 0); assert.equal(result.validationResults[0].overall, 'needs_review');
});
test('bounded validation targets reject before starting a provider process', async t => {
    const s = setup(t, { observations: [] });
    await assert.rejects(s.runner.run({ job, targets: Array.from({ length: 11 }, (_, i) => ({ ...target, candidateId: String(i) })) }), { code: 'OUTPUT' }); assert.equal(s.captured(), undefined);
});
test('network transport errors remain task errors and final acquisition abort cannot yield results', async t => {
    const network = setup(t, { observations: [observation] }, { fetchSource: async () => { throw new Error('network failed'); } }); await assert.rejects(network.runner.run({ job, targets: [target] }), { code: 'NETWORK' });
    const controller = new AbortController(), aborted = setup(t, { observations: [observation] }, { fetchSource: async () => { controller.abort(); return null; } }); await assert.rejects(aborted.runner.run({ job, targets: [target], signal: controller.signal }), { code: 'PROCESS' }); assert.equal(aborted.runner.active, false);
});
