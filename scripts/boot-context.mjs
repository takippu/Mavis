#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBootContext, formatBootContext } from './lib/boot-context-core.mjs';
import { resolveRoots, readJSON } from './lib/brain-sync/roots.mjs';
import { prepareBoot } from './lib/brain-sync/boot.mjs';

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
  const sync = await prepareBoot(roots);
  const result = buildBootContext({
    root,
    codeRoot: roots.codeRoot,
    projectOverrides: readJSON(path.join(roots.machineRoot, 'projects.json'), {}),
    expectIdentity: !!roots.config.restored || (!!roots.config.vault && roots.config.awaitingSetup === false),
    cwd: valueFor('--cwd') || process.cwd(),
    explicitProject: valueFor('--project'),
    today: valueFor('--today'),
  });
  result.sync = sync;
  if(sync.message && !args.includes('--json'))process.stderr.write(`brain-sync: ${sync.message}\n`);
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(result)}\n` : formatBootContext(result));
} catch (error) {
  process.stderr.write(`boot-context: ${error.message}\n`);
  process.exitCode = 1;
}
