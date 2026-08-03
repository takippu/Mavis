'use strict';

// DailyOps = a viewer + composer over the brain's own standups/ folder (the same files
// the `daily-standup` skill writes: standups/<YYYY-MM-DD>.md, a locked plain-text block
// Previous Work Day / Issues Faced / Today). The app reads that real history and can
// compose a new entry into the SAME format + folder, so it stays consistent with the
// skill and the chat-app paste template. Whitespace is preserved exactly (see a real
// file: 6-space project lines, 12-space bullets, 4-space issue lines).

const fs = require('fs');
const path = require('path');

const PROJ = '      - '; // 6 spaces
const BULLET = '            - '; // 12 spaces
const ISSUE = '    - '; // 4 spaces
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v) => (v == null ? '' : String(v));

// shape AND real calendar date — the round-trip rejects impossible dates (2026-13-45)
// and silent rollovers (2026-02-30 → 2026-03-02) before they reach a path or the header.
function validISODate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !Number.isNaN(d.getTime()) && todayISO(d) === s;
}

function standupsDir(brainRoot) { return path.join(brainRoot, 'standups'); }
function memoriesDir(brainRoot) { return path.join(brainRoot, 'daily-memories'); }

// ---- working-day awareness (off-days are configurable; default Sat+Sun) ----
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// CSV of JS getDay() indices (0=Sun … 6=Sat) → Set. Empty/garbage falls back to Sat+Sun.
function parseOffDays(offDays) {
  const set = new Set(String(offDays == null ? '6,0' : offDays)
    .split(',').map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6));
  if (!set.size) { set.add(6); set.add(0); }
  return set;
}
function offDaysLabel(offDays) {
  return Array.from(parseOffDays(offDays)).sort((a, b) => a - b).map((i) => DOW_LONG[i]).join(', ');
}
function isoDow(iso) { return new Date(iso + 'T00:00:00').getDay(); }
function isoDowName(iso) { return DOW_LONG[isoDow(iso)]; }
function addDaysISO(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return todayISO(d); }

// Most recent WORKING day strictly before `date`, skipping configured off-days. Independent of
// whether a memory file exists — it's the candidate header label (the user confirms it).
function prevWorkingDay(date, offDays) {
  const off = parseOffDays(offDays);
  let cur = addDaysISO(date, -1);
  for (let i = 0; i < 14; i++) { if (!off.has(isoDow(cur))) return cur; cur = addDaysISO(cur, -1); }
  return addDaysISO(date, -1); // all off (shouldn't happen) → literal yesterday
}

// Daily-memory files dated AFTER the last saved standup and BEFORE `date`, newest first, each tagged
// working/off. Drives "include all previous days since the last standup, highlight working days only".
// Floors at 10 days back when there's no prior standup so it never sweeps the whole history.
function memoriesSinceLastStandup(brainRoot, date, offDays) {
  const off = parseOffDays(offDays);
  const lastStandup = listStandups(brainRoot).find((s) => s.date < date);
  const floor = addDaysISO(date, -10);
  // A standup written on day D reports D-1's work (its "Previous Work Day"), so D's own work isn't
  // reported until the NEXT standup. Include the standup's own date → lower bound is (D-1), exclusive.
  const lastCovered = lastStandup ? addDaysISO(lastStandup.date, -1) : floor;
  const since = lastStandup && lastCovered > floor ? lastCovered : floor; // exclusive lower bound
  let dates = [];
  try {
    dates = fs.readdirSync(memoriesDir(brainRoot))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ''))
      .filter((d) => d > since && d < date)
      .sort().reverse();
  } catch { dates = []; }
  return dates.map((d) => ({ date: d, dow: isoDowName(d), off: off.has(isoDow(d)) }));
}

function readName(brainRoot) {
  try {
    const md = fs.readFileSync(path.join(brainRoot, 'identity', 'profile.md'), 'utf8');
    const m = md.match(/^name:\s*(.+)$/m);
    return m ? m[1].trim() : 'me';
  } catch { return 'me'; }
}

function todayISO(now) {
  const d = now || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// newest first: [{ date: 'YYYY-MM-DD', text }]
function listStandups(brainRoot) {
  try {
    const dir = standupsDir(brainRoot);
    return fs.readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .map((f) => ({ date: f.replace(/\.md$/, ''), text: fs.readFileSync(path.join(dir, f), 'utf8') }));
  } catch { return []; }
}

// the body lines of a standup's "Today" section (used to seed the next day's "Previous")
function extractTodaySection(text) {
  const lines = str(text).split(/\r?\n/);
  const i = lines.findIndex((l) => /^Today\s*$/.test(l));
  if (i < 0) return '';
  const body = lines.slice(i + 1);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.join('\n');
}

// parse a saved standup back into editable parts (for round-trip editing of today's file)
function parseStandup(text) {
  const lines = str(text).split(/\r?\n/);
  const prevIdx = lines.findIndex((l) => /^Previous Work Day\b/.test(l));
  const issIdx = lines.findIndex((l) => /^Issues Faced\b/.test(l));
  const todIdx = lines.findIndex((l) => /^Today\s*$/.test(l));

  const slice = (from, to) => {
    if (from < 0) return [];
    const out = lines.slice(from + 1, to < 0 ? undefined : to);
    while (out.length && !out[out.length - 1].trim()) out.pop();
    while (out.length && !out[0].trim()) out.shift();
    return out;
  };

  const previousBody = slice(prevIdx, issIdx >= 0 ? issIdx : todIdx).join('\n');

  const issueLines = slice(issIdx, todIdx);
  const issues = issueLines
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter((s) => s && s.toLowerCase() !== 'none')
    .join('\n');

  const todayRows = parseTodayRows(slice(todIdx, -1));
  return { previousBody, issues, todayRows };
}

function parseTodayRows(todayLines) {
  const rows = [];
  let cur = null;
  for (const raw of todayLines) {
    if (!raw.trim()) continue;
    const lead = (raw.match(/^ */) || [''])[0].length;
    const body = raw.replace(/^\s*-\s*/, '').trim();
    if (lead <= 7) {
      const m = /^(.+?)\s*:\s*(.*)$/.exec(body);
      cur = { project: m ? m[1].trim() : body, work: [] };
      if (m && m[2].trim()) cur.work.push(m[2].trim());
      rows.push(cur);
    } else if (cur) {
      cur.work.push(body);
    }
  }
  return rows.map((r) => ({ project: r.project, work: r.work.join('\n') }));
}

// the form's prefill context: name, today's date, auto "Previous Work Day", and (if
// today's standup already exists) its current contents so Generate edits rather than
// blindly clobbers.
function getContext(brainRoot, now) {
  const name = readName(brainRoot);
  const date = todayISO(now);
  const all = listStandups(brainRoot);
  const todayFile = all.find((s) => s.date === date);
  if (todayFile) {
    const p = parseStandup(todayFile.text);
    return { name, date, exists: true, previousBody: p.previousBody, issues: p.issues, todayRows: p.todayRows };
  }
  const prior = all.find((s) => s.date < date);
  return { name, date, exists: false, previousBody: prior ? extractTodaySection(prior.text) : '', issues: '', todayRows: [] };
}

function dows(date) {
  const d = new Date(date + 'T00:00:00');
  const y = new Date(d);
  y.setDate(d.getDate() - 1);
  const fmt = (x) => x.toLocaleDateString('en-US', { weekday: 'long' });
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return { ddmmyyyy: `${dd}/${mm}/${d.getFullYear()}`, dow: fmt(d), ydow: fmt(y) };
}

// {project, work} rows → locked lines (6-space project + 12-space bullets); work's
// first line is the headline, the rest are bullets. Shared by Today + agent Previous.
function rowsToLines(rows, detailed) {
  // model output can deviate: a single object instead of an array, or work as an array of
  // bullets instead of a newline string — coerce both so a usable shape never throws/collapses.
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  const out = [];
  list.forEach((row) => {
    const proj = str(row && row.project).trim();
    const rawWork = row && row.work;
    const workStr = Array.isArray(rawWork) ? rawWork.map(str).join('\n') : str(rawWork);
    const work = workStr.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!proj && !work.length) return;
    out.push(PROJ + (proj || 'General') + ' : ' + (work[0] || 'Continue'));
    // sub-bullets only in DETAILED mode; concise (default) is one headline line per project
    if (detailed) work.slice(1).forEach((b) => out.push(BULLET + b));
  });
  return out;
}

// build the locked plain-text block, whitespace-exact. Accepts either a manual
// previousBody (string) or agent `previous` (rows); issues as string or array.
function composeStandup({ name, date, previousDow, previousBody, previous, issues, todayRows, detailed }) {
  const { ddmmyyyy, dow, ydow } = dows(date);
  const lines = [];
  lines.push(`${ddmmyyyy} - ${dow} - ${name || 'me'}`);
  lines.push('');

  // header day name = the confirmed last WORKING day (off-day-aware), falling back to literal yesterday
  lines.push(`Previous Work Day - ${str(previousDow).trim() || ydow}`);
  let prevLines;
  if (Array.isArray(previous)) prevLines = rowsToLines(previous, detailed);
  else {
    prevLines = str(previousBody).split(/\r?\n/);
    while (prevLines.length && !prevLines[0].trim()) prevLines.shift();
    while (prevLines.length && !prevLines[prevLines.length - 1].trim()) prevLines.pop();
  }
  if (prevLines.length) prevLines.forEach((l) => lines.push(l));
  else lines.push(PROJ + 'None');
  lines.push('');

  lines.push('Issues Faced');
  const issArr = Array.isArray(issues)
    ? issues.map((s) => str(s).trim()).filter(Boolean)
    : str(issues).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (issArr.length) issArr.forEach((s) => lines.push(ISSUE + s));
  else lines.push(ISSUE + 'None');
  lines.push('');

  lines.push('Today');
  rowsToLines(todayRows || [], detailed).forEach((l) => lines.push(l));

  return lines.join('\n') + '\n';
}

function writeFileAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// compose-only (no write). Accepts manual {previousBody, issues, todayRows} or agent
// {previous, issues, today}. Used for the review preview before saving.
function composeFor(brainRoot, input) {
  const date = input && validISODate(str(input.date)) ? input.date : todayISO();
  return composeStandup({
    name: readName(brainRoot),
    date,
    previousDow: input && input.previousDow,
    previousBody: input && input.previousBody,
    previous: input && input.previous,
    issues: input && input.issues,
    todayRows: (input && (input.todayRows || input.today)) || [],
    detailed: !!(input && input.detailed),
  });
}

// persist to standups/<date>.md. If input.text is given it's written verbatim (the
// user-reviewed block); otherwise it's composed from the structured fields.
function saveStandup(brainRoot, input) {
  const date = input && validISODate(str(input.date)) ? input.date : todayISO();
  let text;
  if (input && typeof input.text === 'string' && input.text.trim()) {
    text = input.text.endsWith('\n') ? input.text : input.text + '\n';
  } else {
    text = composeFor(brainRoot, input);
  }
  const dir = standupsDir(brainRoot);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  writeFileAtomic(path.join(dir, date + '.md'), text);
  return { ok: true, date, text };
}

module.exports = {
  listStandups, getContext, composeStandup, composeFor, rowsToLines, saveStandup, parseStandup,
  extractTodaySection, parseTodayRows, readName, todayISO, validISODate,
  parseOffDays, offDaysLabel, isoDowName, prevWorkingDay, memoriesSinceLastStandup,
};
