// Tests for the leak guard.
//
// The guard's whole value is that it catches what actually leaked into this repo, so the cases
// below are drawn from the real incidents rather than invented: a preference dump carrying a real
// project slug, a test fixture using a real client name, a hardcoded greeting, a Windows home
// path, and a .pyc with an absolute source path in its bytecode.
//
// The second half is about false positives, which are the real failure mode. A guard that fires
// on ordinary words gets disabled, and a disabled guard protects nothing — so the tuning
// mechanisms (allow / allowpath / per-line escape / minimum length) are pinned just as hard as
// the detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveIdentifiers,
  loadPrivateConfig,
  pathAllowed,
  scanText,
  scanBinary,
  scanFile,
  looksBinary,
  isBrainRoot,
  MIN_TERM_LENGTH,
} from '../lib/leak-guard-core.mjs';

// A throwaway brain: a couple of gitignored-style project directories, an identity profile, and
// the contract files that make isBrainRoot say yes.
function makeBrain(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-leak-'));
  const w = (rel, body) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  w('AGENTS.md', '# contract\n');
  w('SETUP.md', '# setup\n');
  w('identity/profile.md', '---\nname: Takeshi\npronouns: they/them\n---\n');
  // Display name genuinely different from the slug — the shape this guards against, where a
  // directory name and the product it holds share no characters at all.
  w('projects/acmeportal/index.md', '---\nname: Northwind\nstatus: active\n---\n');
  w('projects/bluebird/index.md', '---\nname: bluebird\nstatus: active\n---\n');
  // An ordinary word that is also a slug, and a slug under the length floor.
  w('projects/team/index.md', '---\nname: team\nstatus: active\n---\n');
  w('projects/abc/index.md', '---\nname: abc\nstatus: active\n---\n');
  for (const [rel, body] of Object.entries(extra)) w(rel, body);
  return root;
}
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });

// ---- derivation ----

test('identifiers are derived from the brain, not hardcoded', () => {
  const root = makeBrain();
  try {
    const ids = deriveIdentifiers(root, { gitUserName: 'Takeshi', gitUserEmail: 'real@example.com' });
    const terms = ids.terms.map((t) => t.term.toLowerCase());
    assert.ok(terms.includes('acmeportal'), 'project slug derived');
    assert.ok(terms.includes('bluebird'), 'second project slug derived');
    assert.ok(terms.includes('takeshi'), 'name from identity/profile.md derived');
    assert.ok(terms.includes('real@example.com'), 'git email derived');
  } finally {
    rm(root);
  }
});

test('a project display name that differs from its slug is derived separately', () => {
  // A product name is often nothing like its directory name, and it is the product name that ends
  // up in a worked example. Deriving only slugs would walk straight past it.
  const root = makeBrain();
  try {
    const ids = deriveIdentifiers(root, {});
    const alias = ids.terms.find((t) => t.term === 'Northwind');
    assert.ok(alias, 'display name derived as its own term');
    assert.match(alias.source, /project name/);
    assert.ok(scanText('built on Northwind last week', ids).some((h) => h.term === 'Northwind'));
  } finally {
    rm(root);
  }
});

test('a display name that is only a CASE variant of the slug is not duplicated', () => {
  // a slug and a display name that differ only in case are the same term once cased-folded, and matching is already
  // case-insensitive — so a second entry would be noise. Detection must still work through the
  // slug, which is what actually matters.
  const root = makeBrain({ 'projects/bluebird/index.md': '---\nname: BlueBird\nstatus: active\n---\n' });
  try {
    const ids = deriveIdentifiers(root, {});
    const variants = ids.terms.filter((t) => t.term.toLowerCase() === 'bluebird');
    assert.equal(variants.length, 1, 'case variant not added as a second term');
    assert.ok(scanText("name: 'BlueBird',", ids).some((h) => h.term.toLowerCase() === 'bluebird'));
  } finally {
    rm(root);
  }
});

test('terms shorter than the minimum are skipped unless explicitly denied', () => {
  const root = makeBrain();
  try {
    const before = deriveIdentifiers(root, {});
    assert.equal(MIN_TERM_LENGTH, 4);
    assert.ok(!before.terms.some((t) => t.term === 'abc'), 'short slug skipped by default');

    fs.writeFileSync(path.join(root, '.mavis-private'), 'deny: abc\n');
    const after = deriveIdentifiers(root, {});
    assert.ok(after.terms.some((t) => t.term === 'abc'), 'an explicit deny has no length floor');
  } finally {
    rm(root);
  }
});

test('a brain with no projects/ still derives the generic identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-leak-bare-'));
  try {
    const ids = deriveIdentifiers(root, { gitUserName: 'Someone', gitUserEmail: 'x@example.com' });
    assert.ok(ids.terms.some((t) => t.term === 'x@example.com'));
    assert.doesNotThrow(() => deriveIdentifiers(root, {}));
  } finally {
    rm(root);
  }
});

// ---- detection: the real incidents ----

test('catches a project slug in a fixture (the IPJ-4 class)', () => {
  const root = makeBrain();
  try {
    const ids = deriveIdentifiers(root, {});
    const hits = scanText(`  { id: 'p1', name: 'Northwind', slug: 'NW', taskCount: 48 },`, ids);
    assert.ok(hits.some((h) => h.term === 'Northwind' && h.severity === 'block'));
    // And through the slug, whatever the casing in the offending file.
    const cased = scanText(`  { name: 'AcmePortal' },`, ids);
    assert.ok(cased.some((h) => h.term.toLowerCase() === 'acmeportal' && h.severity === 'block'));
  } finally {
    rm(root);
  }
});

test("catches a hardcoded greeting (the ', <user's name>' class)", () => {
  const root = makeBrain();
  try {
    const ids = deriveIdentifiers(root, {});
    const hits = scanText(`  return greetingWord() + ', Takeshi';`, ids);
    assert.ok(hits.some((h) => h.term === 'Takeshi' && h.severity === 'block'));
  } finally {
    rm(root);
  }
});

const NO_BRAIN = { terms: [], allow: new Set(), realUsernames: new Set() };

test('catches an email address with no brain at all', () => {
  const hits = scanText('contact: someone@realcorp.io', NO_BRAIN); // leak-guard-allow
  assert.ok(hits.some((h) => h.kind === 'email' && h.severity === 'block'));
});

test('does NOT flag addresses that cannot belong to a person', () => {
  // Reserved documentation domains (RFC 2606) and vendor no-reply addresses. The latter matters
  // specifically: `noreply@anthropic.com` and `noreply@openai.com` are the literal strings the
  // commit-msg hook exists to REJECT, so they appear in that hook, in its tests, and in the
  // contract documenting the rule. Flagging them would make the leak guard fire forever on the
  // anti-attribution machinery, and the fastest way to make someone stop reading a guard's output
  // is to have it be wrong every single time.
  for (const addr of [
    'someone@example.com',
    'a@example.org',
    'b@example.net',
    'noreply@anthropic.com',
    'noreply@openai.com',
    'no-reply@github.com',
  ]) {
    assert.deepEqual(scanText(`Co-authored-by: X <${addr}>`, NO_BRAIN), [], `${addr} must not be flagged`);
  }
});

test('a home path naming THIS user blocks; a stranger path is only advisory', () => {
  const ids = { terms: [], allow: new Set(), realUsernames: new Set(['takeshi']) };
  const mine = scanText('const p = "C:\\\\Users\\\\takeshi\\\\Documents";', ids);
  assert.ok(mine.some((h) => h.kind === 'winhome' && h.severity === 'block'), 'own home path blocks');

  const theirs = scanText('e.g. C:\\\\Users\\\\you\\\\Projects', ids);
  assert.ok(theirs.some((h) => h.kind === 'winhome' && h.severity === 'advisory'), 'generic shape is advisory');
});

test('catches a private key block and an API key', () => {
  // These two lines necessarily CONTAIN the shapes being detected -- there is no way to test a
  // secret-detector without a secret-shaped fixture. The per-line escape is exactly the right
  // tool: it is surgical, and it stays visible in review, unlike exempting the whole file.
  assert.ok(scanText('-----BEGIN RSA PRIVATE KEY-----', NO_BRAIN).some((h) => h.kind === 'privkey')); // leak-guard-allow
  assert.ok(scanText('key = "ghp_abcdefghijklmnop"', NO_BRAIN).some((h) => h.kind === 'apikey')); // leak-guard-allow
});

test('catches a path embedded in BINARY bytecode (the .pyc class)', () => {
  const root = makeBrain();
  try {
    const ids = deriveIdentifiers(root, {});
    // A .pyc-shaped buffer: NUL bytes plus an embedded absolute source path.
    const buf = Buffer.concat([
      Buffer.from([0x0d, 0x0d, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from('C:\\projects\\bluebird\\cutout.py', 'latin1'),
      Buffer.from([0x00, 0x00]),
    ]);
    assert.ok(looksBinary(buf), 'buffer detected as binary');
    const hits = scanBinary(buf, ids);
    assert.ok(hits.some((h) => h.term === 'bluebird'), 'slug found inside bytecode');
    assert.ok(hits.every((h) => h.binary === true && h.line === 0));
  } finally {
    rm(root);
  }
});

test('scanFile routes binary and text content automatically', () => {
  const root = makeBrain();
  try {
    const ids = deriveIdentifiers(root, {});
    const text = scanFile('a.js', ids, "const x = 'bluebird';");
    assert.ok(text.some((h) => h.term === 'bluebird' && !h.binary));

    const bin = scanFile('a.pyc', ids, Buffer.concat([Buffer.from([0, 0]), Buffer.from('bluebird-x')]));
    assert.ok(bin.some((h) => h.binary === true));
  } finally {
    rm(root);
  }
});

// ---- false positives: the reason guards get disabled ----

test('word boundaries stop a slug firing inside an unrelated word', () => {
  const root = makeBrain();
  try {
    const ids = deriveIdentifiers(root, {});
    assert.deepEqual(scanText('const teamwork = 1;', ids), [], 'no match mid-word');
    assert.ok(scanText('open the team app', ids).some((h) => h.term === 'team'), 'matches as a word');
    assert.ok(scanText('path/team/index.md', ids).some((h) => h.term === 'team'), 'slashes are boundaries');
    assert.ok(scanText('see team-app', ids).some((h) => h.term === 'team'), 'hyphens are boundaries');
  } finally {
    rm(root);
  }
});

test('allow: silences an ordinary word that is also a slug', () => {
  const root = makeBrain({ '.mavis-private': 'allow: team\n' });
  try {
    const ids = deriveIdentifiers(root, {});
    assert.deepEqual(scanText('team is an ordinary word', ids), [], 'allowed term produces no finding');
    assert.ok(scanText('the bluebird app', ids).length > 0, 'other terms still fire');
  } finally {
    rm(root);
  }
});

test('allowpath: exempts a whole file (LICENSE must name its holder)', () => {
  const root = makeBrain({ '.mavis-private': 'allowpath: LICENSE\nallowpath: docs/examples/\n' });
  try {
    const ids = deriveIdentifiers(root, {});
    assert.deepEqual(scanFile('LICENSE', ids, 'Copyright (c) 2026 Takeshi'), []);
    assert.deepEqual(scanFile('docs/examples/demo.md', ids, 'the bluebird project'), []);
    assert.ok(scanFile('src/app.js', ids, 'the bluebird project').length > 0, 'unexempt path still fires');
  } finally {
    rm(root);
  }
});

test('a leak-guard-allow comment exempts exactly one line', () => {
  const root = makeBrain();
  try {
    const ids = deriveIdentifiers(root, {});
    const hits = scanText(['const a = "bluebird"; // leak-guard-allow', 'const b = "bluebird";'].join('\n'), ids);
    assert.equal(hits.length, 1, 'only the unmarked line reports');
    assert.equal(hits[0].line, 2);
  } finally {
    rm(root);
  }
});

test('every finding says WHY the term is personal', () => {
  // Without this the user cannot tell a real leak from a slug collision, and the rational move
  // becomes --no-verify rather than tuning.
  const root = makeBrain();
  try {
    const ids = deriveIdentifiers(root, {});
    for (const h of scanText('bluebird and AcmePortal and Takeshi', ids)) {
      assert.ok(h.source && h.source.length > 0, `finding for "${h.term}" carries a source`);
    }
  } finally {
    rm(root);
  }
});

// ---- config + brain detection ----

test('loadPrivateConfig parses deny / allow / allowpath and ignores comments', () => {
  const root = makeBrain({
    '.mavis-private': ['# a comment', '', 'deny: acme-corp', 'allow: team', 'allowpath: LICENSE', 'garbage line'].join('\n'),
  });
  try {
    const cfg = loadPrivateConfig(root);
    assert.deepEqual(cfg.deny, ['acme-corp']);
    assert.deepEqual(cfg.allow, ['team']);
    assert.deepEqual(cfg.allowPaths, ['LICENSE']);
  } finally {
    rm(root);
  }
});

test('pathAllowed handles exact, directory and glob forms', () => {
  assert.ok(pathAllowed('LICENSE', ['LICENSE']));
  assert.ok(pathAllowed('docs/examples/a.md', ['docs/examples/']));
  assert.ok(pathAllowed('docs/examples/a.md', ['docs/']));
  assert.ok(pathAllowed('seeds/topics/_index.md', ['seeds/*']));
  assert.ok(!pathAllowed('src/app.js', ['LICENSE', 'docs/']));
  assert.ok(pathAllowed('docs\\examples\\a.md', ['docs/examples/']), 'windows separators normalize');
});

test('isBrainRoot gates the globally-installed hook to actual brains', () => {
  // The hook is wired through GLOBAL core.hooksPath, so it fires in every repo on the machine.
  // Getting this wrong would scan the user's client repos for the user's own client names.
  const brain = makeBrain();
  const notBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-leak-other-'));
  try {
    assert.equal(isBrainRoot(brain), true);
    assert.equal(isBrainRoot(notBrain), false);
    fs.writeFileSync(path.join(notBrain, 'AGENTS.md'), 'unrelated agent instructions\n');
    assert.equal(isBrainRoot(notBrain), false, 'a bare AGENTS.md is not a brain');
  } finally {
    rm(brain);
    rm(notBrain);
  }
});
