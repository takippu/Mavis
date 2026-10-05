import { randomBytes, createCipheriv, createDecipheriv, hkdfSync, createHash, createHmac, timingSafeEqual, scryptSync } from 'node:crypto';

export const VERSION = 1;
export const id = () => randomBytes(32).toString('base64url');
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function key(master, vault, domain) {
  if (master.length !== 32) throw new Error('Invalid master key');
  return Buffer.from(hkdfSync('sha256', master, vault, `mavis-brain/v1/${domain}`, 32));
}
export function encrypt(bytes, master, vault, epoch = 1, kind = 'document') {
  if(!/^[A-Za-z0-9_-]{43}$/.test(vault) || !Number.isSafeInteger(epoch) || epoch<1 || !['document','attachment','manifest'].includes(kind))throw new Error('Invalid encryption domain');
  if(bytes.length>(kind==='attachment'?24:8)*1024*1024)throw new Error('Plaintext object exceeds limit');
  const objectId = id();
  const nonce = randomBytes(12);
  const header = { version: VERSION, vault, epoch, kind, id: objectId };
  const cipher = createCipheriv('aes-256-gcm', key(master, vault, `${epoch}/${kind}/${objectId}`), nonce);
  cipher.setAAD(Buffer.from(canonical(header)));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const data = Buffer.from(canonical({ ...header, nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), body: body.toString('base64url') }));
  return { id: objectId, epoch, kind, hash: hash(data), bytes: data.length, data };
}
export function decrypt(data, master, expected) {
  if (data.length > 48 * 1024 * 1024 || hash(data) !== expected.hash) throw new Error('Ciphertext integrity failure');
  const envelope = JSON.parse(data.toString('utf8'));
  const { version, vault, epoch, kind, id: objectId } = envelope;
  if (version !== VERSION || vault !== expected.vault || epoch !== expected.epoch || kind !== expected.kind || objectId !== expected.id) throw new Error('Object binding failure');
  const nonce = Buffer.from(envelope.nonce, 'base64url'), tag = Buffer.from(envelope.tag, 'base64url');
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid encryption envelope');
  const cipher = createDecipheriv('aes-256-gcm', key(master, vault, `${epoch}/${kind}/${objectId}`), nonce);
  cipher.setAAD(Buffer.from(canonical({ version, vault, epoch, kind, id: objectId })));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(Buffer.from(envelope.body, 'base64url')), cipher.final()]);
}
export function sign(commit, master, vault, epoch) {
  return createHmac('sha256', key(master, vault, `${epoch}/commit`)).update(canonical(commit)).digest('hex');
}
export function verify(commit, mac, master, vault, epoch) {
  const a = Buffer.from(sign(commit, master, vault, epoch), 'hex'), b = Buffer.from(mac || '', 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Commit authentication failure');
}
export function sealRecovery(value, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('Recovery passphrase needs at least 12 characters');
  const salt = randomBytes(16), nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }), nonce);
  cipher.setAAD(Buffer.from('mavis-recovery/v1'));
  const body = Buffer.concat([cipher.update(canonical(value)), cipher.final()]);
  return { version: VERSION, kdf: { name: 'scrypt', N: 131072, r: 8, p: 1 }, salt: salt.toString('base64url'), nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), body: body.toString('base64url') };
}
export function openRecovery(envelope, passphrase) {
  if (envelope.version !== VERSION || canonical(envelope.kdf) !== canonical({ name: 'scrypt', N: 131072, r: 8, p: 1 }) || typeof envelope.body !== 'string' || envelope.body.length > 800 * 1024 * 1024) throw new Error('Invalid recovery envelope');
  const salt = Buffer.from(envelope.salt, 'base64url'), nonce = Buffer.from(envelope.nonce, 'base64url'), tag = Buffer.from(envelope.tag, 'base64url');
  if (salt.length !== 16 || nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid recovery envelope');
  const cipher = createDecipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }), nonce);
  cipher.setAAD(Buffer.from('mavis-recovery/v1')); cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.body, 'base64url')), cipher.final()]).toString('utf8'));
}
