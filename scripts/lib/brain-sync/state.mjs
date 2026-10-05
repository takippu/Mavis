import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { hash, canonical, sealRecovery, openRecovery } from './crypto.mjs';
import { safeFile } from './scope.mjs';

export function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
export const writeJSON = (file, value) => atomicWrite(file, canonical(value) + '\n');
export async function withLock(directory, operation) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'lock');
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); } catch (e) {
    if (e.code === 'EEXIST') throw Object.assign(new Error('Sync lock exists; doctor must verify recovery before removing a stale lock'), { code: 'LOCKED', exitCode: 7 });
    throw e;
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created: new Date().toISOString() })); fs.closeSync(fd);
  try { return await operation(); } finally { fs.unlinkSync(file); }
}
function adapter(program, args, input) {
  const result = spawnSync(program, args, { input, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Operating-system credential adapter failed; no plaintext fallback was written');
  return result.stdout.trim();
}
export function storeSecrets(directory, secrets, passphrase) {
  const json = canonical(secrets);
  if (process.platform === 'win32') {
    const script = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Security; $data=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
    const protectedData = adapter('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], Buffer.from(json).toString('base64'));
    writeJSON(path.join(directory, 'secrets.json'), { adapter: 'dpapi', data: protectedData });
  } else if (process.platform === 'darwin') {
    // Pass secret input over stdin to Security.framework through Python; never process arguments.
    const script = `import ctypes,sys\ns=ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')\nv=sys.stdin.buffer.read(); service=b'mavis-brain-sync'; account=sys.argv[1].encode()\ns.SecKeychainAddGenericPassword.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_char_p,ctypes.c_uint32,ctypes.c_char_p,ctypes.c_uint32,ctypes.c_char_p,ctypes.c_void_p]\nr=s.SecKeychainAddGenericPassword(None,len(service),service,len(account),account,len(v),v,None)\nsys.exit(0 if r==0 else 1)`;
    const account = randomUUID(); adapter('python3', ['-c', script, account], json);
    writeJSON(path.join(directory, 'secrets.json'), { adapter: 'keychain', account });
  } else {
    if (!passphrase) throw new Error('Linux requires an unlocked recovery passphrase; plaintext key storage is unsupported');
    writeJSON(path.join(directory, 'secrets.json'), { adapter: 'encrypted-file', data: sealRecovery(secrets, passphrase) });
  }
}
export function loadSecrets(directory, passphrase) {
  const envelope = JSON.parse(fs.readFileSync(path.join(directory, 'secrets.json'), 'utf8'));
  if (envelope.adapter === 'dpapi' && process.platform === 'win32') {
    const script = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Security; $data=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
    return JSON.parse(adapter('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], envelope.data));
  }
  if (envelope.adapter === 'keychain' && process.platform === 'darwin') return JSON.parse(adapter('security', ['find-generic-password', '-s', 'mavis-brain-sync', '-a', envelope.account, '-w']));
  if (envelope.adapter === 'encrypted-file') return openRecovery(envelope.data, passphrase);
  throw new Error('Credential adapter belongs to another operating system; import a recovery bundle');
}
export function currentHash(root, relative) {
  try { return hash(fs.readFileSync(safeFile(root, relative))); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function applyJournal(root, directory, changes, remoteFiles, checkpoint = null) {
  const journalFile = path.join(directory, 'apply.json');
  if (fs.existsSync(journalFile)) throw new Error('Interrupted apply requires recovery');
  const transaction = path.join(directory, 'transactions', randomUUID());
  fs.mkdirSync(transaction, { recursive: true, mode: 0o700 });
  const entries = changes.map((change, index) => {
    const before = currentHash(root, change.path);
    if (before !== change.originalHash) throw new Error(`Local file changed before apply: ${change.path}`);
    const original = before === null ? null : fs.readFileSync(safeFile(root, change.path));
    if (original) atomicWrite(path.join(transaction, `${index}.before`), original);
    const data = remoteFiles[change.path]?.data || null;
    if (data) atomicWrite(path.join(transaction, `${index}.after`), data);
    return { path: change.path, before, after: data === null ? null : hash(data), index };
  });
  const journal = { root, transaction, entries, completed: 0, checkpoint };
  writeJSON(journalFile, journal);
  for (const entry of entries) {
    if (currentHash(root, entry.path) !== entry.before) throw new Error('Concurrent edit interrupted apply; recover journal');
    const destination = safeFile(root, entry.path);
    if (entry.after === null) fs.unlinkSync(destination);
    else atomicWrite(destination, fs.readFileSync(path.join(transaction, `${entry.index}.after`)));
    journal.completed++; writeJSON(journalFile, journal);
  }
  // Caller checkpoints its new base before removing the journal.
  return () => fs.unlinkSync(journalFile);
}
export function recoverJournal(root, directory) {
  const file = path.join(directory, 'apply.json');
  if (!fs.existsSync(file)) return { recovered: false };
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (journal.root !== root || !path.resolve(journal.transaction).startsWith(path.resolve(directory, 'transactions') + path.sep)) throw new Error('Invalid apply journal');
  const stateFile=path.join(directory,'state.json');
  const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
  if(journal.checkpoint && state?.head===journal.checkpoint.next.head && journal.entries.every(entry=>currentHash(root,entry.path)===entry.after)) {
    fs.unlinkSync(file); return {recovered:true,completed:true};
  }
  for (const entry of journal.entries) {
    const actual = currentHash(root, entry.path);
    if (actual !== entry.before && actual !== entry.after) throw new Error('Recovery found an external edit; preserve journal and resolve manually');
  }
  for (const entry of journal.entries) {
    if (currentHash(root, entry.path) === entry.before) continue;
    const target = safeFile(root, entry.path);
    if (entry.before === null) fs.unlinkSync(target);
    else {
      const original = fs.readFileSync(path.join(journal.transaction, `${entry.index}.before`));
      if (hash(original) !== entry.before) throw new Error('Recovery backup integrity failure');
      atomicWrite(target, original);
    }
  }
  fs.unlinkSync(file);
  if(journal.checkpoint) writeJSON(stateFile,journal.checkpoint.before);
  return { recovered: true };
}
