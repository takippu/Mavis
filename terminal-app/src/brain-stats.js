'use strict';

// Read-only readers over the brain files that feed the dashboard + projects view.
// Pure helpers (parseFrontmatter / parseTasksProgress / parseDailyHeadlines) are
// unit-tested; the fs orchestration sits on top. Runs in the Electron main process.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseProjectsIndex } = require('./index-parser');
const { mcpServerNames, parseSkillMd } = require('./brain-mcp');

// ---------- result cache ----------
// These readers re-read+parse many brain files; they're hit on every dashboard/
// projects/detail render, every search keystroke, AND every brain-changed re-render.
// The brain only changes via the watcher, so memoize per (brainRoot, key) and clear
// on `invalidate()` (wired to brain-watch in main.js). Between writes, reads are free.
const _cache = new Map();
function invalidate() { _cache.clear(); }
function memo(key, fn) {
  if (_cache.has(key)) return _cache.get(key);
  const v = fn();
  _cache.set(key, v);
  return v;
}

// ---------- pure helpers ----------

// Top YAML frontmatter block → { key: value } (strings; quotes stripped).
function parseFrontmatter(md) {
  if (!md || typeof md !== 'string') return {};
  const lines = md.split(/\r?\n/);
  if (lines[0].trim() !== '---') return {};
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = lines[i].match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

// tasks.md "Progress Summary" → { completed, total } | null.
function parseTasksProgress(md) {
  if (!md || typeof md !== 'string') return null;
  const total = md.match(/\*\*Total Tasks\*\*:\s*(\d+)/);
  if (!total) return null;
  const completed = md.match(/\*\*Completed\*\*:\s*(\d+)/);
  return { total: Number(total[1]), completed: completed ? Number(completed[1]) : 0 };
}

// daily-memory "## <project> — <headline>" section headings → [{project, headline}].
function parseDailyHeadlines(md) {
  if (!md || typeof md !== 'string') return [];
  const out = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (!m) continue;
    const text = m[1].trim();
    if (/^Notes\b/i.test(text)) continue; // skip "## Notes (no project)"
    const [proj, ...rest] = text.split(' — ');
    if (!proj.trim() || proj.trim().startsWith('—')) continue; // skip empty / em-dash-led headings
    out.push({ project: proj.trim(), headline: rest.join(' — ').trim() || proj.trim() });
  }
  return out;
}

// ---------- dashboard aggregates (pure) ----------

// utc-ms of a 'YYYY-MM-DD' calendar date (date-only → DST-safe comparisons).
function dayMs(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s)); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
function msIso(ms) { const d = new Date(ms); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }
function todayMs() { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()); }
const DAY_MS = 86400000;

// [{date,count}] → { current, best } consecutive-day streaks (days with count>0).
// current runs back from today (or yesterday, so a not-yet-logged today doesn't break it).
function computeStreak(activityByDay) {
  const set = new Set();
  (activityByDay || []).forEach((d) => { if (d && d.date && Number(d.count) > 0 && !isNaN(dayMs(d.date))) set.add(d.date); });
  if (!set.size) return { current: 0, best: 0 };
  const sorted = Array.from(set).sort();
  let best = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (dayMs(sorted[i]) - dayMs(sorted[i - 1]) === DAY_MS) { run++; if (run > best) best = run; } else run = 1;
  }
  const t = todayMs();
  let anchor = set.has(msIso(t)) ? t : (set.has(msIso(t - DAY_MS)) ? t - DAY_MS : null);
  let current = 0;
  while (anchor != null && set.has(msIso(anchor))) { current++; anchor -= DAY_MS; }
  return { current, best };
}

// [{date,count}] → { current, peak } weekly section sums (weeks start Sunday).
function weekStats(activityByDay) {
  const buckets = {};
  (activityByDay || []).forEach((d) => {
    if (!d || !d.date) return;
    const ms = dayMs(d.date); if (isNaN(ms)) return;
    const sun = ms - new Date(ms).getUTCDay() * DAY_MS;
    buckets[sun] = (buckets[sun] || 0) + (Number(d.count) || 0);
  });
  const t = todayMs();
  const curSun = t - new Date(t).getUTCDay() * DAY_MS;
  return { current: buckets[curSun] || 0, peak: Math.max(0, ...Object.values(buckets)) };
}

// daily list (each with .headlines) + projects → [{name,count,active}], top by mention count.
// A project mentioned but absent from _index defaults to active (it's clearly being worked on).
function aggregateProjectActivity(daily, projects, limit = 10) {
  const counts = {};
  (daily || []).forEach((d) => { (d.headlines || []).forEach((h) => { if (h && h.project) counts[h.project] = (counts[h.project] || 0) + 1; }); });
  const status = {};
  (projects || []).forEach((p) => {
    const active = String(p.status || p.group || '').toLowerCase() === 'active';
    if (p.name) status[p.name.toLowerCase()] = active;
    if (p.slug) status[p.slug.toLowerCase()] = active;
  });
  return Object.entries(counts)
    .map(([name, count]) => { const k = name.toLowerCase(); return { name, count, active: k in status ? status[k] : true }; })
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ---------- fs orchestration ----------

function safeSlug(slug) {
  return typeof slug === 'string' && /^[A-Za-z0-9._-]+$/.test(slug) && slug !== '.' && slug !== '..';
}

function readProjectMeta(brainRoot, slug) {
  if (!safeSlug(slug)) return {};
  try {
    return parseFrontmatter(
      fs.readFileSync(path.join(brainRoot, 'projects', slug, 'index.md'), 'utf8')
    );
  } catch {
    return {};
  }
}

function listProjectsWithDirs(brainRoot) {
  return memo('projects:' + brainRoot, () => {
    const md = fs.readFileSync(path.join(brainRoot, 'projects', '_index.md'), 'utf8');
    return parseProjectsIndex(md).map((p) => {
      const fm = readProjectMeta(brainRoot, p.slug);
      return { ...p, dir: fm.path || null, lastAccessed: fm.last_accessed || null, color: fm.color || null };
    });
  });
}

function newestDaily(brainRoot) {
  try {
    const dir = path.join(brainRoot, 'daily-memories');
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();
    const f = files[files.length - 1];
    return f ? fs.readFileSync(path.join(dir, f), 'utf8') : null;
  } catch {
    return null;
  }
}

function scanInProgressSpecs(brainRoot, slug, projectName) {
  if (!safeSlug(slug)) return [];
  const specsDir = path.join(brainRoot, 'projects', slug, 'specs');
  let entries;
  try {
    entries = fs.readdirSync(specsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '_archive');
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    let proposal;
    try {
      proposal = fs.readFileSync(path.join(specsDir, e.name, 'proposal.md'), 'utf8');
    } catch {
      continue;
    }
    if ((parseFrontmatter(proposal).status || '').toLowerCase() !== 'in-progress') continue;
    let progress = null;
    try {
      progress = parseTasksProgress(fs.readFileSync(path.join(specsDir, e.name, 'tasks.md'), 'utf8'));
    } catch { /* no tasks file */ }
    found.push({
      project: projectName,
      change: e.name,
      completed: progress ? progress.completed : null,
      total: progress ? progress.total : null,
    });
  }
  return found;
}

function getDashboardData(brainRoot) {
  return memo('dashboard:' + brainRoot, () => _getDashboardData(brainRoot));
}
function _getDashboardData(brainRoot) {
  const projects = listProjectsWithDirs(brainRoot);
  const isActive = (p) => (p.status || p.group || '').toLowerCase() === 'active';

  const recent = projects
    .filter((p) => p.lastAccessed)
    .sort((a, b) => (b.lastAccessed || '').localeCompare(a.lastAccessed || ''))
    .slice(0, 5)
    .map((p) => ({ slug: p.slug, name: p.name, dir: p.dir, lastAccessed: p.lastAccessed, type: p.type, status: p.status }));

  const specs = projects.flatMap((p) => scanInProgressSpecs(brainRoot, p.slug, p.name));
  const daily = listDailyMemories(brainRoot);
  const activity = parseDailyHeadlines(newestDaily(brainRoot)).slice(0, 8);

  // chart data: daily-memory work-sections per day → drives pulse + radial-year;
  // streak/week aggregates → momentum rings; project mention counts → constellation.
  const activityByDay = daily.map((d) => ({ date: d.date, count: d.count }));

  return {
    counts: {
      activeProjects: projects.filter(isActive).length,
      totalProjects: projects.length,
      specsInProgress: specs.length,
      updates: activity.length,
    },
    recent,
    specs,
    activity,
    activityByDay,
    streak: computeStreak(activityByDay),
    week: weekStats(activityByDay),
    projectActivity: aggregateProjectActivity(daily, projects),
  };
}

// ---------- detail + search (brain-panels) ----------

// progress.md "## <when> ..." checkpoint blocks → newest-first, capped.
function parseProgressCheckpoints(md, limit = 6) {
  if (!md || typeof md !== 'string') return [];
  const blocks = [];
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { if (cur) blocks.push(cur); cur = { when: h[1].trim(), bullets: [] }; continue; }
    if (cur) { const b = line.match(/^\s*[-*]\s+(.*)$/); if (b && b[1].trim()) cur.bullets.push(b[1].trim()); }
  }
  if (cur) blocks.push(cur);
  return blocks.slice(-limit).reverse().map((b) => ({ when: b.when, text: b.bullets.slice(0, 4).join(' · ') }));
}

// notes.md "## <section>" headings → capped.
function parseNotesEntries(md, limit = 6) {
  if (!md || typeof md !== 'string') return [];
  const out = [];
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) out.push({ text: h[1].trim() });
  }
  return out.slice(0, limit);
}

// trim a matching line to ~max chars around the hit, with ellipses.
function makeSnippet(line, q, max = 160) {
  const s = String(line || '').trim();
  if (!q) return s.slice(0, max);
  const i = s.toLowerCase().indexOf(String(q).toLowerCase());
  if (i < 0) return s.slice(0, max);
  const start = Math.max(0, i - 40);
  let snip = s.slice(start, start + max);
  if (start > 0) snip = '…' + snip;
  if (start + max < s.length) snip += '…';
  return snip;
}

function collectMentions(brainRoot, projectName, limit = 6) {
  try {
    const dir = path.join(brainRoot, 'daily-memories');
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-12).reverse();
    const out = [];
    for (const f of files) {
      let md; try { md = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const date = f.replace(/\.md$/, '');
      for (const h of parseDailyHeadlines(md)) {
        if (h.project === projectName) { out.push({ date, headline: h.headline }); if (out.length >= limit) return out; }
      }
    }
    return out;
  } catch { return []; }
}

function getProjectDetail(brainRoot, slug) {
  if (!safeSlug(slug)) return null;
  return memo('detail:' + brainRoot + ':' + slug, () => _getProjectDetail(brainRoot, slug));
}
function _getProjectDetail(brainRoot, slug) {
  const fm = readProjectMeta(brainRoot, slug);
  const name = fm.name || slug;
  const read = (file) => { try { return fs.readFileSync(path.join(brainRoot, 'projects', slug, file), 'utf8'); } catch { return ''; } };
  return {
    slug,
    name,
    type: fm.type || '',
    dir: fm.path || null,
    status: fm.status || '',
    lastAccessed: fm.last_accessed || null,
    progress: parseProgressCheckpoints(read('progress.md')),
    notes: parseNotesEntries(read('notes.md')),
    specs: scanInProgressSpecs(brainRoot, slug, name),
    mentions: collectMentions(brainRoot, name),
  };
}

// The searchable corpus: every file's lines + a pre-lowercased copy, read ONCE per
// brain-change (memoized). Search then scans memory per keystroke instead of doing
// fresh disk I/O for the whole brain on every character typed.
function buildSearchCorpus(brainRoot) {
  const docs = [];
  const push = (abs, project, slug, fileLabel) => {
    let md; try { md = fs.readFileSync(abs, 'utf8'); } catch { return; }
    const lines = md.split(/\r?\n/);
    docs.push({ project: project || null, slug: slug || null, file: fileLabel, lines, lower: lines.map((l) => l.toLowerCase()) });
  };
  try {
    const d = path.join(brainRoot, 'daily-memories');
    fs.readdirSync(d).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse()
      .forEach((f) => push(path.join(d, f), null, null, f));
  } catch { /* none */ }
  // Per project: the flat notes.md/progress.md, plus the two dirs brain-repair creates when it
  // rotates checkpoints (progress-archive/<year>.md) or shards notes (notes/_details/<slug>.md).
  // Both dirs are OPTIONAL — most projects have neither, so an absent dir is a silent skip.
  const pushDir = (dir, p, labelPrefix) => {
    let files;
    try { files = fs.readdirSync(dir).filter((f) => /\.md$/.test(f)).sort(); }
    catch { return; } // dir absent (un-repaired project) → nothing to add
    for (const f of files) push(path.join(dir, f), p.name, p.slug, labelPrefix + f);
  };
  for (const p of listProjectsWithDirs(brainRoot)) {
    if (!safeSlug(p.slug)) continue;
    const pdir = path.join(brainRoot, 'projects', p.slug);
    push(path.join(pdir, 'notes.md'), p.name, p.slug, p.slug + '/notes.md');
    push(path.join(pdir, 'progress.md'), p.name, p.slug, p.slug + '/progress.md');
    pushDir(path.join(pdir, 'progress-archive'), p, p.slug + '/progress-archive/');
    pushDir(path.join(pdir, 'notes', '_details'), p, p.slug + '/notes/_details/');
  }
  // Topics: prefer the new two-tier topics/ (_index.md + _details/<slug>.md); fall back to the
  // legacy topic_index.md + topic_details/ only when the new category is absent (un-migrated brain).
  if (fs.existsSync(path.join(brainRoot, 'topics', '_index.md'))) {
    push(path.join(brainRoot, 'topics', '_index.md'), null, null, 'topics/_index.md');
    try {
      const td = path.join(brainRoot, 'topics', '_details');
      fs.readdirSync(td).filter((f) => /\.md$/.test(f)).sort()
        .forEach((f) => push(path.join(td, f), null, null, 'topics/_details/' + f));
    } catch { /* none */ }
  } else {
    push(path.join(brainRoot, 'topic_index.md'), null, null, 'topic_index.md');
    try {
      const td = path.join(brainRoot, 'topic_details');
      fs.readdirSync(td).filter((f) => /\.md$/.test(f)).sort()
        .forEach((f) => push(path.join(td, f), null, null, 'topic_details/' + f));
    } catch { /* none */ }
  }
  return docs;
}

// substring scan over the cached corpus (daily-memories + notes/progress + topic_index), capped.
function searchBrain(brainRoot, query, opts = {}) {
  const q = String(query || '').toLowerCase().trim();
  if (q.length < 2) return [];
  const limit = opts.limit || 80;
  const perFile = opts.perFile || 10;
  const corpus = memo('corpus:' + brainRoot, () => buildSearchCorpus(brainRoot));
  const results = [];
  for (const doc of corpus) {
    if (results.length >= limit) break;
    let n = 0;
    for (let i = 0; i < doc.lower.length; i++) {
      if (doc.lower[i].includes(q)) {
        results.push({ project: doc.project, slug: doc.slug, file: doc.file, line: i + 1, snippet: makeSnippet(doc.lines[i], q) });
        if (++n >= perFile || results.length >= limit) break;
      }
    }
  }
  return results.slice(0, limit);
}

// ---------- daily-log timeline + topic browser ----------

// All daily-memory dates (newest first) with their project sections (headlines).
function listDailyMemories(brainRoot) {
  return memo('daily-list:' + brainRoot, () => {
    try {
      const dir = path.join(brainRoot, 'daily-memories');
      return fs.readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort().reverse()
        .map((f) => {
          const date = f.replace(/\.md$/, '');
          let heads = [];
          try { heads = parseDailyHeadlines(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* skip */ }
          return { date, projects: Array.from(new Set(heads.map((h) => h.project))), count: heads.length, headlines: heads };
        });
    } catch { return []; }
  });
}

// The full markdown of one day, by ISO date.
function getDailyMemory(brainRoot, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date == null ? '' : date))) return null;
  return memo('daily-get:' + brainRoot + ':' + date, () => {
    let content = '';
    try { content = fs.readFileSync(path.join(brainRoot, 'daily-memories', date + '.md'), 'utf8'); } catch { /* missing */ }
    return { date, content };
  });
}

// Parse a topic's body lines into structured fields. Each `**Field:**` (or
// `**Title (added YYYY-MM-DD):**`) starts a field; dated ones become addendums.
function parseTopicBody(bodyLines) {
  const fields = [];
  let cur = null;
  for (const line of bodyLines || []) {
    const mk = line.match(/^\*\*(.+?):\*\*\s?(.*)$/);
    if (mk) {
      const title = mk[1].trim();
      const dm = title.match(/^(.*?)\s*\(added (\d{4}-\d{2}-\d{2})\)\s*$/);
      cur = { key: dm ? dm[1].trim() : title, date: dm ? dm[2] : null, lines: mk[2] ? [mk[2]] : [] };
      fields.push(cur);
    } else if (cur) cur.lines.push(line);
  }
  const byKey = {};
  const addendums = [];
  for (const f of fields) {
    const text = f.lines.join('\n').trim();
    if (f.date) addendums.push({ title: f.key, date: f.date, body: text });
    else byKey[f.key.toLowerCase()] = { text, lines: f.lines };
  }
  const refLines = (byKey.refs ? byKey.refs.lines : []).map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
  return {
    triggers: (byKey.triggers || {}).text || '',
    did: (byKey.did || {}).text || '',
    refs: refLines,
    preempt: (byKey['pre-empt'] || byKey.preempt || {}).text || '',
    addendums,
  };
}

// topics/_index.md + topics/_details/<slug>.md → [{ slug, triggers, did, refs[], preempt, addendums[], body }].
// Prefers the new two-tier `topics/` category; falls back to the legacy topic_index.md +
// topic_details/ on an un-migrated brain (see listTopicsLegacy). Shape is stable for topics-view.js.
function listTopics(brainRoot) {
  return memo('topics:' + brainRoot, () => {
    const index = readCategoryIndex(brainRoot, 'topics');
    if (!index.length) return listTopicsLegacy(brainRoot);
    const entries = {};
    for (const e of listCategoryEntries(brainRoot, 'topics')) entries[e.slug] = e;
    const secOf = (e, label) => {
      if (!e) return '';
      const s = e.sections.find((x) => x.label.toLowerCase() === label);
      return s ? s.content : '';
    };
    return index.map((row) => {
      const e = entries[row.slug];
      const refs = secOf(e, 'refs').split(/\r?\n/).map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
      const did = secOf(e, 'did');
      return {
        slug: row.slug,
        triggers: (row.triggers || []).join(', '),
        did: did || row.summary || '',
        refs,
        preempt: secOf(e, 'pre-empt') || secOf(e, 'preempt') || '',
        addendums: [],                 // dated `(added …)` addendums were a legacy-format construct
        body: e ? [e.body.rule, e.body.why, e.body.how].filter(Boolean).join('\n\n') : '',
      };
    });
  });
}

// Legacy fallback for un-migrated brains: parse topic_index.md (`## Topic: <slug>`) + the substance in
// topic_details/<slug>.md (**Did:**/**Refs:**/**Pre-empt:** markers + dated addendums). Same output shape.
function listTopicsLegacy(brainRoot) {
  let md;
  try { md = fs.readFileSync(path.join(brainRoot, 'topic_index.md'), 'utf8'); } catch { return []; }
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.bodyLines.join('\n').replace(/\n*---\s*$/, '').trim();
    let detailLines = null;
    if (safeSlug(cur.slug)) {
      try { detailLines = fs.readFileSync(path.join(brainRoot, 'topic_details', cur.slug + '.md'), 'utf8').split(/\r?\n/); } catch { /* no detail file → old inline layout */ }
    }
    const p = parseTopicBody(detailLines || cur.bodyLines);
    out.push({ slug: cur.slug, triggers: cur.triggers || p.triggers, did: cur.did || p.did, refs: p.refs, preempt: p.preempt, addendums: p.addendums, body });
    cur = null;
  };
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+Topic:\s*(.+?)\s*$/);
    if (h) { flush(); cur = { slug: h[1].trim(), triggers: '', did: '', bodyLines: [] }; continue; }
    if (!cur) continue;
    const t = line.match(/^\*\*Triggers:\*\*\s*(.*)$/);
    const d = line.match(/^\*\*Did:\*\*\s*(.*)$/);
    if (t) cur.triggers = t[1].trim();
    else if (d) cur.did = d[1].trim();
    cur.bodyLines.push(line);
  }
  flush();
  return out;
}

// ---------- generic two-tier category readers (preferences / rules / topics) ----------
// Mirrors the topics two-tier layout for the new structured categories: a lean
// <category>/_index.md (slug + Triggers + Summary + a Detail pointer) plus per-slug
// <category>/_details/<slug>.md entries (YAML frontmatter + ## Rule / ## Why / ## How body).
// Purely additive: every reader returns the legacy-empty fallback ([] / null) when the
// <category>/ dir/file is absent, so these are no-ops on a brain that hasn't been migrated.

// <category>/_index.md → [{ slug, triggers[], summary, detailRel }]. Sections start at
// `## <slug>` (plain `##`, NOT `## Topic:`); Triggers/Summary/Detail are bold-marker lines.
function parseIndexFile(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  let cur = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      flush();
      const slug = h[1].trim();
      if (slug.includes('<')) { cur = null; continue; } // template placeholder guard
      cur = { slug, triggers: [], summary: '', detailRel: null };
      continue;
    }
    if (!cur) continue;
    const t = line.match(/^\*\*Triggers:\*\*\s*(.*)$/);
    if (t) { cur.triggers = t[1].split(',').map((s) => s.trim()).filter(Boolean); continue; }
    const s = line.match(/^\*\*Summary:\*\*\s*(.*)$/);
    if (s) { cur.summary = s[1].trim(); continue; }
    const d = line.match(/^\*\*Detail:\*\*\s*(.*)$/);
    if (d) { const lm = d[1].match(/\(([^)]*)\)/); cur.detailRel = lm ? lm[1].trim() : null; continue; }
  }
  flush();
  return out;
}

// One YAML frontmatter list key → string[]. Handles the brain's inline-array convention
// (`scope: [a, b, c]`, brackets optional) and a block `- item` form for robustness.
function frontmatterList(md, key) {
  if (!md || typeof md !== 'string') return [];
  const lines = md.split(/\r?\n/);
  if (lines[0].trim() !== '---') return [];
  const strip = (raw) => {
    let v = String(raw).trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    return v.trim();
  };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = lines[i].match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m || m[1] !== key) continue;
    const inline = m[2].trim();
    if (inline) return inline.replace(/^\[/, '').replace(/\]$/, '').split(',').map(strip).filter(Boolean);
    // block form: indented `- item` lines until the next top-level key / fence end.
    const items = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '---') break;
      const b = lines[j].match(/^\s*-\s+(.*)$/);
      if (b) { const v = strip(b[1]); if (v) items.push(v); continue; }
      if (/^\s/.test(lines[j])) continue; // other indented content under the key → ignore
      break; // a new top-level key ends the block
    }
    return items;
  }
  return [];
}

// <category>/_details/<slug>.md → { frontmatter, body:{rule,why,how}, sections:[{label,content}] }.
// Frontmatter scalars come from parseFrontmatter; scope/links are coerced via frontmatterList;
// superseded_by is emitted only when present. The body is three case-insensitive `## Rule/Why/How`
// h2 sections (legacy rule/why/how layout). `sections` is the generic capture: every `## ` h2 in
// body order with its verbatim heading as `label` and trimmed lines as `content` — this carries
// topic-shaped bodies (`## Did/Refs/Pre-empt`) the three rule/why/how buckets would otherwise drop.
function parseEntryFile(text) {
  const fm = parseFrontmatter(text);
  const frontmatter = {
    id: fm.id || '',
    title: fm.title || '',
    category: fm.category || '',
    scope: frontmatterList(text, 'scope'),
    status: fm.status || '',
    since: fm.since || '',
    updated: fm.updated || '',
    links: frontmatterList(text, 'links'),
  };
  if ('superseded_by' in fm) frontmatter.superseded_by = fm.superseded_by;
  const buf = { rule: [], why: [], how: [] };
  const sections = [];       // every `## ` h2 in body order: { label (verbatim), lines }
  let cur = null;
  let sec = null;
  for (const line of (text || '').split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const label = h[1].trim();
      sec = { label, lines: [] };
      sections.push(sec);
      const k = label.toLowerCase();
      // Emitters write the canonical `## How to apply`; also accept bare `## How`
      // (and any `how …` variant) so a body's third section is never silently dropped.
      cur = (k === 'rule') ? 'rule'
        : (k === 'why') ? 'why'
          : (k === 'how to apply' || k === 'how' || k.startsWith('how')) ? 'how'
            : null;
      continue;
    }
    if (sec) sec.lines.push(line);
    if (cur) buf[cur].push(line);
  }
  return {
    frontmatter,
    body: { rule: buf.rule.join('\n').trim(), why: buf.why.join('\n').trim(), how: buf.how.join('\n').trim() },
    sections: sections.map((s) => ({ label: s.label, content: s.lines.join('\n').trim() })),
  };
}

// Category whitelist (whitelist-only path discipline, mirrors MAVIS_FILES; never an arbitrary path).
const CATEGORIES = new Set(['preferences', 'rules', 'topics']);
function safeCategory(category) { return CATEGORIES.has(category); }

// <category>/_index.md → parsed index rows. [] when category invalid or the file/dir is absent.
function readCategoryIndex(brainRoot, category) {
  if (!safeCategory(category)) return [];
  return memo('cat-index:' + brainRoot + ':' + category, () => {
    try { return parseIndexFile(fs.readFileSync(path.join(brainRoot, category, '_index.md'), 'utf8')); }
    catch { return []; }
  });
}

// <category>/_details/<slug>.md → parsed entry. null when category/slug invalid or the file is absent.
function readEntry(brainRoot, category, slug) {
  if (!safeCategory(category) || !safeSlug(slug)) return null;
  return memo('cat-entry:' + brainRoot + ':' + category + ':' + slug, () => {
    try { return parseEntryFile(fs.readFileSync(path.join(brainRoot, category, '_details', slug + '.md'), 'utf8')); }
    catch { return null; }
  });
}

// <category>/_details/*.md → ALL entries (active AND superseded), each parsed via
// parseEntryFile. Unlike readCategoryIndex, this does NOT consult _index.md, so
// superseded entries (omitted from the index by design) are included — this is the
// browser's source of truth. Sorted active-first, then newest `since` first, slug
// tiebreak. [] when category invalid or the _details dir is absent (legacy brain).
function listCategoryEntries(brainRoot, category) {
  if (!safeCategory(category)) return [];
  return memo('cat-entries:' + brainRoot + ':' + category, () => {
    const dir = path.join(brainRoot, category, '_details');
    let files;
    try { files = fs.readdirSync(dir).filter((f) => /\.md$/.test(f)); }
    catch { return []; }                        // dir absent → legacy fallback
    const out = [];
    for (const f of files) {
      const slug = f.replace(/\.md$/, '');
      if (!safeSlug(slug)) continue;
      let parsed;
      try { parsed = parseEntryFile(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch { continue; }                       // unreadable file → skip, keep going
      out.push({ slug, frontmatter: parsed.frontmatter, body: parsed.body, sections: parsed.sections });
    }
    const rank = (e) => (String(e.frontmatter.status).toLowerCase() === 'active' ? 0 : 1);
    out.sort((a, b) =>
      rank(a) - rank(b)
      || String(b.frontmatter.since).localeCompare(String(a.frontmatter.since)) // newest first
      || a.slug.localeCompare(b.slug));         // stable tiebreak
    return out;
  });
}

// ---------- Mavis config (identity + preferences + the contract) ----------

// The brain files that define who Mavis is + how it behaves, keyed for the config view.
// 'rules' has no static entry here — it's resolved dynamically below from contractFiles(), the
// same canonical-first lookup getMavisConfig uses for content. Keeping one source of truth means
// the Rules subtitle, the displayed content, and the "Open file" button target can never disagree
// (they used to: content followed AGENTS.md while Open-file stayed hardcoded to CLAUDE.md).
const MAVIS_FILES = {
  profile: ['identity', 'profile.md'],
  personality: ['identity', 'personality.md'],
  communication: ['identity', 'communication.md'],
};
// Resolve a config key → absolute path (whitelist only; never an arbitrary path).
function mavisFilePath(brainRoot, key) {
  if (key === 'rules') {
    const contracts = contractFiles(brainRoot);
    // Fall back to the legacy CLAUDE.md path even when neither contract file currently exists on
    // disk, so the "Open file" button still resolves to something rather than silently no-op'ing.
    return contracts.length ? contracts[0].path : path.join(brainRoot, 'CLAUDE.md');
  }
  const rel = MAVIS_FILES[key];
  return rel ? path.join(brainRoot, ...rel) : null;
}

// AGENTS.md is the canonical contract; CLAUDE.md is generated from it by scripts/sync-contract.mjs.
// A legacy brain predating the split has only CLAUDE.md, which is still valid.
function contractFiles(brainRoot) {
  const out = [];
  for (const [name, flags] of [['AGENTS.md', { canonical: true }], ['CLAUDE.md', { generated: true }]]) {
    const p = path.join(brainRoot, name);
    try {
      const st = fs.statSync(p);
      out.push({ name, path: p, bytes: st.size, ...flags });
    } catch { /* absent */ }
  }
  // Only one file present means a legacy brain — it is canonical by default, not generated.
  if (out.length === 1 && out[0].name === 'CLAUDE.md') out[0] = { ...out[0], generated: false, canonical: true };
  return out;
}

function getMavisConfig(brainRoot) {
  return memo('mavis-config:' + brainRoot, () => {
    const read = (key) => { try { return fs.readFileSync(mavisFilePath(brainRoot, key), 'utf8'); } catch { return ''; } };
    // The "rules" doc is now sourced from whichever contract file is canonical (AGENTS.md when
    // present, else the legacy CLAUDE.md) rather than a hardcoded CLAUDE.md read, so the config
    // view shows the file that actually governs behaviour post-contract-layer. rulesFile travels
    // alongside so the renderer's subtitle + "Open file" label can name the same file (see
    // mavisFilePath above, which independently resolves the same canonical file for the Open
    // button — one contractFiles() lookup, never a hardcoded filename in either place).
    const contracts = contractFiles(brainRoot);
    let rules = '', rulesFile = 'CLAUDE.md';
    if (contracts.length) {
      rulesFile = contracts[0].name;
      try { rules = fs.readFileSync(contracts[0].path, 'utf8'); } catch { rules = ''; }
    } else rules = read('rules');
    return { profile: read('profile'), personality: read('personality'), communication: read('communication'), rules, rulesFile };
  });
}

// ---------- MCP servers + skills (Inventory) ----------
// Read-only, legacy-safe readers over two sources OUTSIDE the brain markdown:
//   • MCP servers — the user-level ~/.claude.json `mcpServers` map (+ the brain project's
//     own project-level mcpServers, if any). Parsing/secret-hygiene lives in brain-mcp.js;
//     here we only do the fs read + merge + memo. NEVER surfaces command/args/env.
//   • Skills      — skills/<name>/SKILL.md (H1 + first prose paragraph, no YAML frontmatter).
// Both reuse memo()/invalidate() (wired to brain-watch in main.js) and degrade to [] on any
// missing/unreadable/unparseable input — never throw.

// Merge the user-level ~/.claude.json mcpServers with the brain project's project-level
// mcpServers, dedup by name (user wins on collision). → [{ name, source }] where source is
// 'user' | 'project'. [] on a missing/unparseable ~/.claude.json. userJsonPath defaults to
// os.homedir()/.claude.json. Names only — env/args/command are never returned.
function listMcpServers(brainRoot, userJsonPath) {
  const jsonPath = userJsonPath || path.join(os.homedir(), '.claude.json');
  return memo('mcp-servers:' + jsonPath + ':' + brainRoot, () => {
    let obj;
    try { obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
    catch { return []; } // absent or unparseable ~/.claude.json → legacy-safe empty
    const out = [];
    const seen = new Set();
    for (const name of mcpServerNames(obj)) {           // user-level top-level mcpServers
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, source: 'user' });
    }
    // brain project-level mcpServers: projects["<brainRoot>"].mcpServers. The path key is
    // stored with either slash flavour (both variants exist as separate keys), so probe both.
    const projects = obj && obj.projects && typeof obj.projects === 'object' ? obj.projects : null;
    if (projects && brainRoot) {
      const variants = new Set([
        brainRoot,
        String(brainRoot).replace(/\//g, '\\'),
        String(brainRoot).replace(/\\/g, '/'),
      ]);
      for (const key of variants) {
        const entry = projects[key];
        if (!entry || typeof entry !== 'object') continue;
        for (const name of mcpServerNames(entry)) {
          if (seen.has(name)) continue;                // user-level wins on name collision
          seen.add(name);
          out.push({ name, source: 'project' });
        }
      }
    }
    return out;
  });
}

// skills/<name>/SKILL.md → [{ name, description }], sorted by name. [] when skills/ is absent;
// dirs without a readable SKILL.md are skipped (a skill mid-authoring never breaks the list).
function listSkills(brainRoot) {
  return memo('skills:' + brainRoot, () => {
    let entries;
    try { entries = fs.readdirSync(path.join(brainRoot, 'skills'), { withFileTypes: true }); }
    catch { return []; } // no skills/ dir → legacy-safe empty
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || !safeSlug(e.name)) continue;
      let md;
      try { md = fs.readFileSync(path.join(brainRoot, 'skills', e.name, 'SKILL.md'), 'utf8'); }
      catch { continue; } // dir without a readable SKILL.md → skip
      const s = parseSkillMd(md, e.name);
      out.push({ name: s.name, description: s.description });
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return out;
  });
}

// ---------- identity facets (Character tab) ----------
// Parse identity/{profile,personality,communication}.md into selectable facets for the
// journal "Character" view. Pure-string output (key/label/detail) so the renderer only ever
// touches the DOM via textContent / MT.md — no innerHTML with brain text (XSS constraint).
// Legacy-safe: any missing/unreadable identity file degrades that part to ''/[], never throws.

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// `s` → kebab slug for a stable facet key; never empty.
function identitySlug(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'facet';
}

// Suffix a slug (`-2`, `-3`, …) until it's unique within the per-array `seen` set.
function dedupeFacetKey(seen, key) {
  let k = key, n = 2;
  while (seen.has(k)) { k = key + '-' + n++; }
  seen.add(k);
  return k;
}

// `## Heading` splitter for the identity files → [{ heading, body }]. Body = every line after
// the heading until the next `#`/`##` heading or EOF, with leading/trailing blank lines trimmed
// (internal markdown kept). The `# Mavis — …` h1 only terminates/precedes sections, never opens one.
function parseIdentitySections(md) {
  if (!md || typeof md !== 'string') return [];
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    cur.body = cur.lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '').trim();
    delete cur.lines;
    out.push(cur);
  };
  for (const line of md.split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) { flush(); cur = { heading: h2[1].trim(), lines: [] }; continue; }
    if (/^#{1,2}\s/.test(line)) { flush(); cur = null; continue; } // an h1 closes the open section
    if (cur) cur.lines.push(line);
  }
  flush();
  return out;
}

// `- bullet` / `* bullet` lines of a section body → their text (markers stripped).
function identityBullets(body) {
  return String(body || '').split(/\r?\n/)
    .map((l) => { const m = l.match(/^\s*[-*]\s+(.*)$/); return m ? m[1].trim() : null; })
    .filter(Boolean);
}

// Mavis's Core invariants — curated from the contract file (NOT parsed from the identity files),
// surfaced as selectable oath facets. Constant, so it's present even on a legacy brain — which is
// exactly why the wording has to be person-NEUTRAL ("you", "the user"): these four strings render
// on a brain with zero identity files, i.e. on every fresh clone, so a name baked in here would be
// somebody else's name on every machine but one. Names shown to a user come from their own
// identity/profile.md at runtime (see `profile` below), never from a literal in this file.
const CORE_OATHS = [
  {
    key: 'approval-before-mutations',
    label: 'Approval before mutations',
    detail: 'Propose before mutating. Before any action that changes state outside the brain — a write tool, a DB write, a deploy/publish/`git push`, deleting or overwriting files — state the exact change and get explicit approval first. Reads are free; writes are gated.',
  },
  {
    key: 'never-commit-unbidden',
    label: 'Never commit unbidden',
    detail: 'Make edits, run verification, then stop. Never `git commit` or `git push` until you explicitly ask. Global rule across every project.',
  },
  {
    key: 'no-emojis',
    label: 'No emojis',
    detail: 'Zero emojis anywhere — chat, code, comments, or commits. For UI icons use inline SVG / lucide, never emoji.',
  },
  {
    key: 'paired-write',
    label: 'Paired write',
    detail: "Meaningful project work writes to **both** today's daily memory (full narrative) and the project's `progress.md` (concise checkpoint), each pointing at the other (the bidirectional rule).",
  },
];

function getIdentityFacets(brainRoot) {
  return memo('identity-facets:' + brainRoot, () => _getIdentityFacets(brainRoot));
}
function _getIdentityFacets(brainRoot) {
  const read = (key) => { try { return fs.readFileSync(mavisFilePath(brainRoot, key), 'utf8'); } catch { return ''; } };

  // profile — frontmatter-only file.
  const fm = parseFrontmatter(read('profile'));
  const profile = { name: String(fm.name || ''), pronouns: String(fm.pronouns || '') };

  // personality — document order. "Who you are" is portrait-subtitle material (skipped);
  // "Core traits" expands to one facet per bullet; every other `##` section is one facet.
  const personality = [];
  const pSeen = new Set();
  for (const sec of parseIdentitySections(read('personality'))) {
    if (/^who you are$/i.test(sec.heading)) continue;
    if (/^core traits$/i.test(sec.heading)) {
      for (const bullet of identityBullets(sec.body)) {
        const label = bullet.replace(/[.\s]+$/, '');
        if (!label) continue;
        personality.push({ key: dedupeFacetKey(pSeen, identitySlug(label)), label, detail: bullet });
      }
      continue;
    }
    personality.push({ key: dedupeFacetKey(pSeen, identitySlug(sec.heading)), label: sec.heading, detail: sec.body });
  }

  // communication — document order, one facet per `##` section. The label strips a trailing
  // reference to the user's name ("How to address Ada" → "How to address"); the key keeps the
  // ORIGINAL heading slug so it's stable across a name change.
  const communication = [];
  const cSeen = new Set();
  const nameRe = profile.name ? new RegExp('\\s+' + escapeRegExp(profile.name) + '\\s*$', 'i') : null;
  for (const sec of parseIdentitySections(read('communication'))) {
    let label = sec.heading;
    if (nameRe) label = label.replace(nameRe, '');
    label = label.replace(/[\s:]+$/, '');
    communication.push({ key: dedupeFacetKey(cSeen, identitySlug(sec.heading)), label, detail: sec.body });
  }

  return { profile, personality, communication, coreOaths: CORE_OATHS.map((o) => ({ ...o })) };
}

module.exports = {
  parseFrontmatter,
  mavisFilePath,
  contractFiles,
  getMavisConfig,
  getIdentityFacets,
  parseTasksProgress,
  parseDailyHeadlines,
  parseProgressCheckpoints,
  parseNotesEntries,
  makeSnippet,
  computeStreak,
  weekStats,
  aggregateProjectActivity,
  listProjectsWithDirs,
  getDashboardData,
  getProjectDetail,
  searchBrain,
  listDailyMemories,
  getDailyMemory,
  listTopics,
  parseTopicBody,
  parseIndexFile,
  parseEntryFile,
  readCategoryIndex,
  readEntry,
  listCategoryEntries,
  listMcpServers,
  listSkills,
  invalidate,
};
