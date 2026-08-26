'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tc = require('../src/transcript-commands');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

test('extractFencedBlocks preserves exact multiline shell/config content', () => {
  const text = [
    'Run this:',
    '```bash',
    "sudo tee /etc/nginx/sites-available/app >/dev/null <<'NGINX'",
    'server {',
    '  listen 80;',
    '}',
    'NGINX',
    '```',
  ].join('\n');
  assert.deepStrictEqual(tc.extractFencedBlocks(text), [{
    language: 'bash',
    content: "sudo tee /etc/nginx/sites-available/app >/dev/null <<'NGINX'\nserver {\n  listen 80;\n}\nNGINX",
  }]);
});

test('Claude transcript lookup uses the exact session and returns newest blocks first', (t) => {
  const home = tempHome(t);
  const cwd = 'C:\\Users\\A\\project';
  const root = tc.roots(home).claude;
  const projectDir = tc.claudeProjectDir(root, cwd);
  const file = path.join(projectDir, 'claude-session.jsonl');
  writeJsonl(file, [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '```bash\necho older\n```' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '```powershell\nGet-Date\n```' }] } },
  ]);
  const result = tc.listSuggestedCommands({ harness: 'claude', cwd, sessionId: 'claude-session', startedAt: 0 }, { homeDir: home });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.blocks.map((b) => [b.language, b.content]), [
    ['powershell', 'Get-Date'],
    ['bash', 'echo older'],
  ]);
});

test('Codex transcript lookup correlates filename session id and preserves continuations', (t) => {
  const home = tempHome(t);
  const cwd = 'C:\\work\\app';
  const root = tc.roots(home).codex;
  const file = path.join(root, '2026', '08', '05', 'rollout-session-abc.jsonl');
  writeJsonl(file, [
    { type: 'session_meta', payload: { id: 'session-abc', cwd } },
    { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: '```bash\nsudo certbot --nginx \\\n  -d app.example.com\n```' }] } },
    // event_msg duplicates the same answer in real Codex transcripts; it must not duplicate cards.
    { type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate' } },
  ]);
  const result = tc.listSuggestedCommands({ harness: 'codex', cwd, sessionId: 'session-abc', startedAt: 0 }, { homeDir: home });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.blocks.length, 1);
  assert.strictEqual(result.blocks[0].content, 'sudo certbot --nginx \\\n  -d app.example.com');
});

test('an untrusted hook transcript path is ignored instead of escaping the harness root', (t) => {
  const home = tempHome(t);
  const outside = path.join(home, 'outside.jsonl');
  writeJsonl(outside, [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '```bash\nwhoami\n```' }] } }]);
  const result = tc.listSuggestedCommands({ harness: 'claude', cwd: 'C:\\missing', transcriptPath: outside, startedAt: 0 }, { homeDir: home });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.blocks, []);
});

