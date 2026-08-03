'use strict';

// Creates a project from the Projects view: a brain entry always (projects/<slug>/ + an _index.md
// line), and for a NEW project optionally the working folder, a local git repo, and a remote
// (GitHub / GitLab). "Add existing" only writes the brain entry pointing at a folder already on disk.
//
// The pure helpers (slugify / validateNew / planLines / indexMd / indexEntry / appendToIndex) carry
// no side effects and are unit-tested. createProject() orchestrates fs + git + remote AFTER the
// renderer has shown planLines() and the user confirmed — risky/external steps run first so a failure
// never leaves a half-written brain entry.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TYPES = ['tool', 'web-app', 'mobile-app', 'backend', 'bot', 'prospect', 'meta', 'other'];

function slugify(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function todayISO(now) {
  const d = now || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function projectDir(brainRoot, slug) { return path.join(brainRoot, 'projects', slug); }

function toTags(tags) {
  return Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean)
    : String(tags || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// A NEW or EXISTING request is valid only if the slug is free on BOTH sides of the brain.
function validateNew(brainRoot, slug) {
  if (!slug) return { ok: false, reason: 'Enter a project name.' };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return { ok: false, reason: 'Name must produce a valid slug (a-z, 0-9, hyphens).' };
  if (fs.existsSync(projectDir(brainRoot, slug))) return { ok: false, reason: `projects/${slug}/ already exists.` };
  try {
    const idx = fs.readFileSync(path.join(brainRoot, 'projects', '_index.md'), 'utf8');
    if (new RegExp(`\\]\\(${slug}/index\\.md\\)`).test(idx)) return { ok: false, reason: `"${slug}" is already listed in _index.md.` };
  } catch { /* no index yet → fine */ }
  return { ok: true };
}

// Human-readable plan for the confirm step — NO mutation. The renderer renders these verbatim.
function planLines(opts) {
  const o = opts || {};
  const slug = o.slug || slugify(o.name);
  const lines = [];
  if (o.mode === 'existing') {
    lines.push(`Link existing folder → ${o.path}`);
  } else {
    lines.push(o.createFolder ? `Create folder → ${o.path}` : `Use folder (won't create) → ${o.path}`);
    if (o.gitInit) lines.push('Initialize git: git init + .gitignore + README.md + first commit');
    if (o.remote && o.remote.provider) {
      const where = o.remote.provider === 'gitlab' ? (o.remote.baseUrl || 'https://gitlab.com') : 'github.com';
      lines.push(`Create ${o.remote.private ? 'private ' : ''}repo on ${where} + add origin + push`);
    }
  }
  lines.push(`Write brain → projects/${slug}/{index,progress,notes}.md + references/`);
  lines.push('Add an entry to projects/_index.md (Active)');
  return lines;
}

// index.md — frontmatter shape is exactly the CLAUDE.md contract (name/type/status/path/created/
// last_accessed/tags) + a heading + the description.
function indexMd({ slug, name, type, description, dirPath, tags }) {
  const today = todayISO();
  const fm = [
    '---',
    `name: ${name || slug}`,
    `type: ${type || 'tool'}`,
    'status: active',
    `path: ${dirPath || ''}`,
    `created: ${today}`,
    `last_accessed: ${today}`,
    `tags: [${toTags(tags).join(', ')}]`,
    '---',
    '',
    `# ${name || slug}`,
    '',
    (description && String(description).trim()) || '_No description yet._',
    '',
  ];
  return fm.join('\n');
}

// the one-line _index.md bullet
function indexEntry({ slug, type, description }) {
  return `- [${slug}](${slug}/index.md) — ${type || 'tool'}, active — ${(description && String(description).trim()) || 'No description yet.'}`;
}

// Surgically insert the bullet as the LAST entry of the "## Active" section, leaving everything else
// byte-stable. Falls back to creating an Active section if none exists.
function appendToIndex(indexText, entryLine) {
  const text = String(indexText || '');
  const lines = text.split(/\r?\n/);
  const actIdx = lines.findIndex((l) => /^##\s+Active\s*$/i.test(l));
  if (actIdx < 0) return text.replace(/\s*$/, '') + `\n\n## Active\n${entryLine}\n`;
  let insertAt = actIdx + 1;
  for (let i = actIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;          // hit the next section
    if (/^- \[/.test(lines[i])) insertAt = i + 1; // track the last bullet in Active
  }
  lines.splice(insertAt, 0, entryLine);
  return lines.join('\n');
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// `env` is merged over process.env for the child only — see pushEnv() for why the git credential
// travels there rather than in `args`.
function git(cwd, args, env) {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: env ? Object.assign({}, process.env, env) : process.env,
  });
}

// Redact credentials out of any string on its way to the caller.
//
// Two things make this load-bearing rather than paranoid. First, execFileSync puts the ENTIRE argv
// into Error.message, so anything we hand git shows up verbatim in a failure string. Second, the
// renderer prints pushError straight into the Projects status line ("Created - but the remote push
// failed (<...>)"), and a failed first push is the common case, not an edge case — so an unredacted
// failure string is a token on screen, in a screenshot, in a bug report.
//
// Redaction is by SHAPE, not by the one token we happen to be holding: the string may also carry a
// credential the USER put in a remote URL or a git config we never saw. The known-value pass below
// is an extra layer on top, not the mechanism.
const SECRET_PATTERNS = [
  // URL userinfo — scheme://user:pass@host and scheme://token@host. Catches any credential shape.
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@'],
  // Authorization headers, however they reached us.
  [/\b(authorization\s*:\s*)(?:basic|bearer|token)?\s*\S+/gi, '$1***'],
  // Bare credential after a scheme word. 16+ chars so ordinary prose ("basic authentication",
  // "bearer token") stays readable — no real credential is that short.
  [/\b(?:basic|bearer)\s+[A-Za-z0-9+/=_.-]{16,}/gi, '***'],
  // Credentials passed as query parameters (GitLab's ?private_token= and friends).
  [/([?&](?:access_token|private_token|api_key|token)=)[^&\s]+/gi, '$1***'],
  // Vendor token shapes, for the case where a bare token appears with no surrounding syntax.
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '***'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '***'],
  [/\bglpat-[A-Za-z0-9_-]{10,}/g, '***'],
];

function redactSecrets(text, known) {
  let s = String(text == null ? '' : text);
  // Exact-value pass first. Guarded on length so a short/empty "token" can't turn into a global
  // find-and-replace over the whole message.
  if (typeof known === 'string' && known.length >= 8) s = s.split(known).join('***');
  for (const [re, to] of SECRET_PATTERNS) s = s.replace(re, to);
  return s;
}

// Everything git needs to authenticate a one-shot push, carried in the CHILD'S ENVIRONMENT.
//
// The credential must not go in argv: argv is visible in the OS process list (Task Manager's
// command-line column, `ps`, any local process) for the lifetime of the push, so the old
// `git push https://<PAT>@github.com/...` form published the token to every process on the machine.
// Environment blocks are per-process and not world-readable on Windows or Linux, so this is a real
// improvement rather than a reshuffle.
//
// Git has read config from the environment since 2.31 (GIT_CONFIG_COUNT / _KEY_n / _VALUE_n), which
// lets us set http.extraHeader without a command line and without writing a config file to disk.
// On a git older than that the vars are ignored, the push fails on auth, and the user pushes
// manually — the same outcome the old code already produced on a rejected token.
function pushEnv(provider, token) {
  // Same credential the URL userinfo used to encode: GitHub takes the PAT as the username with an
  // empty password; GitLab wants the literal user "oauth2" with the PAT as the password. Sending
  // the full Basic header up front also skips git's 401-then-ask-a-helper round trip.
  const basic = Buffer.from(provider === 'gitlab' ? `oauth2:${token}` : `${token}:`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    // A rejected token must FAIL, not block the app on a prompt nobody can see (stdin is ignored).
    GIT_TERMINAL_PROMPT: '0',
  };
}

// Create a remote repo via the provider REST API → { httpUrl, sshUrl, htmlUrl }. Uses global fetch
// (Electron main / Node 18+). Throws with the provider's status + message on failure.
const REMOTE = {
  async github(token, { name, private: priv, description }) {
    const r = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mavis-terminal', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, private: !!priv, description: description || '' }),
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const j = await r.json();
    return { httpUrl: j.clone_url, sshUrl: j.ssh_url, htmlUrl: j.html_url };
  },
  async gitlab(token, { name, private: priv, description, baseUrl }) {
    const base = (baseUrl || 'https://gitlab.com').replace(/\/$/, '');
    const r = await fetch(`${base}/api/v4/projects`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path: name, visibility: priv ? 'private' : 'public', description: description || '' }),
    });
    if (!r.ok) throw new Error(`GitLab ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const j = await r.json();
    return { httpUrl: j.http_url_to_repo, sshUrl: j.ssh_url_to_repo, htmlUrl: j.web_url };
  },
};

async function createProject(brainRoot, opts) {
  const o = opts || {};
  const slug = o.slug || slugify(o.name);
  const v = validateNew(brainRoot, slug);
  if (!v.ok) return v;

  const did = [];
  const dirPath = String(o.path || '').trim();
  let remoteUrl = null;
  try {
    if (o.mode === 'existing') {
      if (!dirPath || !fs.existsSync(dirPath)) return { ok: false, reason: 'Pick an existing folder that exists on disk.' };
    } else {
      if (!dirPath) return { ok: false, reason: 'Enter or pick a folder path.' };
      if (o.createFolder) { fs.mkdirSync(dirPath, { recursive: true }); did.push('folder'); }
      else if (!fs.existsSync(dirPath)) return { ok: false, reason: `Folder does not exist: ${dirPath} (tick "Create the folder").` };

      if (o.gitInit && !fs.existsSync(path.join(dirPath, '.git'))) {
        git(dirPath, ['init']);
        try { git(dirPath, ['branch', '-M', 'main']); } catch { /* older git / no commit yet */ }
        const gi = path.join(dirPath, '.gitignore');
        if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'node_modules/\n.env\n.env.local\ndist/\nbuild/\n.DS_Store\n');
        const rd = path.join(dirPath, 'README.md');
        if (!fs.existsSync(rd)) fs.writeFileSync(rd, `# ${o.name || slug}\n\n${(o.description || '').trim()}\n`);
        git(dirPath, ['add', '-A']);
        try { git(dirPath, ['commit', '-m', 'Initial commit']); } catch { /* user.name/email unset → repo still created */ }
        did.push('git');
      }

      if (o.remote && o.remote.provider && o.remote.token) {
        const mk = REMOTE[o.remote.provider];
        if (!mk) return { ok: false, reason: `Unknown provider: ${o.remote.provider}`, partial: did };
        const created = await mk(o.remote.token, { name: o.remote.name || slug, private: o.remote.private, description: o.description, baseUrl: o.remote.baseUrl });
        remoteUrl = created.htmlUrl;
        did.push('remote');
        try { git(dirPath, ['remote', 'remove', 'origin']); } catch { /* none */ }
        git(dirPath, ['remote', 'add', 'origin', created.httpUrl]); // clean URL, no token persisted
        try {
          // Push to the clean URL with the credential in the env (pushEnv). `-c credential.helper=`
          // clears any configured helper for this one command so a rejected token can't hand off to
          // Git Credential Manager and pop a window the user never asked for; it carries no secret,
          // so it is safe on the command line.
          git(dirPath, ['-c', 'credential.helper=', 'push', created.httpUrl, 'HEAD:main'], pushEnv(o.remote.provider, o.remote.token));
          try { git(dirPath, ['branch', '--set-upstream-to=origin/main', 'main']); } catch { /* best-effort */ }
          did.push('push');
        } catch (e) {
          // repo + origin exist; only the push failed (auth/keys). Brain entry still gets written.
          // Redact BEFORE slicing: the renderer prints this verbatim, and a 200-char window is wide
          // enough to hold a whole PAT if one ever survives into the message.
          o._pushError = redactSecrets(String(e.message || e), o.remote.token).slice(0, 200);
        }
      }
    }

    // ---- brain scaffold (only after the disk side succeeded) ----
    const pdir = projectDir(brainRoot, slug);
    fs.mkdirSync(path.join(pdir, 'references'), { recursive: true });
    writeAtomic(path.join(pdir, 'index.md'), indexMd({ slug, name: o.name, type: o.type, description: o.description, dirPath, tags: o.tags }));
    writeAtomic(path.join(pdir, 'progress.md'), `# ${o.name || slug} — Progress\n`);
    writeAtomic(path.join(pdir, 'notes.md'), `# ${o.name || slug} — Notes\n`);
    did.push('brain');

    const idxPath = path.join(brainRoot, 'projects', '_index.md');
    let idxText = '';
    try { idxText = fs.readFileSync(idxPath, 'utf8'); } catch { idxText = '# Projects\n\n## Active\n'; }
    writeAtomic(idxPath, appendToIndex(idxText, indexEntry({ slug, type: o.type, description: o.description })));
    did.push('index');

    return { ok: true, slug, path: dirPath, did, htmlUrl: remoteUrl, pushError: o._pushError || null };
  } catch (e) {
    // Same reasoning as _pushError: this reason is rendered to the user, and any git step in the
    // try block above can surface an argv or a remote URL in its message.
    return { ok: false, reason: redactSecrets(String(e.message || e), o.remote && o.remote.token), partial: did };
  }
}

module.exports = {
  TYPES, slugify, todayISO, projectDir, validateNew, planLines, indexMd, indexEntry, appendToIndex, createProject,
  redactSecrets,
};
