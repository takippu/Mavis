// Render core for the harness-portable contract. Zero deps, pure (no I/O, never exits).
// AGENTS.md is canonical; CLAUDE.md is rendered from it.
//   <!-- harness:claude --> ... <!-- /harness -->   kept, markers removed
//   <!-- harness:codex -->  ... <!-- /harness -->   removed entirely
// Markers inside fenced code blocks are literal content and are never interpreted.
//
// Fix round 1: the render output becomes an AI agent's operating contract, so a
// malformed marker or a mangled blank-line collapse must fail loudly, never render
// something silently wrong. See task-1-report.md "Fix round 1" for the two
// confirmed defects this file was rewritten to close.
//
// Fix round 2: round 1's near-miss detector was unanchored (matched "harness"
// inside a "<!--...-->" ANYWHERE on the line), so it also fired on ordinary prose
// that merely mentions or documents the marker syntax -- e.g. a sentence or a
// markdown table cell quoting "<!-- harness:codex -->". AGENTS.md documents its
// own marker syntax in prose, so an over-throwing renderer makes the contract
// unrenderable, which is a different failure with the same practical effect as
// the silent leak round 1 fixed. Round 2 tried a POSITIONAL discriminator (only
// a line whose trimmed content starts with "<!--" is a candidate) -- superseded
// below, see round 3.
//
// Fix round 3: round 2's positional rule was itself wrong, not just its
// implementation. "- <!-- harness:codex -->" (a real marker prefixed by a list
// dash) and "Our contract supports <!-- harness:claude --> markers." (prose)
// are the SAME shape under a positional test -- neither trimmed line starts
// with "<!--" -- yet one must throw (it is a leak: the block content behind it
// must not reach the output) and the other was meant to pass. No positional
// rule can separate them. The discriminator is now SHAPE-based instead:
//   - MARKER-SHAPED: a comment whose inner content, trimmed, is exactly
//     "harness", "harness:<name>", "/harness", or "/harness:<name>" -- and
//     nothing else. "TODO: revisit the harness story later" merely contains
//     the word and is not marker-shaped.
//   - A marker-shaped comment found anywhere on a line, EXCEPT inside an
//     inline code span (single-backtick-delimited), makes that line an
//     ATTEMPTED marker. It must then match the strict MARKER_RE form exactly
//     (alone on the line, 0-3 space indent, known name) or it throws.
//   - A marker-shaped comment inside backticks is literal content and passes.
//   - A comment that merely mentions "harness" without being marker-shaped
//     (a genuine unrelated comment) is ordinary content and passes.
// Deliberate consequence: unbackticked prose that happens to contain a
// marker-shaped comment (e.g. the "Our contract supports..." sentence above)
// now THROWS where round 2 let it pass. This is intentional, not a
// regression -- see the round-3 report section "why prose-mentioning-a-marker
// now throws" for the full rationale. Do not revert this to a silent pass.
//
// Fix round 4: every check in this file operates on ONE array line, so an HTML
// comment spanning two lines was invisible to all of them and leaked silently:
//     a
//     <!-- harness:codex
//     -->
//     secret content
//     <!-- /harness
//     -->
//     b
// rendered "secret content" verbatim into the Claude contract with no error --
// the exact failure class rounds 1 and 3 existed to close, present since the
// round-1 line-splitting design. The fix is a LEXICAL PRECONDITION rather than
// a real multi-line comment parser: outside fenced code blocks, an HTML comment
// must open and close on the same line, or renderClaude throws. A multi-line
// comment parser would be more code, more edge cases, and would reopen the
// question of what a marker split across lines even means -- and it buys
// nothing, because the contract carries zero HTML comments (verified: `<!--`
// and `-->` both occur 0 times in the real CLAUDE.md). Requiring one-line
// comments therefore costs nothing today and converts a silent leak into a
// loud, actionable error.
// The check is applied to the SAME code-span-masked copy of the line that the
// round-3 shape check uses, so the settled "backticks make it literal" rule
// holds uniformly: a line documenting `<!--` on its own inside backticks is
// content, not a broken comment. Fenced blocks return before the check runs,
// so a fence containing an unbalanced `<!--` stays fully literal.

export const BANNER =
  '<!-- GENERATED FILE - DO NOT EDIT. Source: AGENTS.md. Regenerate: node scripts/sync-contract.mjs --write -->';

const KNOWN = new Set(['claude', 'codex']);
export const MARKER_RE = /^\s{0,3}<!--\s*(\/)?harness(?::([a-z0-9-]+))?\s*-->\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

// True marker-shape test, applied to a comment's trimmed inner content only
// (the text between "<!--" and "-->"): exactly "harness", "harness:<name>",
// "/harness", or "/harness:<name>" -- nothing more, nothing less.
const MARKER_SHAPE_RE = /^\/?harness(?::[a-z0-9-]+)?$/;
// Finds every HTML comment on a line; used against a code-span-masked copy so
// comments inside backticks are never considered. Global + non-greedy so
// matchAll walks each comment on the line in turn.
const COMMENT_RE = /<!--([\s\S]*?)-->/g;
// Simple single-backtick-delimited inline code span (no nested backticks, no
// multi-backtick fences-within-a-line). Sufficient for the documented cases;
// masked spans are replaced with '' before comment-shape detection so a
// marker-shaped comment quoted inside backticks is never flagged.
const INLINE_CODE_SPAN_RE = /`[^`\n]*`/g;

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
const ONE_LINE_HINT =
  'multi-line HTML comments are not supported in the contract -- keep every comment ' +
  '(and every harness marker) on a single line';

// Round 4. Lexical precondition for any line outside a fenced code block: every
// HTML comment on it must open AND close on that same line. Without this, a
// marker split across two lines is invisible to every per-line check below and
// its block leaks into the output silently. Operates on the code-span-masked
// line so backtick-quoted comment syntax stays literal (see the round-4 note in
// the header). Throws; never returns a value.
function assertSingleLineComments(line, lineNumber) {
  const masked = line.replace(INLINE_CODE_SPAN_RE, '');
  let pos = 0;
  while (pos < masked.length) {
    const open = masked.indexOf(COMMENT_OPEN, pos);
    const close = masked.indexOf(COMMENT_CLOSE, pos);
    if (open === -1 && close === -1) return;
    if (open === -1 || (close !== -1 && close < open)) {
      throw new Error(
        `stray "-->" at line ${lineNumber}: "${line.trim()}" -- no "<!--" opens it on this ` +
          `line; ${ONE_LINE_HINT}`,
      );
    }
    const end = masked.indexOf(COMMENT_CLOSE, open + COMMENT_OPEN.length);
    if (end === -1) {
      throw new Error(
        `unterminated HTML comment at line ${lineNumber}: "${line.trim()}" -- ${ONE_LINE_HINT}`,
      );
    }
    pos = end + COMMENT_CLOSE.length;
  }
}

export function renderClaude(source) {
  if (typeof source !== 'string') {
    throw new TypeError('renderClaude: source must be a string');
  }

  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let open = null;          // harness name of the block we are inside
  let fence = null;         // the fence marker string we are inside, if any
  let fenceOpenedAt = 0;    // 1-based line the currently open fence opened on,
                             // so an unterminated fence can name it (round 5)
  let justStripped = false; // true immediately after a marker line or a
                             // codex-only line was dropped -- used to collapse
                             // only the blank-line gap a removal leaves behind,
                             // never an arbitrary run of blank lines elsewhere.

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const f = line.match(FENCE_RE);
    if (f) {
      if (fence === null) {
        fence = f[1];
        fenceOpenedAt = i + 1;
      } else if (f[1][0] === fence[0] && f[1].length >= fence.length) {
        // CommonMark: a closing fence uses the same character and is at least as
        // long as the opening one. A shorter run, or the other character, is
        // fence content and leaves the fence open.
        fence = null;
        fenceOpenedAt = 0;
      }
      if (open !== 'codex') {
        out.push(line);
        justStripped = false;
      } else {
        justStripped = true;
      }
      continue;
    }
    if (fence !== null) {
      // Inside a fence: content is literal. Never interpreted, never collapsed.
      if (open !== 'codex') {
        out.push(line);
        justStripped = false;
      } else {
        justStripped = true;
      }
      continue;
    }

    // Round 4. Everything past this point is a per-line check, so a comment that
    // spans lines would slip through all of them. Reject it here, before the
    // marker branches AND before the codex-drop below -- a broken marker inside
    // an open codex block must report the line that is actually malformed, not
    // die later as a generic "unclosed" at EOF. Fence lines and fence interiors
    // already `continue`d above, so they are never checked and stay literal.
    assertSingleLineComments(line, i + 1);

    const m = line.match(MARKER_RE);
    if (m) {
      const closing = Boolean(m[1]);
      const name = m[2];
      if (closing) {
        if (open === null) throw new Error(`unmatched closing harness marker at line ${i + 1}`);
        if (name && name !== open) {
          throw new Error(
            `mismatched closing harness marker "${name}" for open block "${open}" at line ${i + 1}`,
          );
        }
        open = null;
      } else {
        if (open !== null) throw new Error(`nested harness marker at line ${i + 1}`);
        if (!name || !KNOWN.has(name))
          throw new Error(`unknown harness "${name || ''}" at line ${i + 1}`);
        open = name;
      }
      justStripped = true; // marker lines never survive
      continue;
    }

    // MARKER_RE already failed above, so this line is not a well-formed marker.
    // It is only an ATTEMPTED marker -- and therefore an error, not content -- if
    // it contains a MARKER-SHAPED comment outside of any inline code span. Mask
    // out backtick-delimited spans first so a marker-shaped comment quoted
    // literally in documentation (e.g. inside `` `<!-- harness:codex -->` ``)
    // is never flagged.
    const maskedLine = line.replace(INLINE_CODE_SPAN_RE, '');
    let attemptedMarker = false;
    for (const cm of maskedLine.matchAll(COMMENT_RE)) {
      if (MARKER_SHAPE_RE.test(cm[1].trim())) {
        attemptedMarker = true;
        break;
      }
    }
    if (attemptedMarker) {
      throw new Error(
        `malformed harness marker at line ${i + 1}: "${line.trim()}" -- looks like a harness ` +
          'marker; wrap it in backticks if you meant it literally',
      );
    }

    if (open === 'codex') {
      justStripped = true; // codex-only content line dropped
      continue;
    }

    if (line === '' && justStripped && out.length > 0 && out[out.length - 1] === '') {
      // This blank line only abuts the previous one because content between
      // them was just stripped -- merge them into a single blank separator.
      justStripped = false;
      continue;
    }

    out.push(line);
    justStripped = false;
  }

  // Round 5. An unterminated fence swallows the rest of the document as literal
  // content, so a real codex block sitting inside one is never interpreted and
  // leaks verbatim into the Claude contract -- the same silent-leak class as
  // rounds 1-4. Checked BEFORE the unclosed-marker check: when a fence is left
  // open, any marker inside it went uninterpreted, so "unclosed harness marker"
  // would be a downstream symptom naming the wrong problem. An unclosed fence is
  // malformed markdown that renders badly everywhere, so nothing legitimate is
  // rejected here.
  if (fence !== null) {
    throw new Error(
      `unterminated code fence opened at line ${fenceOpenedAt} with "${fence}" -- the contract ` +
        'cannot be rendered with an unclosed code fence; close the fence or remove it',
    );
  }

  if (open !== null) throw new Error(`unclosed harness marker for "${open}"`);

  const body = out.join('\n').replace(/^\n+/, '');
  return `${BANNER}\n\n${body}`;
}
