import { ImageError } from './errors.js';

/**
 * Minimal ZIP writer (STORE, no compression): images are already compressed, so deflate would only cost time.
 * Pure + dependency-free. Output is a Blob assembled from parts, so file data is never copied into one big buffer.
 */
// Slice-by-8 tables: T[k*256 + n] = CRC of byte n followed by k zero bytes. Eight bytes per step instead of one.
const T = (() => {
  const t = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  for (let n = 0; n < 256; n++) { let c = t[n]; for (let k = 1; k < 8; k++) { c = t[c & 255] ^ (c >>> 8); t[k * 256 + n] = c >>> 0; } }
  return t;
})();

/** CRC-32 (IEEE). Pass the previous value as `prev` to continue across chunks. Same result as the byte-at-a-time form, ~2x faster (see bench/). */
export function crc32(b, prev = 0) {
  let c = (prev ^ 0xffffffff) | 0, i = 0;
  const n = b.length, end = n - (n & 7);
  for (; i < end; i += 8) {
    const lo = c ^ (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));
    c = T[1792 + (lo & 255)] ^ T[1536 + ((lo >>> 8) & 255)] ^ T[1280 + ((lo >>> 16) & 255)] ^ T[1024 + (lo >>> 24)]
      ^ T[768 + b[i + 4]] ^ T[512 + b[i + 5]] ^ T[256 + b[i + 6]] ^ T[b[i + 7]];
  }
  for (; i < n; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const ZIP_MAX_ENTRIES = 65535;
const U32 = 0xffffffff;

export function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return { date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1) };
}

const badZip = (why) => new ImageError('zip-invalid', 'The ZIP file did not pass its own check (' + why + '), so it was not offered. Download the files one by one instead.');

/** A ZIP entry name must be a plain relative path: no drive letters, no leading "/", no "..", no empty parts, no backslashes, no control characters. */
export function isSafeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 1024) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(name) || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return name.split('/').every((part) => part && part !== '.' && part !== '..');
}

const tooBig = () => new ImageError('zip-too-big', 'The ZIP would be too large to build in the browser. Download the files one by one instead.');

/** entries: [{ name: string (UTF-8, '/' separators), data: Blob | Uint8Array }]. Returns a Blob (application/zip). */
export async function buildZip(entries, { now = new Date(), isCancelled = () => false } = {}) {
  if (!entries.length) throw new ImageError('zip-empty', 'There is nothing to put in the ZIP yet.');
  if (entries.length > ZIP_MAX_ENTRIES) throw tooBig();
  const enc = new TextEncoder(), { date, time } = dosDateTime(now);
  const parts = [], central = [];
  let offset = 0;

  for (const e of entries) {
    if (isCancelled()) throw new ImageError('zip-cancelled', 'ZIP creation was cancelled.');
    if (!isSafeEntryName(e.name)) throw new ImageError('zip-name', 'A file name is not usable inside a ZIP.');
    const name = enc.encode(e.name);
    if (!name.length || name.length > 65535) throw new ImageError('zip-name', 'A file name is not usable inside a ZIP.');
    const bytes = e.data instanceof Uint8Array ? e.data : new Uint8Array(await e.data.arrayBuffer());   // one file in memory at a time
    const size = bytes.length, crc = crc32(bytes);
    if (offset + 30 + name.length + size > U32) throw tooBig();

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);   // 0x0800 = names are UTF-8
    lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, e.data instanceof Uint8Array ? bytes : e.data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  if (offset + cdSize + 22 > U32) throw tooBig();
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

const r16 = (v, i) => v.getUint16(i, true), r32 = (v, i) => v.getUint32(i, true);

/**
 * Check a ZIP we just built WITHOUT reading the whole thing back: only the end record and the central directory are read
 * (a few bytes per entry). Compares entry count, names (in order), sizes, offsets, and that every local header sits where the
 * directory says it does. Throws ImageError('zip-invalid') on any mismatch. It does NOT recompute CRCs (that would re-read every
 * byte); CRC correctness is covered by tests and by an independent unzip in the e2e suite.
 * `entries` is the same list given to buildZip: [{ name, data: Blob | Uint8Array }].
 */
export async function verifyZip(zip, entries) {
  if (!(zip instanceof Blob) || zip.type !== 'application/zip') throw badZip('wrong type');
  if (zip.size < 22) throw badZip('too short');
  const tail = new DataView(await zip.slice(zip.size - 22).arrayBuffer());
  if (r32(tail, 0) !== 0x06054b50) throw badZip('no end record');
  const count = r16(tail, 10), cdSize = r32(tail, 12), cdAt = r32(tail, 16);
  if (count !== entries.length || r16(tail, 8) !== count) throw badZip('entry count');
  if (cdAt + cdSize + 22 !== zip.size) throw badZip('directory position');
  const cd = new DataView(await zip.slice(cdAt, cdAt + cdSize).arrayBuffer());
  const dec = new TextDecoder('utf-8', { fatal: true });
  let p = 0, expectOffset = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || r32(cd, p) !== 0x02014b50) throw badZip('directory entry ' + (i + 1));
    const size = r32(cd, p + 24), nameLen = r16(cd, p + 28), at = r32(cd, p + 42);
    if (r32(cd, p + 20) !== size) throw badZip('sizes differ');
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen);
    let name; try { name = dec.decode(nameBytes); } catch (e) { throw badZip('name encoding'); }
    const want = entries[i], wantSize = want.data instanceof Blob ? want.data.size : want.data.length;
    if (name !== want.name) throw badZip('name order');
    if (size !== wantSize) throw badZip('size of ' + name);
    if (at !== expectOffset) throw badZip('offset of ' + name);
    const lh = new DataView(await zip.slice(at, at + 30).arrayBuffer());
    if (lh.byteLength < 30 || r32(lh, 0) !== 0x04034b50 || r32(lh, 18) !== size || r16(lh, 26) !== nameLen) throw badZip('local header of ' + name);
    if (r32(lh, 14) !== r32(cd, p + 16)) throw badZip('checksum fields of ' + name);
    expectOffset = at + 30 + nameLen + size;
    p += 46 + nameLen;
  }
  if (p !== cdSize || expectOffset !== cdAt) throw badZip('layout');
  return { entries: count, bytes: zip.size };
}
