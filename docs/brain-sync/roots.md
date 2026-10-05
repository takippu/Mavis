# Code and data roots

Shared selection lives in `scripts/lib/brain-sync/roots.cjs`, re-exported for ESM. Code is resolved from the checkout. Data precedence is explicit `--brain-root`, `MAVIS_DATA_ROOT`, machine registration, then the legacy code checkout. Installer `MAVIS_BRAIN_ROOT` retains its earlier source-checkout meaning; Terminal's existing setting/environment retains its data selection meaning. New activation templates receive separate code/data placeholders.

| Consumer | Memory input | Code input / compatibility |
|---|---|---|
| Boot | Selected identity, rules, project/router, daily headings | Code setup instructions; recover/apply check and safe startup pull precede reads |
| Recall | Selected topics/preferences/rules/projects | Skill routing uses the code contract |
| Init | Selected target categories | Seeds from code; existing categories preserved |
| Lint | Selected data links/size/router/checkpoints | Contract synchronization checks code; migrated code projections preserve legacy relative links |
| Repair | Explicit root, environment/registration, legacy cwd | Executable code stays in checkout; backups go under selected data |
| Harness installer | Profile from selected data | Templates from selected source checkout; legacy source override remains supported |
| Terminal config | Existing explicit setting, environment or registration | Shared resolver located from source checkout or registered code location for packaged builds |
| Terminal readers/writers/watchers | Existing modules receive selected `BRAIN_ROOT` | Health executes code scripts with explicit data; skills/contracts use registered code; watcher events stay on memory |
| Project path display/selection | Machine-local `projects.json` override first | Sync projection omits top-level `path` and `last_accessed`; historical prose is preserved |

Migration previews hashes/bytes for brain directories, legacy topic files/setup marker and local backups. Apply validates source preimages, copies without removing originals, verifies destination hashes, creates local code projections and runs link/lint checks before optional cutover. Receipt/config rollback information stays machine-local. A failed copy preserves the source and partial destination; inspect the receipt and use a new empty destination rather than overwriting it. Rollback selects the preserved source; never delete it as cleanup.

```bash
node scripts/brain.mjs migrate --brain-root "OLD_BRAIN" --destination "NEW_EMPTY_BRAIN" --output "PRIVATE_PLAN.json"
node scripts/brain.mjs migrate --apply-plan "PRIVATE_PLAN.json" --cutover
node scripts/brain.mjs paths --project example --path "/Users/you/Projects/example"
```

The current real brain has not been migrated by implementation. Synthetic Windows fixtures verify separate-root init/boot/recall, copy migration and both installer renderings. A packaged Terminal without a discoverable compatible code checkout reports a migration blocker; native Mac executable packaging is deferred. Native Mac path/keychain behavior still requires its own acceptance run.
