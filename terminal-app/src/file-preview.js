'use strict';

const BYTE_LIMIT = 64 * 1024;
const IMAGE_LIMIT = 20 * 1024 * 1024;
function imageMime(b) {
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 26 && b.toString('ascii', 0, 2) === 'BM' && [12, 40, 108, 124].includes(b.readUInt32LE(14))) return 'image/bmp';
  if (b.length >= 4 && b.readUInt32LE(0) === 0x00010000) return 'image/x-icon';
  if (b.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(b.toString('ascii', 8, 12))) return 'image/avif';
  return null;
}
function bytePreview(b, size) {
  const bytes = b.subarray(0, BYTE_LIMIT), rows = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    rows.push(i.toString(16).padStart(8, '0') + '  ' + [...row].map(n => n.toString(16).padStart(2, '0')).join(' ').padEnd(47) + '  ' + [...row].map(n => n >= 32 && n <= 126 ? String.fromCharCode(n) : '.').join(''));
  }
  return { kind: 'binary', text: rows.join('\n'), truncated: size > bytes.length, shown: bytes.length };
}
module.exports = { imageMime, bytePreview, BYTE_LIMIT, IMAGE_LIMIT };
