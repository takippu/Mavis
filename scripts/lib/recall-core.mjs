import fs from 'node:fs';
import path from 'node:path';
import { parseProjectRouter } from './boot-context-core.mjs';

function readIfPresent(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function splitTriggerList(value) {
  const items = [];
  let current = '';
  let quote = false;
  for (const char of value || '') {
    if (char === '"') quote = !quote;
    if (char === ',' && !quote) {
      if (current.trim()) items.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items.map((item) => item.replace(/^['"`]|['"`]$/g, '').trim()).filter(Boolean);
}

export function parseCategoryIndex(markdown, category) {
  const entries = [];
  const blocks = (markdown || '').split(/(?=^## [^#\r\n])/m);
  for (const block of blocks) {
    const slug = block.match(/^## ([A-Za-z0-9._-]+)\s*$/m)?.[1];
    const triggers = block.match(/^\*\*Triggers:\*\*\s*(.+)$/m)?.[1];
    const summary = block.match(/^\*\*Summary:\*\*\s*(.+)$/m)?.[1];
    const detail = block.match(/^\*\*Detail:\*\*\s*\[[^\]]+\]\(([^)]+)\)/m)?.[1];
    if (!slug || !triggers || !detail || !/^_details\/[A-Za-z0-9._-]+\.md$/.test(detail)) continue;
    entries.push({ kind: category, slug, triggers: splitTriggerList(triggers), summary: summary || '', relativePath: `${category}/${detail}` });
  }
  return entries;
}

export function parseSkillTable(markdown) {
  const skills = [];
  for (const line of (markdown || '').split(/\r?\n/)) {
    const match = line.match(/^\| `(?<file>skills\/[A-Za-z0-9._-]+\/SKILL\.md)` \| (?<description>.+) \|$/);
    if (!match) continue;
    const phrases = [...match.groups.description.matchAll(/"([^"]+)"|`([^`]+)`/g)].map((m) => m[1] || m[2]);
    skills.push({ kind: 'skill', slug: match.groups.file.split('/')[1], relativePath: match.groups.file, description: match.groups.description, triggers: phrases });
  }
  return skills;
}

export function matchesPhrase(query, phrase) {
  const needle = String(phrase || '').trim().toLowerCase();
  if (!needle || /[<>]/.test(needle)) return false;
  const haystack = String(query || '').toLowerCase();
  let from = 0;
  while (true) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) return false;
    const end = start + needle.length;
    const before = start === 0 || !/[a-z0-9]/.test(haystack[start - 1]);
    const after = end === haystack.length || !/[a-z0-9]/.test(haystack[end]);
    if (before && after) return true;
    from = start + 1;
  }
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'my', 'of', 'on', 'or', 'our', 'the', 'this', 'to', 'u', 'use', 'we', 'what', 'when', 'where', 'why', 'with', 'would']);

function words(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => !STOP_WORDS.has(word)).map((word) => {
    if (word.endsWith('ies') && word.length > 5) return `${word.slice(0, -3)}y`;
    if (word.endsWith('ing') && word.length > 6) return word.slice(0, -3);
    if (word.endsWith('s') && !word.endsWith('ss') && word.length > 4) return word.slice(0, -1);
    return word;
  }) || [];
}

function triggerMatch(query, phrase) {
  if (matchesPhrase(query, phrase)) return { kind: 'exact', words: words(phrase).length };
  const triggerWords = [...new Set(words(phrase))];
  if (triggerWords.length < 2) return null;
  const queryWords = new Set(words(query));
  const shared = triggerWords.filter((word) => queryWords.has(word)).length;
  return shared >= 2 && shared / triggerWords.length >= 0.5 ? { kind: 'partial', words: shared } : null;
}

function linksFromDetail(markdown) {
  const frontmatter = (markdown || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const links = frontmatter?.[1].match(/^links:\s*\[([^\]]*)\]/m)?.[1];
  return links ? links.split(',').map((slug) => slug.trim()).filter(Boolean) : [];
}

function cappedDetail(root, relativePath, maxDetailBytes) {
  const source = readIfPresent(path.join(root, ...relativePath.split('/')));
  if (source === null) return { text: null, missing: true, truncated: false };
  if (Buffer.byteLength(source, 'utf8') > maxDetailBytes) return { text: null, missing: false, truncated: true };
  return { text: source, missing: false, truncated: false };
}

export function recallExact({ root, codeRoot = root, query, project = null, limit = 4, maxDetailBytes = 12000, maxTotalDetailBytes = 16000 }) {
  if (!root) throw new Error('brain root is required');
  const terms = String(query || '').trim();
  if (!terms) return { query: terms, results: [], truncated: false, fallback: 'Provide a query.' };
  const categories = ['topics', 'preferences'];
  const entries = categories.flatMap((category) => {
    const markdown = readIfPresent(path.join(root, category, '_index.md'));
    return markdown === null ? [] : parseCategoryIndex(markdown, category);
  });
  const skills = parseSkillTable(readIfPresent(path.join(codeRoot, 'AGENTS.md')));
  const projects = parseProjectRouter(readIfPresent(path.join(root, 'projects', '_index.md'))).map((row) => ({
    kind: 'project', slug: row.slug, relativePath: `projects/${row.slug}/index.md`, summary: row.description, triggers: [row.slug, row.slug.replace(/-/g, ' ')],
  }));
  const candidates = [...entries, ...skills, ...projects];
  const scored = candidates.map((candidate) => {
    const evidence = candidate.triggers.map((trigger) => ({ trigger, match: triggerMatch(terms, trigger) })).filter((item) => item.match);
    if (!evidence.length) return null;
    const matched = evidence.map((item) => item.trigger);
    const best = evidence.reduce((winner, item) => {
      const rank = item.match.kind === 'exact'
        ? item.match.words > 1 ? 100 + item.match.words * 8 + item.trigger.length : 35 + item.trigger.length
        : 35 + item.match.words * 8;
      return rank > winner.rank ? { rank, item } : winner;
    }, { rank: 0, item: null });
    const projectBoost = project && (candidate.slug === project || candidate.summary?.toLowerCase().includes(project.toLowerCase())) ? 3 : 0;
    return { ...candidate, matched, score: best.rank + Math.min(evidence.length, 3) * 2 + projectBoost };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
  const selected = scored.slice(0, Math.max(1, limit));
  const ruleEntries = parseCategoryIndex(readIfPresent(path.join(root, 'rules', '_index.md')), 'rules');
  const bySlug = new Map([...entries, ...ruleEntries].map((entry) => [entry.slug, entry]));
  let remainingBytes = maxTotalDetailBytes;
  const results = selected.map((candidate, index) => {
    const detailDeferred = (index > 0 || candidate.score < 50) && candidate.kind !== 'skill';
    const detail = candidate.kind === 'skill' || detailDeferred ? { text: null, missing: false, truncated: false } : cappedDetail(root, candidate.relativePath, Math.min(maxDetailBytes, remainingBytes));
    if (detail.text) remainingBytes -= Buffer.byteLength(detail.text, 'utf8');
    const related = candidate.kind === 'skill' || candidate.kind === 'project' ? [] : linksFromDetail(detail.text).map((slug) => {
      const target = bySlug.get(slug);
      return target ? { slug, path: target.relativePath, summary: target.summary, matched: target.triggers.some((trigger) => matchesPhrase(terms, trigger)) } : { slug, path: null, summary: '', matched: false };
    });
    return {
      kind: candidate.kind,
      slug: candidate.slug,
      path: candidate.relativePath,
      matched: candidate.matched,
      score: candidate.score,
      summary: candidate.summary || candidate.description || '',
      detail: detail.text,
      detailMissing: detail.missing,
      detailTruncated: detail.truncated,
      detailDeferred,
      related,
      requiresSkillRead: candidate.kind === 'skill',
    };
  });
  return {
    query: terms,
    project,
    results,
    truncated: scored.length > selected.length,
    totalMatches: scored.length,
    fallback: categories.some((category) => !fs.existsSync(path.join(root, category, '_index.md')))
      ? 'A category index is missing; use the legacy manual grep/read fallback for it.'
      : selected[0]?.score < 50 ? 'Only weak trigger matches found; inspect summaries or use manual grep before relying on them.' : null,
  };
}

export function formatRecall(result) {
  const parts = [`# Mavis exact recall`, `Query: ${result.query}`, `Matches: ${result.totalMatches || 0}${result.truncated ? ' (more available)' : ''}`];
  if (result.fallback) parts.push(`Fallback: ${result.fallback}`);
  for (const item of result.results) {
    parts.push(`\n## ${item.kind}: ${item.slug}`);
    parts.push(`Path: ${item.path}`);
    parts.push(`Matched: ${item.matched.join(', ')}`);
    if (item.summary) parts.push(`Summary: ${item.summary}`);
    if (item.requiresSkillRead) parts.push('Read the SKILL.md before using this skill; this result does not activate it.');
    if (item.detailMissing) parts.push('Detail file missing; verify manually.');
    if (item.detailTruncated) parts.push('Detail exceeds output budget; read the canonical file before answering.');
    if (item.detailDeferred) parts.push('Detail deferred; read the canonical file if this candidate bears on the question.');
    if (item.detail) parts.push(`\n${item.detail}`);
    if (item.related.length) parts.push(`Related candidates: ${item.related.map((link) => `${link.slug} (${link.path || 'unresolved'}${link.matched ? ', query match' : ''})`).join('; ')}`);
  }
  return `${parts.join('\n')}\n`;
}
