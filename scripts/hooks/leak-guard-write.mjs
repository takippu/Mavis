#!/usr/bin/env node
// Claude Code PostToolUse hook: catch personal content the moment it is written, not at commit.
//
// WHY WRITE-TIME AND NOT JUST PRE-COMMIT
// --------------------------------------
// Most of what leaked into this repo was not typed by its owner. It was written by an AI
// assistant that had the real brain loaded and reached for the nearest concrete example: a real
// client's production board as a test fixture, a real launch as a worked example in a skill, the
// owner's own name hardcoded into a dashboard greeting. A pre-commit hook does catch that, but
// only after it is written, staged, and shown in a diff the user may not read closely.
//
// This hook closes the gap. It runs immediately after every Write and Edit, and when it finds
// something it returns `decision: "block"` with a reason, which Claude Code feeds straight back
// into the model's context. The assistant sees the finding in the same turn it created it, while
// fixing it is still a one-line edit.
//
// It is deliberately mechanical. The repository already states a no-AI-attribution rule in three
// separate files and still accumulated 17 commits carrying attribution trailers, because a rule
// held in context loses to a default re-injected every turn. A hook executed by the harness
// cannot be summarised away, forgotten after a compaction, or reasoned around.
//
// Input (stdin JSON): { tool_name, tool_input: { file_path, ... }, tool_response: { filePath } }
// Output (stdout JSON): a hook result, or nothing at all when the file is clean.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveIdentifiers, scanFile, isBrainRoot } from '../lib/leak-guard-core.mjs';

// scripts/hooks/ -> scripts/ -> brain root
const brainRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// Never let the guard break the user's session. Any unexpected failure exits 0 silently: a
// write-time advisory is a safety net, and a safety net that can halt the work it protects gets
// removed. The pre-commit hook is the layer that is allowed to say no.
function bail() {
  process.exit(0);
}

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch {
  bail();
}

let payload;
try {
  payload = JSON.parse(raw || '{}');
} catch {
  bail();
}

const filePath = payload?.tool_response?.filePath || payload?.tool_input?.file_path;
if (!filePath) bail();

const abs = path.isAbsolute(filePath) ? filePath : path.resolve(brainRoot, filePath);

// Only files inside THIS brain are in scope. Claude Code sessions routinely edit other
// repositories, and scanning a client repo for that client's own name would fire constantly on
// the one place it legitimately belongs.
const rel = path.relative(brainRoot, abs);
if (rel.startsWith('..') || path.isAbsolute(rel)) bail();
if (!isBrainRoot(brainRoot)) bail();

const relPosix = rel.split(path.sep).join('/');

// A gitignored file cannot reach the public repo -- that is the entire point of the brain living
// in ignored directories. Writing personal content there is correct behaviour, not a leak, and
// flagging it would make the guard fire on almost every memory write.
try {
  execFileSync('git', ['check-ignore', '-q', relPosix], { cwd: brainRoot, stdio: 'ignore' });
  bail(); // exit 0 == ignored == nothing to do
} catch {
  // non-zero from check-ignore means NOT ignored, so the file is tracked or trackable. Continue.
}

if (!fs.existsSync(abs)) bail();

let identifiers;
try {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: brainRoot, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  identifiers = deriveIdentifiers(brainRoot, {
    gitUserName: git(['config', 'user.name']),
    gitUserEmail: git(['config', 'user.email']),
  });
} catch {
  bail();
}

let findings = [];
try {
  findings = scanFile(relPosix, identifiers, fs.readFileSync(abs)).filter((f) => f.severity === 'block');
} catch {
  bail();
}

if (findings.length === 0) bail();

// Deduplicate by term so a slug repeated 30 times in a fixture reports once, with a count.
const byTerm = new Map();
for (const f of findings) {
  if (!byTerm.has(f.term)) byTerm.set(f.term, { ...f, count: 0, lines: [] });
  const e = byTerm.get(f.term);
  e.count += 1;
  if (e.lines.length < 5 && f.line) e.lines.push(f.line);
}

const detail = [...byTerm.values()]
  .map((f) => {
    const where = f.binary ? '(binary)' : `line${f.lines.length > 1 ? 's' : ''} ${f.lines.join(', ')}`;
    const more = f.count > f.lines.length ? ` and ${f.count - f.lines.length} more` : '';
    return `  - "${f.term}" [${f.source}] at ${where}${more}`;
  })
  .join('\n');

const reason = `Leak guard: you just wrote personal or client-identifying content into ${relPosix}, which is NOT gitignored and would be published.

${detail}

These terms were derived from this user's own private brain (project directories, identity/profile.md, git config) -- they are not generic keywords. Replace them with synthetic examples now, in this same turn:
  - project or client names -> obviously fake ones (acme-portal, bluebird, northwind)
  - real ticket IDs -> TICKET-1 / PROJ-42
  - the user's name in shipped UI -> read it from identity/profile.md at runtime instead of hardcoding
  - absolute machine paths -> os.tmpdir() in tests, or a neutral placeholder in prose
  - real domains -> example.com

If the term genuinely belongs here, say so rather than silently leaving it: it can be exempted with "allow:" or "allowpath:" in .mavis-private, or a "leak-guard-allow" comment on that single line.`;

process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason,
    systemMessage: `Leak guard: ${byTerm.size} personal identifier(s) written into ${relPosix}`,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reason },
  })
);
process.exit(0);
