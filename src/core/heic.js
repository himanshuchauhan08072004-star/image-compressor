/** Pure HEIC/HEIF helpers: naming, header (ispe/irot) parsing. No DOM, no wasm. */
export const isHeic = (kind) => !!kind && kind.type === 'heic';
/** Output type for "keep format": browsers cannot encode HEIC, so it is saved as JPG. */
export const keepMime = (kind) => (isHeic(kind) ? 'image/jpeg' : kind.mime);
/** File name or MIME claims HEIC/HEIF (a hint only; bytes decide). */
export const claimsHeic = (f) => !!f && (/\.(heic|heif|hif)$/i.test(f.name || '') || /^image\/hei[cf]/i.test(f.type || ''));

const u32 = (b, i) => b[i] * 16777216 + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const tag = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const BAD = { status: 'bad' }, UNKNOWN = { status: 'unknown' };

/** Child boxes in [start,end). Returns null if a box is malformed. */
function boxes(b, start, end) {
  const out = [];
  let i = start;
  while (i + 8 <= end && out.length < 4096) {
    let size = u32(b, i), hdr = 8;
    if (size === 1) { if (i + 16 > end) return null; if (u32(b, i + 8) !== 0) return null; size = u32(b, i + 12); hdr = 16; }
    else if (size === 0) size = end - i;
    if (size < hdr || i + size > end) return null;
    out.push({ type: tag(b, i + 4), start: i + hdr, end: i + size });
    i += size;
  }
  return out;
}

/**
 * Primary image width/height from the first bytes (meta box: pitm + ipco ispe/irot + ipma). Pure.
 * { status:'ok', width, height } | { status:'more', need } | { status:'unknown' } (cannot tell: use the decoder) | { status:'bad' }.
 * A robustness guard only; the real decoder re-checks the size before it allocates pixels.
 */
export function parseHeicHeader(b) {
  let i = 0, meta = null;
  for (let n = 0; n < 64 && i + 8 <= b.length; n++) {
    let size = u32(b, i), hdr = 8;
    if (size === 1) { if (i + 16 > b.length) return { status: 'more', need: i + 16 }; size = u32(b, i + 12); hdr = 16; }
    if (size < hdr) return size === 0 ? UNKNOWN : BAD;
    if (tag(b, i + 4) === 'meta') {
      if (i + size > b.length) return { status: 'more', need: i + size };
      meta = { start: i + hdr + 4, end: i + size }; break;
    }
    i += size;
  }
  if (!meta) return i + 8 > b.length ? { status: 'more', need: i + 8 } : UNKNOWN;
  const kids = boxes(b, meta.start, meta.end);
  if (!kids) return BAD;
  const pitm = kids.find((k) => k.type === 'pitm'), iprp = kids.find((k) => k.type === 'iprp');
  if (!pitm || !iprp) return UNKNOWN;
  const pid = b[pitm.start] === 0 ? u16(b, pitm.start + 4) : u32(b, pitm.start + 4);
  const pk = boxes(b, iprp.start, iprp.end);
  if (!pk) return BAD;
  const ipco = pk.find((k) => k.type === 'ipco'), ipma = pk.find((k) => k.type === 'ipma');
  if (!ipco || !ipma) return UNKNOWN;
  const props = boxes(b, ipco.start, ipco.end);
  if (!props) return BAD;
  // ipma: find associations for the primary item
  const ver = b[ipma.start], big = (b[ipma.start + 3] & 1) === 1;
  let p = ipma.start + 4;
  const count = u32(b, p); p += 4;
  let assoc = null;
  for (let e = 0; e < count && p + 3 <= ipma.end; e++) {
    const id = ver < 1 ? u16(b, p) : u32(b, p); p += ver < 1 ? 2 : 4;
    const n = b[p++], list = [];
    for (let a = 0; a < n && p < ipma.end; a++) { if (big) { list.push(u16(b, p) & 0x7fff); p += 2; } else { list.push(b[p] & 0x7f); p += 1; } }
    if (id === pid) { assoc = list; break; }
  }
  if (!assoc) return UNKNOWN;
  let w = 0, h = 0;
  for (const idx of assoc) {                         // transformative properties apply in association order: ispe, then clap / irot
    const pr = props[idx - 1];
    if (!pr) continue;
    if (pr.type === 'ispe' && pr.end - pr.start >= 12) { w = u32(b, pr.start + 4); h = u32(b, pr.start + 8); }
    else if (pr.type === 'clap' && pr.end - pr.start >= 32 && u32(b, pr.start + 4) && u32(b, pr.start + 12)) { w = Math.round(u32(b, pr.start) / u32(b, pr.start + 4)); h = Math.round(u32(b, pr.start + 8) / u32(b, pr.start + 12)); }
    else if (pr.type === 'irot' && pr.end > pr.start && (b[pr.start] & 1)) { const t = w; w = h; h = t; }
  }
  if (!(w >= 1 && h >= 1)) return UNKNOWN;
  return { status: 'ok', width: w, height: h };
}
