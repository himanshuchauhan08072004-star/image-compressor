/**
 * Read width/height (and JPEG EXIF orientation) from the first bytes of a file, WITHOUT decoding pixels.
 * Pure. Returns {status:'ok',width,height,orientation} | {status:'more',need} | {status:'bad'}.
 * This is a robustness guard against huge or lying images, not a security boundary: the browser's own
 * decoder remains the thing that actually parses the file.
 */
const BAD = { status: 'bad' };
const more = (need) => ({ status: 'more', need });
const ok = (width, height, orientation = 1, alpha = false) => (width >= 1 && height >= 1 ? { status: 'ok', width, height, orientation, alpha } : BAD);
const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => b[i] * 16777216 + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const ascii = (b, from, to) => { let s = ''; for (let i = from; i < to; i++) s += String.fromCharCode(b[i]); return s; };

/** True if the PNG declares transparency: alpha colour types, or a tRNS chunk before the image data. */
function pngHasAlpha(b) {
  const type = b[25];
  if (type === 4 || type === 6) return true;
  let i = 33;                                              // first chunk after the 25-byte IHDR chunk
  while (i + 8 <= b.length) {
    const t = ascii(b, i + 4, i + 8), len = u32(b, i);
    if (t === 'tRNS') return true;
    if (t === 'IDAT') return false;
    i += 12 + len;
  }
  return true;                                             // ran out of header bytes: assume it might be transparent
}

function parsePng(b) {
  if (b.length < 26) return more(26);
  return ascii(b, 12, 16) === 'IHDR' ? ok(u32(b, 16), u32(b, 20), 1, pngHasAlpha(b)) : BAD;
}

function parseWebp(b) {
  if (b.length < 16) return more(16);
  const tag = ascii(b, 12, 16);
  const need = tag === 'VP8L' ? 25 : 30;        // tiny lossless files can be barely longer than their header
  if (b.length < need) return more(need);
  if (tag === 'VP8X') return ok(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), 1, (b[20] & 0x10) !== 0);
  if (tag === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return BAD;
    return ok((b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff, 1, false);
  }
  if (tag === 'VP8L') {
    if (b[20] !== 0x2f) return BAD;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return ok(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff), 1, ((bits >>> 28) & 1) === 1);
  }
  return BAD;
}

/** EXIF orientation (1-8) from an APP1 segment whose data spans [start, end). null if absent/invalid. */
function exifOrientation(b, start, end) {
  if (end - start < 14 || ascii(b, start, start + 4) !== 'Exif' || b[start + 4] !== 0 || b[start + 5] !== 0) return null;
  const t = start + 6, le = b[t] === 0x49;
  if (!le && b[t] !== 0x4d) return null;
  const r16 = (i) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const r32 = (i) => (le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : (b[i] * 16777216) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]);
  if (r16(t + 2) !== 42) return null;
  const ifd = t + r32(t + 4);
  if (ifd + 2 > end) return null;
  const n = Math.min(r16(ifd), 256);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return null;
    if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : null; }
  }
  return null;
}

const isSOF = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function parseJpeg(b) {
  let i = 2, orientation = 1;
  for (;;) {
    if (i + 4 > b.length) return more(i + 4);
    if (b[i] !== 0xff) return BAD;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }                                     // fill byte
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return BAD;                              // ended before any frame header
    const len = u16(b, i + 2);
    if (len < 2) return BAD;
    if (isSOF(m)) return i + 9 > b.length ? more(i + 9) : ok(u16(b, i + 7), u16(b, i + 5), orientation);
    if (m === 0xe1) {
      if (i + 2 + len > b.length) return more(i + 2 + len);
      const o = exifOrientation(b, i + 4, i + 2 + len);
      if (o) orientation = o;
    }
    i += 2 + len;
  }
}

export function parseImageHeader(bytes, type) {
  if (type === 'png') return parsePng(bytes);
  if (type === 'webp') return parseWebp(bytes);
  if (type === 'jpeg') return parseJpeg(bytes);
  return BAD;
}
