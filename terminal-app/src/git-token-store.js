'use strict';

// Per-provider git host tokens (GitHub / GitLab PAT) in userData/git-<provider>-token.json.
// Encrypted at rest via Electron safeStorage (OS keychain/DPAPI) — same posture as token-store.js,
// including its fail-closed rule, which the long comment there explains in full. The short version:
// `{ mode: 0o600 }` is a POSIX permission bit and a NO-OP on Windows (Node maps it to the read-only
// attribute, not to an ACL), so on Windows a plaintext token would be readable by any process
// running as this user. We therefore refuse to store rather than store unprotected, and keep the
// plaintext path only where the mode is real (POSIX) or where there is no Electron (unit tests).
// The renderer only ever sees { present, maskedTail, encrypted }.

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const PROVIDERS = ['github', 'gitlab'];
const file = (d, provider) => path.join(d, `git-${provider}-token.json`);
const hasSafeStorage = () => !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function');
const canEncrypt = () => { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; } };
const plaintextIsRefused = () => hasSafeStorage() && process.platform === 'win32';
const okProvider = (p) => PROVIDERS.includes(p);

function getToken(userDataDir, provider) {
  if (!okProvider(provider)) return null;
  try {
    const o = JSON.parse(fs.readFileSync(file(userDataDir, provider), 'utf8'));
    if (o && typeof o.enc === 'string') {
      if (!canEncrypt()) return null;
      try { return safeStorage.decryptString(Buffer.from(o.enc, 'base64')) || null; } catch { return null; }
    }
    return o && typeof o.token === 'string' && o.token ? o.token : null;
  } catch { return null; }
}

function tokenStatus(userDataDir, provider) {
  const t = getToken(userDataDir, provider);
  if (!t) return { present: false, maskedTail: '' };
  return { present: true, maskedTail: t.slice(-4), encrypted: canEncrypt() };
}

function setToken(userDataDir, provider, t) {
  if (!okProvider(provider)) return { present: false, maskedTail: '' };
  const token = String(t || '');
  // Fail closed rather than write a PAT no OS control protects (see the header comment).
  if (!canEncrypt() && plaintextIsRefused()) return { present: false, maskedTail: '', error: 'no-encryption' };
  try {
    // `unprotected` makes the on-disk file self-describing about which posture wrote it.
    const payload = canEncrypt()
      ? { enc: safeStorage.encryptString(token).toString('base64') }
      : { token, unprotected: true };
    fs.writeFileSync(file(userDataDir, provider), JSON.stringify(payload), { mode: 0o600 });
  } catch { /* best-effort */ }
  return tokenStatus(userDataDir, provider);
}

function clearToken(userDataDir, provider) {
  if (okProvider(provider)) { try { fs.unlinkSync(file(userDataDir, provider)); } catch { /* gone */ } }
  return { present: false, maskedTail: '' };
}

module.exports = { PROVIDERS, getToken, setToken, clearToken, tokenStatus };
