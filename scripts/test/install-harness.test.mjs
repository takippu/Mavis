import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  spliceMarkers,
  detectHarnesses,
  isDuplicateContract,
  resolvePlaceholders,
  stripMarkerBlock,
  targetsFor,
  BEGIN,
  END,
} from '../lib/install-harness-core.mjs';

test('appends a marker block to a file that has none', () => {
  const out = spliceMarkers('pre-existing user content\n', 'PAYLOAD');
  assert.ok(out.includes('pre-existing user content'));
  assert.ok(out.includes(BEGIN));
  assert.ok(out.includes('PAYLOAD'));
  assert.ok(out.includes(END));
});

test('replaces only the block, preserving content on both sides', () => {
  const existing = `before\n${BEGIN}\nOLD\n${END}\nafter\n`;
  const out = spliceMarkers(existing, 'NEW');
  assert.ok(out.includes('before'));
  assert.ok(out.includes('after'));
  assert.ok(out.includes('NEW'));
  assert.ok(!out.includes('OLD'));
});

test('is idempotent', () => {
  const once = spliceMarkers('x\n', 'P');
  assert.equal(spliceMarkers(once, 'P'), once);
});

test('handles an empty target file', () => {
  const out = spliceMarkers('', 'P');
  assert.ok(out.includes('P'));
});

test('throws on an unclosed existing marker rather than duplicating the block', () => {
  assert.throws(() => spliceMarkers(`a\n${BEGIN}\nb\n`, 'P'), /unclosed|malformed/i);
});

test('detectHarnesses reports both absent when neither resolves', () => {
  const d = detectHarnesses({ probe: () => null });
  assert.deepEqual(d, { claude: false, codex: false });
});

test('detectHarnesses reports what the probe finds', () => {
  const d = detectHarnesses({ probe: (bin) => (bin === 'codex' ? 'C:/x/codex.cmd' : null) });
  assert.equal(d.codex, true);
  assert.equal(d.claude, false);
});

// --- duplicate-contract guard ------------------------------------------------------------

const CONTRACT = [
  '# Standing invariants (Ada)',
  '',
  'body text',
  '',
  '## Attribution: never claim co-authorship',
  '',
  'more body',
  '',
  '## No emojis anywhere',
  '',
  'even more body',
  '',
].join('\n');

test('stripMarkerBlock returns only the content outside the block', () => {
  const s = stripMarkerBlock(`above\n${BEGIN}\ninside\n${END}\nbelow\n`);
  assert.ok(s.includes('above'));
  assert.ok(s.includes('below'));
  assert.ok(!s.includes('inside'));
});

test('isDuplicateContract refuses a file that already holds the contract unmarked', () => {
  const d = isDuplicateContract(CONTRACT, CONTRACT);
  assert.equal(d.duplicate, true);
  assert.ok(d.headings.includes('# Standing invariants (Ada)'));
});

test('isDuplicateContract ignores a copy that lives inside the marker block', () => {
  // The installer owns the block and replaces it in place, so it can never duplicate.
  const existing = `notes\n${BEGIN}\n${CONTRACT}\n${END}\n`;
  assert.equal(isDuplicateContract(existing, CONTRACT).duplicate, false);
});

test('isDuplicateContract allows an unrelated file', () => {
  assert.equal(isDuplicateContract('# My notes\n\nnothing to do with it\n', CONTRACT).duplicate, false);
});

test('isDuplicateContract tolerates one incidental heading collision', () => {
  const existing = '# Someone else notes\n\n## No emojis anywhere\n\nmy own rule\n';
  assert.equal(isDuplicateContract(existing, CONTRACT).duplicate, false);
});

test('a payload that documents its own markers still round-trips to one block', () => {
  // Regression: the real global-invariants.md explains the markers in prose, so the written
  // block contains the literal strings. indexOf(END) closed on the payload's own text and
  // corrupted the file on re-install; the outermost pair is the real one.
  const payload = `title\nanything between ${BEGIN} and ${END} is overwritten\ntail`;
  const once = spliceMarkers('user notes\n', payload);
  const twice = spliceMarkers(once, payload);
  assert.equal(twice, once);
  assert.ok(once.includes('user notes'));
  assert.ok(once.trimEnd().endsWith(END));
  const lines = once.split('\n').map(l => l.trim());
  assert.equal(lines.filter(l => l === BEGIN).length, 1);
  assert.equal(lines.filter(l => l === END).length, 1);
});

test('isDuplicateContract refuses on two shared headings even without the title', () => {
  const existing = [
    '# Someone else notes',
    '',
    '## No emojis anywhere',
    '',
    '## Attribution: never claim co-authorship',
    '',
  ].join('\n');
  const d = isDuplicateContract(existing, CONTRACT);
  assert.equal(d.duplicate, true);
  assert.equal(d.headings.length, 2);
});

// --- markers are LINE-ANCHORED ---------------------------------------------------------------
// Substring matching for the markers destroyed user content. These are the reproductions.
// The rule: a marker is a line whose trimmed content is exactly the marker string. Anything
// else is ordinary content and can never act as a delimiter.

test('a marker mentioned in prose ABOVE the block is not a delimiter', () => {
  // Reproduction. indexOf(BEGIN) landed on the prose mention and slice(0, i) truncated there,
  // so everything from the mention to the end of the real block was deleted. The trigger is
  // live: the installer's own REFUSED message tells the user to type these exact strings into
  // this exact file by hand.
  const existing = [
    'my notes mention ' + BEGIN + ' inline',
    'KEEP THIS PARAGRAPH',
    '',
    BEGIN,
    'OLD BLOCK BODY',
    END,
    'tail',
    '',
  ].join('\n');
  const out = spliceMarkers(existing, 'NEW');
  assert.ok(out.includes('KEEP THIS PARAGRAPH'), 'user content above the block was deleted');
  assert.ok(out.includes('my notes mention'), 'the prose line itself was deleted');
  assert.ok(out.includes('tail'));
  assert.ok(out.includes('NEW'));
  assert.ok(!out.includes('OLD BLOCK BODY'));
  // Still exactly one real block; the inline mention is not counted as one.
  assert.equal(count(out, BEGIN), 1);
  assert.equal(count(out, END), 1);
});

test('a marker mentioned in prose BELOW the block is not a delimiter', () => {
  const existing = [
    BEGIN,
    'OLD BLOCK BODY',
    END,
    'KEEP THIS PARAGRAPH',
    'see the ' + END + ' marker for details',
    '',
  ].join('\n');
  const out = spliceMarkers(existing, 'NEW');
  assert.ok(out.includes('KEEP THIS PARAGRAPH'), 'user content below the block was deleted');
  assert.ok(out.includes('for details'));
  assert.ok(!out.includes('OLD BLOCK BODY'));
  assert.equal(count(out, BEGIN), 1);
});

test('two marker blocks throw rather than collapsing into one', () => {
  // Reproduction. indexOf(BEGIN) took the first opener and lastIndexOf(END) the second closer,
  // so the whole span became one block and everything between the two was deleted.
  const existing = [BEGIN, 'one', END, 'MIDDLE CONTENT', BEGIN, 'two', END, ''].join('\n');
  assert.throws(() => spliceMarkers(existing, 'NEW'), /malformed/i);
  assert.throws(() => spliceMarkers(existing, 'NEW'), /2 .*begin.* lines/i);
  // And the input is untouched - a pure function cannot lose what it never returns, but this
  // pins the property the caller depends on: no output means no write means no deletion.
  assert.ok(existing.includes('MIDDLE CONTENT'));
});

test('two end markers throw', () => {
  const existing = [BEGIN, 'body', END, 'user text', END, ''].join('\n');
  assert.throws(() => spliceMarkers(existing, 'NEW'), /2 .*end.* lines/i);
});

test('an end marker before a begin marker throws', () => {
  const existing = [END, 'user text', BEGIN, 'body', ''].join('\n');
  assert.throws(() => spliceMarkers(existing, 'NEW'), /malformed/i);
  assert.throws(() => spliceMarkers(existing, 'NEW'), /comes before/i);
});

test('a lone end marker with no begin throws instead of appending', () => {
  assert.throws(() => spliceMarkers(`notes\n${END}\n`, 'NEW'), /unclosed|malformed/i);
});

test('an indented marker line is still a marker', () => {
  // Trimmed comparison: markers inside a list item or a blockquote-free indent still delimit.
  const existing = `before\n   ${BEGIN}\nOLD\n\t${END}\nafter\n`;
  const out = spliceMarkers(existing, 'NEW');
  assert.ok(out.includes('before'));
  assert.ok(out.includes('after'));
  assert.ok(out.includes('NEW'));
  assert.ok(!out.includes('OLD'));
  assert.equal(count(out, BEGIN), 1);
});

test('a payload carrying a whole-line marker is refused', () => {
  // Writing it would produce a file with two BEGIN lines that only the next run could refuse.
  assert.throws(() => spliceMarkers('notes\n', `title\n${BEGIN}\nbody`), /malformed payload/i);
});

test('stripMarkerBlock is line-anchored, so a quoted marker cannot hide an unmarked copy', () => {
  // The same flaw gave isDuplicateContract a FALSE NEGATIVE: lastIndexOf(END) landed on a
  // quoted marker below the block and stripped the unmarked contract copy away with it, after
  // which the guard reported the file clean and the installer appended a second contract.
  // The unmarked copy has to sit BETWEEN the block and the quoted marker for the old
  // lastIndexOf to swallow it - which is exactly the layout an append-then-hand-edit produces.
  const existing = [
    'my notes',
    BEGIN,
    'installed block',
    END,
    '',
    '# Standing invariants (Ada)',
    '',
    '## No emojis anywhere',
    '',
    'and we quote the ' + END + ' marker down here',
    '',
  ].join('\n');
  const outside = stripMarkerBlock(existing);
  assert.ok(outside.includes('# Standing invariants (Ada)'), 'the unmarked copy was stripped');
  assert.ok(outside.includes('## No emojis anywhere'));
  assert.ok(!outside.includes('installed block'));
  assert.equal(isDuplicateContract(existing, CONTRACT).duplicate, true);
});

test('stripMarkerBlock returns the whole text when the markers are ambiguous', () => {
  // Conservative direction for a guard: seeing MORE text can only cause a refusal, never a
  // silent write. (The CLI splices first, so an ambiguous file has already errored by here.)
  const two = [BEGIN, 'a', END, '# Standing invariants (Ada)', BEGIN, 'b', END, ''].join('\n');
  assert.ok(stripMarkerBlock(two).includes('# Standing invariants (Ada)'));
});

// --- placeholder resolution ----------------------------------------------------------------

test('resolvePlaceholders substitutes every known key', () => {
  const out = resolvePlaceholders(
    '# Standing invariants ({{USER_NAME}})\nhook: {{BRAIN_ROOT}}/scripts/git-hooks/commit-msg\n',
    { USER_NAME: 'Ada', BRAIN_ROOT: 'D:/brains/mavis' }
  );
  assert.equal(out, '# Standing invariants (Ada)\nhook: D:/brains/mavis/scripts/git-hooks/commit-msg\n');
  assert.ok(!out.includes('{{'));
});

test('resolvePlaceholders throws when a value is missing rather than passing it through', () => {
  assert.throws(
    () => resolvePlaceholders('hi {{USER_NAME}}', { BRAIN_ROOT: '/b' }),
    /unresolved placeholder\(s\): \{\{USER_NAME\}\}/
  );
});

test('resolvePlaceholders treats an empty or blank value as missing', () => {
  assert.throws(() => resolvePlaceholders('hi {{USER_NAME}}', { USER_NAME: '' }), /USER_NAME/);
  assert.throws(() => resolvePlaceholders('hi {{USER_NAME}}', { USER_NAME: '   ' }), /USER_NAME/);
});

test('resolvePlaceholders throws on a placeholder nobody supplies', () => {
  assert.throws(
    () => resolvePlaceholders('{{MACHINE_ID}}', { USER_NAME: 'Ada' }),
    /MACHINE_ID/
  );
});

test('resolvePlaceholders catches a brace-shaped typo the key regex would skip', () => {
  assert.throws(() => resolvePlaceholders('{{ USER-NAME }}', { USER_NAME: 'Ada' }), /unresolved/);
});

test('resolvePlaceholders throws on unbalanced braces', () => {
  // Both earlier sweeps need a BALANCED pair, so a half-open placeholder - one mistyped brace
  // while editing mavis/global-invariants.md, the exact workflow --help advertises - passed
  // through and would have landed verbatim in the user's live operating contract.
  assert.throws(
    () => resolvePlaceholders('hi {{USER_NAME} and }} there', { USER_NAME: 'Ada' }),
    /unbalanced braces/i
  );
  assert.throws(() => resolvePlaceholders('a {{USER_NAME}', { USER_NAME: 'Ada' }), /unbalanced/i);
  assert.throws(() => resolvePlaceholders('a USER_NAME}}', { USER_NAME: 'Ada' }), /unbalanced/i);
  // A single brace is ordinary prose and must still pass.
  assert.equal(resolvePlaceholders('a {literal} brace', {}), 'a {literal} brace');
  // And the nested-brace form that already worked keeps working.
  assert.equal(resolvePlaceholders('{{{USER_NAME}}}', { USER_NAME: 'Ada' }), '{Ada}');
});

test('resolvePlaceholders is idempotent', () => {
  const values = { USER_NAME: 'Ada', BRAIN_ROOT: 'D:/b' };
  const once = resolvePlaceholders(RAW_INVARIANTS, values);
  assert.equal(resolvePlaceholders(once, values), once);
});

test('the committed payload is portable: placeholders, no name, no machine path', () => {
  assert.ok(RAW_INVARIANTS.includes('{{USER_NAME}}'));
  assert.ok(RAW_INVARIANTS.includes('{{BRAIN_ROOT}}'));
  // No absolute user path of any shape (C:/Users/x, C:\Users\x, /home/x, /Users/x).
  assert.equal(/[A-Za-z]:[\\/]Users[\\/]/.test(RAW_INVARIANTS), false, 'windows user path in payload');
  assert.equal(/(^|\s)\/(home|Users)\//.test(RAW_INVARIANTS), false, 'unix user path in payload');
  // And it resolves cleanly for an arbitrary user, which is the whole point.
  const out = resolvePlaceholders(RAW_INVARIANTS, { USER_NAME: 'Ada', BRAIN_ROOT: '/srv/brain' });
  assert.ok(out.includes('# Standing invariants (Ada)'));
  assert.ok(out.includes('/srv/brain/scripts/git-hooks/commit-msg'));
  assert.ok(!out.includes('{{'));
});

test('the committed /mavis prompt is portable too, and resolves to real absolute paths', () => {
  assert.ok(RAW_SLASH.includes('{{BRAIN_ROOT}}'));
  assert.ok(RAW_SLASH.includes('{{USER_NAME}}'));
  assert.equal(/[A-Za-z]:[\\/]Users[\\/]/.test(RAW_SLASH), false, 'windows user path in prompt');
  assert.equal(/(^|\s)\/(home|Users)\//.test(RAW_SLASH), false, 'unix user path in prompt');

  // /mavis exists to tell an agent to resolve brain paths ABSOLUTELY. A wrong or unresolved
  // root silently points the whole session at the wrong brain, so check the shape of what
  // comes out, not just that substitution happened.
  const out = resolvePlaceholders(RAW_SLASH, { USER_NAME: 'Ada', BRAIN_ROOT: 'D:/brains/mavis' });
  assert.ok(!out.includes('{{'));
  assert.ok(!out.includes('}}'));
  assert.ok(out.includes('`D:/brains/mavis/CLAUDE.md`'));
  assert.ok(out.includes('D:/brains/mavis/identity/profile.md'));
  assert.ok(out.includes("Ada's persistent project collaborator"));
  // Every brain path in the rendered prompt is absolute (drive letter or leading slash).
  const roots = out.match(/[^`\s]*\/(CLAUDE\.md|identity|daily-memories|projects|topic_index\.md)/g) || [];
  assert.ok(roots.length >= 5, `expected several brain paths, found ${roots.length}`);
  for (const r of roots) {
    assert.ok(/^([A-Za-z]:\/|\/)/.test(r), `not an absolute brain path: ${r}`);
  }
});

// --- output style: portability + the Claude-only target -------------------------------------

test('the committed output style is portable and carries no machine path', () => {
  assert.equal(/[A-Za-z]:[\\/]Users[\\/]/.test(RAW_STYLE), false, 'windows user path in style');
  assert.equal(/(^|\s)\/(home|Users)\//.test(RAW_STYLE), false, 'unix user path in style');
  const out = resolvePlaceholders(RAW_STYLE, { USER_NAME: 'Ada', BRAIN_ROOT: 'D:/brains/mavis' });
  assert.ok(!out.includes('{{'));
  assert.ok(!out.includes('}}'));
  assert.ok(out.includes('D:/brains/mavis/mavis/output-style-terse.md'));
  // The frontmatter name is what settings.json's "outputStyle" key must match. If this
  // drifts, the style installs fine and is silently never selected.
  assert.ok(/^---\r?\n(.*\r?\n)*?name: mavis-terse\r?$/m.test(RAW_STYLE), 'frontmatter name');
});

test('the output style governs length only and does not restate compaction-proof invariants', () => {
  // global-invariants.md already carries the no-emoji rule into ~/.claude/CLAUDE.md, which
  // survives compaction. Restating it here would be a third copy with nothing keeping them
  // in sync - the exact drift the brain's two-tier rule exists to prevent.
  assert.equal(/emoji/i.test(RAW_STYLE), false, 'no-emoji rule duplicated from global-invariants');
  // And the depth carve-out MUST survive, or a compacted session runs compress-only.
  assert.ok(/Depth overrides brevity/.test(RAW_STYLE));
});

test('targetsFor adds the output style to claude, and never to codex', () => {
  const homes = { claudeHome: '/h/.claude', codexHome: '/h/.codex', invariants: 'i', slash: 's', outputStyle: 'o' };
  const claude = targetsFor('claude', homes);
  const styles = claude.filter(t => t.label.includes('output-styles'));
  assert.equal(styles.length, 1);
  assert.equal(styles[0].kind, 'prompt');
  assert.equal(styles[0].mode, 'whole');
  assert.equal(styles[0].path, '/h/.claude/output-styles/mavis-terse.md');
  assert.equal(styles[0].payload, 'o');
  // Codex has no output-style concept; a target there would write a file nothing reads.
  assert.equal(targetsFor('codex', homes).some(t => t.label.includes('output-styles')), false);
});

test('targetsFor omits the output style entirely when the payload is empty', () => {
  // Not a cosmetic guard: a zero-byte style file loads as a valid-but-empty instruction,
  // so the style would read as installed and enabled while saying nothing at all.
  const homes = { claudeHome: '/h/.claude', codexHome: '/h/.codex', invariants: 'i', slash: 's' };
  const claude = targetsFor('claude', homes);
  assert.equal(claude.length, 2);
  assert.equal(claude.some(t => t.label.includes('output-styles')), false);
  assert.equal(targetsFor('claude', { ...homes, outputStyle: '' }).length, 2);
});

// --- write path, end to end, against temp homes only ---------------------------------------
// The dry-run path proved the CONTENT was right; nothing had ever proved the WRITE mechanics.
// These drive the real CLI as a subprocess with CLAUDE_CONFIG_DIR / CODEX_HOME pointed at
// mkdtemp directories, so --yes is exercised without ever touching the user's live config.

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'install-harness.mjs');
const ROOT = path.resolve(here, '..', '..');
// The committed sources, placeholders intact. Every write test installs from a COPY of these
// in a temp brain root with a fixture identity, so the suite never depends on the gitignored
// identity/ dir existing and never installs the real user's name into a fixture.
const RAW_INVARIANTS = fs.readFileSync(path.join(ROOT, 'mavis', 'global-invariants.md'), 'utf8')
  .replace(/\r\n?/g, '\n');
const RAW_SLASH = fs.readFileSync(path.join(ROOT, 'mavis', 'slash-mavis.md'), 'utf8')
  .replace(/\r\n?/g, '\n');
const RAW_STYLE = fs.readFileSync(path.join(ROOT, 'mavis', 'output-style-terse.md'), 'utf8')
  .replace(/\r\n?/g, '\n');
const FIXTURE_NAME = 'Fixture Person';
const toPosix = (p) => p.split(path.sep).join('/');
// All committed sources carry placeholders now, so the expected on-disk bytes are the
// RESOLVED text, never the raw file.
const expectedSlash = (homes) => resolvePlaceholders(RAW_SLASH, homes.values);
const expectedInvariants = (homes) => resolvePlaceholders(RAW_INVARIANTS, homes.values);
const expectedStyle = (homes) => resolvePlaceholders(RAW_STYLE, homes.values);

// Tripwire: the real homes, snapshotted before any subprocess runs, asserted unchanged at the
// end. If an env override ever stops being honoured, this is what catches it.
const REAL_TARGETS = [
  path.join(os.homedir(), '.claude', 'CLAUDE.md'),
  path.join(os.homedir(), '.claude', 'commands', 'mavis.md'),
  path.join(os.homedir(), '.claude', 'output-styles', 'mavis-terse.md'),
  path.join(os.homedir(), '.codex', 'AGENTS.md'),
  path.join(os.homedir(), '.codex', 'prompts', 'mavis.md'),
  path.join(os.homedir(), '.codex', 'config.toml'),
];

function snapshotReal() {
  return REAL_TARGETS.map(p => {
    try {
      const st = fs.statSync(p);
      return `${p} size=${st.size} mtimeMs=${st.mtimeMs}`;
    } catch {
      return `${p} ABSENT`;
    }
  });
}

const REAL_BEFORE = snapshotReal();

// opts.profile: frontmatter text for identity/profile.md, or null to omit the file entirely.
// opts.invariants: override the payload. Default is the real committed one, placeholders and
// all, so these tests exercise the file that actually ships.
function tempHomes(label, t, opts = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mavis-install-${label}-`)));
  const brain = path.join(dir, 'brain');
  fs.mkdirSync(path.join(brain, 'mavis'), { recursive: true });
  fs.writeFileSync(path.join(brain, 'mavis', 'global-invariants.md'),
    opts.invariants === undefined ? RAW_INVARIANTS : opts.invariants, 'utf8');
  fs.writeFileSync(path.join(brain, 'mavis', 'slash-mavis.md'),
    opts.slash === undefined ? RAW_SLASH : opts.slash, 'utf8');
  fs.writeFileSync(path.join(brain, 'mavis', 'output-style-terse.md'),
    opts.outputStyle === undefined ? RAW_STYLE : opts.outputStyle, 'utf8');
  if (opts.profile !== null) {
    fs.mkdirSync(path.join(brain, 'identity'), { recursive: true });
    fs.writeFileSync(path.join(brain, 'identity', 'profile.md'),
      opts.profile === undefined ? `---\nname: ${FIXTURE_NAME}\npronouns: they/them\n---\n` : opts.profile,
      'utf8');
  }

  const homes = {
    dir,
    brain,
    claudeHome: path.join(dir, '.claude'),
    codexHome: path.join(dir, '.codex'),
    // What the CLI will substitute for {{...}} given this fixture.
    values: { USER_NAME: FIXTURE_NAME, BRAIN_ROOT: toPosix(brain) },
  };
  // Containment: inside the OS temp dir, never inside the real harness homes.
  assert.ok(homes.dir.startsWith(fs.realpathSync(os.tmpdir())), homes.dir);
  assert.ok(!homes.claudeHome.startsWith(path.join(os.homedir(), '.claude')));
  assert.ok(!homes.codexHome.startsWith(path.join(os.homedir(), '.codex')));
  if (t) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return homes;
}

function runCli(homes, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: homes.claudeHome,
      CODEX_HOME: homes.codexHome,
      // Install from the fixture brain, not this repo, so the suite does not depend on the
      // gitignored identity/ dir and never writes the real user's name into a fixture.
      MAVIS_BRAIN_ROOT: homes.brain,
      // Detection is a PATH probe; force it so these tests pass on a machine with neither
      // harness installed. It cannot cause a write - only --yes does that.
      MAVIS_INSTALL_ASSUME_HARNESSES: 'claude,codex',
      ...extraEnv,
    },
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function seed(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

const read = (f) => fs.readFileSync(f, 'utf8');
// Count real markers only: a marker occupies its own line. The payload MENTIONS both markers
// inline in prose ("anything between `<!-- mavis:begin -->` ... is overwritten"), which a
// naive substring count would score as a second block.
const count = (hay, needle) =>
  hay.split('\n').filter(l => l.trim() === needle).length;

test('write path: first install into an empty temp home creates the file with the block', (t) => {
  const homes = tempHomes('fresh', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  assert.equal(fs.existsSync(target), false);

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes('WROTE:'), r.out);
  assert.equal(fs.existsSync(target), true);

  const text = read(target);
  assert.equal(count(text, BEGIN), 1);
  assert.equal(count(text, END), 1);
  assert.ok(text.includes('## Attribution: never claim co-authorship'));
  // The prompt target is created too, directory and all.
  assert.equal(read(path.join(homes.claudeHome, 'commands', 'mavis.md')), expectedSlash(homes));
});

test('write path: a second identical run is byte-identical and adds no second block', (t) => {
  const homes = tempHomes('idempotent', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');

  assert.equal(runCli(homes, ['--harness', 'claude', '--global', '--yes']).status, 0);
  const first = read(target);

  const second = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.equal(second.status, 0, second.out);
  assert.ok(second.out.includes('already up to date'), second.out);
  assert.equal(second.out.includes('WROTE:'), false, second.out);

  assert.equal(read(target), first);
  assert.equal(count(read(target), BEGIN), 1);
});

test('write path: a changed payload replaces only the block, preserving both sides', (t) => {
  const homes = tempHomes('replace', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  seed(target, [
    '# My own harness notes',
    '',
    'KEEP ME ABOVE',
    '',
    `${BEGIN}`,
    'STALE CONTRACT TEXT from an older install',
    `${END}`,
    '',
    'KEEP ME BELOW',
    '',
  ].join('\n'));

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.equal(r.status, 0, r.out);

  const text = read(target);
  assert.ok(text.includes('KEEP ME ABOVE'));
  assert.ok(text.includes('KEEP ME BELOW'));
  assert.ok(text.includes('# My own harness notes'));
  assert.ok(!text.includes('STALE CONTRACT TEXT'));
  assert.ok(text.includes('## Attribution: never claim co-authorship'));
  assert.equal(count(text, BEGIN), 1);
  assert.equal(count(text, END), 1);
});

test('write path: a whole-file target is backed up before it is replaced', (t) => {
  const homes = tempHomes('backup', t);
  const target = path.join(homes.claudeHome, 'commands', 'mavis.md');
  seed(target, 'my older /mavis command\n');

  const r = runCli(homes, ['--harness', 'claude', '--yes']);
  assert.equal(r.status, 0, r.out);

  assert.equal(fs.existsSync(`${target}.mavis-bak`), true);
  assert.equal(read(`${target}.mavis-bak`), 'my older /mavis command\n');
  assert.equal(read(target), expectedSlash(homes));
});

test('write path: codex home gets AGENTS.md plus a prompts/ dir it had to create', (t) => {
  const homes = tempHomes('codex', t);
  const agents = path.join(homes.codexHome, 'AGENTS.md');
  const prompt = path.join(homes.codexHome, 'prompts', 'mavis.md');
  assert.equal(fs.existsSync(path.dirname(prompt)), false);

  const r = runCli(homes, ['--harness', 'codex', '--global', '--yes']);
  assert.equal(r.status, 0, r.out);

  assert.equal(count(read(agents), BEGIN), 1);
  const text = read(prompt);
  assert.ok(text.startsWith('---\n'));
  assert.ok(text.includes('argument-hint:'));
  assert.ok(text.includes('Activate Mavis'));
  // config.toml is printed, never written.
  assert.equal(fs.existsSync(path.join(homes.codexHome, 'config.toml')), false);
  assert.ok(r.out.includes('commit_attribution = ""'));
});

test('no --yes writes zero bytes even when the target already exists', (t) => {
  const homes = tempHomes('dryrun', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  seed(target, '# My own harness notes\n\nuntouched\n');
  const before = fs.statSync(target);

  const r = runCli(homes, ['--harness', 'claude', '--global']);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes('Files written:     0 (dry run)'), r.out);

  assert.equal(read(target), '# My own harness notes\n\nuntouched\n');
  assert.equal(fs.statSync(target).size, before.size);
  assert.equal(fs.statSync(target).mtimeMs, before.mtimeMs);
  // And it did not create the prompt target, a backup, or a temp sibling either.
  assert.equal(fs.existsSync(path.join(homes.claudeHome, 'commands', 'mavis.md')), false);
  assert.equal(fs.existsSync(`${target}.mavis-bak`), false, 'a dry run must not back up');
  assert.equal(fs.existsSync(`${target}.mavis-tmp`), false);
});

test('refuses and writes nothing when the target already holds the contract unmarked', (t) => {
  const homes = tempHomes('duplicate', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  // Exactly the situation on the real machine: a hand-maintained copy, no markers. Seeded with
  // the RESOLVED payload, because that is what a previous hand-install would have left behind
  // and it is what the guard has to recognise.
  const seeded = expectedInvariants(homes);
  seed(target, seeded);
  const before = fs.statSync(target);

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.notEqual(r.status, 0, 'a refused install must exit non-zero');
  assert.ok(r.out.includes('REFUSED'), r.out);
  assert.ok(r.out.includes('# Standing invariants'), r.out);
  assert.ok(r.out.includes('mavis:begin'), r.out);
  // The guard must key on the RESOLVED title, or genericizing would have silently
  // disarmed it: the payload says {{USER_NAME}}, the file on disk says the real name.
  assert.ok(r.out.includes(`# Standing invariants (${FIXTURE_NAME})`), r.out);

  assert.equal(read(target), seeded);
  assert.equal(fs.statSync(target).mtimeMs, before.mtimeMs);
  assert.equal(count(read(target), BEGIN), 0);
});

test('the refusal clears once the old copy is wrapped in markers', (t) => {
  const homes = tempHomes('adopted', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  seed(target, `${BEGIN}\nan older copy of the contract\n${END}\n`);

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.equal(r.status, 0, r.out);
  const text = read(target);
  assert.ok(!text.includes('an older copy of the contract'));
  assert.equal(count(text, BEGIN), 1);
});

test('write path: the installed copy is personalized and carries no placeholder', (t) => {
  const homes = tempHomes('resolve', t);
  const r = runCli(homes, ['--harness', 'both', '--global', '--yes']);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes(`Installing for: ${FIXTURE_NAME}`), r.out);

  const written = [
    path.join(homes.claudeHome, 'CLAUDE.md'),
    path.join(homes.claudeHome, 'commands', 'mavis.md'),
    path.join(homes.codexHome, 'AGENTS.md'),
    path.join(homes.codexHome, 'prompts', 'mavis.md'),
  ];
  for (const f of written) {
    const text = read(f);
    // The requirement, checked on the bytes that actually landed on disk.
    assert.equal(text.includes('{{'), false, `placeholder survived into ${f}`);
    assert.equal(text.includes('}}'), false, `placeholder survived into ${f}`);
  }
  const claude = read(written[0]);
  assert.ok(claude.includes(`# Standing invariants (${FIXTURE_NAME})`));
  assert.ok(claude.includes(`Commits and PRs are authored as ${FIXTURE_NAME}'s alone.`));
  assert.ok(claude.includes(`${toPosix(homes.brain)}/scripts/git-hooks/commit-msg`));
  // Same payload, so the codex copy is personalized identically.
  assert.equal(read(written[2]), claude.slice(claude.indexOf(BEGIN)));
});

test('write path: resolution is idempotent - a second run rewrites nothing', (t) => {
  const homes = tempHomes('resolve-twice', t);
  assert.equal(runCli(homes, ['--harness', 'both', '--global', '--yes']).status, 0);
  const first = [
    read(path.join(homes.claudeHome, 'CLAUDE.md')),
    read(path.join(homes.codexHome, 'AGENTS.md')),
  ];

  const second = runCli(homes, ['--harness', 'both', '--global', '--yes']);
  assert.equal(second.status, 0, second.out);
  assert.equal(second.out.includes('WROTE:'), false, second.out);
  assert.equal(read(path.join(homes.claudeHome, 'CLAUDE.md')), first[0]);
  assert.equal(read(path.join(homes.codexHome, 'AGENTS.md')), first[1]);
});

test('write path: the WHOLE-FILE targets are resolved, not just the spliced one', (t) => {
  const homes = tempHomes('resolve-whole', t);
  const r = runCli(homes, ['--harness', 'both', '--yes']); // no --global: prompts only
  assert.equal(r.status, 0, r.out);

  const claudeCmd = path.join(homes.claudeHome, 'commands', 'mavis.md');
  const codexPrompt = path.join(homes.codexHome, 'prompts', 'mavis.md');
  // The spliced targets are deliberately not in this run, so nothing else could be doing it.
  assert.equal(fs.existsSync(path.join(homes.claudeHome, 'CLAUDE.md')), false);
  assert.equal(fs.existsSync(path.join(homes.codexHome, 'AGENTS.md')), false);

  const root = toPosix(homes.brain);
  for (const f of [claudeCmd, codexPrompt]) {
    const text = read(f);
    assert.equal(text.includes('{{'), false, `placeholder survived into ${f}`);
    assert.equal(text.includes('}}'), false, `placeholder survived into ${f}`);
    assert.ok(text.includes(`${root}/CLAUDE.md`), `brain root missing from ${f}`);
    assert.ok(text.includes(`${root}/identity/profile.md`), `brain root missing from ${f}`);
    assert.ok(text.includes(`${FIXTURE_NAME}'s persistent project collaborator`), f);
    // Absolute, so /mavis cannot point a session at the wrong brain.
    assert.ok(/[A-Za-z]:\//.test(root) || root.startsWith('/'), root);
  }
  // The Codex copy carries its own frontmatter, and the description inherits the resolved root.
  const codexText = read(codexPrompt);
  assert.ok(codexText.startsWith('---\n'));
  assert.ok(codexText.includes('argument-hint:'));
  assert.ok(codexText.includes(`from the brain at ${root}.`), codexText.slice(0, 400));
});

test('fails and writes nothing when identity/profile.md is missing', (t) => {
  const homes = tempHomes('no-profile', t, { profile: null });
  const target = path.join(homes.claudeHome, 'CLAUDE.md');

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.notEqual(r.status, 0, `expected failure, got ${r.status}\n${r.out}`);
  assert.ok(r.out.includes('identity/profile.md') || r.out.includes('identity\\profile.md'), r.out);
  assert.ok(r.out.includes('Nothing was written'), r.out);
  assert.ok(r.out.includes('name: Your Name'), r.out);
  // Nothing at all, not even the placeholder-free prompt file.
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.join(homes.claudeHome, 'commands', 'mavis.md')), false);
});

test('fails and writes nothing when profile.md has no name field', (t) => {
  const homes = tempHomes('no-name', t, { profile: '---\npronouns: they/them\n---\n\n# Profile\n' });

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.notEqual(r.status, 0, `expected failure, got ${r.status}\n${r.out}`);
  assert.ok(r.out.includes('no "name:" field'), r.out);
  assert.equal(fs.existsSync(path.join(homes.claudeHome, 'CLAUDE.md')), false);
});

test('the missing-name failure covers the whole-file targets too', (t) => {
  // Same guarantee, exercised on a prompts-only run: resolution happens before any target is
  // built, so a bad identity file cannot leak {{USER_NAME}} into /mavis either.
  const homes = tempHomes('no-name-prompt', t, { profile: '---\nname:\n---\n' });

  const r = runCli(homes, ['--harness', 'both', '--yes']); // no --global
  assert.notEqual(r.status, 0, `expected failure, got ${r.status}\n${r.out}`);
  assert.ok(r.out.includes('no "name:" field'), r.out);
  assert.ok(r.out.includes('Nothing was written'), r.out);
  assert.equal(fs.existsSync(path.join(homes.claudeHome, 'commands', 'mavis.md')), false);
  assert.equal(fs.existsSync(path.join(homes.codexHome, 'prompts', 'mavis.md')), false);
  assert.equal(fs.existsSync(path.join(homes.codexHome, 'prompts')), false);
});

test('an unresolved placeholder in the /mavis source stops the install', (t) => {
  const homes = tempHomes('bad-prompt', t, {
    slash: '---\ndescription: x\n---\n\nRead `{{BRAIN_ROOT}}/CLAUDE.md` on {{MACHINE_ID}}.\n',
  });

  const r = runCli(homes, ['--harness', 'claude', '--yes']);
  assert.notEqual(r.status, 0, `expected failure, got ${r.status}\n${r.out}`);
  assert.ok(r.out.includes('MACHINE_ID'), r.out);
  assert.equal(fs.existsSync(path.join(homes.claudeHome, 'commands', 'mavis.md')), false);
});

test('fails and writes nothing when the payload holds an unknown placeholder', (t) => {
  const homes = tempHomes('unknown-ph', t, {
    invariants: '# Standing invariants ({{USER_NAME}})\n\nbuilt on {{MACHINE_ID}}\n',
  });

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.notEqual(r.status, 0, `expected failure, got ${r.status}\n${r.out}`);
  assert.ok(r.out.includes('MACHINE_ID'), r.out);
  assert.equal(fs.existsSync(path.join(homes.claudeHome, 'CLAUDE.md')), false);
});

// --- recovery: backup, atomicity, line endings -----------------------------------------------

test('write path: a SPLICE target is backed up before it is written', (t) => {
  // The backup used to be gated on mode === 'whole', so the two targets that actually carry
  // pre-existing user content - ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md - were the two with
  // no recovery copy. That is only safe while the splice is provably correct.
  const homes = tempHomes('bak-splice', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  const original = [
    '# My own harness notes',
    '',
    'KEEP ME ABOVE',
    '',
    BEGIN,
    'STALE CONTRACT TEXT',
    END,
    '',
    'KEEP ME BELOW',
    '',
  ].join('\n');
  seed(target, original);

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes('backup:'), r.out);

  assert.equal(fs.existsSync(`${target}.mavis-bak`), true, 'splice target got no .mavis-bak');
  assert.equal(read(`${target}.mavis-bak`), original, 'the backup is not the ORIGINAL bytes');
  assert.ok(read(target).includes('KEEP ME BELOW'));
  assert.ok(!read(target).includes('STALE CONTRACT TEXT'));
  // No temp sibling survives a successful write.
  assert.equal(fs.existsSync(`${target}.mavis-tmp`), false);
});

test('write path: an interrupted write leaves the original intact', (t) => {
  // A directory squatting on the temp path makes the write fail partway through, standing in
  // for an interruption. writeFileSync straight at the target would have truncated a live
  // config file; a temp sibling plus rename cannot.
  const homes = tempHomes('atomic', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  const original = '# My own harness notes\n\nIRREPLACEABLE\n';
  seed(target, original);
  fs.mkdirSync(`${target}.mavis-tmp`, { recursive: true });
  const before = fs.statSync(target);

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.notEqual(r.status, 0, `a failed write must exit non-zero\n${r.out}`);
  assert.ok(r.out.includes('could not write'), r.out);
  assert.ok(r.out.includes('original file is untouched'), r.out);

  assert.equal(read(target), original, 'the original was damaged by a failed write');
  assert.equal(fs.statSync(target).mtimeMs, before.mtimeMs);
  // And the backup was taken before the attempt, so there is a copy either way.
  assert.equal(read(`${target}.mavis-bak`), original);
});

test('write path: a stale temp sibling is replaced, not appended to', (t) => {
  const homes = tempHomes('stale-tmp', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  seed(target, '# My own harness notes\n\nKEEP ME\n');
  fs.writeFileSync(`${target}.mavis-tmp`, 'JUNK FROM A CRASHED RUN\n', 'utf8');

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.equal(r.status, 0, r.out);
  const text = read(target);
  assert.ok(!text.includes('JUNK FROM A CRASHED RUN'));
  assert.ok(text.includes('KEEP ME'));
  assert.equal(count(text, BEGIN), 1);
  assert.equal(fs.existsSync(`${target}.mavis-tmp`), false, 'the temp sibling was left behind');
});

test('write path: a symlink at the temp path is not followed', (t) => {
  const homes = tempHomes('tmp-symlink', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  const decoy = path.join(homes.dir, 'decoy.txt');
  seed(target, '# My own harness notes\n\nKEEP ME\n');
  fs.writeFileSync(decoy, 'DECOY MUST SURVIVE\n', 'utf8');
  try {
    fs.symlinkSync(decoy, `${target}.mavis-tmp`, 'file');
  } catch {
    // Windows without developer mode / elevation cannot create symlinks. The unlink-first
    // behaviour is still exercised by the stale-temp-sibling test above.
    t.skip('symlinks not permitted on this machine');
    return;
  }

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.equal(r.status, 0, r.out);
  assert.equal(read(decoy), 'DECOY MUST SURVIVE\n', 'the write followed the symlink');
  assert.ok(read(target).includes('KEEP ME'));
  assert.equal(count(read(target), BEGIN), 1);
});

test('write path: a symlinked target is written through, not replaced', (t) => {
  // A dotfiles repo linked into ~/.claude. writeFileSync followed the link for free; rename
  // would have replaced the link with a regular file and stranded the dotfiles copy.
  const homes = tempHomes('symlink-target', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  const real = path.join(homes.dir, 'dotfiles-CLAUDE.md');
  fs.mkdirSync(homes.claudeHome, { recursive: true });
  fs.writeFileSync(real, '# My own harness notes\n\nKEEP ME\n', 'utf8');
  try {
    fs.symlinkSync(real, target, 'file');
  } catch {
    t.skip('symlinks not permitted on this machine');
    return;
  }

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.equal(r.status, 0, r.out);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true, 'the symlink was replaced');
  const text = read(real);
  assert.ok(text.includes('KEEP ME'), 'the dotfiles copy did not receive the write');
  assert.equal(count(text, BEGIN), 1);
  assert.equal(read(`${real}.mavis-bak`), '# My own harness notes\n\nKEEP ME\n');
});

test('write path: a CRLF target keeps its line endings', (t) => {
  const homes = tempHomes('crlf', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  const original = '# My own harness notes\r\n\r\nKEEP ME EXACTLY\r\n';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, original, 'utf8');

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes('CRLF'), r.out);

  const text = read(target);
  assert.ok(text.includes('# My own harness notes\r\n'), 'the preserved region was rewritten');
  assert.ok(text.includes('KEEP ME EXACTLY\r\n'));
  assert.equal(/(^|[^\r])\n/.test(text), false, 'a lone LF appeared in a CRLF file');
  assert.equal(count(text, BEGIN), 1);
  // The backup holds the original bytes, CRLF and all.
  assert.equal(read(`${target}.mavis-bak`), original);
});

test('write path: an LF target gains no carriage returns', (t) => {
  const homes = tempHomes('lf', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  seed(target, '# My own harness notes\n\nKEEP ME\n');

  assert.equal(runCli(homes, ['--harness', 'claude', '--global', '--yes']).status, 0);
  assert.equal(read(target).includes('\r'), false, 'CR appeared in an LF file');
});

test('write path: a file with two marker blocks is refused and nothing is written', (t) => {
  // End to end for the collapse case: the CLI reports the malformed markers, writes nothing,
  // and exits non-zero rather than merging the blocks and deleting what sat between them.
  const homes = tempHomes('two-blocks', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  const original = [BEGIN, 'one', END, 'MIDDLE CONTENT', BEGIN, 'two', END, ''].join('\n');
  seed(target, original);
  const before = fs.statSync(target);

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.notEqual(r.status, 0, r.out);
  assert.ok(r.out.includes('malformed mavis markers'), r.out);
  assert.equal(read(target), original);
  assert.ok(read(target).includes('MIDDLE CONTENT'), 'content between two blocks was deleted');
  assert.equal(fs.statSync(target).mtimeMs, before.mtimeMs);
});

test('write path: a stray marker mention above the block preserves the file on disk', (t) => {
  // The full reproduction, through the real CLI onto real bytes: a user who followed the
  // REFUSED message's own instructions and also mentioned a marker in their notes.
  const homes = tempHomes('stray-mention', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  seed(target, [
    '# My own harness notes',
    '',
    `my notes mention ${BEGIN} inline`,
    'KEEP THIS PARAGRAPH',
    '',
    BEGIN,
    'STALE CONTRACT TEXT',
    END,
    '',
    'KEEP ME BELOW',
    '',
  ].join('\n'));

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.equal(r.status, 0, r.out);

  const text = read(target);
  assert.ok(text.includes('KEEP THIS PARAGRAPH'), 'user content above the block was deleted');
  assert.ok(text.includes('my notes mention'), 'the prose line was deleted');
  assert.ok(text.includes('KEEP ME BELOW'));
  assert.ok(!text.includes('STALE CONTRACT TEXT'));
  assert.equal(count(text, BEGIN), 1);
  assert.equal(count(text, END), 1);
});

// --- the preview must name the real destination ----------------------------------------------

test('dry run: a symlinked target names the resolved destination in the preview', (t) => {
  // The safety model is dry-run-then-authorise. A preview that names ~/.claude/CLAUDE.md while
  // the apply writes into a dotfiles repo elsewhere defeats the mechanism it exists to provide.
  const homes = tempHomes('preview-symlink', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  const real = path.join(homes.dir, 'dotfiles-CLAUDE.md');
  fs.mkdirSync(homes.claudeHome, { recursive: true });
  fs.writeFileSync(real, '# My own harness notes\n\nKEEP ME\n', 'utf8');
  try {
    fs.symlinkSync(real, target, 'file');
  } catch {
    t.skip('symlinks not permitted on this machine');
    return;
  }
  const realPosix = toPosix(fs.realpathSync(real));

  const dry = runCli(homes, ['--harness', 'claude', '--global']);
  assert.equal(dry.status, 0, dry.out);
  assert.ok(dry.out.includes('Files written:     0 (dry run)'), dry.out);
  assert.ok(dry.out.includes(realPosix), `the preview never named ${realPosix}\n${dry.out}`);
  assert.ok(dry.out.includes('writes go through to'), dry.out);
  // Nothing moved, and the destination the preview named is still the old bytes.
  assert.equal(read(real), '# My own harness notes\n\nKEEP ME\n');
  assert.equal(fs.existsSync(`${real}.mavis-bak`), false);

  // And the apply writes exactly where the preview said it would.
  const applied = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.equal(applied.status, 0, applied.out);
  assert.ok(applied.out.includes(realPosix), applied.out);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(count(read(real), BEGIN), 1, 'the apply did not write where the preview said');
});

test('a broken symlink at a target path is reported, not swallowed', (t) => {
  const homes = tempHomes('broken-symlink', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  fs.mkdirSync(homes.claudeHome, { recursive: true });
  try {
    fs.symlinkSync(path.join(homes.dir, 'nowhere.md'), target, 'file');
  } catch {
    t.skip('symlinks not permitted on this machine');
    return;
  }

  const dry = runCli(homes, ['--harness', 'claude', '--global']);
  assert.equal(dry.status, 0, dry.out);
  assert.ok(dry.out.includes('symlink: BROKEN'), dry.out);
  assert.ok(dry.out.includes('REPLACES the link with a regular file'), dry.out);
});

test('a directory at a target path is a normal target error, not a stack trace', (t) => {
  const homes = tempHomes('eisdir', t);
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  fs.mkdirSync(target, { recursive: true });

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.notEqual(r.status, 0, r.out);
  assert.ok(r.out.includes('is a directory, not a file'), r.out);
  assert.equal(/^\s+at .*\(/m.test(r.out), false, `a raw stack trace escaped\n${r.out}`);
  // The other target in the same run is still processed rather than aborted.
  assert.equal(fs.existsSync(path.join(homes.claudeHome, 'commands', 'mavis.md')), true);
  assert.equal(fs.statSync(target).isDirectory(), true);
});

test('a marker fault in the PAYLOAD is attributed to the payload, not the target file', (t) => {
  // Sending the user to hand-edit their own config when the fault is in the brain source is
  // worse than saying nothing: they go looking for markers that are not there.
  const homes = tempHomes('payload-blame', t, {
    invariants: `# Standing invariants ({{USER_NAME}})\n\n${BEGIN}\n\nbody\n`,
  });
  const target = path.join(homes.claudeHome, 'CLAUDE.md');
  seed(target, '# My own harness notes\n\nKEEP ME\n');

  const r = runCli(homes, ['--harness', 'claude', '--global', '--yes']);
  assert.notEqual(r.status, 0, r.out);
  assert.ok(r.out.includes('malformed payload'), r.out);
  assert.ok(r.out.includes('Source: the PAYLOAD, not this target file'), r.out);
  assert.ok(r.out.includes(`${toPosix(homes.brain)}/mavis/global-invariants.md`), r.out);
  // It must NOT tell them to go fix markers in their own config.
  assert.equal(r.out.includes('Fix the markers in this target file'), false, r.out);
  assert.equal(read(target), '# My own harness notes\n\nKEEP ME\n');
});

test('the real harness homes were never touched by any of the above', () => {
  assert.deepEqual(snapshotReal(), REAL_BEFORE);
});
