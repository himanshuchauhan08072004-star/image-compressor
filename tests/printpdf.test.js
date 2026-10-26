import test from 'node:test';
import assert from 'node:assert/strict';
import { planLayout } from '../src/core/layout.js';
import { buildPdf, validatePdf, jpegInfo, PT_PER_MM } from '../src/core/pdf.js';
import { exportSheetPdf, pdfPagesFor } from '../src/core/sheet-export.js';
import { planGroupImage, previewSourceRect } from '../src/core/sheet-images.js';

const jpg = (w, h, comps = 3) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 8 + comps * 3, 8, h >> 8, h & 255, w >> 8, w & 255, comps, ...Array(comps * 3).fill(1), 0xff, 0xd9]);
const L = (o = {}) => { const r = planLayout({ paper: 'A4', margin: 10, hGap: 3, vGap: 3, groups: [{ w: 35, h: 45, copies: 8 }], ...o }); assert.ok(r.ok, r.error); return r; };
const text = async (blob) => new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
const draws = (s) => [...s.matchAll(/q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im(\d+) Do Q/g)].map((m) => ({ w: +m[1], h: +m[2], x: +m[3], y: +m[4], im: +m[5] }));

test('preview and PDF use the same rectangles (shared layout model)', async () => {
  const lay = L({ groups: [{ id: 'a', w: 35, h: 45, copies: 6 }, { id: 'b', w: 70, h: 90, copies: 1 }] });
  const pages = pdfPagesFor(lay);
  lay.pages.forEach((p, i) => p.forEach((it, k) => { for (const key of ['x', 'y', 'w', 'h']) assert.equal(pages[i][k][key], it[key]); assert.equal(pages[i][k].image, it.group); }));
  const { blob } = await exportSheetPdf({ layout: lay, images: [{ bytes: jpg(413, 531) }, { bytes: jpg(827, 1063) }] }), s = await text(blob), d = draws(s), H = lay.page.h * PT_PER_MM;
  assert.equal(d.length, lay.items.length);
  lay.items.forEach((it, i) => { assert.ok(Math.abs(d[i].w - it.w * PT_PER_MM) < 0.01 && Math.abs(d[i].h - it.h * PT_PER_MM) < 0.01); assert.ok(Math.abs(d[i].x - it.x * PT_PER_MM) < 0.01); assert.ok(Math.abs(d[i].y - (H - (it.y + it.h) * PT_PER_MM)) < 0.01); assert.equal(d[i].im, it.group); });
});
test('PDF page size matches paper and orientation (pt)', async () => {
  const want = (o, wMM, hMM) => async () => {
    const lay = L(o), { blob, check } = await exportSheetPdf({ layout: lay, images: [{ bytes: jpg(100, 100) }] }); void blob;
    assert.ok(Math.abs(check.widthPt - wMM / 25.4 * 72) < 0.01 && Math.abs(check.heightPt - hMM / 25.4 * 72) < 0.01, JSON.stringify(o));
  };
  await want({}, 210, 297)(); await want({ landscape: true }, 297, 210)(); await want({ paper: 'A5' }, 148, 210)(); await want({ paper: 'LETTER' }, 215.9, 279.4)(); await want({ paper: 'LETTER', landscape: true }, 279.4, 215.9)();
  await want({ paper: { key: 'CUSTOM', w: 4, h: 6, unit: 'in' }, groups: [{ w: 30, h: 40, copies: 1 }] }, 101.6, 152.4)();
  const l = await exportSheetPdf({ layout: L({ paper: 'LETTER' }), images: [{ bytes: jpg(10, 10) }] }); assert.ok(Math.abs(l.check.widthPt - 612) < 0.01 && Math.abs(l.check.heightPt - 792) < 0.01);
});
test('two images, one object each; shared across copies', async () => {
  const lay = L({ groups: [{ w: 35, h: 45, copies: 4 }, { w: 50, h: 70, copies: 2 }] }), { blob, infos } = await exportSheetPdf({ layout: lay, images: [{ bytes: jpg(413, 531) }, { bytes: jpg(591, 827) }] }), s = await text(blob);
  assert.equal([...s.matchAll(/\/Subtype \/Image/g)].length, 2); assert.deepEqual(infos.map((i) => [i.width, i.height]), [[413, 531], [591, 827]]);
  assert.equal(draws(s).filter((d) => d.im === 0).length, 4); assert.equal(draws(s).filter((d) => d.im === 1).length, 2);
});
test('cutting guides: one outline per photo, on the photo edges; absent when off', async () => {
  const on = await exportSheetPdf({ layout: L({ guides: 'box' }), images: [{ bytes: jpg(100, 100) }] }), s = await text(on.blob);
  assert.equal(on.check.guides, 8); assert.equal([...s.matchAll(/ re S\n/g)].length, 8); const first = /0\.25 w 0\.3 G\n([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re S/.exec(s), d = draws(s)[0];
  assert.ok(Math.abs(+first[1] - d.x) < 0.01 && Math.abs(+first[2] - d.y) < 0.01 && Math.abs(+first[3] - d.w) < 0.01 && Math.abs(+first[4] - d.h) < 0.01);
  const off = await exportSheetPdf({ layout: L(), images: [{ bytes: jpg(100, 100) }] }); assert.equal(off.check.guides, 0);
  const pages = pdfPagesFor(L({ guides: 'box' }));
  const bytes = new Uint8Array(await on.blob.arrayBuffer()); assert.throws(() => validatePdf(bytes, { pageMM: { w: 210, h: 297 }, pages, images: [{ w: 100, h: 100 }], guides: 'none' }), /guides/);
});
test('validatePdf catches a photo that is not where the layout says', async () => {
  const lay = L(), { blob } = await exportSheetPdf({ layout: lay, images: [{ bytes: jpg(100, 100) }] }), bytes = new Uint8Array(await blob.arrayBuffer());
  const moved = pdfPagesFor(lay); moved[0][3] = { ...moved[0][3], x: moved[0][3].x + 1 };
  assert.throws(() => validatePdf(bytes, { pageMM: lay.page, pages: moved, images: [{ w: 100, h: 100 }] }), /photo 4 is not at its planned position/);
  const resized = pdfPagesFor(lay); resized[0][0] = { ...resized[0][0], w: 36 };
  assert.throws(() => validatePdf(bytes, { pageMM: lay.page, pages: resized, images: [{ w: 100, h: 100 }] }), /photo 1/);
  assert.throws(() => validatePdf(bytes, { pageMM: { w: 215.9, h: 279.4 }, pages: pdfPagesFor(lay), images: [{ w: 100, h: 100 }] }), /page size/);
  assert.throws(() => validatePdf(bytes, { pageMM: lay.page, pages: pdfPagesFor(lay), images: [{ w: 101, h: 100 }] }), /image size/);
});
test('legacy single-image PDF call is unchanged (jpeg param, default image 0)', async () => {
  const pages = [[{ x: 10, y: 10, w: 35, h: 45 }]], blob = buildPdf({ pageMM: { w: 210, h: 297 }, pages, jpeg: { bytes: jpg(413, 531) } }), s = await text(blob);
  assert.ok(s.includes('4 0 obj\n<< /Title (Shrinkit photo sheet)')); assert.ok(s.includes('/Page /Parent 2 0 R') && /5 0 obj\n<< \/Type \/Page /.test(s));
  validatePdf(new Uint8Array(await blob.arrayBuffer()), { pageMM: { w: 210, h: 297 }, pages, imageW: 413, imageH: 531 });
});
test('export errors are readable and nothing is half-made', async () => {
  const lay = L();
  await assert.rejects(() => exportSheetPdf({ layout: { ok: false, error: 'Margin must be 0 to 50 mm.' }, images: [] }), /Margin must be/);
  await assert.rejects(() => exportSheetPdf({ layout: lay, images: [] }), /needs a picture/);
  await assert.rejects(() => exportSheetPdf({ layout: lay, images: [{ bytes: new Uint8Array([1, 2, 3]) }] }), (e) => !!e.message);
  const ov = L({ mode: 'manual', manual: { 'g0:1': { x: 12, y: 12 } } }); assert.equal(ov.exportable, false);
  await assert.rejects(() => exportSheetPdf({ layout: ov, images: [{ bytes: jpg(10, 10) }] }), /overlap/i);
  const bp = (o) => () => buildPdf({ pageMM: { w: 210, h: 297 }, pages: [[{ x: 1, y: 1, w: 10, h: 10 }]], images: [{ bytes: jpg(10, 10) }], ...o });
  assert.throws(bp({ pages: [] }), /nothing to place/); assert.throws(bp({ pages: [[]] }), /nothing to place/); assert.throws(bp({ images: [] }), /no photo/);
  assert.throws(bp({ pages: [[{ x: 1, y: 1, w: 10, h: 10, image: 3 }]] }), /no image/); assert.throws(bp({ pages: [[{ x: 1, y: 1, w: 0, h: 10 }]] }), /invalid/); assert.throws(bp({ pages: [[{ x: NaN, y: 1, w: 5, h: 10 }]] }), /invalid/);
  assert.throws(bp({ pageMM: { w: 9000, h: 100 } }), /outside what a PDF/); assert.throws(bp({ pageMM: { w: 0, h: 100 } }), /outside what a PDF/); assert.throws(bp({ guides: 'dots' }), /guide/);
});
test('PDF stays small: the same picture is embedded once however many copies', async () => {
  const big = new Uint8Array(200_000); big.set(jpg(100, 100)); const a = await exportSheetPdf({ layout: L({ groups: [{ w: 35, h: 45, copies: 1 }] }), images: [{ bytes: big }] }), b = await exportSheetPdf({ layout: L({ groups: [{ w: 35, h: 45, copies: 25 }] }), images: [{ bytes: big }] });
  assert.ok(b.blob.size - a.blob.size < 5000, 'extra copies cost ' + (b.blob.size - a.blob.size) + ' bytes');
});
test('planGroupImage: crop shape, never upscale, never stretch, limits', () => {
  const g = { w: 35, h: 45, fit: 'cover' }, p = planGroupImage(2000, 3000, g, 300);
  assert.deepEqual([p.width, p.height], [413, 531]); assert.ok(Math.abs(p.crop.w / p.crop.h - 35 / 45) < 0.002); assert.ok(p.crop.x >= 0 && p.crop.y >= 0 && p.crop.x + p.crop.w <= 2000 && p.crop.y + p.crop.h <= 3000);
  const small = planGroupImage(200, 300, g, 300); assert.ok(small.width <= 200 && small.height <= 300); assert.ok(Math.abs(small.width / small.height - 35 / 45) < 0.01); assert.ok(small.effectiveDpi < 300);
  const same = planGroupImage(413, 531, g, 300); assert.equal(same.resize, null); assert.deepEqual([same.width, same.height], [same.crop.w, same.crop.h]);
  const c = planGroupImage(300, 200, { w: 100, h: 100, fit: 'contain' }, 300); assert.ok(c.width <= 300 && c.height <= 300 && c.crop === null); assert.equal(c.resize.fit, 'contain');
  const huge = planGroupImage(20000, 20000, { w: 1200, h: 1200, fit: 'cover' }, 1200); assert.ok(huge.width * huge.height <= 40_000_000 && Math.max(huge.width, huge.height) <= 20000);
  assert.throws(() => planGroupImage(0, 10, g, 300), /no size/);
});
test('previewSourceRect uses the same centre-crop rule as the export', () => {
  const r = previewSourceRect(2000, 3000, { w: 35, h: 45, fit: 'cover' }), p = planGroupImage(2000, 3000, { w: 35, h: 45, fit: 'cover' }, 300);
  assert.ok(Math.abs(r.w - p.crop.w) <= 1 && Math.abs(r.x - p.crop.x) <= 1 && Math.abs(r.y - p.crop.y) <= 1); assert.equal(previewSourceRect(10, 10, { w: 1, h: 1, fit: 'contain' }).contain, true);
});
