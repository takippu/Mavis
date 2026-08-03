// Core for scripts/init-brain.mjs -- seed the three two-tier categories from seeds/ on a
// fresh clone. Pure planning + apply, no CLI concerns, so it can be tested against a tmpdir.
//
// WHY THIS EXISTS AT ALL. SETUP.md used to hand the AI a shell one-liner per platform:
//   bash:       cp -r seeds/<cat>/. <cat>/          (correct -- preserves _details/)
//   PowerShell: Copy-Item -Recurse seeds/<cat>/* <cat>/
// The PowerShell form FLATTENS. `seeds/rules/_details/entry-lifecycle.md` lands at
// `rules/entry-lifecycle.md`, because -Recurse with a `*` source enumerates leaves and copies
// them into the destination root rather than mirroring the tree. Copy-Item exits 0, so the
// corruption is silent -- and the result is a brain whose rules/_index.md points at four
// `_details/<slug>.md` paths that do not exist, three of which AGENTS.md hard-references as
// shipped contract procedure. Windows is this project's primary platform, so the broken form
// was the one most users would run.
//
// A script removes the whole class: one code path, same result on every platform, idempotent,
// and it can assert afterwards that the links it just laid down actually resolve.
import fs from 'node:fs';
import path from 'node:path';

// The three trigger-routed two-tier categories. Order is display order, not dependency order.
export const CATEGORIES = ['preferences', 'rules', 'topics'];

// A category is considered "already installed" iff its _index.md exists. Per SETUP.md that file
// is the marker: a prior install may hold real learned entries, and re-seeding over them would
// destroy user knowledge. Presence of the DIRECTORY is deliberately not the test -- an empty
// `topics/` left behind by a half-finished setup should still get its seed.
function indexPath(brainRoot, category) {
  return path.join(brainRoot, category, '_index.md');
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err; // EACCES/EISDIR/... are real problems; do not report them as "absent"
  }
}

// Walk a seed directory into a flat list of {from, to} pairs with the tree structure encoded in
// the relative path. This is the piece the PowerShell one-liner got wrong, so it is the piece
// that gets an explicit, testable implementation.
function collectSeedFiles(seedDir, targetDir) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, childRel);
      else if (entry.isFile()) out.push({ from: abs, to: path.join(targetDir, childRel), rel: childRel });
    }
  };
  walk(seedDir, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Decide what a fresh install needs, without touching disk.
 *
 * Returns { seedsPresent, categories: [{ name, status, files, mkdirs }], problems }
 * status is one of:
 *   'seed'    -- _index.md absent, the seed tree will be laid down
 *   'present' -- _index.md already there, seed skipped (only _details/ is ensured)
 *   'noseed'  -- _index.md absent AND no seed ships for it (caller must fall back to SETUP.md prose)
 */
export function planInit(brainRoot) {
  const seedsRoot = path.join(brainRoot, 'seeds');
  const seedsPresent = exists(seedsRoot);
  const categories = [];
  const problems = [];

  for (const name of CATEGORIES) {
    const target = path.join(brainRoot, name);
    const detailsDir = path.join(target, '_details');
    const alreadyInstalled = exists(indexPath(brainRoot, name));
    const seedDir = path.join(seedsRoot, name);
    const hasSeed = seedsPresent && exists(seedDir);

    // _details/ is ensured in every case. For preferences and topics the seed ships only an
    // _index.md, and SETUP.md requires the empty _details/ to exist so the first learned entry
    // has somewhere to land without the writer having to mkdir -p first.
    const mkdirs = exists(detailsDir) ? [] : [detailsDir];

    let status;
    let files = [];
    if (alreadyInstalled) {
      status = 'present';
    } else if (hasSeed) {
      status = 'seed';
      // Never overwrite: a file that somehow already exists under an absent _index.md is left
      // alone and reported, rather than being clobbered by the seed.
      files = collectSeedFiles(seedDir, target).filter((f) => {
        if (exists(f.to)) {
          problems.push(`${name}: ${path.relative(brainRoot, f.to)} already exists, left untouched`);
          return false;
        }
        return true;
      });
    } else {
      status = 'noseed';
      problems.push(`${name}: no seed at seeds/${name}/ -- fall back to the header preamble in SETUP.md`);
    }

    categories.push({ name, status, files, mkdirs });
  }

  return { seedsPresent, categories, problems };
}

/** Execute a plan from planInit. Returns { created: string[], mkdirs: string[] }. */
export function applyInit(brainRoot, plan) {
  const created = [];
  const mkdirs = [];

  for (const cat of plan.categories) {
    for (const { from, to } of cat.files) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // 'wx' refuses to write through an existing file OR a symlink that reappeared between
      // planning and applying -- the same trap sync-contract.mjs and install-harness.mjs guard.
      // The seed content is small, so a plain read+write is fine; no atomic rename needed
      // because a partial file here is discarded and re-seeded on the next run.
      fs.writeFileSync(to, fs.readFileSync(from), { flag: 'wx' });
      created.push(path.relative(brainRoot, to));
    }
    for (const dir of cat.mkdirs) {
      fs.mkdirSync(dir, { recursive: true });
      mkdirs.push(path.relative(brainRoot, dir));
    }
  }

  return { created, mkdirs };
}

/**
 * Assert that every `_details/<slug>.md` link in each category's _index.md resolves on disk.
 *
 * This is the check that would have caught the flattening bug the day it shipped. It runs after
 * apply, so the script cannot report success over a corrupt tree.
 *
 * Returns [{ category, link, resolved, ok }]. Categories with no _index.md are skipped silently
 * (nothing was installed, so there is nothing to verify).
 */
export function verifyDetailLinks(brainRoot) {
  const results = [];
  for (const name of CATEGORIES) {
    const idx = indexPath(brainRoot, name);
    if (!exists(idx)) continue;
    const body = fs.readFileSync(idx, 'utf8');
    // Matches the `**Detail:** [text](_details/slug.md)` form the schema mandates. Only the
    // target inside the parens matters; the label is free text and is ignored.
    for (const m of body.matchAll(/\]\((_details\/[^)]+\.md)\)/g)) {
      const link = m[1];
      const resolved = path.join(brainRoot, name, link);
      results.push({ category: name, link, resolved, ok: exists(resolved) });
    }
  }
  return results;
}
