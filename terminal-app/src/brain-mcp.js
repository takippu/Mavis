'use strict';

// Pure parsers for the MCP-servers + skills readers. No fs / no path here — the fs
// orchestration + memoization lives in brain-stats.js, which requires these and wraps
// them with its shared memo()/invalidate() cache. Kept separate so the parsing logic is
// unit-tested against plain fixtures (a ~/.claude.json-shaped object; a SKILL.md string).

// A ~/.claude.json-shaped object (top-level OR a projects[<path>] entry) → its mcpServers
// map's server names, sorted. NAMES ONLY — never command / args / env; those can hold
// secrets (e.g. a PM_TOKEN), so the reader must never surface them. Legacy-safe: a missing,
// non-object, or array-shaped mcpServers yields []. Key ordering inside a server def is
// irrelevant (pencil lists `command` before `type`) — we only read the map's own keys.
function mcpServerNames(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const m = obj.mcpServers;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return [];
  return Object.keys(m).filter((k) => k && typeof k === 'string').sort();
}

// A skills/<dir>/SKILL.md body + its dir name → { name, description }. These files have NO
// YAML frontmatter (parseFrontmatter would return {} on them), so parse the markdown instead:
//   name        — the leading `# <Name>` H1, with a trailing ` — Skill` (em/en-dash or hyphen)
//                  stripped; falls back to the dir name when the H1 is missing/empty.
//   description — the first prose paragraph after the H1 (consecutive non-empty lines joined),
//                  skipping blank lines, sub-headings, bullets/blockquotes/tables, and fences.
function parseSkillMd(md, dirName) {
  const fallback = String(dirName || '').trim();
  const lines = (typeof md === 'string' ? md : '').split(/\r?\n/);
  let name = '';
  let idx = 0;
  for (; idx < lines.length; idx++) {
    const h1 = lines[idx].match(/^#\s+(.+?)\s*$/); // single-# H1 only (`## …` won't match)
    if (h1) {
      name = h1[1].trim().replace(/\s*[—–-]\s*Skill\s*$/i, '').trim();
      idx++;
      break;
    }
  }
  // first prose paragraph after the H1: skip leading blanks/headings/bullets/fences, then
  // collect consecutive prose lines until the next such break-line.
  const para = [];
  for (; idx < lines.length; idx++) {
    const l = lines[idx].trim();
    const isBreak = !l || /^#{1,6}\s/.test(l) || /^```/.test(l) || /^[-*>|]/.test(l);
    if (isBreak) { if (para.length) break; continue; }
    para.push(l);
  }
  const description = para.join(' ').replace(/\s+/g, ' ').trim();
  return { name: name || fallback, description };
}

module.exports = { mcpServerNames, parseSkillMd };
