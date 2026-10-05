#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildBootContext } from './lib/boot-context-core.mjs';
import { recallExact } from './lib/recall-core.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturePath = path.join(root, 'projects', 'mavis-brain', 'specs', 'boot-recall-optimization', 'fixture-50.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
if (fixture.length < 50) throw new Error(`Expected at least 50 real prompts; found ${fixture.length}`);

const rows = fixture.map((sample) => {
  if (sample.expected && !fs.existsSync(path.join(root, ...sample.expected.split('/')))) {
    throw new Error(`Fixture target missing: ${sample.expected}`);
  }
  const start = performance.now();
  let paths;
  let bytes;
  let readPaths;
  if (sample.class === 'project') {
    const selected = buildBootContext({ root, explicitProject: sample.query.replace(/^mavis\s+/i, ''), today: '2026-09-26' });
    paths = selected.project ? [`projects/${selected.project.slug}/index.md`] : [];
    bytes = Buffer.byteLength(JSON.stringify(selected), 'utf8');
    readPaths = paths;
  } else {
    const result = recallExact({ root, query: sample.query, limit: 3 });
    paths = result.results.map((item) => item.path);
    readPaths = result.results.filter((item) => item.detail !== null).map((item) => item.path);
    bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  }
  const ms = performance.now() - start;
  return { class: sample.class, query: sample.query, expected: sample.expected, paths, top1: Boolean(sample.expected && paths[0] === sample.expected), hit3: Boolean(sample.expected && paths.includes(sample.expected)), irrelevantCandidates: sample.expected === null ? paths.length : paths.filter((p) => p !== sample.expected).length, irrelevantReads: sample.expected === null ? readPaths.length : readPaths.filter((p) => p !== sample.expected).length, bytes, ms };
});

function summarize(items) {
  const positives = items.filter((r) => r.expected !== null);
  const sorted = items.map((r) => r.ms).sort((a, b) => a - b);
  const pick = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    cases: items.length,
    positiveCases: positives.length,
    top1: positives.filter((r) => r.top1).length,
    recallAt3: positives.filter((r) => r.hit3).length,
    noSourceCases: items.length - positives.length,
    irrelevantCandidates: items.reduce((sum, r) => sum + r.irrelevantCandidates, 0),
    irrelevantDetailReads: items.reduce((sum, r) => sum + r.irrelevantReads, 0),
    medianMs: Number(pick(0.5).toFixed(3)),
    p95Ms: Number(pick(0.95).toFixed(3)),
    medianBytes: [...items].map((r) => r.bytes).sort((a, b) => a - b)[Math.floor(items.length / 2)],
  };
}

const byClass = Object.fromEntries([...new Set(rows.map((r) => r.class))].map((kind) => [kind, summarize(rows.filter((r) => r.class === kind))]));
const output = { fixture: path.relative(root, fixturePath).replace(/\\/g, '/'), total: summarize(rows), byClass, misses: rows.filter((r) => r.expected && !r.hit3).map(({ class: kind, query, expected, paths }) => ({ class: kind, query, expected, paths })) };
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
