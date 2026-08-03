// The commit-msg hook is the mechanical backstop for no-co-authored-by-trailers. It must
// reject BOTH vendors' defaults - Codex's was added 2026-07-25 after the Codex-portability
// audit found its trailer passed clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, '..', 'git-hooks', 'commit-msg');

function runHook(message) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookmsg-'));
  const f = path.join(dir, 'COMMIT_EDITMSG');
  fs.writeFileSync(f, message);
  // sh is available on Windows via Git for Windows.
  return spawnSync('sh', [HOOK, f], { encoding: 'utf8' });
}

const REJECTED = [
  ['claude trailer',        'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'],
  ['claude footer',         'feat: x\n\nGenerated with [Claude Code](https://claude.com)\n'],
  ['anthropic address',     'feat: x\n\nCo-Authored-By: Someone <noreply@anthropic.com>\n'],
  ['codex trailer',         'feat: x\n\nCo-authored-by: Codex <noreply@openai.com>\n'],
  ['codex lowercase',       'feat: x\n\nco-authored-by: codex <noreply@openai.com>\n'],
  ['openai address only',   'feat: x\n\nCo-authored-by: Bot <noreply@openai.com>\n'],
  ['codex footer',          'feat: x\n\nGenerated with Codex\n'],
  ['leading whitespace',    'feat: x\n\n   Co-authored-by: Codex <noreply@openai.com>\n'],
  // Pinning tests (2026-07-25 owner ruling): the hook deliberately over-blocks
  // any co-author at openai.com/anthropic.com, not just the bots' noreply@
  // addresses. See the "DELIBERATE OVER-BLOCK" comment in the hook for the
  // asymmetric-cost reasoning. Do not "fix" these by narrowing the patterns.
  ['deliberately over-blocks a human at openai.com (see hook comment)',
    'feat: x\n\nCo-authored-by: Sam <sam@openai.com>\n'],
  ['deliberately over-blocks a variant anthropic.com address (see hook comment)',
    'feat: x\n\nCo-Authored-By: Claude <claude@anthropic.com>\n'],
];

for (const [name, msg] of REJECTED) {
  test(`rejects ${name}`, () => {
    const r = runHook(msg);
    assert.equal(r.status, 1, `expected rejection, got ${r.status}\n${r.stderr}`);
  });
}

const ACCEPTED = [
  ['a clean message',            'feat: add the thing\n'],
  ['a body mentioning codex',    'fix: handle codex adapter args\n\nThe codex CLI needs -c overrides.\n'],
  ['a co-author who is a person','feat: x\n\nCo-authored-by: Ahmad <ahmad@example.com>\n'],
  // Contrast cases for the deliberate openai.com/anthropic.com over-block above:
  // an ordinary human co-author elsewhere, and body prose that merely names the
  // vendors, must still pass. Only the trailer/footer patterns should ever match.
  ['an ordinary human co-author (contrast to the openai.com/anthropic.com over-block)',
    'feat: x\n\nCo-authored-by: Ahmad <ahmad@example.com>\n'],
  ['body prose mentioning openai and anthropic (see hook comment)',
    'fix: mention openai and anthropic in the body\n\nDiscussing the openai.com trailer format.\n'],
];

for (const [name, msg] of ACCEPTED) {
  test(`accepts ${name}`, () => {
    const r = runHook(msg);
    assert.equal(r.status, 0, `expected acceptance, got ${r.status}\n${r.stderr}`);
  });
}

test('accepts when the message file does not exist', () => {
  const r = spawnSync('sh', [HOOK, path.join(os.tmpdir(), 'definitely-absent-msg')], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
});
