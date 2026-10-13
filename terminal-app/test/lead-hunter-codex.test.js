'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CodexRunner, commandArgs } = require('../src/lead-hunter-codex');
function setup(events, { exit = 0 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-runner-test-'));
    let child;
    const spawn = (bin, args, options) => {
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.pid = 987654321;
        child.kill = () => { setTimeout(() => child.emit('close', null, 'SIGTERM'), 10); return true; };
        setImmediate(() => {
            for (const e of events)
                child.stdout.write(JSON.stringify(e) + '\n');
            if (exit !== null) {
                child.stdout.end();
                child.emit('close', exit, null);
            }
        });
        return child;
    };
    return { dir, runner: new CodexRunner({ dir, binPath: '/codex', spawn, preflight: false, killGroup: () => false, fetchSource: async () => null }), child: () => child };
}
test('command isolates CLI configuration, instructions and execution tools', () => {
    const a = commandArgs('/schema');
    for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--json'])
        assert.ok(a.includes(flag));
    assert.ok(a.includes('read-only'));
    assert.ok(a.includes('never'));
    assert.ok(a.includes('shell_tool'));
    assert.ok(a.includes('plugins'));
    assert.equal(a.at(-1), '-');
    assert.ok(!a.some(x => x.includes('bypass')));
});
test('structured genuine events yield zero candidates without acquired evidence', async () => { const s = setup([{ type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'shops' } } }, { type: 'item.completed', item: { type: 'agent_message', text: '{"candidates":[],"exhausted":true}' } }, { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5 } }]); const events = []; const r = await s.runner.run({ job: { goal: 'Find shops', filters: { region: 'Selangor' } }, onEvent: e => events.push(e) }); assert.equal(r.exhausted, true); assert.equal(r.usage.input_tokens, 20); assert.equal(events.filter(e => e.type === 'search').length, 1); fs.rmSync(s.dir, { recursive: true }); });
test('malformed final and nonzero auth exits are typed', async () => {
    for (const [events, exit, code] of [[[{ type: 'item.completed', item: { type: 'agent_message', text: 'bad' } }], 0, 'OUTPUT'], [[{ type: 'error', message: '401 authentication required' }], 1, 'AUTH']]) {
        const s = setup(events, { exit });
        await assert.rejects(s.runner.run({ job: { goal: 'a', filters: { region: 'b' } } }), { code });
        fs.rmSync(s.dir, { recursive: true });
    }
});
test('abort rejection waits child teardown and bounded output rejects', async () => { const s = setup([], { exit: null }); const ac = new AbortController(); const p = s.runner.run({ job: { goal: 'a', filters: { region: 'b' } }, signal: ac.signal }); setTimeout(() => ac.abort(), 5); await assert.rejects(p, { code: 'PROCESS' }); fs.rmSync(s.dir, { recursive: true }); const t = setup([{ type: 'error', message: 'x'.repeat(500) }], { exit: null }); t.runner.maxTranscriptBytes = 100; await assert.rejects(t.runner.run({ job: { goal: 'a', filters: { region: 'b' } } }), { code: 'OUTPUT' }); fs.rmSync(t.dir, { recursive: true }); });
test('unrecognized tool types and missing native search evidence fail closed', async () => {
    for (const events of [[{ type: 'item.started', item: { type: 'browser_call' } }], [{ type: 'item.completed', item: { type: 'agent_message', text: '{"candidates":[],"exhausted":true}' } }]]) {
        const s = setup(events);
        await assert.rejects(s.runner.run({ job: { goal: 'a', filters: { region: 'b' } } }), { code: events[0].item.type === 'browser_call' ? 'PROCESS' : 'OUTPUT' });
        fs.rmSync(s.dir, { recursive: true });
    }
});
test('real process group abort terminates an owned child and descendant before settlement', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-tree-test-'));
    let descendant;
    const runner = new CodexRunner({ dir, binPath: process.execPath, preflight: false, spawn: (_bin, _args, opts) => require('node:child_process').spawn(process.execPath, ['-e', `const cp=require('child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({type:'thread.started',descendant:c.pid}));setInterval(()=>{},1000);`], opts) });
    const original = runner.spawn;
    runner.spawn = (...args) => { const child = original(...args); child.stdout.once('data', c => { descendant = JSON.parse(c.toString()).descendant; }); return child; };
    const ac = new AbortController();
    const p = runner.run({ job: { goal: 'a', filters: { region: 'b' } }, signal: ac.signal });
    await new Promise(r => setTimeout(r, 80));
    ac.abort();
    await assert.rejects(p, { code: 'PROCESS' });
    assert.ok(descendant);
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
    fs.rmSync(dir, { recursive: true });
});
test('public source fetch refuses DNS answers resolving to private addresses', async () => {
    const dns = require('node:dns').promises, old = dns.lookup;
    dns.lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    try {
        assert.equal(await require('../src/lead-hunter-codex').fetchPublicSource('https://public.example.com'), null);
    }
    finally {
        dns.lookup = old;
    }
});
test('pinned public DNS callback supports Node all-address requests and returns acquired text', async () => {
    const dns = require('node:dns').promises, https = require('node:https'), oldLookup = dns.lookup, oldGet = https.get;
    dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    https.get = (_url, opts, callback) => { const req = new EventEmitter(); req.destroy = () => { setImmediate(() => req.emit('close')); }; opts.lookup('example.com', { all: true }, (error, answers) => { assert.equal(error, null); assert.deepEqual(answers, [{ address: '93.184.216.34', family: 4 }]); }); setImmediate(() => { const res = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'text/html' }; res.destroy = () => setImmediate(() => res.emit('close')); callback(res); res.emit('data', Buffer.from('<h1>Alpha Workshop</h1><p>Selangor</p><a href="/contact">Contact form</a>')); res.emit('end'); }); return req; };
    try {
        const result = await require('../src/lead-hunter-codex').fetchPublicSource('https://example.com/business');
        assert.ok(result.text.includes('Alpha Workshop'));
        assert.ok(result.text.includes('https://example.com/contact'));
    }
    finally {
        dns.lookup = oldLookup;
        https.get = oldGet;
    }
});
test('full batch deadline is typed TIMEOUT and does not start another child', async () => {
    const s = setup([], { exit: null });
    s.runner.batchTimeoutMs = 15;
    await assert.rejects(s.runner.run({ job: { goal: 'a', filters: { region: 'b' } } }), { code: 'TIMEOUT' });
    assert.equal(s.runner.active, false);
    fs.rmSync(s.dir, { recursive: true });
});
test('stored API authentication fails before model launch', async () => {
    const cp = require('node:child_process'), old = cp.spawnSync, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-auth-test-'));
    cp.spawnSync = () => ({ status: 0, stdout: '', stderr: 'Logged in using an API key' });
    try {
        const r = new CodexRunner({ dir, binPath: '/codex', spawn: () => { throw new Error('Must not launch'); } });
        await assert.rejects(r.run({ job: { goal: 'a', filters: { region: 'b' } } }), { code: 'AUTH' });
    }
    finally {
        cp.spawnSync = old;
        fs.rmSync(dir, { recursive: true });
    }
});
test('source-backed candidate result requires acquired page text and preserves observations', async () => {
    const candidate = { company: 'Alpha Workshop', industry: 'Auto repair', region: 'Selangor', city: 'Shah Alam', address: '', website: { state: 'found', url: 'https://example.com/business' }, contact: { email: '', phone: '', form: '' }, sources: [{ url: 'https://example.com/business', label: 'Official' }] };
    const s = setup([{ type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'workshops Selangor' } } }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ candidates: [candidate], exhausted: false }) } }]);
    s.runner.fetchSource = async (url) => ({ url, label: 'example.com', text: 'Alpha Workshop Auto repair Shah Alam Selangor', observedAt: '2026-10-13T00:00:00Z' });
    const result = await s.runner.run({ job: { goal: 'a', filters: { region: 'Selangor', city: 'Shah Alam', sources: 'business_sites' } } });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].website.state, 'found');
    assert.equal(result.sourceObservations.length, 1);
    fs.rmSync(s.dir, { recursive: true });
});
test('source acquisition is inside the full batch deadline', async () => {
    const output = { candidates: [{ company: 'Alpha', industry: 'Workshop', region: 'Selangor', city: '', address: '', website: { state: 'unknown', url: '' }, contact: { email: '', phone: '', form: '' }, sources: [{ url: 'https://example.com/business', label: 'Official' }] }], exhausted: false };
    const s = setup([{ type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'a' } } }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }]);
    s.runner.batchTimeoutMs = 20;
    s.runner.fetchSource = async (_url, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    await assert.rejects(s.runner.run({ job: { goal: 'a', filters: { region: 'b' } } }), { code: 'TIMEOUT' });
    assert.equal(s.runner.active, false);
    fs.rmSync(s.dir, { recursive: true });
});
function mockPublicHttp(responses) {
    const dns = require('node:dns').promises, https = require('node:https'), oldLookup = dns.lookup, oldGet = https.get, requests = [];
    dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    https.get = (_url, _opts, callback) => {
        const req = new EventEmitter();
        req.destroyed = false;
        req.destroy = () => {
            if (req.destroyed)
                return;
            req.destroyed = true;
            setImmediate(() => req.emit('close'));
        };
        requests.push(req);
        setImmediate(() => {
            const spec = responses.shift();
            const res = new EventEmitter();
            res.statusCode = spec.status;
            res.headers = spec.headers;
            res.destroyed = false;
            res.resume = () => { };
            res.destroy = () => {
                if (res.destroyed)
                    return;
                res.destroyed = true;
                setImmediate(() => res.emit('close'));
            };
            req.response = res;
            callback(res);
            if (spec.body && !res.destroyed) {
                res.emit('data', Buffer.from(spec.body));
                res.emit('end');
                setImmediate(() => { res.emit('close'); req.emit('close'); });
            }
        });
        return req;
    };
    return { requests, restore() { dns.lookup = oldLookup; https.get = oldGet; } };
}
test('rejected and redirect bodies are destroyed before source acquisition settles', async () => {
    for (const responses of [[{ status: 404, headers: { 'content-type': 'text/html' } }], [{ status: 301, headers: { location: 'https://www.example.com/business' } }, { status: 200, headers: { 'content-type': 'text/html' }, body: 'Alpha Workshop Auto repair Selangor' }]]) {
        const m = mockPublicHttp(responses);
        try {
            await require('../src/lead-hunter-codex').fetchPublicSource('https://example.com/business');
            assert.equal(m.requests[0].destroyed, true);
            assert.equal(m.requests[0].response.destroyed, true);
        }
        finally {
            m.restore();
        }
    }
});
test('fetch preserves citation alias, final URL and redirect chain', async () => {
    const m = mockPublicHttp([{ status: 301, headers: { location: 'https://www.example.com/business' } }, { status: 200, headers: { 'content-type': 'text/html' }, body: 'Alpha Workshop Auto repair Selangor' }]);
    try {
        const o = await require('../src/lead-hunter-codex').fetchPublicSource('https://example.com/business');
        assert.equal(o.requestedUrl, 'https://example.com/business');
        assert.equal(o.finalUrl, 'https://www.example.com/business');
        assert.deepEqual(o.redirectChain, [o.requestedUrl, o.finalUrl]);
    }
    finally {
        m.restore();
    }
});
test('runner validates full nested final output before requesting sources', async () => {
    for (const candidate of [null, { sources: [null] }, { company: 'x', industry: 42, region: 'x', city: '', address: '', website: { state: 'bogus', url: '' }, contact: { email: '', phone: '', form: '' }, sources: [] }]) {
        const s = setup([{ type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'a' } } }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ candidates: [candidate], exhausted: false }) } }]);
        s.runner.fetchSource = () => { throw new Error('Cannot acquire malformed output'); };
        try {
            await assert.rejects(s.runner.run({ job: { goal: 'a', filters: { region: 'x' } } }), { code: 'OUTPUT' });
        }
        finally {
            fs.rmSync(s.dir, { recursive: true });
        }
    }
});
test('continuous accepted response is stopped by absolute deadline with both streams closed', async () => {
    const m = mockPublicHttp([{ status: 200, headers: { 'content-type': 'text/html' } }]);
    try {
        await assert.rejects(require('../src/lead-hunter-codex').fetchPublicSource('https://example.com/business', { timeoutMs: 15 }), { code: 'TIMEOUT' });
        assert.equal(m.requests[0].destroyed, true);
        assert.equal(m.requests[0].response.destroyed, true);
    }
    finally {
        m.restore();
    }
});
test('HTML acquisition retains separate local blocks and excludes scripts from page evidence', () => {
    const { htmlEvidence } = require('../src/lead-hunter-codex');
    const e = htmlEvidence('<title>Locations - Alpha Workshop</title><main><div><p>Shah Alam Selangor 10 Main Road</p><p>Phone +603 111 2222</p></div><div><p>Johor Bahru Johor 22 Other Road</p><p>Phone +607 333 4444</p></div></main><script>johor@alpha.com</script>', 'https://example.com/business');
    assert.equal(e.pageTitle, 'Locations - Alpha Workshop');
    assert.ok(e.blocks.some(b => b.includes('Shah Alam') && b.includes('+603') && !b.includes('Johor')));
    assert.ok(!e.text.includes('johor@alpha.com'));
});
test('unconfirmed process teardown retains PID and shutdown rejects until recovery', async () => {
    const s = setup([{ type: 'item.completed', item: { type: 'agent_message', text: '{"candidates":[],"exhausted":true}' } }]);
    s.runner.teardownTimeoutMs = 20;
    let alive = true;
    s.runner.killGroup = () => alive;
    try {
        await assert.rejects(s.runner.run({ job: { goal: 'a', filters: { region: 'b' } } }), { code: 'PROCESS' });
        assert.equal(s.runner.ownedPids.size, 1);
        assert.equal(s.runner.active, true);
        await assert.rejects(s.runner.shutdown(), { code: 'PROCESS' });
        assert.equal(s.runner.ownedPids.size, 1);
        alive = false;
        await s.runner.shutdown();
        assert.equal(s.runner.ownedPids.size, 0);
        assert.equal(s.runner.active, false);
    }
    finally {
        fs.rmSync(s.dir, { recursive: true });
    }
});
test('runner propagates each selected model while legacy jobs retain the compatible default', async () => {
    for (const model of ['gpt-6.1-sol', undefined]) {
        const s = setup([{ type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'a' } } }, { type: 'item.completed', item: { type: 'agent_message', text: '{"candidates":[],"exhausted":true}' } }]);
        let args;
        const original = s.runner.spawn;
        s.runner.spawn = (bin, values, opts) => { args = values; return original(bin, values, opts); };
        try {
            await s.runner.run({ job: { goal: 'a', model, filters: { region: 'b' } } });
            assert.equal(args[args.indexOf('--model') + 1], model || 'gpt-5.5');
        }
        finally {
            fs.rmSync(s.dir, { recursive: true });
        }
    }
});
test('command builder rejects unsupported or null model instead of treating it as legacy default', () => {
    for (const model of [null, '', 'unknown-model', '--dangerously-bypass-approvals-and-sandbox'])
        assert.throws(() => commandArgs('/schema', model), { code: 'HUNTER_INVALID' });
});
const disabledHostWarning = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
test('only proven newer model gets direct web namespace while default flags stay unchanged', () => {
    const option = 'features.code_mode.direct_only_tool_namespaces=["web"]';
    assert.ok(commandArgs('/schema', 'gpt-6.1-sol').includes(option));
    assert.ok(!commandArgs('/schema', 'gpt-5.5').includes(option));
    assert.ok(!commandArgs('/schema', 'gpt-6-sol').includes(option));
});
test('direct-web model tolerates only disabled host notice and still requires real search', async () => {
    for (const hasSearch of [true, false]) {
        const events = [{ type: 'item.completed', item: { type: 'error', message: disabledHostWarning } }, ...(hasSearch ? [{ type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'a' } } }] : []), { type: 'item.completed', item: { type: 'agent_message', text: '{"candidates":[],"exhausted":true}' } }];
        const s = setup(events);
        try {
            const p = s.runner.run({ job: { goal: 'a', model: 'gpt-6.1-sol', filters: { region: 'b' } } });
            if (hasSearch)
                assert.equal((await p).exhausted, true);
            else
                await assert.rejects(p, { code: 'OUTPUT' });
        }
        finally {
            fs.rmSync(s.dir, { recursive: true });
        }
    }
});
test('direct-web allowance does not excuse other errors or actual non-web calls', async () => {
    for (const item of [{ type: 'command_execution', command: 'whoami' }, { type: 'error', message: disabledHostWarning + ' Unexpected additional failure.' }]) {
        const s = setup([{ type: 'item.completed', item }, { type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'a' } } }, { type: 'item.completed', item: { type: 'agent_message', text: '{"candidates":[],"exhausted":true}' } }]);
        try {
            await assert.rejects(s.runner.run({ job: { goal: 'a', model: 'gpt-6.1-sol', filters: { region: 'b' } } }), { code: 'PROCESS' });
            assert.equal(s.runner.ownedPids.size, 0);
        }
        finally {
            fs.rmSync(s.dir, { recursive: true });
        }
    }
});
test('native default continues to reject the disabled-host notice', async () => {
    const s = setup([{ type: 'item.completed', item: { type: 'error', message: disabledHostWarning } }, { type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'a' } } }, { type: 'item.completed', item: { type: 'agent_message', text: '{"candidates":[],"exhausted":true}' } }]);
    try {
        await assert.rejects(s.runner.run({ job: { goal: 'a', model: 'gpt-5.5', filters: { region: 'b' } } }), { code: 'PROCESS' });
    }
    finally {
        fs.rmSync(s.dir, { recursive: true });
    }
});
test('direct-web non-web attempt retains unconfirmed PID and refuses another run', async () => {
    const s = setup([{ type: 'item.started', item: { type: 'command_execution', command: 'whoami' } }]);
    s.runner.teardownTimeoutMs = 20;
    let alive = true;
    s.runner.killGroup = () => alive;
    try {
        await assert.rejects(s.runner.run({ job: { goal: 'a', model: 'gpt-6.1-sol', filters: { region: 'b' } } }), { code: 'PROCESS' });
        assert.equal(s.runner.active, true);
        assert.equal(s.runner.ownedPids.size, 1);
        await assert.rejects(s.runner.run({ job: { goal: 'a', model: 'gpt-6.1-sol', filters: { region: 'b' } } }), { code: 'PROCESS' });
    }
    finally {
        alive = false;
        await s.runner.shutdown();
        fs.rmSync(s.dir, { recursive: true });
    }
});
test('known installed feature registry warning remains nonfatal for direct-web search', async () => {
    const notice = 'Under-development features enabled: skip_host_skill_discovery, standalone_web_search. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in /codex/config.toml.';
    const s = setup([{ type: 'item.completed', item: { type: 'error', message: notice } }, { type: 'item.completed', item: { type: 'error', message: disabledHostWarning } }, { type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: 'a' } } }, { type: 'item.completed', item: { type: 'agent_message', text: '{"candidates":[],"exhausted":true}' } }]);
    try {
        assert.equal((await s.runner.run({ job: { goal: 'a', model: 'gpt-6.1-sol', filters: { region: 'b' } } })).exhausted, true);
    }
    finally {
        fs.rmSync(s.dir, { recursive: true });
    }
});
