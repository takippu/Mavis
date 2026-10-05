import fs from 'node:fs';
import path from 'node:path';

function readIfPresent(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function parseProjectRouter(markdown) {
  const rows = [];
  for (const line of (markdown || '').split(/\r?\n/)) {
    const match = line.match(/^- \[([^\]]+)\]\(([^)]+)\)\s+[—–-]\s+(.+)$/);
    if (!match) continue;
    const [, slug, relativeIndex, description] = match;
    if (!/^[A-Za-z0-9._-]+$/.test(slug)) continue;
    if (relativeIndex !== `${slug}/index.md`) continue;
    rows.push({ slug, relativeIndex, description, line });
  }
  return rows;
}

export function frontmatterField(markdown, field) {
  const lines = (markdown || '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return null;
  const prefix = `${field}:`;
  const row = lines.slice(1, end).find((line) => line.startsWith(prefix));
  if (!row) return null;
  return row.slice(prefix.length).trim().replace(/^(['"])(.*)\1$/, '$2') || null;
}

export function comparablePath(value) {
  if (!value) return null;
  let normalized = String(value).trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(normalized)) normalized = normalized.toLowerCase();
  return normalized;
}

export function newestCheckpoint(markdown) {
  if (!markdown) return null;
  const lines = markdown.split(/\r?\n/);
  const first = lines.findIndex((line) => /^## /.test(line));
  if (first < 0) return null;
  let end = lines.findIndex((line, index) => index > first && /^## /.test(line));
  if (end < 0) end = lines.length;
  return lines.slice(first, end).join('\n').trimEnd();
}

export function dailyHeadings(markdown) {
  if (!markdown) return [];
  return markdown.split(/\r?\n/).filter((line) => /^## [^#]/.test(line));
}

export function buildBootContext({ root, codeRoot = root, projectOverrides = {}, expectIdentity = false, cwd = process.cwd(), explicitProject = null, today }) {
  if (!root) throw new Error('brain root is required');
  const profile = readIfPresent(path.join(root, 'identity', 'profile.md'));
  if (profile === null) {
    if(expectIdentity)return {status:'missing_identity',root,message:'Restored/registered identity is missing. Pull/recover the correct brain; do not run setup or reset.'};
    return { status: 'setup_required', root, setupPath: path.join(codeRoot, 'SETUP.md') };
  }

  const router = parseProjectRouter(readIfPresent(path.join(root, 'projects', '_index.md')));
  const projectIndex = (row) => readIfPresent(path.join(root, 'projects', row.relativeIndex));
  let selected = null;
  let selection = 'none';
  if (explicitProject !== null && String(explicitProject).trim()) {
    const candidate = String(explicitProject).trim().toLowerCase();
    selected = router.find((row) => row.slug.toLowerCase() === candidate ||
      frontmatterField(projectIndex(row), 'name')?.toLowerCase() === candidate) || null;
    selection = selected ? 'explicit' : 'unknown_explicit';
  } else {
    const wanted = comparablePath(cwd);
    selected = router.find((row) => comparablePath(projectOverrides[row.slug]?.path || frontmatterField(projectIndex(row), 'path')) === wanted) || null;
    if (selected) selection = 'cwd';
  }

  const date = today || new Date().toLocaleDateString('en-CA');
  const result = {
    status: selection === 'unknown_explicit' ? 'unknown_project' : 'ready',
    root,
    date,
    selection,
    explicitProject: explicitProject || null,
    identity: {
      profile,
      personality: readIfPresent(path.join(root, 'identity', 'personality.md')),
      communication: readIfPresent(path.join(root, 'identity', 'communication.md')),
    },
    rulesIndex: readIfPresent(path.join(root, 'rules', '_index.md')),
    todayHeadings: selected || selection === 'unknown_explicit' ? [] : dailyHeadings(readIfPresent(path.join(root, 'daily-memories', `${date}.md`))).slice(-3),
    project: null,
  };
  if (selected) {
    const directory = path.join(root, 'projects', selected.slug);
    result.project = {
      slug: selected.slug,
      routerLine: selected.line,
      index: projectIndex(selected),
      localPath: projectOverrides[selected.slug]?.path || frontmatterField(projectIndex(selected), 'path'),
      notes: readIfPresent(path.join(directory, 'notes.md')),
      newestProgress: newestCheckpoint(readIfPresent(path.join(directory, 'progress.md'))),
    };
  }
  return result;
}

export function formatBootContext(result) {
  if(result.status==='missing_identity')return `${result.message}\n`;
  if (result.status === 'setup_required') {
    return `Mavis setup required. Read and run ${result.setupPath}.\n`;
  }
  const parts = [
    '# Mavis boot context',
    `Status: ${result.status}`,
    `Project selection: ${result.selection}`,
    `Date: ${result.date}`,
  ];
  if (result.status === 'unknown_project') {
    parts.push(`Unknown explicit project: ${result.explicitProject}`);
    parts.push('Ask before creating this project; do not substitute the current-directory project.');
  }
  const section = (label, value) => {
    if (value !== null && value !== undefined) parts.push(`\n## ${label}\n${value}`);
  };
  section('identity/profile.md', result.identity.profile);
  section('identity/personality.md', result.identity.personality);
  section('identity/communication.md', result.identity.communication);
  section('rules/_index.md', result.rulesIndex);
  if (result.selection !== 'explicit' && result.todayHeadings.length) {
    section(`daily-memories/${result.date}.md headings`, result.todayHeadings.join('\n'));
  }
  if (result.project) {
    section('selected project router line', result.project.routerLine);
    section(`projects/${result.project.slug}/index.md`, result.project.index);
    if(result.project.localPath)section('selected project machine-local path',result.project.localPath);
    section(`projects/${result.project.slug}/notes.md`, result.project.notes);
    section(`projects/${result.project.slug}/progress.md newest checkpoint`, result.project.newestProgress);
  }
  return `${parts.join('\n')}\n`;
}
