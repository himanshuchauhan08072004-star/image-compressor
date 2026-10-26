import test from 'node:test';
import assert from 'node:assert/strict';
import { mmToPx, pxToMm, validateSpec, computeCrop, outputPlan, passportRecipeParts, maxZoom, PRESETS, baseCrop } from '../src/core/passport.js';
import { layoutSheet, validateSheet, PAPERS, LIMITS } from '../src/core/sheet.js';
import { buildPdf, validatePdf, jpegInfo, PT_PER_MM } from '../src/core/pdf.js';
import { planOutput } from '../src/core/geometry.js';

const spec = (o = {}) => { const r = validateSpec({ wMM: 35, hMM: 45, dpi: 300, ...o }); assert.ok(r.ok, r.error); return r.spec; };
const jpg = (w, h, comps = 3) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 8 + comps * 3, 8, h >> 8, h & 255, w >> 8, w & 255, comps, ...Array(comps * 3).fill(1), 0xff, 0xd9]);
const aspectErr = (c, a) => Math.abs(c.w / c.h - a) / a;

test('mm -> px at 300 DPI (and other DPIs); round trip', () => {
  assert.equal(mmToPx(35, 300), 413); assert.equal(mmToPx(45, 300), 531); assert.equal(mmToPx(50.8, 300), 600); assert.equal(mmToPx(25.4, 300), 300);
  assert.equal(mmToPx(35, 150), 207); assert.equal(mmToPx(35, 600), 827);
  assert.equal(mmToPx(pxToMm(413, 300), 300), 413); assert.equal(mmToPx(pxToMm(1234, 300), 300), 1234);
  const s = spec(); assert.deepEqual([s.wPx, s.hPx], [413, 531]); assert.ok(Math.abs(s.aspect - 413 / 531) < 1e-12);
});
test('presets are general sizes and convert to expected pixels at 300 DPI', () => {
  const px = Object.fromEntries(PRESETS.map((p) => [p.key, [mmToPx(p.w, 300), mmToPx(p.h, 300)]]));
  assert.deepEqual(px, { '35x45': [413, 531], '2x2in': [600, 600], '33x48': [390, 567], '40x50': [472, 591] });
});
test('validateSpec: custom sizes, ranges, DPI, safety limits', () => {
  assert.equal(validateSpec({ wMM: 9, hMM: 45, dpi: 300 }).ok, false); assert.equal(validateSpec({ wMM: 35, hMM: 301, dpi: 300 }).ok, false);
  assert.equal(validateSpec({ wMM: 35, hMM: 45, dpi: 71 }).ok, false); assert.equal(validateSpec({ wMM: 35, hMM: 45, dpi: 300.5 }).ok, false);
  assert.equal(validateSpec({ wMM: NaN, hMM: 45, dpi: 300 }).ok, false); assert.equal(validateSpec({ wMM: 35, hMM: 45, dpi: 1201 }).ok, false);
  const big = validateSpec({ wMM: 300, hMM: 300, dpi: 600 }); assert.equal(big.ok, false); assert.match(big.error, /7087 × 7087/); assert.match(big.error, /40 megapixel/);
  assert.equal(validateSpec({ wMM: 300, hMM: 300, dpi: 300 }).ok, true);                // 3543² = 12.6 MP
  assert.equal(validateSpec({ wMM: 123.4, hMM: 56.7, dpi: 300 }).spec.wPx, mmToPx(123.4, 300));
});
test('validateSpec: max side limit message', () => {
  const r = validateSpec({ wMM: 300, hMM: 10, dpi: 1200 }); assert.equal(r.ok, true); assert.equal(r.spec.wPx, 14173);   // under 16384: allowed
  assert.equal(validateSpec({ wMM: 300, hMM: 20, dpi: 1200 }).ok, true); assert.equal(validateSpec({ wMM: 300, hMM: 300, dpi: 1200 }).ok, false);
});
test('computeCrop: portrait, landscape and square sources keep the exact aspect and stay inside', () => {
  const a = spec().aspect;
  for (const [sw, sh] of [[3000, 4000], [4000, 3000], [3000, 3000], [1200, 1800], [5000, 800], [800, 5000], [413, 531], [100, 100]]) {
    for (const zoom of [1, 1.5, 3, 8]) {
      const c = computeCrop(sw, sh, a, zoom);
      assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= sw && c.y + c.h <= sh, JSON.stringify([sw, sh, zoom, c]));
      assert.ok(aspectErr(c, a) <= 0.75 / Math.min(c.w, c.h), `aspect ${sw}x${sh} z${zoom}: ${c.w}/${c.h}`);   // integer pixels: error is at most about half a pixel
      assert.ok(planOutput(sw, sh, { crop: c }).ok, 'the real planner accepts it');
    }
  }
});
test('computeCrop: zoom 1 is the largest fit; zoom shrinks it; centre moves it and is clamped', () => {
  const a = 413 / 531, c1 = computeCrop(3000, 4000, a, 1), b = baseCrop(3000, 4000, a);
  assert.ok(Math.abs(c1.w - b.w) <= 1 && c1.w === 3000);                                  // portrait 3:4 source: width-limited
  assert.deepEqual([c1.x, c1.w], [0, 3000]);
  const l = computeCrop(4000, 3000, a, 1); assert.equal(l.h, 3000); assert.equal(l.y, 0); assert.equal(l.x, Math.round(2000 - l.w / 2));   // landscape source: height-limited, centred
  const z2 = computeCrop(3000, 4000, a, 2); assert.ok(Math.abs(z2.w - 1500) <= 1);
  const edge = computeCrop(3000, 4000, a, 2, 0, 0); assert.deepEqual([edge.x, edge.y], [0, 0]);
  const far = computeCrop(3000, 4000, a, 2, 99999, 99999); assert.equal(far.x + far.w, 3000); assert.equal(far.y + far.h, 4000);
  assert.equal(computeCrop(3000, 4000, a, 0.2).w, c1.w); assert.equal(computeCrop(3000, 4000, a, NaN).w, c1.w);   // bad zoom -> 1
  assert.ok(computeCrop(3000, 4000, a, 9999).w >= 16); assert.ok(maxZoom(3000, 4000, a) <= 8);
});
test('swapped (landscape) photo size gives a landscape crop', () => {
  const s = spec({ wMM: 45, hMM: 35 }); const c = computeCrop(3000, 4000, s.aspect, 1); assert.ok(c.w > c.h && aspectErr(c, s.aspect) < 0.01);
});
test('outputPlan: downscales to the exact target, never upscales, reports effective DPI', () => {
  const s = spec(), big = computeCrop(3000, 4000, s.aspect, 1), o = outputPlan(big, s);
  assert.deepEqual([o.w, o.h], [413, 531]); assert.deepEqual([o.resize.width, o.resize.height, o.resize.allowUpscale], [413, 531, false]); assert.equal(o.upscaleAvoided, false); assert.equal(o.effectiveDpi, 300);
  const small = computeCrop(300, 400, s.aspect, 1), p = outputPlan(small, s);
  assert.equal(p.upscaleAvoided, true); assert.deepEqual([p.w, p.h], [small.w, small.h]); assert.equal(p.resize, null); assert.ok(p.effectiveDpi < 300 && p.effectiveDpi > 200, String(p.effectiveDpi));
  const exact = outputPlan({ x: 0, y: 0, w: 413, h: 531 }, s); assert.equal(exact.resize, null); assert.equal(exact.upscaleAvoided, false);
});
test('passportRecipeParts: recipe is accepted by the real planner and respects output limits', () => {
  for (const [sw, sh] of [[3000, 4000], [4000, 3000], [300, 400]]) {
    const s = spec(), r = passportRecipeParts(sw, sh, s, { zoom: 1.7, cx: sw / 2, cy: sh / 2 }, 'white'), p = planOutput(sw, sh, { crop: r.crop, resize: r.resize });
    assert.ok(p.ok, p.error); assert.equal(p.plan.outW, r.out.w); assert.equal(p.plan.outH, r.out.h); assert.equal(r.flatten, true);
    assert.equal(passportRecipeParts(sw, sh, s, { zoom: 1, cx: 0, cy: 0 }, 'keep').flatten, false);
  }
});

// ---------------------------------------------------------------- sheet
const L = (o = {}) => layoutSheet({ paper: 'A4', margin: 10, gap: 3, copies: 8, photoW: 35, photoH: 45, ...o });
test('layoutSheet: A4 portrait grid maths (35 × 45, margin 10, gap 3)', () => {
  const r = L(); assert.ok(r.ok); assert.deepEqual(r.page, { w: 210, h: 297 }); assert.deepEqual(r.printable, { x: 10, y: 10, w: 190, h: 277 });
  assert.equal(r.cols, 5); assert.equal(r.rows, 5); assert.equal(r.perPage, 25);                   // floor((190+3)/38)=5, floor((277+3)/48)=5
  assert.equal(r.pages.length, 1); assert.equal(r.pages[0].length, 8); assert.deepEqual(r.pages[0][0], { x: 10, y: 10, w: 35, h: 45 }); assert.deepEqual(r.pages[0][5], { x: 10, y: 58, w: 35, h: 45 });
});
test('layoutSheet: every rect keeps its physical size, stays inside the margins, never overlaps, keeps the spacing', () => {
  for (const o of [{}, { margin: 0, gap: 0 }, { margin: 20, gap: 5, copies: 40 }, { landscape: true, copies: 20 }, { photoW: 50.8, photoH: 50.8, copies: 12 }, { margin: 5.5, gap: 1.25, photoW: 33, photoH: 48, copies: 30 }]) {
    const r = L({ copies: 8, ...o }); assert.ok(r.ok, JSON.stringify(o)); const m = o.margin ?? 10, g = o.gap ?? 3;
    for (const page of r.pages) {
      for (const a of page) {
        assert.equal(a.w, o.photoW ?? 35); assert.equal(a.h, o.photoH ?? 45);
        assert.ok(a.x >= m - 1e-9 && a.y >= m - 1e-9 && a.x + a.w <= r.page.w - m + 1e-9 && a.y + a.h <= r.page.h - m + 1e-9, 'inside printable ' + JSON.stringify(a));
      }
      for (let i = 0; i < page.length; i++) for (let j = i + 1; j < page.length; j++) {
        const a = page[i], b = page[j], dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
        assert.ok(Math.max(dx, dy) >= g - 1e-9, 'gap >= spacing between ' + i + ' and ' + j);
      }
    }
  }
});
test('layoutSheet: landscape swaps the page; margin 0 / gap 0 fills the page exactly', () => {
  const r = L({ landscape: true }); assert.deepEqual(r.page, { w: 297, h: 210 });
  const f = L({ margin: 0, gap: 0, photoW: 70, photoH: 99, copies: 6 }); assert.equal(f.cols, 3); assert.equal(f.rows, 3); assert.equal(f.perPage, 9);
  const exact = L({ margin: 0, gap: 0, photoW: 105, photoH: 148.5, copies: 4 }); assert.equal(exact.perPage, 4); assert.ok(exact.pages[0].every((a) => a.x + a.w <= 210 + 1e-9 && a.y + a.h <= 297 + 1e-9));
});
test('layoutSheet: multiple copies spill onto extra pages; counts add up', () => {
  const r = L({ copies: 60 }); assert.equal(r.perPage, 25); assert.equal(r.pages.length, 3); assert.deepEqual(r.pages.map((p) => p.length), [25, 25, 10]); assert.equal(r.pages.flat().length, 60);
  assert.equal(L({ copies: 1 }).pages[0].length, 1); assert.equal(L({ copies: 25 }).pages.length, 1); assert.equal(L({ copies: 26 }).pages.length, 2);
});
test('layoutSheet: refuses instead of clipping; validates margins, spacing, copies, page limit', () => {
  const big = L({ photoW: 200, photoH: 45 }); assert.equal(big.ok, false); assert.match(big.error, /does not fit/);
  assert.equal(L({ margin: 120 }).ok, false); assert.equal(L({ margin: -1 }).ok, false); assert.equal(L({ gap: 31 }).ok, false); assert.equal(L({ copies: 0 }).ok, false); assert.equal(L({ copies: 2.5 }).ok, false); assert.equal(L({ copies: 101 }).ok, false);
  assert.equal(L({ photoW: 190, photoH: 277, copies: 11 }).ok, false); assert.match(L({ photoW: 190, photoH: 277, copies: 11 }).error, /limit/);
  assert.equal(L({ photoW: 190, photoH: 277, copies: 10 }).ok, true); assert.equal(L({ paper: 'B9' }).ok, false); assert.equal(PAPERS.A4.w, 210);
  assert.equal(validateSheet({ paper: 'A4', margin: 0, gap: 0, copies: LIMITS.copiesMax }).ok, true);
});

// ---------------------------------------------------------------- PDF
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
test('jpegInfo reads size/components; rejects non-JPEG and unsupported layouts', () => {
  assert.deepEqual(jpegInfo(jpg(413, 531)), { width: 413, height: 531, components: 3 }); assert.deepEqual(jpegInfo(jpg(10, 20, 1)), { width: 10, height: 20, components: 1 });
  assert.throws(() => jpegInfo(Uint8Array.from([0x89, 0x50])), (e) => e.code === 'pdf-image'); assert.throws(() => jpegInfo(jpg(10, 10, 4)), (e) => e.code === 'pdf-image');
});
test('buildPdf: A4 page size in points, photos at physical size, validates itself; 8 copies on one page', async () => {
  const r = L(), blob = buildPdf({ pageMM: r.page, pages: r.pages, jpeg: { bytes: jpg(413, 531) } }), b = await bytesOf(blob), s = new TextDecoder('latin1').decode(b);
  assert.equal(blob.type, 'application/pdf'); const v = validatePdf(b, { pageMM: r.page, pages: r.pages, imageW: 413, imageH: 531 });
  assert.deepEqual([v.pages, v.photos], [1, 8]); assert.ok(Math.abs(v.widthPt - 595.2756) < 0.01 && Math.abs(v.heightPt - 841.8898) < 0.01, `${v.widthPt} x ${v.heightPt}`);
  assert.match(s, /\/MediaBox \[0 0 595\.2756 841\.8898\]/);
  const w = 35 * PT_PER_MM, h = 45 * PT_PER_MM; assert.ok(s.includes('q ' + Math.round(w * 1e4) / 1e4 + ' 0 0 ' + Math.round(h * 1e4) / 1e4 + ' '), 'photo drawn 35 × 45 mm in points (99.2126 × 127.559)');
  assert.ok(Math.abs(w - 99.2126) < 1e-3 && Math.abs(h - 127.559) < 1e-3);
  const first = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/.exec(s); assert.ok(Math.abs(+first[3] - 10 * PT_PER_MM) < 1e-3, 'left margin 10 mm'); assert.ok(Math.abs(+first[4] - (841.8898 - 55 * PT_PER_MM)) < 1e-2, 'top margin 10 mm (PDF y is bottom-up)');
  assert.ok(/\/Filter \/DCTDecode/.test(s) && /\/Width 413 \/Height 531/.test(s));
});
test('buildPdf: landscape page, several pages, same image object shared', async () => {
  const r = L({ landscape: true, copies: 60 }), b = await bytesOf(buildPdf({ pageMM: r.page, pages: r.pages, jpeg: { bytes: jpg(100, 130) } })), s = new TextDecoder('latin1').decode(b);
  const v = validatePdf(b, { pageMM: r.page, pages: r.pages, imageW: 100, imageH: 130 }); assert.equal(v.pages, r.pages.length); assert.equal(v.photos, 60); assert.ok(Math.abs(v.widthPt - 841.8898) < 0.01 && Math.abs(v.heightPt - 595.2756) < 0.01);
  assert.equal([...s.matchAll(/\/Subtype \/Image/g)].length, 1);
});
test('validatePdf: detects wrong page size, wrong photo count, damaged xref, wrong image size', async () => {
  const r = L(), b = await bytesOf(buildPdf({ pageMM: r.page, pages: r.pages, jpeg: { bytes: jpg(413, 531) } })), base = { pageMM: r.page, pages: r.pages, imageW: 413, imageH: 531 };
  assert.throws(() => validatePdf(b, { ...base, pageMM: { w: 297, h: 210 } }), (e) => e.code === 'pdf-invalid' && /page size/.test(e.message));
  assert.throws(() => validatePdf(b, { ...base, pages: [r.pages[0].slice(1)] }), /photos drawn/); assert.throws(() => validatePdf(b, { ...base, imageW: 400 }), /image size/);
  const broken = b.slice(); const s = new TextDecoder('latin1').decode(broken), at = s.indexOf('xref\n') + 30; broken[at] = 0x39; assert.throws(() => validatePdf(broken, base), /offset|xref/);
  assert.throws(() => validatePdf(b.slice(0, b.length - 8), base), /end marker/); assert.throws(() => validatePdf(Uint8Array.from([1, 2, 3]), base), /header/);
});
test('buildPdf refuses empty pages', () => { assert.throws(() => buildPdf({ pageMM: { w: 210, h: 297 }, pages: [[]], jpeg: { bytes: jpg(1, 1) } }), (e) => e.code === 'pdf-empty'); });
