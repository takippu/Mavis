'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dailyops = require('../src/dailyops');
const agent = require('../src/dailyops-agent');
const { normalize } = require('../src/pm-client');
const tokenStore = require('../src/token-store');

// Every person, project, ticket code and host below is SYNTHETIC on purpose. These fixtures used
// to be a snapshot of a live production board — real ticket codes, real assignees, a real PM host —
// which made the test file a directory of someone else's work the moment the repo went public.
// Nothing here asserts on a real system, so the names are free: `Ada` is the stand-in user,
// `acme-portal` / `bluebird` the stand-in projects, `TICKET-<n>` the ticket codes, and
// `pm.example.com` the PM host (never dialled — every fetch in this file is stubbed).
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mt-int-'));
function brainWith(standups, name) {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'identity'));
  fs.writeFileSync(path.join(d, 'identity', 'profile.md'), `---\nname: ${name || 'Ada'}\n---\n`);
  fs.mkdirSync(path.join(d, 'standups'));
  Object.entries(standups || {}).forEach(([date, text]) => fs.writeFileSync(path.join(d, 'standups', date + '.md'), text));
  return d;
}

// ---- dailyops: compose the locked standup format (whitespace-exact) ----
test('composeStandup emits the locked format: header, 6-space projects, 12-space bullets', () => {
  const text = dailyops.composeStandup({
    name: 'Ada', date: '2026-06-24', previousBody: '', issues: '', detailed: true,
    todayRows: [{ project: 'acme-portal', work: 'Continue import batch\nrun smoke\ncommit' }],
  });
  assert.match(text, /^24\/06\/2026 - Wednesday - Ada\n/);
  assert.match(text, /\nPrevious Work Day - Tuesday\n      - None\n/);
  assert.match(text, /\nIssues Faced\n    - None\n/);
  assert.match(text, /\nToday\n      - acme-portal : Continue import batch\n            - run smoke\n            - commit\n$/);
});

test('composeStandup is CONCISE by default: one headline line per project, no sub-bullets', () => {
  const text = dailyops.composeStandup({
    name: 'Ada', date: '2026-06-24',
    previous: [{ project: 'acme-portal', work: 'shipped import batch\nmerged TICKET-12/13\nbuilt TICKET-14/15' }],
    issues: [], todayRows: [{ project: 'acme-portal', work: 'Continue smoke\nrun a\nrun b' }],
  });
  assert.match(text, /Previous Work Day - Tuesday\n      - acme-portal : shipped import batch\n\nIssues Faced/);
  assert.match(text, /Today\n      - acme-portal : Continue smoke\n$/);
  assert.doesNotMatch(text, /\n {12}- /); // no 12-space sub-bullets in concise mode
});

test('composeStandup renders previous body verbatim and one issue per line', () => {
  const text = dailyops.composeStandup({
    name: 'Ada', date: '2026-06-24',
    previousBody: '      - alpha : shipped\n            - did x',
    issues: 'flaky CI\nslow build',
    todayRows: [{ project: 'beta', work: 'keep going' }],
  });
  assert.match(text, /Previous Work Day - Tuesday\n      - alpha : shipped\n            - did x\n/);
  assert.match(text, /Issues Faced\n    - flaky CI\n    - slow build\n/);
});

test('parseStandup round-trips composeStandup output', () => {
  const rows = [{ project: 'A', work: 'H1\nb1\nb2' }, { project: 'B', work: 'H2' }];
  const text = dailyops.composeStandup({ name: 'Ada', date: '2026-06-24', previousBody: '      - X : y', issues: 'one\ntwo', todayRows: rows, detailed: true });
  const p = dailyops.parseStandup(text);
  assert.deepStrictEqual(p.todayRows, rows);
  assert.strictEqual(p.issues, 'one\ntwo');
  assert.strictEqual(p.previousBody, '      - X : y');
});

test('listStandups returns entries newest-first', () => {
  const d = brainWith({ '2026-06-22': 'a\n', '2026-06-23': 'b\n', '2026-06-20': 'c\n' });
  const all = dailyops.listStandups(d);
  assert.deepStrictEqual(all.map((s) => s.date), ['2026-06-23', '2026-06-22', '2026-06-20']);
  assert.strictEqual(dailyops.listStandups(tmp()).length, 0); // no standups dir → []
});

test('getContext seeds Previous from the prior day’s Today when today has no file', () => {
  const prior = 'X\n\nPrevious Work Day - Mon\n      - old : stuff\n\nIssues Faced\n    - None\n\nToday\n      - alpha : did the thing\n            - detail\n';
  const d = brainWith({ '2026-06-23': prior }, 'Ada');
  const ctx = dailyops.getContext(d, new Date('2026-06-24T12:00:00'));
  assert.strictEqual(ctx.exists, false);
  assert.strictEqual(ctx.name, 'Ada');
  assert.strictEqual(ctx.date, '2026-06-24');
  assert.strictEqual(ctx.previousBody, '      - alpha : did the thing\n            - detail');
});

test('saveStandup writes standups/<date>.md and getContext then edits it (exists + parsed rows)', () => {
  const d = brainWith({});
  const r = dailyops.saveStandup(d, { date: '2026-06-24', previousBody: '', issues: '', todayRows: [{ project: 'mavis-terminal', work: 'rebuild DailyOps' }] });
  assert.ok(r.ok);
  assert.ok(fs.existsSync(path.join(d, 'standups', '2026-06-24.md')));
  assert.strictEqual(dailyops.listStandups(d)[0].date, '2026-06-24');
  const ctx = dailyops.getContext(d, new Date('2026-06-24T12:00:00'));
  assert.strictEqual(ctx.exists, true);
  assert.deepStrictEqual(ctx.todayRows, [{ project: 'mavis-terminal', work: 'rebuild DailyOps' }]);
});

test('saveStandup rejects a calendar-invalid date and falls back to today (no garbage file)', () => {
  const d = brainWith({});
  const r = dailyops.saveStandup(d, { date: '2026-13-45', previousBody: '', issues: '', todayRows: [{ project: 'x', work: 't' }] });
  assert.ok(r.ok);
  assert.strictEqual(r.date, dailyops.todayISO());
  assert.strictEqual(fs.existsSync(path.join(d, 'standups', '2026-13-45.md')), false);
});

test('composeStandup drops leading/trailing blank lines in an edited previousBody', () => {
  const text = dailyops.composeStandup({ name: 'T', date: '2026-06-24', previousBody: '\n\n      - X : y\n\n', issues: '', todayRows: [{ project: 'a', work: 'b' }] });
  assert.match(text, /Previous Work Day - Tuesday\n      - X : y\n\nIssues Faced/);
});

test('composeStandup builds Previous from agent rows + array issues (whitespace-exact)', () => {
  const text = dailyops.composeStandup({
    name: 'Ada', date: '2026-06-24', detailed: true,
    previous: [{ project: 'acme-portal', work: 'shipped import batch\nmerged TICKET-12/13\nbuilt TICKET-14/15' }],
    issues: ['flaky CI', 'slow build'],
    todayRows: [{ project: 'acme-portal', work: 'Continue smoke + commit' }],
  });
  assert.match(text, /Previous Work Day - Tuesday\n      - acme-portal : shipped import batch\n            - merged TICKET-12\/13\n            - built TICKET-14\/15\n/);
  assert.match(text, /Issues Faced\n    - flaky CI\n    - slow build\n/);
  assert.match(text, /Today\n      - acme-portal : Continue smoke \+ commit\n$/);
});

test('saveStandup writes verbatim text when input.text is given', () => {
  const d = brainWith({});
  const block = '24/06/2026 - Wednesday - Ada\n\nToday\n      - x : y\n';
  const r = dailyops.saveStandup(d, { date: '2026-06-24', text: block });
  assert.ok(r.ok);
  assert.strictEqual(fs.readFileSync(path.join(d, 'standups', '2026-06-24.md'), 'utf8'), block);
});

// ---- dailyops-agent control-block parser ----
test('parseControl extracts an ASK block (tolerating leading prose)', () => {
  const raw = 'Read yesterday. Found 2 projects.\n\n<<<ASK>>>{"questions":[{"id":"projects","header":"Projects","label":"Which?","kind":"multiselect","options":["a","b"]}]}<<<END>>>';
  const r = agent.parseControl(raw);
  assert.strictEqual(r.kind, 'ask');
  assert.strictEqual(r.questions.length, 1);
  assert.strictEqual(r.questions[0].kind, 'multiselect');
  assert.strictEqual(agent.preamble(raw), 'Read yesterday. Found 2 projects.');
});

test('parseControl extracts a DONE block and message fallback', () => {
  const done = agent.parseControl('<<<DONE>>>{"previous":[],"issues":[],"today":[{"project":"x","work":"y"}]}<<<END>>>');
  assert.strictEqual(done.kind, 'done');
  assert.deepStrictEqual(done.data.today, [{ project: 'x', work: 'y' }]);
  assert.strictEqual(agent.parseControl('just chatting, no block').kind, 'message');
});

test('parseControl is robust to a stray marker in prose and a marker inside JSON', () => {
  // stray <<<ASK>>> in the preamble must not hijack parsing
  const stray = agent.parseControl('I will emit <<<ASK>>> now.\n<<<ASK>>>{"questions":[{"id":"a","kind":"text","label":"x"}]}<<<END>>>');
  assert.strictEqual(stray.kind, 'ask');
  // literal <<<END>>> inside a JSON string must not truncate the block
  const inner = agent.parseControl('<<<DONE>>>{"today":[{"project":"x","work":"mention <<<END>>> in docs"}]}<<<END>>>');
  assert.strictEqual(inner.kind, 'done');
  assert.strictEqual(inner.data.today[0].work, 'mention <<<END>>> in docs');
  // a present-but-broken block is an explicit error, not a silent message
  assert.strictEqual(agent.parseControl('<<<ASK>>>{not json}<<<END>>>').kind, 'error');
});

test('rowsToLines coerces a single-object row and array work (LLM shape deviations)', () => {
  const t1 = dailyops.composeStandup({ name: 'T', date: '2026-06-24', previous: [], issues: [], todayRows: { project: 'X', work: 'do it' } });
  assert.match(t1, /Today\n      - X : do it\n/);
  const t2 = dailyops.composeStandup({ name: 'T', date: '2026-06-24', previous: [], issues: [], detailed: true, todayRows: [{ project: 'Y', work: ['head', 'b1', 'b2'] }] });
  assert.match(t2, /Today\n      - Y : head\n            - b1\n            - b2\n/);
});

// ---- pm-client.normalize ----
test('normalize maps fields and clamps unknown status to other', () => {
  const r = normalize({ id: 1, title: 'T', status: 'doing', project: { name: 'P' } }, 'task', 'https://x');
  assert.strictEqual(r.kind, 'task');
  assert.strictEqual(r.title, 'T');
  assert.strictEqual(r.project, 'P');
  assert.strictEqual(r.status, 'doing');
  const u = normalize({ id: 2, status: 'weird' }, 'cr', 'https://x');
  assert.strictEqual(u.status, 'other');
  assert.strictEqual(u.kind, 'cr');
});

test('normalize tolerates missing fields', () => {
  const r = normalize(null, 'task', 'https://x');
  assert.strictEqual(r.title, '(untitled)');
  assert.strictEqual(r.status, 'other');
});

test('listMyWork orchestrates me→projects→tasks against the mcp/v1 routes and normalizes', async () => {
  const pm = require('../src/pm-client');
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    const json = (d) => ({ ok: true, status: 200, json: async () => d });
    if (url.endsWith('/api/mcp/v1/me')) return json({ userId: 'u1', name: 'Ada' });
    if (url.endsWith('/api/mcp/v1/projects')) return json([{ id: 'p1', name: 'acme-portal', taskCount: 5, crCount: 2 }]);
    if (url.includes('/api/mcp/v1/projects/p1/tasks')) return json([{ id: 't1', code: 'TICKET-4', title: 'Customer Portal', status: 'doing', priority: 'medium', phase: 'Phase 2a' }]);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const r = await pm.listMyWork('https://pm.example.com', 'tok');
    assert.ok(r.ok);
    assert.strictEqual(r.me.name, 'Ada');
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.items[0].code, 'TICKET-4');
    assert.strictEqual(r.items[0].project, 'acme-portal');
    assert.strictEqual(r.items[0].status, 'doing');
    assert.ok(calls.some((u) => u.includes('/api/mcp/v1/projects/p1/tasks?assigneeId=u1')));
  } finally { global.fetch = orig; }
});

test('listMyWork handles no-token and 401 cleanly', async () => {
  const pm = require('../src/pm-client');
  assert.strictEqual((await pm.listMyWork('https://x', '')).reason, 'no-token');
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  try { assert.strictEqual((await pm.listMyWork('https://x', 'bad')).reason, 'unauthorized'); }
  finally { global.fetch = orig; }
});

// ---- pm-client.getTask / normalizeTask (detail contract) ----
test('getTask fetches /tasks/<ref> with Bearer and normalizes detail (checklist, comments, sourceCr)', async () => {
  const pm = require('../src/pm-client');
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), auth: opts && opts.headers && opts.headers.Authorization });
    return {
      ok: true, status: 200, json: async () => ({
        id: 't1', code: 'TICKET-4', title: 'Customer Portal', status: 'doing', priority: 'medium',
        assigneeName: 'Ada', categoryName: 'Phase 2a', subcategory: 'IMPORT', phase: 'Phase 2a', branch: 'f/x',
        description: 'Build the portal', dueDate: '2026-07-01',
        checklist: [{ content: 'a', isCompleted: true }, { content: 'b', isCompleted: false }],
        comments: [{ content: 'looks good', authorName: 'Sam', createdAt: '2026-06-20' }],
        sourceCr: { code: 'TICKET-4', title: 'Portal CR', status: 'approved', description: 'do it' },
      }),
    };
  };
  try {
    const r = await pm.getTask('https://pm.example.com', 'tok', 'TICKET-4');
    assert.ok(r.ok);
    assert.strictEqual(r.task.title, 'Customer Portal');
    assert.strictEqual(r.task.status, 'doing');
    assert.strictEqual(r.task.assignee, 'Ada');
    assert.strictEqual(r.task.checklist.length, 2);
    assert.strictEqual(r.task.checklist[0].isCompleted, true);
    assert.strictEqual(r.task.comments[0].author, 'Sam');
    assert.strictEqual(r.task.sourceCr.code, 'TICKET-4');
    assert.ok(calls[0].url.endsWith('/api/mcp/v1/tasks/TICKET-4'));
    assert.strictEqual(calls[0].auth, 'Bearer tok');
  } finally { global.fetch = orig; }
});

test('getTask returns typed failures: no-token, bad-ref, not-found, unauthorized', async () => {
  const pm = require('../src/pm-client');
  assert.strictEqual((await pm.getTask('https://x', '', 'TICKET-4')).reason, 'no-token');
  assert.strictEqual((await pm.getTask('https://x', 'tok', '')).reason, 'bad-ref');
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  try { assert.strictEqual((await pm.getTask('https://x', 'tok', 'NOPE-9')).reason, 'not-found'); }
  finally { global.fetch = orig; }
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  try { assert.strictEqual((await pm.getTask('https://x', 'tok', 'TICKET-4')).reason, 'unauthorized'); }
  finally { global.fetch = orig; }
});

test('normalizeTask tolerates missing fields, clamps unknown status, coerces 0/1 isCompleted', () => {
  const { normalizeTask } = require('../src/pm-client');
  const r = normalizeTask(null, 'https://x');
  assert.strictEqual(r.title, '(untitled)');
  assert.deepStrictEqual(r.checklist, []);
  assert.deepStrictEqual(r.comments, []);
  assert.strictEqual(r.sourceCr, null);
  const u = normalizeTask({ status: 'weird', checklist: [{ content: 'x', isCompleted: 1 }, { content: 'y', isCompleted: 0 }] }, 'https://x');
  assert.strictEqual(u.status, 'other');
  assert.strictEqual(u.checklist[0].isCompleted, true);
  assert.strictEqual(u.checklist[1].isCompleted, false);
});

// ---- pm-client.listProjects / listProjectTasks (per-project board) ----
test('listProjects returns me + normalized projects', async () => {
  const pm = require('../src/pm-client');
  const orig = global.fetch;
  global.fetch = async (url) => {
    const json = (d) => ({ ok: true, status: 200, json: async () => d });
    if (String(url).endsWith('/api/mcp/v1/me')) return json({ userId: 'u1', name: 'Ada' });
    if (String(url).endsWith('/api/mcp/v1/projects')) return json([
      { id: 'p1', name: 'acme-portal', slug: 'ACME', status: 'production', taskCount: 48, crCount: 44 },
      { id: 'p2', name: 'bluebird', taskCount: 0 },
    ]);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const r = await pm.listProjects('https://pm.example.com', 'tok');
    assert.ok(r.ok);
    assert.strictEqual(r.me.userId, 'u1');
    assert.strictEqual(r.projects.length, 2);
    assert.strictEqual(r.projects[0].name, 'acme-portal');
    assert.strictEqual(r.projects[0].taskCount, 48);
  } finally { global.fetch = orig; }
});

test('listProjectTasks fetches all tasks, filters by assignee when given, and normalizes', async () => {
  const pm = require('../src/pm-client');
  const calls = [];
  const orig = global.fetch;
  const all = [
    { id: 't1', code: 'TICKET-4', title: 'Customer Portal', status: 'doing', assigneeName: 'Ada', subcategory: null, categoryName: null, phase: 'Phase 2a' },
    { id: 't6', code: 'TICKET-6', title: 'User Access Page', status: 'doing', assigneeName: null, subcategory: 'LOGIN/ MULTITENANT', categoryName: 'Multi Tenant', phase: 'Phase 2a' },
  ];
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => (String(url).includes('assigneeId=') ? [all[0]] : all) };
  };
  try {
    const allRes = await pm.listProjectTasks('https://pm.example.com', 'tok', 'p1');
    assert.ok(allRes.ok);
    assert.strictEqual(allRes.items.length, 2);
    assert.strictEqual(allRes.items[0].assignee, 'Ada');
    assert.strictEqual(allRes.items[1].assignee, '');
    assert.strictEqual(allRes.items[1].subcategory, 'LOGIN/ MULTITENANT');
    const mineRes = await pm.listProjectTasks('https://pm.example.com', 'tok', 'p1', { assigneeId: 'u1' });
    assert.strictEqual(mineRes.items.length, 1);
    assert.ok(calls.some((u) => u.includes('/api/mcp/v1/projects/p1/tasks?assigneeId=u1')));
    assert.strictEqual((await pm.listProjectTasks('https://x', 'tok', '')).reason, 'bad-ref');
    assert.strictEqual((await pm.listProjectTasks('https://x', '', 'p1')).reason, 'no-token');
  } finally { global.fetch = orig; }
});

test('normalize surfaces assignee/category/subcategory for board cards', () => {
  const { normalize } = require('../src/pm-client');
  const r = normalize({ id: 1, title: 'T', status: 'doing', assigneeName: 'Ada', categoryName: 'Cat', subcategory: 'Sub' }, 'task', 'https://x');
  assert.strictEqual(r.assignee, 'Ada');
  assert.strictEqual(r.category, 'Cat');
  assert.strictEqual(r.subcategory, 'Sub');
});

// ---- token-store ----
test('token set/get/status/clear round-trips with a masked tail', () => {
  const d = tmp();
  assert.strictEqual(tokenStore.tokenStatus(d).present, false);
  tokenStore.setToken(d, 'abcd1234');
  assert.strictEqual(tokenStore.getToken(d), 'abcd1234');
  const s = tokenStore.tokenStatus(d);
  assert.strictEqual(s.present, true);
  assert.strictEqual(s.maskedTail, '1234');
  tokenStore.clearToken(d);
  assert.strictEqual(tokenStore.getToken(d), null);
});

test('corrupt token file reads as no token', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'pm-token.json'), 'nope');
  assert.strictEqual(tokenStore.getToken(d), null);
});
