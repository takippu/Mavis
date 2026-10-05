# Owner-run Cloudflare deployment

Deployment needs your own account and dedicated resources. The tool never uses the original author's account. Keep R2 public access disabled. This guide is separate from permission to seed personal memory.

From the Mavis checkout, generate a concrete preview:

```bash
node scripts/brain.mjs cloud setup --account YOUR_ACCOUNT_ID --name your-mavis-brain
```

The preview creates nothing. Review Workers, D1 and R2 costs/product access using the linked official pricing pages. Browser authentication and billing activation belong to the account owner. Save the preview with `--output <private-plan.json>`, then apply that exact reviewed plan with `cloud setup --apply-plan <private-plan.json>`. The CLI privately prompts for server secrets, rejects resource-name collisions, saves progress receipts and verifies private R2, health and unauthenticated refusal. Provider creation/resume and a synthetic two-device roundtrip were verified on 2026-10-05; each new owner's account still needs its own verification. The equivalent owner-run resource commands follow.

```bash
cd packages/brain-sync-worker
npm ci
npx wrangler login
npx wrangler whoami
npx wrangler r2 bucket create your-mavis-brain-private
npx wrangler d1 create your-mavis-brain-metadata
```

If a name already exists, stop and inspect its ownership; do not adopt it automatically. Record returned resource IDs in machine-local deployment receipts. Copy `wrangler.example.jsonc` to `wrangler.private.jsonc`, replace the name/bindings with the approved resources, add your account ID, and preserve the migrations directory. The private config is Git-ignored. Do not put any secrets into it.

```bash
npx wrangler secret put AUTH_PEPPER --config wrangler.private.jsonc
npx wrangler secret put BOOTSTRAP_TOKEN --config wrangler.private.jsonc
npx wrangler deploy --config wrangler.private.jsonc
```

Use the reviewed `cloud setup --apply-plan` provisioner for the schema: it stages LF SQL and uses D1's import parser with an atomic migration ledger. The live remote migrations/query splitter rejected valid trigger bodies; LF normalization alone did not resolve this deployment. Cloudflare has [related trigger-parser reports](https://github.com/cloudflare/workers-sdk/issues/15314). Local migrations continue to work normally.

Generate independent high-entropy random values locally and paste them into Wrangler's private prompts. Neither secret is a vault encryption key. Keep the one-time bootstrap value privately until the first-owner CLI enrollment succeeds, then remove it:

```bash
npx wrangler secret delete BOOTSTRAP_TOKEN --config wrangler.private.jsonc
```

Verify `/health`, refusal of unauthenticated vault/object requests, actual account/resource IDs and private bucket settings before calling a deployment live. Run synthetic memory acceptance first, including simultaneous commits, orphaned uploads, quota behavior and recovery. This repository's Miniflare tests prove local runtime behavior; they do not prove your cloud deployment.

For local development, use `wrangler.local.jsonc`, local D1 migrations and `.dev.vars` holding synthetic `AUTH_PEPPER`/`BOOTSTRAP_TOKEN`. Never use production secrets in fixtures. `npm test` runs Workers/D1/R2 integration without login. Committed revisions are retained; orphan cleanup and full retention maintenance require acceptance before production-scale use.

Deployment rollback must preserve both the database and object bucket. Never delete resources to roll back a code version. Independent client exports remain the recovery source if the service is lost. Provider metadata backup/restore rehearsal is a production gate.
