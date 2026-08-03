'use strict';

// DailyOps generator: drives an agent CLI headlessly to draft today's standup from the
// brain's daily-memories, asking the user via a strict control protocol the app renders as
// cards. Multi-turn, resuming the same headless session across turns. Read-only tools; the
// APP composes + saves the file, so the model never writes the brain. The prompt carries
// the protocol; Claude takes it on stdin (no arg-escaping), Codex takes it positionally —
// see src/harness/<id>.js. Which harness runs the standup follows the global Settings
// default (decision 5) — the caller passes it in, this module has no opinion of its own.

const { spawn } = require('child_process');
const crypto = require('crypto');
const dailyops = require('./dailyops');
const harnessRegistry = require('./harness');
const { aggregateStreamedTurn } = require('./harness/aggregate-stream');

const ddmm = (x) => `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
const dow = (x) => x.toLocaleDateString('en-US', { weekday: 'long' });

// Extract the strict control block from Claude's result text. Anchors on the LAST opening
// marker (so a stray marker in the preamble note doesn't hijack parsing) and the LAST
// <<<END>>> after it (so the literal marker appearing inside a JSON value can't truncate
// it). A present-but-unparseable block is an explicit error, not a silent 'message'.
function grab(t, tag) {
  const open = '<<<' + tag + '>>>';
  const start = t.lastIndexOf(open);
  if (start < 0) return null;
  const after = t.slice(start + open.length);
  const endIdx = after.lastIndexOf('<<<END>>>');
  if (endIdx < 0) return null;
  return after.slice(0, endIdx).trim();
}
function tryJson(s) {
  if (s == null) return undefined;
  const x = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(x); } catch { return null; }
}
function parseControl(text) {
  const t = String(text || '');
  const askRaw = grab(t, 'ASK');
  if (askRaw != null) {
    const ask = tryJson(askRaw);
    if (ask && Array.isArray(ask.questions)) return { kind: 'ask', questions: ask.questions };
    return { kind: 'error', error: 'Claude returned a malformed ASK block.' };
  }
  const doneRaw = grab(t, 'DONE');
  if (doneRaw != null) {
    const done = tryJson(doneRaw);
    if (done && typeof done === 'object') return { kind: 'done', data: done };
    return { kind: 'error', error: 'Claude returned a malformed DONE block.' };
  }
  return { kind: 'message', text: t.trim() };
}

// prose before the first control marker — Claude's short note, shown above the cards
function preamble(text) {
  const t = String(text || '');
  const i = t.indexOf('<<<');
  return (i > 0 ? t.slice(0, i) : '').trim();
}

function buildStartPrompt(brainRoot, date, offDays) {
  const d = new Date(date + 'T00:00:00');
  const name = dailyops.readName(brainRoot);
  const prevWork = dailyops.prevWorkingDay(date, offDays);       // ISO of the candidate last working day
  const prevWorkDow = dailyops.isoDowName(prevWork);
  const mems = dailyops.memoriesSinceLastStandup(brainRoot, date, offDays);
  const working = mems.filter((m) => !m.off);
  const offMems = mems.filter((m) => m.off);
  // every working-day memory since the last standup; fall back to just the candidate day if none found
  const readDays = working.length ? working : [{ date: prevWork, dow: prevWorkDow }];

  const lines = [];
  lines.push(`You are generating ${name}'s daily standup. Today is ${ddmm(d)} (${dow(d)}).`);
  lines.push(`${name}'s off-days are ${dailyops.offDaysLabel(offDays)} — work is NOT logged on those days.`);
  lines.push(`The most recent working day before today is ${ddmm(new Date(prevWork + 'T00:00:00'))} (${prevWorkDow}). ${name}'s leave is ad-hoc and NOT recorded, so you MUST confirm the real last working day in your questions.`);
  lines.push('');
  lines.push('TASK');
  lines.push('1. Read these daily-memory files (every working day since the last standup) with the Read tool — paths are relative to the current directory:');
  readDays.forEach((m) => lines.push(`   - daily-memories/${m.date}.md  (${m.dow})`));
  if (offMems.length) lines.push(`   Off-days in this span (do NOT treat as working days, skip them): ${offMems.map((m) => `${m.date} ${m.dow}`).join(', ')}.`);
  lines.push(`   Also read daily-memories/${date}.md if it exists (today's plan).`);
  lines.push('2. From the working-day memories\' "## <project> — <headline>" sections, prepare a short headline + 2-4 verb-phrase bullets per project (colleague-glance level; no file names or commit SHAs). Merge the SAME project across multiple working days into ONE entry.');
  lines.push('3. Decide what you can fill yourself vs. what you must ASK the user.');
  lines.push('');
  lines.push('OUTPUT PROTOCOL (STRICT)');
  lines.push('End your reply with EXACTLY ONE control block and NOTHING after it. Two kinds:');
  lines.push('');
  lines.push('To ask the user:');
  lines.push('<<<ASK>>>{"questions":[{"id":"<short-id>","header":"<=12 chars","label":"<question>","kind":"multiselect|select|text","options":["opt1","opt2"]}]}<<<END>>>');
  lines.push('');
  lines.push('When the standup is complete:');
  lines.push('<<<DONE>>>{"previousDow":"<Weekday of the confirmed last working day>","previous":[{"project":"<Display Name>","work":"<headline>\\n<bullet>\\n<bullet>"}],"issues":["<issue>"],"today":[{"project":"<Display Name>","work":"<headline or Continue>"}]}<<<END>>>');
  lines.push('');
  lines.push('RULES');
  lines.push('- Exactly ONE block per reply; nothing after <<<END>>>.');
  lines.push('- JSON must be VALID and on a SINGLE line. Escape newlines inside strings as \\n.');
  lines.push('- In "work", the FIRST line is the headline; each following line is a bullet.');
  lines.push(`- First turn: ASK ONE block with — (a) "Which day was your last working day?" (kind select; options = ${prevWorkDow} ${prevWork}${working.length > 1 ? ' plus the other working days you read, so ad-hoc leave can be corrected' : ''}); (b) which projects to include (kind multiselect, options = the projects you found across the working days); (c) "Any issues faced?" (kind text); (d) today's plan if today's memory is missing (kind text).`);
  lines.push('- "previousDow" in DONE = the weekday name of the day the user confirmed as their last working day.');
  lines.push('- Do NOT write any files. Do NOT print the standup as prose outside the control block.');
  return lines.join('\n');
}

function buildContinuePrompt(answers) {
  return [
    'User answers: ' + JSON.stringify(answers || {}),
    '',
    'Now produce the FINAL standup. Emit exactly one <<<DONE>>>{...}<<<END>>> block per the protocol. Include only the chosen projects in "previous" using the bullets you prepared from the working-day memories. Set "previousDow" to the weekday name of the last working day the user confirmed. "today" = one row per chosen project from my plan. If something is still genuinely missing, you may emit one more <<<ASK>>> block instead.',
  ].join('\n');
}

// in-flight children, so a timeout / app quit can reclaim the whole tree
const active = new Set();
function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill();
  } catch { /* already gone */ }
}
function cancelAll() { for (const c of active) killTree(c); active.clear(); }

// run one headless agent turn. Resolves {ok, result, sessionId} | {ok:false, error, sessionId}.
// For Codex, sessionId on the resolved value is the SERVER-assigned thread id, or null if none
// was ever announced — NEVER the caller's own uuid (see aggregate-stream.js). genStart/genContinue
// hold no state of their own between calls and rely on this return value to carry the id forward
// to the caller (who round-trips it back in on the next turn), so a leaked client uuid here
// would resurface as a bogus `exec resume <uuid>` one layer up.
function runTurn({ cwd, prompt, sessionId, resume, harnessId }, timeoutMs = 120000) {
  return new Promise((resolve) => {
    // Which harness runs the standup follows the global Settings default (decision 5).
    const adapter = harnessRegistry.get(harnessId || harnessRegistry.DEFAULT_ID);
    const binPath = adapter.resolveBin();
    if (!binPath) return resolve({ ok: false, error: adapter.label + ' not found on PATH', sessionId });
    const h = adapter.headlessArgs({ prompt, sessionId, resume, allowedTools: 'Read,Glob,Grep' });
    // headlessCommand, NOT ptyCommand: ptyCommand is the interactive-TUI arg builder and
    // unconditionally appends a --permission-mode Claude never carried headlessly pre-branch (it
    // forced plan mode, whose ExitPlanMode tool isn't in --allowedTools, so a headless turn never
    // returned a usable reply). See Finding 1, 2026-07-26 whole-branch review.
    const cmd = adapter.headlessCommand({ binPath, permissionMode: 'plan' });
    const args = cmd.args.concat(h.args);
    let child;
    try { child = spawn(cmd.file, args, { cwd, windowsHide: true }); }
    catch (e) { return resolve({ ok: false, error: e.message, sessionId }); }
    active.add(child);
    let out = '', err = '', settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      // drop the stream listeners so a killed/early-closed child stops accumulating
      try { child.stdout.removeAllListeners('data'); child.stderr.removeAllListeners('data'); if (child.stdin) child.stdin.removeAllListeners('error'); } catch { /* noop */ }
      active.delete(child);
      resolve(v);
    };
    // cmd.exe is the child; the CLI (node/rust) is a grandchild — kill the whole tree on Windows
    const killer = setTimeout(() => { killTree(child); done({ ok: false, error: 'timed out', sessionId }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => done({ ok: false, error: e.message, sessionId }));
    // stdin can emit an async EPIPE/EOF if the child closes it early — must be handled or
    // the unhandled stream 'error' tears down the whole Electron main process.
    if (child.stdin) child.stdin.on('error', (e) => done({ ok: false, error: e.message, sessionId }));
    child.on('close', (code) => {
      if (h.streaming) {
        // codex exec --json: JSONL, reduced by aggregateStreamedTurn. sid is the SERVER-assigned
        // id or null — UNCONDITIONAL, never a fallback to the `sessionId` we were called with.
        // `assigned || sessionId || null` was the 2026-07-26 bug: on a turn where Codex never
        // announced an id, our own client uuid would survive as if it were the real thread id,
        // then get resumed against next time (`exec resume <uuid codex never created>`) instead
        // of degrading to a fresh run as codex.headlessArgs intends.
        const agg = aggregateStreamedTurn(adapter, out);
        const sid = agg.sessionId || null;
        if (agg.error) return done({ ok: false, error: agg.error, sessionId: sid });
        if (code !== 0) return done({ ok: false, error: 'codex: ' + (err.trim() || 'exited ' + code), sessionId: sid });
        return done({ ok: true, result: agg.text, sessionId: sid });
      }
      // parse stdout first — claude usually emits its real reason as JSON even on a non-zero
      // exit (usage limit, auth, etc.); surfacing that beats a bare "claude exited 1".
      const ev = adapter.parseEvent(out);
      if (ev && ev.isError) return done({ ok: false, error: ev.text || 'claude error', sessionId });
      if (code !== 0) {
        const reason = (ev && ev.text) ? ev.text : (err.trim() || out.trim().slice(-300) || ('exited ' + code));
        return done({ ok: false, error: 'claude: ' + reason, sessionId });
      }
      if (!ev) return done({ ok: false, error: 'claude returned unparseable output', sessionId });
      done({ ok: true, result: ev.text, sessionId: adapter.sessionIdFrom(ev, sessionId) });
    });
    if (h.stdin != null) {
      try { child.stdin.write(h.stdin); child.stdin.end(); } catch (e) { done({ ok: false, error: e.message, sessionId }); }
    } else {
      try { child.stdin.end(); } catch { /* noop */ }
    }
  });
}

function finalize(brainRoot, date, sessionId, raw) {
  const ctl = parseControl(raw);
  if (ctl.kind === 'ask') return { kind: 'ask', sessionId, questions: ctl.questions, note: preamble(raw) };
  if (ctl.kind === 'done') {
    const input = { date, previousDow: ctl.data.previousDow, previous: ctl.data.previous, issues: ctl.data.issues, today: ctl.data.today };
    let text, textDetailed;
    // Compose BOTH: concise (one headline line per project — the default) and detailed
    // (with the sub-bullets). The review UI toggles between them without re-running Claude.
    try {
      text = dailyops.composeFor(brainRoot, Object.assign({}, input, { detailed: false }));
      textDetailed = dailyops.composeFor(brainRoot, Object.assign({}, input, { detailed: true }));
    } catch (e) { return { kind: 'error', sessionId, error: 'compose failed: ' + e.message }; }
    return { kind: 'done', sessionId, text, textDetailed };
  }
  if (ctl.kind === 'error') return { kind: 'error', sessionId, error: ctl.error };
  return { kind: 'message', sessionId, text: ctl.text };
}

async function genStart(brainRoot, date, offDays, harnessId) {
  const d = dailyops.validISODate(date) ? date : dailyops.todayISO();
  const sessionId = crypto.randomUUID();
  const turn = await runTurn({ cwd: brainRoot, prompt: buildStartPrompt(brainRoot, d, offDays), sessionId, resume: false, harnessId });
  // turn.sessionId is ALREADY the correct value per adapter (runTurn resolves it on every path —
  // Claude echoes ours via claude.sessionIdFrom, Codex is the server id or null). Do NOT fall
  // back to the local `sessionId` here: that reintroduces the exact bug fixed in runTurn one
  // layer up — this local var is OUR uuid, and resuming against it when Codex assigned none
  // produces the same bogus `exec resume <uuid>` the fix in runTurn exists to prevent.
  const sid = turn.sessionId;
  if (!turn.ok) return { kind: 'error', sessionId: sid, error: turn.error };
  return finalize(brainRoot, d, sid, turn.result);
}

async function genContinue(brainRoot, date, sessionId, answers, harnessId) {
  const d = dailyops.validISODate(date) ? date : dailyops.todayISO();
  if (!sessionId || typeof sessionId !== 'string') return { kind: 'error', error: 'no session' };
  const turn = await runTurn({ cwd: brainRoot, prompt: buildContinuePrompt(answers), sessionId, resume: true, harnessId });
  const sid = turn.sessionId; // see genStart — no fallback to the (possibly stale) local sessionId
  if (!turn.ok) return { kind: 'error', sessionId: sid, error: turn.error };
  return finalize(brainRoot, d, sid, turn.result);
}

module.exports = { genStart, genContinue, parseControl, preamble, buildStartPrompt, buildContinuePrompt, cancelAll };
