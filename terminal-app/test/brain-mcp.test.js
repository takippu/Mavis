'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mcpServerNames, parseSkillMd } = require('../src/brain-mcp');
const { listMcpServers, listSkills, invalidate } = require('../src/brain-stats');

// ---- mcpServerNames (pure) ----

// A ~/.claude.json-shaped fixture: names map to full server defs carrying secrets.
// The server names are invented — the point of the fixture is the SHAPE (a name whose def holds a
// token), and the sort assertions below depend on the chosen names, so keep them alphabetically
// after `pencil` if you rename them.
const CLAUDE_JSON = {
  mcpServers: {
    'ticket-pm': { type: 'stdio', command: 'npx', args: ['-y', 'ticket-pm-mcp'], env: { PM_TOKEN: 'pmk_secret' } },
    firebase: { type: 'stdio', command: 'npx', args: ['-y', 'firebase-tools@15.20.0', 'mcp'], env: {} },
    // pencil lists `command` before `type` — key ordering must not matter
    pencil: { command: 'C:\\Users\\x\\mcp-server.exe', args: ['--app', 'vscode'], env: {}, type: 'stdio' },
  },
};

test('mcpServerNames returns the server names, sorted', () => {
  assert.deepStrictEqual(mcpServerNames(CLAUDE_JSON), ['firebase', 'pencil', 'ticket-pm']);
});

test('mcpServerNames never surfaces command / args / env (names only)', () => {
  const names = mcpServerNames(CLAUDE_JSON);
  const blob = JSON.stringify(names);
  assert.ok(!blob.includes('PM_TOKEN'));
  assert.ok(!blob.includes('pmk_secret'));
  assert.ok(!blob.includes('npx'));
  assert.ok(names.every((n) => typeof n === 'string'));
});

test('mcpServerNames → [] for missing / non-object / array mcpServers', () => {
  assert.deepStrictEqual(mcpServerNames({}), []);
  assert.deepStrictEqual(mcpServerNames({ mcpServers: null }), []);
  assert.deepStrictEqual(mcpServerNames({ mcpServers: [] }), []);
  assert.deepStrictEqual(mcpServerNames(null), []);
  assert.deepStrictEqual(mcpServerNames(undefined), []);
  assert.deepStrictEqual(mcpServerNames('nope'), []);
});

// ---- parseSkillMd (pure) ----

const SKILL_MD = [
  '# Spec-Driven — Skill',
  '',
  "A 4-artifact spec workflow for non-trivial changes. Use when a feature deserves design first.",
  '',
  '## When to invoke',
  '- "propose <feature>"',
].join('\n');

test('parseSkillMd reads name from the H1 (trailing " — Skill" stripped) + first prose paragraph', () => {
  assert.deepStrictEqual(parseSkillMd(SKILL_MD, 'spec-driven'), {
    name: 'Spec-Driven',
    description: 'A 4-artifact spec workflow for non-trivial changes. Use when a feature deserves design first.',
  });
});

test('parseSkillMd falls back to the dir name when the H1 is missing', () => {
  const md = 'no heading here\n\njust prose\n';
  assert.strictEqual(parseSkillMd(md, 'daily-standup').name, 'daily-standup');
});

test('parseSkillMd skips blanks/sub-headings/bullets/fences before the prose paragraph', () => {
  const md = '# Client Deck — Skill\n\n\n## Section first\n\nThe real description line.\n';
  const out = parseSkillMd(md, 'client-deck');
  assert.strictEqual(out.name, 'Client Deck');
  assert.strictEqual(out.description, 'The real description line.');
});

test('parseSkillMd joins a multi-line first paragraph into one description', () => {
  const md = '# X — Skill\n\nline one\nline two\n\n## next\n';
  assert.strictEqual(parseSkillMd(md, 'x').description, 'line one line two');
});

test('parseSkillMd → { name: dir, description: "" } on empty / non-string input', () => {
  assert.deepStrictEqual(parseSkillMd('', 'connect-pm-mcp'), { name: 'connect-pm-mcp', description: '' });
  assert.deepStrictEqual(parseSkillMd(null, 'connect-pm-mcp'), { name: 'connect-pm-mcp', description: '' });
});

// ---- listMcpServers (fs orchestration + merge) ----

function tmpJson(obj) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-mcp-')), '.claude.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('listMcpServers merges user-level names with project-level, deduping (user wins)', () => {
  invalidate();
  const brainRoot = 'C:/brain/project';
  const jsonPath = tmpJson({
    mcpServers: {
      'ticket-pm': { command: 'npx', env: { PM_TOKEN: 'secret' } },
      firebase: { command: 'npx', env: {} },
    },
    projects: {
      // slash-normalized key lookup: stored with backslashes, brainRoot uses forward slashes
      'C:\\brain\\project': { mcpServers: { firebase: { command: 'x' }, local: { command: 'y' } } },
    },
  });
  const out = listMcpServers(brainRoot, jsonPath);
  assert.deepStrictEqual(out, [
    { name: 'firebase', source: 'user' },
    { name: 'ticket-pm', source: 'user' },
    { name: 'local', source: 'project' }, // firebase collision resolved to the user entry
  ]);
  // secrets never leak
  assert.ok(!JSON.stringify(out).includes('secret'));
});

test('listMcpServers → [] on a missing / unparseable ~/.claude.json', () => {
  invalidate();
  assert.deepStrictEqual(listMcpServers('C:/brain', path.join(os.tmpdir(), 'mt-does-not-exist-xyz.json')), []);
  invalidate();
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-mcp-')), '.claude.json');
  fs.writeFileSync(bad, '{ not json');
  assert.deepStrictEqual(listMcpServers('C:/brain', bad), []);
});

test('listMcpServers → user-only when the brain project has no project-level mcpServers', () => {
  invalidate();
  const jsonPath = tmpJson({ mcpServers: { pencil: { command: 'x' } }, projects: {} });
  assert.deepStrictEqual(listMcpServers('C:/brain', jsonPath), [{ name: 'pencil', source: 'user' }]);
});

// ---- listSkills (fs orchestration) ----

test('listSkills reads skills/<name>/SKILL.md → [{name, description}] sorted by name', () => {
  invalidate();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-skills-'));
  const mk = (dir, body) => {
    fs.mkdirSync(path.join(root, 'skills', dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', dir, 'SKILL.md'), body);
  };
  mk('spec-driven', '# Spec-Driven — Skill\n\nSpec workflow desc.\n');
  mk('client-deck', '# Client Deck — Skill\n\nClient HTML desc.\n');
  // a dir with no SKILL.md is skipped
  fs.mkdirSync(path.join(root, 'skills', 'half-baked'), { recursive: true });

  assert.deepStrictEqual(listSkills(root), [
    { name: 'Client Deck', description: 'Client HTML desc.' },
    { name: 'Spec-Driven', description: 'Spec workflow desc.' },
  ]);
});

test('listSkills → [] when skills/ is absent (legacy brain)', () => {
  invalidate();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-skills-'));
  assert.deepStrictEqual(listSkills(root), []);
});
