#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recallExact, formatRecall } from './lib/recall-core.mjs';
import { resolveRoots } from './lib/brain-sync/roots.mjs';

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
  return args[index + 1];
};
try {
  const roots = resolveRoots({ brainRoot: valueFor('--brain-root') || valueFor('--root') });
  const root = roots.brainRoot;
  const query = valueFor('--query') || args.filter((arg, index) => !arg.startsWith('--') && !['--root', '--brain-root', '--project', '--query', '--limit'].includes(args[index - 1]))[0];
  if (!query) throw new Error('Use --query <text>');
  const result = recallExact({ root, codeRoot: roots.codeRoot, query, project: valueFor('--project'), limit: Number(valueFor('--limit') || 4) });
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(result)}\n` : formatRecall(result));
} catch (error) {
  process.stderr.write(`recall: ${error.message}\n`);
  process.exitCode = 1;
}
