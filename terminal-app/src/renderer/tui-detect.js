'use strict';

// MT.tuiDetect — pure, line-level predicates for Claude Code's TUI states, each taking ONE
// buffer line of text. No DOM, no terminal object → unit-tested (test/tui-detect.test.js).
// session-view's working → awaiting → ready state machine (which drives completion notifications
// and the tab busy-dot) scans the buffer and delegates the per-line decision here. Kept separate
// + tested because the exact idle/working strings drift across CLI versions (auto/plan modes,
// borderless vs bordered prompt) and have repeatedly broken notifications when isReady stopped
// matching a new idle screen.
//
// STATUS (post-sidecar): this was the primary notifier before agent-CLI lifecycle hooks existed,
// then the fallback once hooks landed for Claude. Now that the harness-agnostic sidecar (see
// src/session-events.js) covers BOTH harnesses out-of-band, this module is a fallback for CLAUDE
// ONLY — it stays scoped to Claude's TUI strings and does not grow Codex regexes. Guessing at
// another CLI's footer/prompt text from the outside is exactly the drift the sidecar exists to
// replace with real lifecycle events; a Codex pane simply relies on the sidecar and never touches
// this path. session-view sets `pane.hookDriven = true` on the first sidecar signal for a pane,
// which stops this regex path from scheduling notifications for it — so in practice this module
// only still fires for a Claude build old enough to predate hooks (< 2.1.141).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // node (tests)
  if (typeof window !== 'undefined') (window.MT = window.MT || {}).tuiDetect = api; // renderer
})(this, function () {
  // Claude prints "esc to interrupt" in its footer WHILE generating. Its presence = working.
  function isWorkingLine(t) { return /esc to interrupt/i.test(t); }

  // Claude drops the working footer when it PAUSES for the user mid-turn (tool-permission prompt,
  // plan/trust approval, numbered-choice menu). Not a finished turn — its own notify moment.
  function isAwaitingLine(t) {
    return /❯\s*\d+\.\s/.test(t)                // interactive numbered-menu cursor
      || /\bDo you want\b/i.test(t)             // permission question
      || /Would you like to proceed/i.test(t); // plan-mode approval
  }

  // A POSITIVE idle signal: Claude's input prompt / hint chrome is back, i.e. the turn TRULY
  // finished. Completion fires on THIS, never on the mere absence of the working footer (which
  // blinks out between tool calls). Must cover every idle-screen variant the CLI ships:
  //   - "? for shortcuts"                  default idle hint
  //   - "<mode> on (shift+tab to cycle)"   auto / plan / accept-edits / bypass-permissions modes
  //                                        (borderless prompt — the variant that broke 0.2.x)
  //   - bordered "│ > "                    older CLI input box
  // A bare borderless "> " is deliberately NOT matched — it appears in response text / blockquotes
  // and would false-fire mid-turn; the mode hint below it is the reliable idle marker.
  function isReadyLine(t) {
    if (/\?\s+for\s+shortcuts/i.test(t)) return true;
    if (/shift\s*\+\s*tab\s+to\s+cycle/i.test(t)) return true;
    if (/[│┃]\s{0,2}>\s/.test(t)) return true;
    return false;
  }

  return { isWorkingLine, isAwaitingLine, isReadyLine };
});
