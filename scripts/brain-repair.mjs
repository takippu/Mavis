// Brain repairer. Run from the brain root.
// Usage: node scripts/brain-repair.mjs rotate <project> (--dry-run [--json] | --apply [--json] [--plan=<file|->])
//        node scripts/brain-repair.mjs shard-notes <project> (--dry-run [--json] | --apply [--json] [--plan=<file|->])
//
// --dry-run never writes anything; --apply copies every original to
// _backup/repair-<timestamp>/ before writing. There is no auto-apply path:
// approval-before-mutations is the caller's job.
//
// --plan=<file> (or --plan=- for stdin) applies a plan previously emitted by
// --dry-run --json instead of re-planning from disk. Prefer it for any gated
// preview -> approve -> apply flow: without it the diff that was approved and the
// diff that runs are two separate reads of a tree other sessions also write to.
// Either way applyPlan verifies each precondition and refuses a stale plan.
import fs from 'node:fs';
import { planRotation, planShard, applyPlan } from './lib/brain-repair-core.mjs';

const argv = process.argv.slice(2);
const flagArgs = argv.filter((a) => a.startsWith('--'));
const flags = new Set(flagArgs.filter((a) => !a.includes('=')));
const planOpt = flagArgs.find((a) => a.startsWith('--plan='));
const [cmd, project] = argv.filter((a) => !a.startsWith('--'));
const dry = flags.has('--dry-run');
const apply = flags.has('--apply');
const json = flags.has('--json');
const planFile = planOpt ? planOpt.slice('--plan='.length) : null;
const root = process.cwd();

if (!['rotate', 'shard-notes'].includes(cmd) ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(project || '') ||
    dry === apply ||
    (planFile !== null && (!apply || planFile === ''))) {
  console.error('usage: brain-repair.mjs rotate|shard-notes <project> ' +
    '(--dry-run [--json] | --apply [--json] [--plan=<file|->])');
  process.exit(2);
}

let plan;
try {
  if (planFile) {
    plan = JSON.parse(fs.readFileSync(planFile === '-' ? 0 : planFile, 'utf8'));
    if (plan.command !== cmd || plan.project !== project) {
      throw new Error(`plan is for "${plan.command} ${plan.project}", not "${cmd} ${project}"`);
    }
    if (!Array.isArray(plan.writes)) throw new Error('plan has no writes array');
  } else {
    plan = cmd === 'rotate' ? planRotation(root, project) : planShard(root, project);
  }
} catch (e) {
  console.error(`${cmd} ${project}: ${e.message}`);
  process.exit(1);
}

if (dry) {
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`${cmd} ${project}: ${JSON.stringify(plan.summary)}`);
    for (const w of plan.writes) console.log(`  would write ${w.path} (${Buffer.byteLength(w.after)} bytes)`);
    console.log('  (dry run — nothing written)');
  }
} else {
  let backupDir;
  try {
    ({ backupDir } = applyPlan(root, plan));
  } catch (e) {
    console.error(`${cmd} ${project}: ${e.message}`);
    process.exit(1);
  }
  const out = { applied: true, summary: plan.summary, backupDir: backupDir.replace(/\\/g, '/') };
  console.log(json ? JSON.stringify(out, null, 2) : `applied; originals in ${out.backupDir}`);
}
