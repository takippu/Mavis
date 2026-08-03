'use strict';

// Read-only client for the optional Project Board integration (Settings → "Project board tab",
// off by default). It speaks a Bearer-token REST API rooted at config.PM_BASE_URL — a
// user-configurable setting whose default points at the public hosted board this client was
// written against. The route shapes below are the contract; any deployment that serves them works:
//   GET /api/mcp/v1/me                          → { userId, name, email, role, visibleProjectCount }
//   GET /api/mcp/v1/projects                    → [{ id, name, slug, status, crCount, taskCount }]
//   GET /api/mcp/v1/projects/:id/tasks?assigneeId=… → [task summaries]
//   GET /api/mcp/v1/tasks/:id (UUID or code like "PROJ-42") → full task w/ checklist+comments+sourceCr
// "My work" = my assigned tasks across every visible project. The token comes from the board's
// own /settings/api-tokens page (read scope is enough). Every call is gated on a token.

const ENDPOINTS = {
  me: '/api/mcp/v1/me',
  projects: '/api/mcp/v1/projects',
  projectTasks: (id) => '/api/mcp/v1/projects/' + encodeURIComponent(id) + '/tasks',
  task: (id) => '/api/mcp/v1/tasks/' + encodeURIComponent(id),
};
const KNOWN_STATUS = ['todo', 'doing', 'done'];

function normalize(it, kind, baseUrl) {
  it = it || {};
  const status = String(it.status || it.state || '').toLowerCase();
  const project = it.project && typeof it.project === 'object'
    ? String(it.project.name || it.project.slug || '')
    : String(it.project || it.projectName || '');
  return {
    id: String(it.id || it.key || ''),
    kind,
    code: it.code ? String(it.code) : '',
    title: String(it.title || it.name || it.summary || '(untitled)'),
    project,
    status: KNOWN_STATUS.includes(status) ? status : 'other',
    priority: it.priority ? String(it.priority) : '',
    phase: it.phase ? String(it.phase) : '',
    assignee: it.assigneeName ? String(it.assigneeName) : '',
    category: it.categoryName ? String(it.categoryName) : '',
    subcategory: it.subcategory ? String(it.subcategory) : '',
    url: String(it.url || baseUrl || ''),
  };
}

async function getJson(url, headers, signal) {
  let r;
  try { r = await fetch(url, { headers, signal }); }
  catch { return { ok: false, reason: 'network' }; }
  if (r.status === 401 || r.status === 403) return { ok: false, reason: 'unauthorized' };
  if (!r.ok) return { ok: false, reason: 'http-' + r.status };
  try { return { ok: true, data: await r.json() }; } catch { return { ok: false, reason: 'bad-json' }; }
}

async function listMyWork(baseUrl, token, opts = {}) {
  if (!token) return { ok: false, reason: 'no-token' };
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 10000);
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  try {
    const me = await getJson(base + ENDPOINTS.me, headers, ctrl.signal);
    if (!me.ok) return me;
    const userId = me.data && me.data.userId;
    if (!userId) return { ok: false, reason: 'no-user' };

    const projRes = await getJson(base + ENDPOINTS.projects, headers, ctrl.signal);
    if (!projRes.ok) return projRes;
    const projects = Array.isArray(projRes.data) ? projRes.data : [];

    // my assigned tasks per visible project, fetched in parallel
    const perProject = await Promise.all(projects.map(async (p) => {
      const url = base + ENDPOINTS.projectTasks(p.id) + '?assigneeId=' + encodeURIComponent(userId);
      const r = await getJson(url, headers, ctrl.signal);
      const arr = (r.ok && Array.isArray(r.data)) ? r.data : [];
      return arr.map((t) => normalize(Object.assign({}, t, { project: p.name }), 'task', base));
    }));

    return {
      ok: true,
      me: { name: (me.data && me.data.name) || '', userId },
      projects: projects.map((p) => ({ id: p.id, name: p.name, taskCount: p.taskCount, crCount: p.crCount })),
      items: perProject.flat(),
    };
  } finally {
    clearTimeout(timer);
  }
}

// List the visible projects + resolve "me" (for the per-project board picker and
// the optional "only my tasks" filter). Gated on a token.
async function listProjects(baseUrl, token, opts = {}) {
  if (!token) return { ok: false, reason: 'no-token' };
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 10000);
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  try {
    const me = await getJson(base + ENDPOINTS.me, headers, ctrl.signal);
    if (!me.ok) return me;
    const projRes = await getJson(base + ENDPOINTS.projects, headers, ctrl.signal);
    if (!projRes.ok) return projRes;
    const projects = Array.isArray(projRes.data) ? projRes.data : [];
    return {
      ok: true,
      me: { name: (me.data && me.data.name) || '', userId: (me.data && me.data.userId) || '' },
      projects: projects.map((p) => ({
        id: String((p && p.id) || ''),
        name: String((p && p.name) || '(untitled)'),
        slug: p && p.slug ? String(p.slug) : '',
        status: p && p.status ? String(p.status) : '',
        taskCount: p && typeof p.taskCount === 'number' ? p.taskCount : 0,
        crCount: p && typeof p.crCount === 'number' ? p.crCount : 0,
      })),
    };
  } finally {
    clearTimeout(timer);
  }
}

// All tasks in ONE project (the board's own project view), or only those assigned to
// `opts.assigneeId` when provided (the "Mine" toggle). Gated on a token.
async function listProjectTasks(baseUrl, token, projectId, opts = {}) {
  if (!token) return { ok: false, reason: 'no-token' };
  const pid = String(projectId == null ? '' : projectId);
  if (!pid) return { ok: false, reason: 'bad-ref' };
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 10000);
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  try {
    let url = base + ENDPOINTS.projectTasks(pid);
    if (opts.assigneeId) url += '?assigneeId=' + encodeURIComponent(opts.assigneeId);
    const r = await getJson(url, headers, ctrl.signal);
    if (!r.ok) return r;
    const arr = Array.isArray(r.data) ? r.data : [];
    return { ok: true, items: arr.map((t) => normalize(t, 'task', base)) };
  } finally {
    clearTimeout(timer);
  }
}

// Full task detail (description + subtasks/checklist + comments + source CR).
// Defensive: every field is coerced; missing arrays become []; never throws on shape.
function normalizeTask(t, baseUrl) {
  t = t || {};
  const arr = (x) => (Array.isArray(x) ? x : []);
  const status = String(t.status || '').toLowerCase();
  const cr = t.sourceCr && typeof t.sourceCr === 'object' ? t.sourceCr : null;
  return {
    id: String(t.id || ''),
    code: t.code ? String(t.code) : '',
    title: String(t.title || '(untitled)'),
    status: KNOWN_STATUS.includes(status) ? status : 'other',
    priority: t.priority ? String(t.priority) : '',
    phase: t.phase ? String(t.phase) : '',
    assignee: t.assigneeName ? String(t.assigneeName) : '',
    category: t.categoryName ? String(t.categoryName) : '',
    subcategory: t.subcategory ? String(t.subcategory) : '',
    branch: t.branch ? String(t.branch) : '',
    dueDate: t.dueDate ? String(t.dueDate) : '',
    description: t.description != null ? String(t.description) : '',
    checklist: arr(t.checklist).map((c) => ({
      id: c && c.id ? String(c.id) : '',
      content: String((c && c.content) != null ? c.content : ''),
      isCompleted: !!(c && c.isCompleted),
      completedAt: c && c.completedAt ? String(c.completedAt) : null,
      sortOrder: c && typeof c.sortOrder === 'number' ? c.sortOrder : 0,
    })),
    comments: arr(t.comments).map((c) => ({
      id: c && c.id ? String(c.id) : '',
      author: String((c && c.authorName) || 'Someone'),
      content: String((c && c.content) != null ? c.content : ''),
      createdAt: c && c.createdAt ? String(c.createdAt) : '',
    })),
    sourceCr: cr
      ? {
          code: cr.code ? String(cr.code) : '',
          title: cr.title ? String(cr.title) : '',
          status: String(cr.status || '').toLowerCase(),
          description: cr.description != null ? String(cr.description) : '',
        }
      : null,
    url: String(t.url || baseUrl || ''),
  };
}

// Fetch one task by UUID or human code ("PROJ-42"). Read-only. Gated on a token.
async function getTask(baseUrl, token, ref, opts = {}) {
  if (!token) return { ok: false, reason: 'no-token' };
  const id = String(ref == null ? '' : ref).trim();
  if (!id) return { ok: false, reason: 'bad-ref' };
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 10000);
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  try {
    const r = await getJson(base + ENDPOINTS.task(id), headers, ctrl.signal);
    if (!r.ok) return r.reason === 'http-404' ? { ok: false, reason: 'not-found' } : r;
    return { ok: true, task: normalizeTask(r.data, base) };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a description-embed / task image by its key (the path after /api/images/,
// e.g. "description-embeds/<projectId>/<uuid>.png") through the Bearer-authed MCP
// image route, and return it as a base64 data: URL for inline rendering. The web
// /api/images route is session-gated, so the app can't <img> it directly — main
// fetches with the token here and hands the renderer a self-contained data URL.
async function getImage(baseUrl, token, key, opts = {}) {
  if (!token) return { ok: false, reason: 'no-token' };
  const raw = String(key == null ? '' : key).replace(/^\/+/, '');
  // only a relative images key — never an absolute URL or a path traversal
  if (!raw || /^[a-z]+:\/\//i.test(raw) || raw.split('/').some((seg) => seg === '..')) return { ok: false, reason: 'bad-key' };
  const safe = raw.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 15000);
  try {
    let r;
    try { r = await fetch(base + '/api/mcp/v1/images/' + safe, { headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal }); }
    catch { return { ok: false, reason: 'network' }; }
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'unauthorized' };
    if (!r.ok) return { ok: false, reason: 'http-' + r.status };
    const ct = String(r.headers.get('content-type') || '');
    if (!/^image\//i.test(ct)) return { ok: false, reason: 'not-image' };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > (opts.maxBytes || 8 * 1024 * 1024)) return { ok: false, reason: 'too-large' };
    return { ok: true, dataUrl: 'data:' + ct + ';base64,' + buf.toString('base64') };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { listMyWork, listProjects, listProjectTasks, getTask, getImage, normalize, normalizeTask, getJson, ENDPOINTS, KNOWN_STATUS };
