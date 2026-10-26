import { ImageError } from './errors.js';

/**
 * Metadata inspection + lossless removal for JPEG, PNG and WebP. Pure: bytes in, bytes/report out.
 *
 * Removal uses a WHITELIST: only structures needed to draw the picture are copied. Everything else
 * (including blocks this code does not understand, and data after the end of the image) is dropped.
 * The report side only knows the categories listed in LABELS; verification therefore says
 * "checked for X" rather than "everything is gone".
 */
export const LABELS = {
  gps: 'GPS location', camera: 'Camera or lens make and model', datetime: 'Date and time taken',
  serial: 'Device serial numbers or unique IDs', person: 'Author, owner or copyright text', software: 'Editing software',
  description: 'Description or user comment', makernote: 'Manufacturer-specific notes', thumbnail: 'Embedded thumbnail preview',
  'exif-other': 'Other EXIF details', xmp: 'XMP data (editing or descriptive information)', iptc: 'IPTC / Photoshop data',
  text: 'Text notes stored in the file', comment: 'Comments', timestamp: 'Modification timestamp',
  extra: 'Other embedded data (vendor blocks, extra images)', trailing: 'Extra data after the end of the image',
  icc: 'Colour profile (not personal data)',
};
export const CHECKED = ['gps', 'camera', 'datetime', 'serial', 'person', 'software', 'description', 'makernote', 'thumbnail', 'exif-other', 'xmp', 'iptc', 'text', 'comment', 'timestamp', 'extra', 'trailing'];
const ORDER = Object.keys(LABELS);

const damaged = () => new ImageError('damaged', 'This image looks damaged or incomplete, so its metadata cannot be removed safely.');
const ascii = (b, from, to) => { let s = ''; for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const startsWith = (b, at, str) => ascii(b, at, at + str.length) === str;
const u32be = (b, i) => b[i] * 16777216 + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + b[i + 3] * 16777216;

// ---------------------------------------------------------------- EXIF / TIFF
const EXIF_IDS = {
  0x010f: 'camera', 0x0110: 'camera', 0xa434: 'camera', 0xa433: 'camera', 0xa432: 'camera',
  0x0132: 'datetime', 0x9003: 'datetime', 0x9004: 'datetime', 0x9010: 'datetime', 0x9011: 'datetime', 0x9012: 'datetime',
  0x0131: 'software', 0x013b: 'person', 0x8298: 'person', 0xa430: 'person',
  0x010e: 'description', 0x9286: 'description', 0x927c: 'makernote',
  0xa431: 'serial', 0xa435: 'serial', 0xa420: 'serial',
};
const T_ORIENT = 0x0112, T_EXIF = 0x8769, T_GPS = 0x8825, T_INTEROP = 0xa005;

/** Parse a TIFF block (as found in EXIF). Returns { orientation, ids:Set } or null if not valid TIFF. */
function parseTiff(b, t, end) {
  if (t + 8 > end) return null;
  const le = b[t] === 0x49;
  if (!le && b[t] !== 0x4d) return null;
  const r16 = (i) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const r32 = (i) => (le ? u32le(b, i) : u32be(b, i));
  if (r16(t + 2) !== 42) return null;
  const ids = new Set(); let orientation = 1;

  const readIfd = (rel, depth) => {
    const at = t + rel;
    if (rel === 0 || at + 2 > end) return 0;
    const n = Math.min(r16(at), 512);
    for (let k = 0; k < n; k++) {
      const e = at + 2 + k * 12;
      if (e + 12 > end) return 0;
      const tag = r16(e);
      if (tag === T_ORIENT) { const v = r16(e + 8); if (v >= 1 && v <= 8) orientation = v; }
      else if (tag === T_GPS) ids.add('gps');
      else if (tag === T_EXIF || tag === T_INTEROP) { if (depth < 2) { const before = ids.size; readIfd(r32(e + 8), depth + 1); if (ids.size === before && depth === 0) { /* empty sub-IFD */ } } }
      else ids.add(EXIF_IDS[tag] || 'exif-other');
    }
    return at + 2 + n * 12 + 4 <= end ? r32(at + 2 + n * 12) : 0;
  };
  const next = readIfd(r32(t + 4), 0);
  if (next) ids.add('thumbnail');                       // a second IFD holds the embedded thumbnail
  return { orientation, ids };
}

// ---------------------------------------------------------------- JPEG
const isSOF = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** Walk every segment (including entropy-coded data) up to the real EOI. Throws if malformed/truncated. */
function scanJpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw damaged();
  const segs = []; let pos = 2, sof = false;
  for (;;) {
    if (pos + 2 > b.length || b[pos] !== 0xff) throw damaged();
    const m = b[pos + 1];
    if (m === 0xff) { pos++; continue; }
    if (m === 0xd9) { segs.push({ m, start: pos, end: pos + 2 }); return { segs, end: pos + 2 }; }
    if (m === 0xd8) throw damaged();                                     // nested SOI
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { segs.push({ m, start: pos, end: pos + 2 }); pos += 2; continue; }
    if (pos + 4 > b.length) throw damaged();
    const len = (b[pos + 2] << 8) | b[pos + 3];
    if (len < 2 || pos + 2 + len > b.length) throw damaged();
    const seg = { m, start: pos, end: pos + 2 + len };
    if (isSOF(m)) sof = true;
    pos = seg.end;
    if (m === 0xda) {                                                    // entropy-coded data follows
      if (!sof) throw damaged();
      let j = pos;
      for (; j + 1 < b.length; j++) {
        if (b[j] !== 0xff) continue;
        const n = b[j + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { j++; continue; }
        if (n === 0xff) continue;
        break;
      }
      if (j + 1 >= b.length) throw damaged();
      seg.end = j; pos = j;
    }
    segs.push(seg);
  }
}

function classifyJpegSeg(b, s) {
  const d = s.start + 4;
  if (s.m === 0xfe) return 'comment';
  if (s.m < 0xe0 || s.m > 0xef) return 'core';
  if (s.m === 0xe0) return startsWith(b, d, 'JFIF\0') ? 'jfif' : 'extra';
  if (s.m === 0xe1) return startsWith(b, d, 'Exif\0\0') ? 'exif' : startsWith(b, d, 'http://ns.adobe.com/xap/1.0/\0') || startsWith(b, d, 'http://ns.adobe.com/xmp/extension/\0') ? 'xmp' : 'extra';
  if (s.m === 0xe2) return startsWith(b, d, 'ICC_PROFILE\0') ? 'icc' : 'extra';
  if (s.m === 0xed) return startsWith(b, d, 'Photoshop 3.0') ? 'iptc' : 'extra';
  if (s.m === 0xee) return startsWith(b, d, 'Adobe') ? 'adobe' : 'extra';
  return 'extra';
}

function inspectJpeg(b) {
  const { segs, end } = scanJpeg(b);
  const ids = new Set(); let orientation = 1;
  for (const s of segs) {
    const k = classifyJpegSeg(b, s);
    if (k === 'exif') { const t = parseTiff(b, s.start + 10, s.end); if (t) { t.ids.forEach((x) => ids.add(x)); orientation = t.orientation; } else ids.add('exif-other'); }
    else if (k === 'jfif') { if (s.end - s.start > 18 && (b[s.start + 16] || b[s.start + 17])) ids.add('thumbnail'); }
    else if (['xmp', 'iptc', 'comment', 'icc', 'extra'].includes(k)) ids.add(k);
  }
  if (b.length > end) ids.add('trailing');
  return { ids, orientation };
}

const MINIMAL_EXIF = (o) => Uint8Array.from([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8,
  0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0]);

function stripJpeg(b, { keepIcc }) {
  const { segs } = scanJpeg(b);
  const info = inspectJpeg(b);
  const parts = [Uint8Array.of(0xff, 0xd8)];
  if (info.orientation > 1) parts.push(MINIMAL_EXIF(info.orientation));
  for (const s of segs) {
    const k = classifyJpegSeg(b, s);
    if (k === 'core' || k === 'adobe' || (k === 'icc' && keepIcc)) parts.push(b.subarray(s.start, s.end));
    else if (k === 'jfif') {                                             // keep the header, drop any embedded thumbnail
      const seg = Uint8Array.from(b.subarray(s.start, Math.min(s.end, s.start + 18)));
      if (seg.length >= 18) { seg[2] = 0; seg[3] = 16; seg[16] = 0; seg[17] = 0; parts.push(seg.subarray(0, 18)); }
    }
  }
  return { parts, orientation: info.orientation };
}

// ---------------------------------------------------------------- PNG
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'pHYs', 'cICP']);

function scanPng(b) {
  if (b.length < 33 || b[0] !== 0x89 || !startsWith(b, 1, 'PNG') || b[4] !== 13 || b[5] !== 10 || b[6] !== 26 || b[7] !== 10) throw damaged();
  const chunks = []; let pos = 8;
  for (;;) {
    if (pos + 12 > b.length) throw damaged();
    const len = u32be(b, pos), type = ascii(b, pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || pos + 12 + len > b.length) throw damaged();
    if (chunks.length === 0 && type !== 'IHDR') throw damaged();
    chunks.push({ type, start: pos, dataStart: pos + 8, dataEnd: pos + 8 + len, end: pos + 12 + len });
    pos += 12 + len;
    if (type === 'IEND') return { chunks, end: pos };
  }
}

function inspectPng(b) {
  const { chunks, end } = scanPng(b);
  const ids = new Set(); let orientation = 1;
  for (const c of chunks) {
    if (c.type === 'acTL') throw new ImageError('animated', 'Animated PNG is not supported.');
    if (c.type === 'eXIf') { const t = parseTiff(b, c.dataStart, c.dataEnd); if (t) { t.ids.forEach((x) => ids.add(x)); orientation = t.orientation; } else ids.add('exif-other'); }
    else if (c.type === 'tIME') ids.add('timestamp');
    else if (c.type === 'iCCP') ids.add('icc');
    else if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') ids.add(startsWith(b, c.dataStart, 'XML:com.adobe.xmp') ? 'xmp' : 'text');
    else if (!PNG_KEEP.has(c.type)) ids.add('extra');
  }
  if (b.length > end) ids.add('trailing');
  return { ids, orientation };
}

function stripPng(b, { keepIcc }) {
  const { chunks } = scanPng(b);
  const info = inspectPng(b);
  const parts = [b.subarray(0, 8)];
  for (const c of chunks) if (PNG_KEEP.has(c.type) || (keepIcc && c.type === 'iCCP')) parts.push(b.subarray(c.start, c.end));
  return { parts, orientation: info.orientation };
}

// ---------------------------------------------------------------- WebP
function scanWebp(b) {
  if (b.length < 20 || !startsWith(b, 0, 'RIFF') || !startsWith(b, 8, 'WEBP')) throw damaged();
  const total = 8 + u32le(b, 4);
  if (total > b.length || total < 20) throw damaged();
  const chunks = []; let pos = 12;
  while (pos < total) {
    if (pos + 8 > total) throw damaged();
    const size = u32le(b, pos + 4), dataStart = pos + 8, dataEnd = dataStart + size, end = dataEnd + (size & 1);
    if (end > total) throw damaged();
    chunks.push({ type: ascii(b, pos, pos + 4), start: pos, dataStart, dataEnd, end });
    pos = end;
  }
  return { chunks, end: total };
}

function inspectWebp(b) {
  const { chunks, end } = scanWebp(b);
  const ids = new Set(); let orientation = 1;
  for (const c of chunks) {
    if (c.type === 'ANIM' || c.type === 'ANMF') throw new ImageError('animated', 'Animated WebP is not supported.');
    if (c.type === 'EXIF') {
      const at = startsWith(b, c.dataStart, 'Exif\0\0') ? c.dataStart + 6 : c.dataStart;
      const t = parseTiff(b, at, c.dataEnd); if (t) { t.ids.forEach((x) => ids.add(x)); orientation = t.orientation; } else ids.add('exif-other');
    } else if (c.type === 'XMP ') ids.add('xmp');
    else if (c.type === 'ICCP') ids.add('icc');
    else if (!['VP8X', 'VP8 ', 'VP8L', 'ALPH'].includes(c.type)) ids.add('extra');
  }
  if (b.length > end) ids.add('trailing');
  return { ids, orientation };
}

function stripWebp(b, { keepIcc }) {
  const { chunks } = scanWebp(b);
  const info = inspectWebp(b);
  const kept = [];
  for (const c of chunks) {
    if (['VP8 ', 'VP8L', 'ALPH'].includes(c.type) || (c.type === 'ICCP' && keepIcc)) kept.push(b.subarray(c.start, c.end));
    else if (c.type === 'VP8X') {
      if (c.dataEnd - c.dataStart < 10) throw damaged();
      const x = Uint8Array.from(b.subarray(c.start, c.end));
      x[8] &= ~0x0c;                                                     // EXIF + XMP flags off
      if (!keepIcc) x[8] &= ~0x20;
      kept.push(x);
    }
  }
  if (!kept.some((p) => ['VP8 ', 'VP8L'].includes(ascii(p, 0, 4)))) throw damaged();
  const size = 4 + kept.reduce((n, p) => n + p.length, 0);
  const head = Uint8Array.of(0x52, 0x49, 0x46, 0x46, size & 255, (size >> 8) & 255, (size >> 16) & 255, (size >>> 24) & 255, 0x57, 0x45, 0x42, 0x50);
  return { parts: [head, ...kept], orientation: info.orientation };
}

// ---------------------------------------------------------------- public API
const BY_TYPE = { jpeg: [inspectJpeg, stripJpeg], png: [inspectPng, stripPng], webp: [inspectWebp, stripWebp] };

/** What is stored in this file, in plain categories. */
export function inspectMetadata(bytes, type) {
  const f = BY_TYPE[type];
  if (!f) throw new ImageError('unsupported', 'Metadata inspection is not available for this format.');
  const { ids, orientation } = f[0](bytes);
  return { type, found: ORDER.filter((k) => ids.has(k)), orientation };
}

/**
 * Lossless removal. Returns { parts, size, removed, orientation, keptRotationFlag }.
 * PNG/WebP files with a rotation flag are refused: the flag would be lost and the picture could appear sideways.
 */
export function stripMetadata(bytes, type, { keepIcc = true } = {}) {
  const f = BY_TYPE[type];
  if (!f) throw new ImageError('unsupported', 'Metadata removal is not available for this format.');
  const before = inspectMetadata(bytes, type);
  if (type !== 'jpeg' && before.orientation > 1) {
    throw new ImageError('orientation', 'This file has a rotation flag that lossless removal would lose. Use “Rebuild image” instead.');
  }
  const { parts, orientation } = f[1](bytes, { keepIcc });
  const size = parts.reduce((n, p) => n + p.length, 0);
  const removed = before.found.filter((k) => !(k === 'icc' && keepIcc));
  return { parts, size, removed, orientation, keptRotationFlag: type === 'jpeg' && orientation > 1 };
}

/**
 * Re-read a produced file and report what categories are still present.
 * Allowed leftovers: the colour profile (if asked to keep) and a rotation-flag-only EXIF block.
 */
export function verifyMetadata(bytes, type, { keepIcc = false } = {}) {
  const { found, orientation } = inspectMetadata(bytes, type);
  const remaining = found.filter((k) => !(k === 'icc' && keepIcc));
  return { clean: remaining.length === 0, remaining, orientation, keptIcc: keepIcc && found.includes('icc'), checked: CHECKED };
}
