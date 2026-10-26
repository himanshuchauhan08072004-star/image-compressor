import { ImageError } from './errors.js';

/**
 * Minimal PDF writer for photo sheets: each JPEG is embedded once (DCTDecode, bytes untouched, so no re-compression and no
 * stretching) and drawn at physical size wherever the layout puts it. No dependency. Coordinates in millimetres, origin top-left.
 * Phase 7: several images (rect.image = index, default 0) and optional cutting guides (hairline box around each photo).
 */
export const PT_PER_MM = 72 / 25.4;
const f = (n) => String(Math.round(n * 10000) / 10000);
const enc = new TextEncoder();

/** Read size and colour components from a JPEG's frame header. Throws ImageError if it is not a usable JPEG. */
export function jpegInfo(b) {
  if (!(b[0] === 0xff && b[1] === 0xd8)) throw new ImageError('pdf-image', 'The photo is not a JPEG, so it cannot be placed in the PDF.');
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) { p++; continue; }
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const height = (b[p + 5] << 8) | b[p + 6], width = (b[p + 7] << 8) | b[p + 8], components = b[p + 9];
      if (![1, 3].includes(components) || !width || !height) throw new ImageError('pdf-image', 'This JPEG uses a colour layout the PDF export does not support.');
      return { width, height, components };
    }
    p += 2 + len;
  }
  throw new ImageError('pdf-image', 'Could not read the photo\u2019s size from its JPEG data.');
}

const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').replace(/[()\\]/g, '');

export const GUIDE_WIDTH_PT = 0.25;
const IMG_REF = /\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g;

/**
 * pages: [[{x,y,w,h,image?}, ...], ...] in mm on a page of pageMM {w,h}.
 * images: [{ bytes }] (one JPEG each; size is read from the bytes) or the older single `jpeg: { bytes }`.
 * guides: 'none' | 'box' (thin outline exactly on each photo's edge). Returns a Blob.
 */
export function buildPdf({ pageMM, pages, jpeg, images, guides = 'none', title = 'Shrinkit photo sheet' }) {
  const list = images && images.length ? images : jpeg ? [jpeg] : [];
  if (!list.length) throw new ImageError('pdf-image', 'There is no photo to place in the PDF.');
  const infos = list.map((im) => jpegInfo(im.bytes));
  if (!pages.length || pages.some((p) => !p.length)) throw new ImageError('pdf-empty', 'There is nothing to place on the page.');
  if (!['none', 'box'].includes(guides)) throw new ImageError('pdf-guides', 'Unknown cutting-guide style.');
  for (const p of pages) for (const r of p) {
    const k = r.image ?? 0;
    if (!Number.isInteger(k) || k < 0 || k >= list.length) throw new ImageError('pdf-image', 'A photo on the sheet has no image to draw.');
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w <= 0 || r.h <= 0) throw new ImageError('pdf-geometry', 'A photo on the sheet has an invalid position or size.');
  }
  if (!(pageMM.w > 0 && pageMM.h > 0) || pageMM.w * PT_PER_MM > 14400 || pageMM.h * PT_PER_MM > 14400) throw new ImageError('pdf-geometry', 'The page size is outside what a PDF can hold.');
  const W = pageMM.w * PT_PER_MM, H = pageMM.h * PT_PER_MM, N = list.length;
  const parts = [enc.encode('%PDF-1.4\n%'), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 0x0a])], offsets = [];
  let pos = parts[0].length + parts[1].length;
  const put = (x) => { const u = typeof x === 'string' ? enc.encode(x) : x; parts.push(u); pos += u.length; };
  const obj = (n, body) => { offsets[n] = pos; put(n + ' 0 obj\n'); put(body); put('\nendobj\n'); };

  // object numbers: 1 catalog, 2 pages, 3..2+N images, 3+N info, then page/content pairs
  const nPages = pages.length, infoN = 3 + N, firstPage = 4 + N, kids = pages.map((_, i) => (firstPage + i * 2) + ' 0 R').join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [' + kids + '] /Count ' + nPages + ' >>');
  list.forEach((im, i) => {
    const info = infos[i];
    offsets[3 + i] = pos; put((3 + i) + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + info.width + ' /Height ' + info.height + ' /ColorSpace /' + (info.components === 1 ? 'DeviceGray' : 'DeviceRGB') +
      ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>\nstream\n'); put(im.bytes); put('\nendstream\nendobj\n');
  });
  obj(infoN, '<< /Title (' + ascii(title) + ') /Producer (Shrinkit) >>');
  const xobjects = list.map((_, i) => '/Im' + i + ' ' + (3 + i) + ' 0 R').join(' ');
  pages.forEach((rects, i) => {
    const pn = firstPage + i * 2, cn = pn + 1;
    let content = rects.map((r) => 'q ' + f(r.w * PT_PER_MM) + ' 0 0 ' + f(r.h * PT_PER_MM) + ' ' + f(r.x * PT_PER_MM) + ' ' + f(H - (r.y + r.h) * PT_PER_MM) + ' cm /Im' + (r.image ?? 0) + ' Do Q\n').join('');
    if (guides === 'box') content += 'q ' + GUIDE_WIDTH_PT + ' w 0.3 G\n' + rects.map((r) => f(r.x * PT_PER_MM) + ' ' + f(H - (r.y + r.h) * PT_PER_MM) + ' ' + f(r.w * PT_PER_MM) + ' ' + f(r.h * PT_PER_MM) + ' re S\n').join('') + 'Q\n';
    obj(pn, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + f(W) + ' ' + f(H) + '] /Resources << /XObject << ' + xobjects + ' >> >> /Contents ' + cn + ' 0 R >>');
    obj(cn, '<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream');
  });
  const size = firstPage + nPages * 2, xref = pos;
  let x = 'xref\n0 ' + size + '\n0000000000 65535 f \n';
  for (let n = 1; n < size; n++) x += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  put(x + 'trailer\n<< /Size ' + size + ' /Root 1 0 R /Info ' + infoN + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  return new Blob(parts, { type: 'application/pdf' });
}

/**
 * Structural self-check of a PDF made by buildPdf: header/trailer, every xref offset lands on its object, page count,
 * MediaBox in points, every embedded image's pixel size, and for EVERY photo its drawn position and size in points against
 * the layout (so "physical size" is checked, not assumed). Throws ImageError when anything is off.
 * expect: { pageMM:{w,h}, pages:[[rects]], images:[{w,h}] (or imageW/imageH for one image), guides?:'none'|'box' }
 */
export function validatePdf(bytes, expect) {
  const bad = (m) => new ImageError('pdf-invalid', 'The PDF failed its self-check (' + m + '), so it was not offered for download.');
  const s = new TextDecoder('latin1').decode(bytes);
  if (!s.startsWith('%PDF-1.')) throw bad('header');
  if (!s.trimEnd().endsWith('%%EOF')) throw bad('end marker');
  const sx = s.lastIndexOf('startxref'), xrefAt = parseInt(s.slice(sx + 9).trim(), 10);
  if (!(xrefAt > 0) || s.slice(xrefAt, xrefAt + 4) !== 'xref') throw bad('xref position');
  const m = /^xref\n0 (\d+)\n/.exec(s.slice(xrefAt)); if (!m) throw bad('xref table');
  const count = parseInt(m[1], 10); let q = xrefAt + m[0].length + 20;           // skip the free entry
  for (let n = 1; n < count; n++, q += 20) {
    const off = parseInt(s.slice(q, q + 10), 10);
    if (s.slice(off, off + String(n).length + 6) !== n + ' 0 obj') throw bad('object ' + n + ' offset');
  }
  const W = expect.pageMM.w * PT_PER_MM, H = expect.pageMM.h * PT_PER_MM;
  const boxes = [...s.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)];
  if (boxes.length !== expect.pages.length) throw bad('page count ' + boxes.length + ' vs ' + expect.pages.length);
  for (const b of boxes) if (Math.abs(+b[1] - W) > 0.01 || Math.abs(+b[2] - H) > 0.01) throw bad('page size ' + b[1] + ' × ' + b[2] + ' pt');
  const want = expect.images || [{ w: expect.imageW, h: expect.imageH }], got = [...s.matchAll(IMG_REF)];
  if (got.length !== want.length || got.some((g, i) => +g[1] !== want[i].w || +g[2] !== want[i].h)) throw bad('image size');
  const draws = [...s.matchAll(/q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im(\d+) Do Q/g)], flat = expect.pages.flat();
  if (draws.length !== flat.length) throw bad('photos drawn ' + draws.length + ' vs ' + flat.length);
  flat.forEach((r, i) => {
    const d = draws[i], ex = [r.w * PT_PER_MM, r.h * PT_PER_MM, r.x * PT_PER_MM, H - (r.y + r.h) * PT_PER_MM];
    if (ex.some((v, k) => Math.abs(+d[k + 1] - v) > 0.01)) throw bad('photo ' + (i + 1) + ' is not at its planned position and size');
    if (+d[5] !== (r.image ?? 0)) throw bad('photo ' + (i + 1) + ' uses the wrong image');
  });
  const guideCount = [...s.matchAll(/ re S\n/g)].length, wantGuides = expect.guides === 'box' ? flat.length : 0;
  if (guideCount !== wantGuides) throw bad('cutting guides ' + guideCount + ' vs ' + wantGuides);
  return { pages: boxes.length, photos: draws.length, guides: guideCount, widthPt: +boxes[0][1], heightPt: +boxes[0][2] };
}
