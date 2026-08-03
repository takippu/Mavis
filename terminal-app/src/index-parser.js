'use strict';

// Pure parsers for the brain's project files. Side-effect free so they're
// trivially unit-testable (see test/index-parser.test.js). The fs reads that
// feed these live in main.js.

// A project line in projects/_index.md:
//   - [<name>](<slug>/index.md) — <type>, <status> — <description...>
// grouped under `## Active` / `## Paused` / `## Archived`. The separator is an
// em-dash (U+2014) with surrounding spaces; descriptions can themselves contain
// " — ", so we split on the FIRST separator to peel off the meta.

const HEADING_RE = /^##\s+(.+?)\s*$/;
const ITEM_RE = /^-\s+\[([^\]]+)\]\(([^)]*)\)\s+—\s+(.*)$/;
const SEP = ' — ';

function parseProjectsIndex(md) {
  if (!md || typeof md !== 'string') return [];

  const projects = [];
  let group = null;
  let inFence = false;

  for (const line of md.split(/\r?\n/)) {
    // Skip fenced code blocks (the file ends with a ``` Format example that
    // would otherwise parse as a bogus `<name>` project).
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = line.match(HEADING_RE);
    if (heading) {
      group = heading[1].trim();
      continue;
    }

    const item = line.match(ITEM_RE);
    if (!item || !group) continue;

    const name = item[1].trim();
    if (name.includes('<')) continue; // template placeholder guard

    // The on-disk folder comes from the link target, not the bracket text
    // (they usually match, but trust the link).
    const slug = (item[2].split('/')[0] || name).trim();

    const rest = item[3].trim();
    const parts = rest.split(SEP);
    const meta = (parts.shift() || '').trim();
    const description = parts.join(SEP).trim();
    const [type = '', status = ''] = meta.split(',').map((s) => s.trim());

    projects.push({ name, slug, type, status, description, group });
  }

  return projects;
}

// Extract the `path:` value from a project index.md's YAML frontmatter, or null.
function extractFrontmatterPath(indexMd) {
  if (!indexMd || typeof indexMd !== 'string') return null;

  const lines = indexMd.split(/\r?\n/);
  if (lines[0].trim() !== '---') return null; // no frontmatter

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break; // end of frontmatter
    const m = lines[i].match(/^path:\s*(.+?)\s*$/);
    if (!m) continue;
    let v = m[1].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    return v || null;
  }
  return null;
}

module.exports = { parseProjectsIndex, extractFrontmatterPath };
