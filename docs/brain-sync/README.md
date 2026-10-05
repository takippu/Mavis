# Mavis Brain Sync

The portable CLI and Cloudflare service ship in the Mavis code checkout. Private memory stays on disk as Markdown, with supported referenced PNG/JPEG/WebP/GIF images and PDFs. Uploads occur only through explicit `push` or `sync` commands. AES-GCM encrypts content and manifest paths before transmission; the service stores opaque ciphertext in private R2 and revision metadata in D1.

This is an implementation under local acceptance. Read [acceptance.md](acceptance.md) before production use. Native Mac credential storage and live provider acceptance require verification on those systems. Existing local memory is usable without sync.

## Owner setup

Use Node 22 or later. Clone the code; keep the private data folder outside Git for new installations. Deploy a dedicated service using [cloudflare.md](cloudflare.md). Deploying code does not upload memory. The account owner handles Cloudflare login, product/billing activation and secret custody.

Initialize after obtaining your service HTTPS origin:

```powershell
node scripts/brain.mjs init --brain-root "C:/Users/You/MavisBrain" --endpoint "https://your-service.workers.dev"
```

For an existing colocated brain, use its current directory initially. Initialization seeds missing categories without replacing existing entries. Run the Mavis setup wizard only if this is a genuinely new identity. Do not run setup/reset on a failed restoration. Initialization privately protects keys with Windows DPAPI, macOS Keychain, or a passphrase-encrypted Linux file; keys are never silently written as plaintext.

Run `bootstrap` in your own terminal, enter the one-time bootstrap secret privately, then remove the server bootstrap secret. Export a protected recovery bundle to independent private storage before the first upload. Its unlocking secret is entered privately; do not send it to Mavis in chat.

```powershell
node scripts/brain.mjs bootstrap
node scripts/brain.mjs export --output "D:/Private/mavis-recovery.enc.json"
node scripts/brain.mjs push --dry-run
node scripts/brain.mjs push
```

Review the actual first-upload paths and bytes. Secret filename filters and the content scanner are safeguards, not proof that every authored document is secret-free. Missing/out-of-root attachment references fail the scan; move assets into an allowed brain directory or fix the link deliberately. Arbitrary binaries, executable files, SVG/HTML and unreferenced attachments are excluded. Limits are 8 MiB per Markdown document, 24 MiB per supported attachment, 10,000 files and 512 MiB reserved ciphertext per deployment. JSON/base64 envelopes add storage overhead. Nothing raises these caps automatically.

Machine configuration is separate from memory: Windows `%LOCALAPPDATA%/Mavis/brain-sync`, macOS `~/Library/Application Support/Mavis/brain-sync`, Linux `${XDG_CONFIG_HOME:-~/.config}/mavis/brain-sync`. `MAVIS_SYNC_HOME` selects an isolated registration for testing or another owner. Data precedence is `--brain-root`, `MAVIS_DATA_ROOT`, registered root, legacy checkout. Never share this entire machine folder between operating systems; use invitation/recovery instead.

## Second laptop

On the enrolled owner device:

```powershell
node scripts/brain.mjs invite --output "D:/Private/mac-invitation.enc.json"
```

Privately transfer the encrypted invitation and its unlocking secret through separate private channels. Invitations expire after ten minutes and enroll one device once. The recipient needs the Mavis checkout and Node, but no Cloudflare deployment credentials or model API key.

```bash
node scripts/brain.mjs connect --input "$HOME/Private/mac-invitation.enc.json" --brain-root "$HOME/MavisBrain"
node scripts/brain.mjs pull
node scripts/install-harness.mjs --harness both --global
```

Inspect the install preview, then repeat with `--yes` to install activation. The recipient directory must be empty. Connection installs keys/credentials and a trusted receipt; it does not reset identity or upload local files. Pull before activation. A fresh device needs the privately supplied receipt for rollback detection; encryption alone cannot prove an untrusted server is showing the latest revision.

## Everyday use

Say “push my brain”, “pull my brain”, “sync my brain”, “brain status” or “brain history” to Mavis. Both harnesses route these to the same CLI. The installed activation must be refreshed after this code update. The selected data root contains identity/memory; executable scripts, skills and contracts come from code.

`status` reports local pending paths. `status --remote` authenticates with the service. `push` refuses a changed remote head. `pull` checks base/local/remote and applies none of a revision if divergent paths remain unresolved. Conflict copies are protected machine-local files outside recall. Choosing local keeps that version pending against the new base; choosing remote applies the remote version. Neither timestamps nor force overwrites resolve conflicts.

```bash
node scripts/brain.mjs pull --dry-run
node scripts/brain.mjs conflicts --resolve "projects/example/notes.md" --choose local
node scripts/brain.mjs sync
node scripts/brain.mjs history
node scripts/brain.mjs restore --revision "OPAQUE_REVISION_ID" --dry-run
```

Use `doctor` to inspect an interrupted operation; `doctor --recover` refuses a live lock and restores or finishes a journaled local apply. Backups live outside the active brain. Direct editors must cooperate with save markers; the client checks preimages but does not claim to lock arbitrary agents/editors. A configured save brackets the paired write with `save begin`, lints, then `save finish`. Explicit mode never uploads from save completion.

Offline exports contain canonical scoped content and epoch keys, without device/provider credentials. `import --input <file> --brain-root <empty-directory>` restores independently of Cloudflare. Imported copies need fresh enrollment before remote access. Restore creates a new head from an old snapshot. Review its preview and pull afterward to apply that head locally. Keep independent exports: the server operator can delete ciphertext or deny availability.

Revocation prevents future API access but does not erase copied plaintext or keys. Owner `key rotate --dry-run` previews a complete re-encryption into the next epoch; `key rotate` commits it. Privately use `key export` and `key import` to rekey remaining authorized devices, or invite a new one. Local tests prove old keys cannot decrypt the new head; native Mac/provider acceptance remains open. Never transfer the new bundle to a revoked device.

## Troubleshooting

Exit 2: input/configuration or lint; 3: conflict/stale head; 4: offline/timeout; 5: authentication/revocation; 6: incompatible version; 7: corrupt/interrupted state; 8: quota/limits. Commands leave local files pending on network/auth failures. Linux startup cannot unlock a passphrase interactively and falls back to local memory. Do not delete keys or journals to make an error disappear. Retained committed history is not pruned automatically.
