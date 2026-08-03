import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAIN_ROOT = join(__dirname, '..', '..');
const OUTPUT = join(__dirname, '..', 'public', 'data.json');

type Category = 'identity' | 'core' | 'projects' | 'daily-memories' | 'skills';
type NodeType = 'category' | 'project' | 'file';

const CATEGORY_COLORS: Record<Category, string> = {
  identity: '#7aa2f7',
  core: '#a9b1d6',
  projects: '#9ece6a',
  'daily-memories': '#ff9e64',
  skills: '#bb9af7',
};

interface CyNode {
  data: {
    id: string;
    label: string;
    type: NodeType;
    category: Category;
    parentId?: string;
    filePath?: string;
    content?: string;
    color: string;
  };
}

interface CyEdge {
  data: {
    id: string;
    source: string;
    target: string;
    kind: string;
  };
}

const nodes: CyNode[] = [];
const edges: CyEdge[] = [];

function addNode(n: CyNode) { nodes.push(n); }
function addEdge(source: string, target: string, kind: string) {
  edges.push({ data: { id: `${source}->${target}:${kind}`, source, target, kind } });
}

function readMd(p: string): string | null {
  try { return readFileSync(p, 'utf-8'); } catch { return null; }
}

function parseFrontmatter(content: string): Record<string, any> | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const result: Record<string, any> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const k = line.match(/^(\w+):\s*(.*)$/);
    if (!k) continue;
    let v: any = k[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    result[k[1]] = v;
  }
  return result;
}

function walk(dir: string, fn: (full: string) => void) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, fn);
    else fn(full);
  }
}

function addFile(filePath: string, category: Category, parentId: string, label?: string): string {
  const id = `file:${filePath}`;
  const content = readMd(join(BRAIN_ROOT, filePath));
  addNode({
    data: {
      id,
      label: label ?? basename(filePath, '.md'),
      type: 'file',
      category,
      parentId,
      filePath,
      content: content ?? '(file unreadable)',
      color: CATEGORY_COLORS[category],
    },
  });
  return id;
}

// 1. Top-level category nodes
const categories: Category[] = ['identity', 'core', 'projects', 'daily-memories', 'skills'];
for (const cat of categories) {
  addNode({
    data: {
      id: `cat:${cat}`,
      label: cat.toUpperCase(),
      type: 'category',
      category: cat,
      color: CATEGORY_COLORS[cat],
    },
  });
}

// 2. Identity files
const identityDir = join(BRAIN_ROOT, 'identity');
if (existsSync(identityDir)) {
  for (const name of readdirSync(identityDir)) {
    if (!name.endsWith('.md')) continue;
    addFile(`identity/${name}`, 'identity', 'cat:identity');
  }
}

// 3. Core files (root .md / LICENSE)
for (const name of ['CLAUDE.md', 'SETUP.md', 'README.md', 'LICENSE']) {
  if (!existsSync(join(BRAIN_ROOT, name))) continue;
  addFile(name, 'core', 'cat:core');
}

// 4. Projects (each subfolder, walk recursively for .md files)
const projectsDir = join(BRAIN_ROOT, 'projects');
if (existsSync(projectsDir)) {
  for (const projectName of readdirSync(projectsDir)) {
    const projectFull = join(projectsDir, projectName);
    if (!statSync(projectFull).isDirectory()) continue;
    if (projectName.startsWith('_')) continue;

    const projectId = `project:${projectName}`;
    addNode({
      data: {
        id: projectId,
        label: projectName,
        type: 'project',
        category: 'projects',
        parentId: 'cat:projects',
        color: CATEGORY_COLORS.projects,
      },
    });

    walk(projectFull, (full) => {
      if (!full.endsWith('.md')) return;
      const filePath = relative(BRAIN_ROOT, full).replace(/\\/g, '/');
      addFile(filePath, 'projects', projectId);
    });
  }
}

// 5. Daily memories (with edges to projects via frontmatter)
const dailyDir = join(BRAIN_ROOT, 'daily-memories');
if (existsSync(dailyDir)) {
  for (const name of readdirSync(dailyDir)) {
    if (!name.endsWith('.md')) continue;
    if (name.startsWith('_')) continue;
    const filePath = `daily-memories/${name}`;
    const id = addFile(filePath, 'daily-memories', 'cat:daily-memories');

    const content = readMd(join(BRAIN_ROOT, filePath));
    if (content) {
      const fm = parseFrontmatter(content);
      if (fm && Array.isArray(fm.projects)) {
        for (const projectName of fm.projects) {
          addEdge(id, `project:${projectName}`, 'mentions');
        }
      }
    }
  }
}

// 6. Skills (each subfolder with SKILL.md)
const skillsDir = join(BRAIN_ROOT, 'skills');
if (existsSync(skillsDir)) {
  for (const skillName of readdirSync(skillsDir)) {
    const skillFull = join(skillsDir, skillName);
    if (!statSync(skillFull).isDirectory()) continue;
    const skillFile = join(skillFull, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    addFile(`skills/${skillName}/SKILL.md`, 'skills', 'cat:skills', skillName);
  }
}

// Filter out edges pointing to non-existent nodes
const nodeIds = new Set(nodes.map(n => n.data.id));
const validEdges = edges.filter(e => nodeIds.has(e.data.source) && nodeIds.has(e.data.target));

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify({ nodes, edges: validEdges }, null, 2));
console.log(`brain-viz: wrote ${nodes.length} nodes, ${validEdges.length} edges → ${relative(process.cwd(), OUTPUT)}`);
