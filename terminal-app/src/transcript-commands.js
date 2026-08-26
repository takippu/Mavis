'use strict';

// Read-only command extraction from the native Claude/Codex JSONL transcripts. The renderer names
// only a LIVE pty id; main resolves that id to this trusted session context and this module derives
// every filesystem path itself. No renderer-supplied path ever reaches fs.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TAIL_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 12;
const MAX_BLOCKS = 24;
const MAX_BLOCK_BYTES = 256 * 1024;

function roots(homeDir = os.homedir()) {
  return {
    claude: path.join(homeDir, '.claude', 'projects'),
    codex: path.join(homeDir, '.codex', 'sessions'),
  };
}

function withinRoot(root, target) {
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    const rel = path.relative(realRoot, realTarget);
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

function claudeProjectDir(root, cwd) {
  if (!cwd) return null;
  // Claude's project directory is the absolute cwd with every separator (including the colon)
  // replaced independently. C:\work -> C--work, matching Claude Code's on-disk convention.
  return path.join(root, String(cwd).replace(/[:\\/]/g, '-'));
}

function listFiles(root, predicate, limit = 200) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && (!predicate || predicate(entry.name, full))) out.push(full);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function firstJson(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString('utf8').split(/\r?\n/, 1)[0];
    return JSON.parse(line);
  } catch {
    return null;
  } finally {
    try { if (fd != null) fs.closeSync(fd); } catch { /* noop */ }
  }
}

function newest(files, startedAt) {
  const floor = Number(startedAt || 0) - 120000;
  return files
    .map((file) => { try { return { file, stat: fs.statSync(file) }; } catch { return null; } })
    .filter((x) => x && (!floor || x.stat.mtimeMs >= floor))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]?.file || null;
}

function findClaudeTranscript(root, ctx) {
  const dir = claudeProjectDir(root, ctx.cwd);
  if (!dir || !withinRoot(root, dir)) return null;
  if (ctx.transcriptPath && withinRoot(root, ctx.transcriptPath)) return ctx.transcriptPath;
  if (ctx.sessionId) {
    const exact = path.join(dir, String(ctx.sessionId) + '.jsonl');
    if (withinRoot(root, exact)) return exact;
  }
  return newest(listFiles(dir, (name) => name.endsWith('.jsonl')), ctx.startedAt);
}

function findCodexTranscript(root, ctx) {
  if (ctx.transcriptPath && withinRoot(root, ctx.transcriptPath)) return ctx.transcriptPath;
  // The exact hook-provided session id is the common path. Keep a generous fallback for a CLI
  // version that omits it: date-sharded Codex roots can exceed a few hundred files over time.
  const files = listFiles(root, (name) => name.endsWith('.jsonl'), 5000);
  if (ctx.sessionId) {
    const id = String(ctx.sessionId).toLowerCase();
    const exact = files.find((file) => path.basename(file).toLowerCase().includes(id));
    if (exact && withinRoot(root, exact)) return exact;
  }
  const cwd = path.resolve(String(ctx.cwd || '')).toLowerCase();
  const matching = files.filter((file) => {
    const row = firstJson(file);
    const metaCwd = row && row.type === 'session_meta' && row.payload && row.payload.cwd;
    return metaCwd && path.resolve(String(metaCwd)).toLowerCase() === cwd;
  });
  return newest(matching, ctx.startedAt);
}

function findTranscript(ctx, homeDir) {
  const rs = roots(homeDir);
  if (ctx.harness === 'claude') return findClaudeTranscript(rs.claude, ctx);
  if (ctx.harness === 'codex') return findCodexTranscript(rs.codex, ctx);
  return null;
}

function readTailLines(file, maxBytes = TAIL_BYTES) {
  let fd;
  try {
    const stat = fs.statSync(file);
    const length = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - length);
    const buf = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    return text.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  } finally {
    try { if (fd != null) fs.closeSync(fd); } catch { /* noop */ }
  }
}

function assistantTexts(harness, lines, limit = MAX_MESSAGES) {
  const out = [];
  const seen = new Set();
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    let text = '';
    if (harness === 'claude' && row.type === 'assistant' && row.message && row.message.role === 'assistant') {
      text = (Array.isArray(row.message.content) ? row.message.content : [])
        .filter((part) => part && part.type === 'text')
        .map((part) => String(part.text || ''))
        .join('\n');
    } else if (harness === 'codex' && row.type === 'response_item' && row.payload && row.payload.role === 'assistant') {
      text = (Array.isArray(row.payload.content) ? row.payload.content : [])
        .filter((part) => part && (part.type === 'output_text' || part.type === 'text'))
        .map((part) => String(part.text || part.value || ''))
        .join('\n');
    }
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function extractFencedBlocks(text) {
  const out = [];
  const re = /(?:^|\n)(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)\r?\n\1(?=\r?$|\n)/gm;
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    const content = match[3];
    if (!content || Buffer.byteLength(content, 'utf8') > MAX_BLOCK_BYTES) continue;
    const info = String(match[2] || '').trim();
    const language = (info.split(/\s+/, 1)[0] || 'text').toLowerCase();
    out.push({ language, content });
  }
  return out;
}

function listSuggestedCommands(ctx, { homeDir } = {}) {
  if (!ctx || !ctx.cwd || !['claude', 'codex'].includes(ctx.harness)) return { ok: false, blocks: [], reason: 'unsupported-session' };
  const file = findTranscript(ctx, homeDir);
  if (!file) return { ok: true, blocks: [], reason: 'transcript-not-found' };
  const texts = assistantTexts(ctx.harness, readTailLines(file));
  const blocks = [];
  const seen = new Set();
  for (let messageIndex = 0; messageIndex < texts.length && blocks.length < MAX_BLOCKS; messageIndex++) {
    for (const block of extractFencedBlocks(texts[messageIndex])) {
      if (seen.has(block.content)) continue;
      seen.add(block.content);
      blocks.push({ ...block, messageIndex });
      if (blocks.length >= MAX_BLOCKS) break;
    }
  }
  return { ok: true, blocks, source: path.basename(file) };
}

module.exports = {
  roots, withinRoot, claudeProjectDir, readTailLines, assistantTexts, extractFencedBlocks,
  findTranscript, listSuggestedCommands,
};
