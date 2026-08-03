'use strict';

// PM API token in userData/pm-token.json. Encrypted at rest via Electron safeStorage when
// available (OS keychain / DPAPI). Never logged; renderer only ever sees {present, maskedTail}.
//
// About the fallback when safeStorage is unavailable — read this before trusting `{ mode: 0o600 }`:
//
//   0o600 is a POSIX permission bit. On Windows Node does NOT translate it into an ACL; it only
//   maps the write bit to the read-only file attribute. So on Windows the mode buys NOTHING, and a
//   plaintext token in userData is readable by every process running as this user. This is a
//   Windows-primary app, so that is the case that matters.
//
// Hence the split below: we fail CLOSED on Windows (refuse to store rather than store in the
// clear), and keep the plaintext path only where the mode is actually enforced (POSIX) or where
// there is no Electron at all (unit tests — require('electron') is a path string outside Electron,
// so safeStorage is undefined). In practice the Windows branch is nearly unreachable: DPAPI is
// always available to a real Electron app, so isEncryptionAvailable() returning false there means
// something is genuinely wrong and silently downgrading to plaintext is the wrong answer.

const fs = require('fs');
const path = require('path');
// In a non-Electron context (unit tests) require('electron') is a path string, so
// safeStorage is undefined.
const { safeStorage } = require('electron');

const file = (d) => path.join(d, 'pm-token.json');
const hasSafeStorage = () => !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function');
const canEncrypt = () => {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
};
// Storing in the clear is only acceptable where the file mode is a real access control.
const plaintextIsRefused = () => hasSafeStorage() && process.platform === 'win32';

function getToken(userDataDir) {
  try {
    const o = JSON.parse(fs.readFileSync(file(userDataDir), 'utf8'));
    if (o && typeof o.enc === 'string') {
      if (!canEncrypt()) return null;
      try { return safeStorage.decryptString(Buffer.from(o.enc, 'base64')) || null; } catch { return null; }
    }
    return o && typeof o.token === 'string' && o.token ? o.token : null;
  } catch { return null; }
}

// `encrypted` lets the UI tell the user which of the two postures they are actually on, instead of
// the store deciding quietly on their behalf.
function tokenStatus(userDataDir) {
  const t = getToken(userDataDir);
  if (!t) return { present: false, maskedTail: '' };
  return { present: true, maskedTail: t.slice(-4), encrypted: canEncrypt() };
}

function setToken(userDataDir, t) {
  const token = String(t || '');
  // Fail closed rather than write a token no OS control protects. `error` is additive — callers
  // that only read {present, maskedTail} still see a correct "not stored".
  if (!canEncrypt() && plaintextIsRefused()) {
    return { present: false, maskedTail: '', error: 'no-encryption' };
  }
  try {
    // The `unprotected` marker makes the file self-describing: anyone who opens it can see the
    // contents were never encrypted, without having to know this module's rules.
    const payload = canEncrypt()
      ? { enc: safeStorage.encryptString(token).toString('base64') }
      : { token, unprotected: true };
    fs.writeFileSync(file(userDataDir), JSON.stringify(payload), { mode: 0o600 });
  } catch { /* best-effort */ }
  return tokenStatus(userDataDir);
}

function clearToken(userDataDir) {
  try { fs.unlinkSync(file(userDataDir)); } catch { /* already gone */ }
  return { present: false, maskedTail: '' };
}

module.exports = { getToken, setToken, clearToken, tokenStatus };
