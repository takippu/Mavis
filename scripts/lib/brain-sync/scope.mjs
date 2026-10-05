import fs from 'node:fs';
import path from 'node:path';
import { hash } from './crypto.mjs';

export const DIRECTORIES = ['identity', 'preferences', 'rules', 'topics', 'projects', 'daily-memories', 'memory', 'standups'];
const excluded = /^(?:\..*|_backup|_local|node_modules|dist|workspace|skills|scripts|__pycache__|service-account.*)$/i;
const attachments = /\.(?:png|jpe?g|webp|gif|pdf)$/i;
export function validatePath(relative) {
  if (typeof relative !== 'string' || relative.length > 240 || relative.normalize('NFC') !== relative || relative.includes('\\') || relative.includes('%') || /[\x00-\x1f<>:"|?*]/.test(relative)) throw new Error('Unsafe document path');
  const pieces = relative.split('/');
  if (!DIRECTORIES.includes(pieces[0]) || pieces.some(p => !p || p === '.' || p === '..' || excluded.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe document path');
  if (!/\.md$/i.test(relative) && !attachments.test(relative)) throw new Error('Unsupported document type');
  return relative;
}
export function safeFile(root, relative) {
  validatePath(relative);
  let current = root;
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Linked data root is unsupported');
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked document path is unsupported'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return current;
}
export function projectProjection(relative, bytes) {
  if (!/^projects\/[^/]+\/index\.md$/.test(relative)) return bytes;
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return Buffer.from(source.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)/, (_, start, body, end) => start + body.split(/\r?\n/).filter(line => !/^(?:path|last_accessed):/.test(line)).join('\n') + end));
}
function verifyAttachment(relative, bytes) {
  const ext = path.extname(relative).toLowerCase();
  const valid = ext === '.pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : ext === '.png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a','hex')) : ['.jpg','.jpeg'].includes(ext) ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : ext === '.gif' ? /^GIF8[79]a$/.test(bytes.subarray(0,6).toString()) : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
  if (!valid) throw new Error(`Invalid attachment format: ${relative}`);
}
export function snapshot(root) {
  const files = {}, references = new Set(), collisions = new Set(), warnings = [];
  function collect(relative, attachment = false) {
    validatePath(relative);
    const folded = relative.toLowerCase();
    if (collisions.has(folded)) throw new Error(`Case collision: ${relative}`);
    collisions.add(folded);
    const file = safeFile(root, relative), before = fs.statSync(file);
    if (!before.isFile() || before.size > (attachment ? 24 : 8) * 1024 * 1024) throw new Error(`Document exceeds limit: ${relative}`);
    const original = fs.readFileSync(file), after = fs.statSync(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Brain changed during snapshot; retry');
    if (attachment) verifyAttachment(relative, original);
    else {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(original);
      if (text.includes('\0')) throw new Error(`Binary Markdown: ${relative}`);
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{24,})\b/.test(text)) warnings.push(relative);
      for (const match of text.matchAll(/!?\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
        let target; try { target = decodeURIComponent(match[1].split('#')[0]); } catch { throw new Error(`Invalid attachment link: ${relative}`); }
        if (/^[a-z]+:|^\/\//i.test(target) || !attachments.test(target)) continue;
        const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
        validatePath(normalized); references.add(normalized);
      }
    }
    const bytes = attachment ? original : projectProjection(relative, original);
    files[relative] = { hash: hash(bytes), bytes: bytes.length, kind: attachment ? 'attachment' : 'document', data: bytes, originalHash: hash(original) };
  }
  function walk(relative) {
    const dir = path.join(root, relative);
    if (!fs.existsSync(dir)) return;
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Linked brain directory is unsupported');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (excluded.test(entry.name)) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Linked entry: ${child}`);
      if (entry.isDirectory()) walk(child);
      else if (/\.md$/i.test(entry.name)) collect(child);
    }
  }
  for (const dir of DIRECTORIES) walk(dir);
  for (const reference of references) collect(reference, true);
  for(const [relative,file] of Object.entries(files))if(hash(fs.readFileSync(safeFile(root,relative)))!==file.originalHash)throw new Error('Brain changed during batch snapshot; retry after completed save');
  if (Object.keys(files).length > 10000) throw new Error('Brain exceeds document count limit');
  return { files, warnings };
}
export function mergePlan(base, local, remote) {
  const changes = [], conflicts = [];
  for (const name of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const b = base[name]?.hash || null, l = local[name]?.hash || null, r = remote[name]?.hash || null;
    if (l === r || r === b) continue;
    if (l !== b) conflicts.push(name);
    else changes.push({ path: name, before: l, after: r });
  }
  return { changes, conflicts };
}
