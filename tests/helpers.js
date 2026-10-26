// Builders for synthetic image files. Structure-valid (enough for container parsers), not decodable pixels.
export const A = (s) => [...s].map((c) => c.charCodeAt(0));
export const be16 = (n) => [(n >> 8) & 255, n & 255];
export const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
export const le16 = (n) => [n & 255, (n >> 8) & 255];
export const le32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
export const cat = (...p) => Uint8Array.from(p.flatMap((x) => [...x]));
export const find = (b, str) => { const n = A(str); outer: for (let i = 0; i + n.length <= b.length; i++) { for (let j = 0; j < n.length; j++) if (b[i + j] !== n[j]) continue outer; return i; } return -1; };
export const has = (b, str) => find(b, str) >= 0;
export const concat = (parts) => cat(...parts);

/** TIFF with IFD0 (+ optional Exif IFD, GPS IFD, thumbnail IFD1). entries: [tag, type, bytes|number] ; ascii => bytes incl NUL */
export function tiff({ ifd0 = [], exif = null, gps = null, thumb = false }, le = false) {
  const w16 = le ? le16 : be16, w32 = le ? le32 : be32;
  const ptrs = []; if (exif) ptrs.push([0x8769, 'exif']); if (gps) ptrs.push([0x8825, 'gps']);
  const all0 = [...ifd0, ...ptrs.map(([t, k]) => [t, 4, k])];
  const sizeOf = (entries) => { let data = 0; for (const [, , v] of entries) if (Array.isArray(v) && v.length > 4) data += v.length + (v.length & 1); return 2 + entries.length * 12 + 4 + data; };
  const off0 = 8, offExif = off0 + sizeOf(all0), offGps = offExif + (exif ? sizeOf(exif) : 0), offI1 = offGps + (gps ? sizeOf(gps) : 0);
  const build = (entries, at, next) => {
    const out = [...w16(entries.length)]; let dataAt = at + 2 + entries.length * 12 + 4; const data = [];
    for (const [tag, type, v] of entries) {
      let count = 1, val;
      if (v === 'exif') val = w32(offExif); else if (v === 'gps') val = w32(offGps);
      else if (Array.isArray(v)) { count = type === 2 ? v.length : v.length / (type === 3 ? 2 : 1); if (v.length <= 4) val = [...v, 0, 0, 0, 0].slice(0, 4); else { val = w32(dataAt); data.push(...v, ...(v.length & 1 ? [0] : [])); dataAt += v.length + (v.length & 1); } }
      else val = type === 3 ? [...w16(v), 0, 0] : w32(v);
      out.push(...w16(tag), ...w16(type), ...w32(count), ...val);
    }
    return [...out, ...w32(next), ...data];
  };
  const head = [...(le ? A('II') : A('MM')), ...w16(42), ...w32(8)];
  return cat(head, build(all0, off0, thumb ? offI1 : 0), exif ? build(exif, offExif, 0) : [], gps ? build(gps, offGps, 0) : [], thumb ? build([[0x0201, 4, 0], [0x0202, 4, 0]], offI1, 0) : []);
}
export const ascii0 = (s) => [...A(s), 0];

export const FULL_TIFF = (o = 6, le = false) => tiff({
  ifd0: [[0x010f, 2, ascii0('TESTMAKER_CANON')], [0x0110, 2, ascii0('TESTMODEL_EOS')], [0x0112, 3, o], [0x0131, 2, ascii0('TESTSOFT_PHOTOSHOP')], [0x0132, 2, ascii0('2024:01:02 03:04:05')], [0x013b, 2, ascii0('TESTARTIST_JOHN')]],
  exif: [[0x9003, 2, ascii0('2024:01:02 03:04:05')], [0xa431, 2, ascii0('TESTSERIAL_12345')], [0x927c, 7, A('TESTMAKERNOTE')]],
  gps: [[1, 2, ascii0('N')], [2, 5, [0, 0, 0, 28, 0, 0, 0, 1, 0, 0, 0, 27, 0, 0, 0, 1, 0, 0, 0, 30, 0, 0, 0, 1]], [3, 2, ascii0('E')]],
  thumb: true,
}, le);

export const seg = (m, data) => [0xff, m, ...be16(data.length + 2), ...data];
export const SOF = (w = 8, h = 8) => seg(0xc0, [8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
export const SOS = [0xff, 0xda, ...be16(12), 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0];
export const ENTROPY = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0x00, 0xd9, 0x78, 0x9a, 0xff, 0x00];   // stuffed FF00, RST, and a stuffed "D9"

export function jpeg({ exif, jfif, xmp, iptc, comment, icc, mpf, adobe, trailing, progressive } = {}) {
  const parts = [[0xff, 0xd8]];
  if (jfif) parts.push(seg(0xe0, [...A('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, jfif.tw || 0, jfif.th || 0, ...(jfif.thumb || [])]));
  if (exif) parts.push(seg(0xe1, [...A('Exif'), 0, 0, ...exif]));
  if (xmp) parts.push(seg(0xe1, [...A('http://ns.adobe.com/xap/1.0/'), 0, ...A(xmp)]));
  if (icc) parts.push(seg(0xe2, [...A('ICC_PROFILE'), 0, 1, 1, ...A('TESTICCDATA')]));
  if (mpf) parts.push(seg(0xe2, [...A('MPF'), 0, ...A('TESTMPFDATA')]));
  if (iptc) parts.push(seg(0xed, [...A('Photoshop 3.0'), 0, ...A(iptc)]));
  if (adobe) parts.push(seg(0xee, [...A('Adobe'), 0, 100, 0, 0, 0, 0, 1]));
  if (comment) parts.push(seg(0xfe, A(comment)));
  parts.push(seg(0xdb, [0, ...new Array(64).fill(8)]), SOF());
  if (progressive) parts.push(seg(0xc4, [0x00, ...new Array(16).fill(0), 1]), SOS, ENTROPY, seg(0xc4, [0x10, ...new Array(16).fill(0), 2]), SOS, ENTROPY);
  else parts.push(SOS, ENTROPY);
  parts.push([0xff, 0xd9]);
  if (trailing) parts.push(A(trailing));
  return concat(parts);
}

const crc = [0, 0, 0, 0];
export const pngChunk = (type, data) => [...be32(data.length), ...A(type), ...data, ...crc];
export function png({ text, xmp, exif, time, icc, priv, phys, trns, trailing, actl } = {}) {
  const parts = [[0x89, ...A('PNG'), 13, 10, 26, 10], pngChunk('IHDR', [...be32(8), ...be32(8), 8, 3, 0, 0, 0])];
  if (actl) parts.push(pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]));
  parts.push(pngChunk('gAMA', be32(45455)));
  if (icc) parts.push(pngChunk('iCCP', [...A('icc'), 0, 0, ...A('TESTICCDATA')]));
  if (phys) parts.push(pngChunk('pHYs', [...be32(11811), ...be32(11811), 1]));
  if (time) parts.push(pngChunk('tIME', [7, 232, 1, 2, 3, 4, 5]));
  if (text) parts.push(pngChunk('tEXt', [...A('Comment'), 0, ...A(text)]));
  if (xmp) parts.push(pngChunk('iTXt', [...A('XML:com.adobe.xmp'), 0, 0, 0, 0, 0, ...A(xmp)]));
  if (exif) parts.push(pngChunk('eXIf', [...exif]));
  if (priv) parts.push(pngChunk('prVT', A(priv)));
  parts.push(pngChunk('PLTE', [255, 255, 255, 0, 0, 0]));
  if (trns) parts.push(pngChunk('tRNS', [0]));
  parts.push(pngChunk('IDAT', [1, 2, 3, 4, 5, 6, 7, 8]), pngChunk('IEND', []));
  if (trailing) parts.push(A(trailing));
  return concat(parts);
}

const riff = (chunks) => { const body = concat(chunks); return cat(A('RIFF'), le32(body.length + 4), A('WEBP'), body); };
export const wchunk = (type, data) => [...A(type), ...le32(data.length), ...data, ...(data.length & 1 ? [0] : [])];
export function webp({ simple, exif, xmp, icc, alpha, flags, extra, trailing, exifPrefix } = {}) {
  if (simple) return riff([wchunk('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 8, 0, 8, 0, 1, 2, 3])]);
  let f = flags ?? ((icc ? 0x20 : 0) | (alpha ? 0x10 : 0) | (exif ? 0x08 : 0) | (xmp ? 0x04 : 0));
  const parts = [wchunk('VP8X', [f, 0, 0, 0, 7, 0, 0, 7, 0, 0])];
  if (icc) parts.push(wchunk('ICCP', A('TESTICCDATA')));
  if (alpha) parts.push(wchunk('ALPH', [0, 1, 2]));
  parts.push(wchunk('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 8, 0, 8, 0, 1, 2, 3]));
  if (exif) parts.push(wchunk('EXIF', [...(exifPrefix ? [...A('Exif'), 0, 0] : []), ...exif]));
  if (xmp) parts.push(wchunk('XMP ', A(xmp)));
  if (extra) parts.push(wchunk('ZZZZ', A(extra)));
  const out = riff(parts);
  return trailing ? cat(out, A(trailing)) : out;
}
