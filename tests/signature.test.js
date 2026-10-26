import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  DEFAULTS, PRESETS, RANGES, WORK_MAX_PIXELS, PAD_MAX, INK_LEVEL, normalizeParams, assertPixels, toGray, estimateBackground, bgPlane, alphaCurve, cleanAlpha,
  speckArea, removeSpecks, inkBounds, scaleRectOut, inkOutsideCrop, detectInk, resolveInk, composeRGBA, processAlpha, exportRegion, planExport, pngDeclaresAlpha, BLUE,
} from '../src/core/signature.js';
import { inspectImage } from '../src/core/decode.js';
import { MAX_SIDE, MAX_OUTPUT_PIXELS } from '../src/core/limits.js';
import { A, be32, cat, png, pngChunk } from './helpers.js';

// ---------- synthetic "photos" ----------
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const reseed = () => { seed = 12345; };

/** Paper with optional shading gradient and noise. */
function paper(w, h, { base = 240, shade = 0, noise = 0 } = {}) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, v = base - shade * (x / w) + (rnd() - 0.5) * 2 * noise;
    d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
  }
  return d;
}
/** Distance from point to segment. */
const dseg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
/**
 * Draw anti-aliased ink: pixels within `r` of a segment (or a dot) are darkened toward `ink` colour with a soft 1px edge.
 * Returns the ground-truth core mask (pixels at the centre line, certainly ink).
 */
function stroke(d, w, h, segs, { ink = [20, 20, 90], r = 1, strength = 1 } = {}) {
  const core = new Uint8Array(w * h);
  for (const [ax, ay, bx, by] of segs) {
    for (let y = Math.max(0, Math.floor(Math.min(ay, by) - r - 2)); y <= Math.min(h - 1, Math.ceil(Math.max(ay, by) + r + 2)); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - r - 2)); x <= Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r + 2)); x++) {
        const dist = dseg(x, y, ax, ay, bx, by), cover = Math.max(0, Math.min(1, r + 0.5 - dist)) * strength;
        if (cover <= 0) continue;
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) d[i + c] = d[i + c] * (1 - cover) + ink[c] * cover;
        if (dist <= Math.max(0.5, r - 0.5)) core[y * w + x] = 1;
      }
    }
  }
  return core;
}
const prep = (d, w, h) => { const gray = toGray(d, w, h), bg = estimateBackground(gray, w, h); return { gray, bgp: bgPlane(bg, { w, h }), bg }; };
const run = (d, w, h, params) => { const { gray, bgp } = prep(d, w, h); return processAlpha(gray, bgp, w, h, params, w * h); };
const share = (alpha, mask, min) => { let n = 0, hit = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) { n++; if (alpha[i] >= min) hit++; } return hit / n; };
const countWhere = (alpha, mask, min) => { let n = 0; for (let i = 0; i < alpha.length; i++) if (!mask[i] && alpha[i] > min) n++; return n; };

/** A little squiggle + dots, roughly signature-like. */
const SIG = [[20, 70, 50, 30], [50, 30, 80, 75], [80, 75, 110, 35], [110, 35, 150, 70], [150, 70, 190, 60]];
const DOTS = [[170, 20, 170, 20], [30, 95, 30, 95]];   // disconnected dots

// ---------- params ----------
test('normalizeParams: clamps, rounds, ignores garbage, validates colours', () => {
  assert.deepEqual(normalizeParams(), DEFAULTS);
  const p = normalizeParams({ brightness: 999, contrast: -999, threshold: 300.6, ink: -4, whiten: 'x', noise: NaN, inkColor: 'rainbow', customColor: 'javascript:1' });
  assert.deepEqual([p.brightness, p.contrast, p.threshold, p.ink, p.whiten, p.noise], [100, -100, 255, 0, DEFAULTS.whiten, DEFAULTS.noise]);
  assert.equal(p.inkColor, 'auto'); assert.equal(p.customColor, DEFAULTS.customColor);
  assert.equal(normalizeParams({ customColor: '#ABCDEF', inkColor: 'custom' }).customColor, '#abcdef');
  assert.equal(normalizeParams({ brightness: '', contrast: null }).brightness, 0);
  for (const pr of PRESETS) for (const [k, v] of Object.entries(pr.values)) assert.ok(v >= RANGES[k][0] && v <= RANGES[k][1], pr.key + ' ' + k);
});

test('assertPixels / toGray reject mismatched or empty data with a user message', () => {
  assert.throws(() => assertPixels(new Uint8ClampedArray(7), 2, 1), { code: 'pixels' });
  assert.throws(() => toGray(new Uint8ClampedArray(0), 0, 0), { code: 'pixels' });
  assert.throws(() => toGray(null, 2, 2), { code: 'pixels' });
  assert.throws(() => estimateBackground(new Uint8Array(3), 2, 2), { code: 'pixels' });
  assert.throws(() => assertPixels(new Uint8ClampedArray(8), 1.5, 2), { code: 'pixels' });
});

test('toGray: luminance, and source transparency counts as white', () => {
  const d = Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 10, 10, 10, 0, 0, 0, 0, 128]);
  const g = toGray(d, 5, 1);
  assert.deepEqual([g[0], g[1]], [0, 255]); assert.equal(g[2], Math.round(0.299 * 255));
  assert.equal(g[3], 255);                 // fully transparent -> white
  assert.ok(g[4] > 120 && g[4] < 135);     // half transparent black over white -> mid grey
});

// ---------- threshold ----------
test('threshold: alpha curve is 0 above the threshold, full well below it, monotonic, and the threshold moves the cut', () => {
  const p = normalizeParams({ ink: 0, threshold: 150 }), lut = alphaCurve(p);
  assert.equal(lut[255], 0); assert.equal(lut[200], 0); assert.equal(lut[150], 0);
  assert.equal(lut[0], 255); assert.equal(lut[100], 255);
  for (let v = 1; v < 256; v++) assert.ok(lut[v] <= lut[v - 1], 'monotonic at ' + v);
  assert.ok(lut[130] > 0 && lut[130] < 255, 'soft ramp keeps anti-aliased edges');
  const hi = alphaCurve(normalizeParams({ ink: 0, threshold: 220 }));
  assert.ok(hi[200] > 0 && lut[200] === 0, 'a higher threshold keeps fainter marks');
  assert.equal(alphaCurve(normalizeParams({ threshold: 0 })).every((v) => v === 0), true);
});

test('threshold: whole-image behaviour on a flat grey ramp', () => {
  const w = 256, h = 4, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = x; d[i + 3] = 255; }
  const base = { brightness: 0, contrast: 0, ink: 0, whiten: 0, noise: 0 };
  const lo = cleanAlpha(toGray(d, w, h), new Uint8Array(w * h).fill(255), { ...base, threshold: 100 }), hi = cleanAlpha(toGray(d, w, h), new Uint8Array(w * h).fill(255), { ...base, threshold: 200 });
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  assert.ok(sum(hi) > sum(lo)); assert.equal(lo[200], 0); assert.ok(hi[150] > 200);
  for (let x = 1; x < w; x++) assert.ok(hi[x] <= hi[x - 1]);       // darker -> never less ink
});

test('brightness, contrast and ink darkness move alpha in the expected direction', () => {
  const w = 3, h = 1, d = Uint8ClampedArray.from([150, 150, 150, 255, 150, 150, 150, 255, 150, 150, 150, 255]);
  const g = toGray(d, w, h), bgp = new Uint8Array(3).fill(255), base = { ...DEFAULTS, whiten: 0, contrast: 0, brightness: 0, ink: 0, threshold: 170 };
  const a0 = cleanAlpha(g, bgp, base)[0];
  assert.ok(cleanAlpha(g, bgp, { ...base, brightness: 40 })[0] < a0, 'brighter -> less ink');
  assert.ok(cleanAlpha(g, bgp, { ...base, brightness: -40 })[0] > a0, 'darker -> more ink');
  const lightInk = (c) => cleanAlpha(g, bgp, { ...base, threshold: 120, contrast: c })[0];
  assert.ok(lightInk(60) > lightInk(0) && lightInk(-40) <= lightInk(0), 'ink darker than the light pivot: more contrast = stronger ink');
  assert.ok(cleanAlpha(g, bgp, { ...base, ink: 80 })[0] > a0, 'ink darkness strengthens');
});

// ---------- background whitening ----------
test('whitening flattens uneven paper to nothing while keeping ink (shaded, noisy photo)', () => {
  reseed();
  const w = 220, h = 120, d = paper(w, h, { base: 238, shade: 70, noise: 6 });      // 238 -> 168 across the page, plus noise
  const core = stroke(d, w, h, SIG, { r: 1.2 });
  const { alpha } = run(d, w, h, { ...DEFAULTS, whiten: 100 });
  assert.ok(share(alpha, core, 128) > 0.9, 'stroke recall ' + share(alpha, core, 128));
  const bad = countWhere(alpha, (() => { const m = new Uint8Array(w * h); for (let i = 0; i < m.length; i++) { const x = i % w, y = (i - x) / w; for (const s of SIG) if (dseg(x, y, ...s) < 6) { m[i] = 1; break; } } return m; })(), INK_LEVEL);
  assert.ok(bad / (w * h) < 0.002, 'background pixels wrongly kept: ' + bad);
  const none = run(d, w, h, { ...DEFAULTS, whiten: 0 }).alpha;                       // sanity: without whitening the dark side of the page leaks
  let leak = 0; for (let i = 0; i < none.length; i++) if (none[i] > INK_LEVEL) leak++;
  assert.ok(leak > bad * 5, 'whiten has a measurable effect (' + leak + ' vs ' + bad + ')');
});

test('estimateBackground tracks the paper, ignoring thin ink; bgPlane works at any window and any size', () => {
  const w = 200, h = 100, d = paper(w, h, { base: 220, shade: 0, noise: 0 });
  stroke(d, w, h, [[10, 50, 190, 50]], { r: 1.5, ink: [0, 0, 0] });
  const bg = estimateBackground(toGray(d, w, h), w, h), full = bgPlane(bg, { w, h });
  assert.ok(Math.abs(full[50 * w + 100] - 220) <= 1, 'ink row still reports paper level: ' + full[50 * w + 100]);
  const small = bgPlane(bg, { w: 20, h: 10 }), win = bgPlane(bg, { w: 10, h: 10, u0: 0.5, v0: 0.5, u1: 1, v1: 1 });
  assert.equal(small.length, 200); assert.ok(small.every((v) => Math.abs(v - 220) <= 1)); assert.ok(win.every((v) => Math.abs(v - 220) <= 1));
  const tiny = estimateBackground(new Uint8Array([200]), 1, 1); assert.equal(bgPlane(tiny, { w: 3, h: 3 })[4], 200);   // 1x1 image does not crash
});

// ---------- stroke preservation ----------
test('stroke preservation: thin strokes and disconnected dots survive every preset', () => {
  for (const pr of PRESETS) {
    reseed();
    const w = 220, h = 120, d = paper(w, h, { base: 240, shade: 25, noise: 4 });
    const core = stroke(d, w, h, [...SIG, ...DOTS], { r: 1.1 });
    const { alpha } = run(d, w, h, { ...DEFAULTS, ...pr.values });
    assert.ok(share(alpha, core, 128) > 0.85, pr.key + ' stroke recall ' + share(alpha, core, 128).toFixed(3));
    const dot = (x, y) => alpha[y * w + x]; assert.ok(dot(170, 20) > 128 && dot(30, 95) > 128, pr.key + ' dots kept');
  }
});

test('stroke preservation: a faint signature is found by the Faint preset and lost by Dark Ink (that is what the presets are for)', () => {
  reseed();
  const w = 220, h = 120, d = paper(w, h, { base: 244, noise: 3 });
  const core = stroke(d, w, h, SIG, { r: 1.4, ink: [150, 150, 175] });          // pale pen
  const faint = run(d, w, h, { ...DEFAULTS, ...PRESETS.find((p) => p.key === 'faint').values }).alpha;
  const dark = run(d, w, h, { ...DEFAULTS, ...PRESETS.find((p) => p.key === 'dark').values }).alpha;
  assert.ok(share(faint, core, 128) > 0.85, 'faint recall ' + share(faint, core, 128).toFixed(3));
  assert.ok(share(faint, core, 128) > share(dark, core, 128), 'faint preset beats dark preset on a pale pen');
});

test('stroke preservation: width-1 line stays continuous (no gaps) at default settings', () => {
  reseed();
  const w = 200, h = 40, d = paper(w, h, { base: 240, noise: 3 });
  stroke(d, w, h, [[10, 20, 190, 20]], { r: 0.6, ink: [10, 10, 10] });
  const { alpha } = run(d, w, h, DEFAULTS);
  for (let x = 12; x < 188; x++) assert.ok(Math.max(alpha[19 * w + x], alpha[20 * w + x], alpha[21 * w + x]) >= 100, 'gap at x=' + x);
});

// ---------- noise / specks ----------
test('speck removal: clears small faint blobs, keeps strokes, dots and disconnected parts', () => {
  const w = 120, h = 80, a = new Uint8Array(w * h);
  const fill = (x0, y0, ww, hh, v) => { for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + ww; x++) a[y * w + x] = v; };
  fill(5, 5, 2, 2, 80); fill(20, 5, 1, 1, 60); fill(40, 40, 3, 3, 90);          // faint specks (4, 1, 9 px)
  fill(60, 10, 7, 7, 255);                                                      // solid dot (49 px)
  fill(10, 60, 100, 1, 90);                                                     // thin faint line (100 px, connected)
  fill(80, 40, 5, 5, 200);                                                      // mid-strength disconnected mark (25 px, no solid pixel)
  const minArea = 30, n = removeSpecks(a, w, h, minArea);
  assert.equal(n, 4, 'blobs removed (three faint specks and the 25 px mid-strength blob under the limit)');
  assert.equal(a[5 * w + 5] + a[20 * w + 5] + a[41 * w + 41], 0, 'faint specks gone');
  assert.equal(a[13 * w + 63], 255, 'solid dot kept');
  assert.equal(a[60 * w + 50], 90, 'thin connected line kept');
  const b = new Uint8Array(w * h); b[100] = 90;
  assert.equal(removeSpecks(b, w, h, 0), 0); assert.equal(b[100], 90, 'minArea 0 disables removal');
});

test('noise slider: 0 keeps specks, higher removes more of them, signature stays', () => {
  reseed();
  const w = 800, h = 500, d = paper(w, h, { base: 242, noise: 2 });                    // big enough that the speck limit is a few pixels
  const core = stroke(d, w, h, [...SIG, ...DOTS], { r: 1.2 });
  for (let i = 0; i < 80; i++) { const x = 5 + Math.floor(rnd() * (w - 10)), y = 300 + Math.floor(rnd() * 190); stroke(d, w, h, [[x, y, x + 1, y]], { r: 1, ink: [160, 160, 160] }); }   // greyish dust in the lower band
  const alphaAt = (n) => run(d, w, h, { ...DEFAULTS, noise: n }).alpha;
  const dust = (alpha) => { let c = 0; for (let y = 290; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > INK_LEVEL) c++; return c; };
  const a0 = alphaAt(0), a100 = alphaAt(100);
  assert.ok(dust(a0) > 100); assert.ok(dust(a100) < dust(a0) * 0.5, 'dust ' + dust(a0) + ' -> ' + dust(a100));
  assert.ok(share(a100, core, 128) > 0.85, 'signature recall at noise 100: ' + share(a100, core, 128).toFixed(3));
  assert.equal(speckArea(0, 1e6), 0); assert.equal(speckArea(100, 1e6), 20); assert.ok(speckArea(100, 12e6) > speckArea(100, 1.4e6));
});

// ---------- bounds / crop / padding ----------
test('inkBounds: tight box containing every ink pixel; null for a blank page', () => {
  reseed();
  const w = 220, h = 120, d = paper(w, h, { base: 240, noise: 2 });
  const core = stroke(d, w, h, [...SIG, ...DOTS], { r: 1.1 });
  const { alpha } = run(d, w, h, DEFAULTS), b = inkBounds(alpha, w, h);
  for (let i = 0; i < core.length; i++) if (core[i]) { const x = i % w, y = (i - x) / w; assert.ok(x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h, 'core pixel outside bounds ' + x + ',' + y); }
  assert.ok(b.w < w && b.h < h && b.x > 5);
  assert.equal(inkBounds(new Uint8Array(100), 10, 10), null);
});

test('scaleRectOut rounds outward, adds margin and stays inside the image', () => {
  const r = scaleRectOut({ x: 10, y: 10, w: 20, h: 8 }, 3, 3, 2, 400, 300);
  assert.ok(r.x <= 28 && r.y <= 28 && r.x + r.w >= 92 && r.y + r.h >= 56);
  const edge = scaleRectOut({ x: 0, y: 0, w: 140, h: 100 }, 3, 3, 4, 400, 300); assert.deepEqual(edge, { x: 0, y: 0, w: 400, h: 300 });
  assert.ok(scaleRectOut({ x: 0, y: 0, w: 1, h: 1 }, 0.5, 0.5, 0, 10, 10).w >= 1);
});

test('inkOutsideCrop counts ink that a crop would cut off', () => {
  const w = 20, h = 10, a = new Uint8Array(w * h); a[5 * w + 2] = 255; a[5 * w + 10] = 255; a[5 * w + 18] = 255; a[0] = 10;   // last is below the ink level
  assert.deepEqual(inkOutsideCrop(a, w, h, { x: 0, y: 0, w: 20, h: 10 }), { total: 3, outside: 0 });
  assert.deepEqual(inkOutsideCrop(a, w, h, { x: 5, y: 0, w: 10, h: 10 }), { total: 3, outside: 2 });
});

test('exportRegion: crops are clamped; large crops are reduced (never enlarged) to the work limit', () => {
  const r = exportRegion({ x: -5, y: 3.4, w: 99999, h: 40 }, 4000, 3000);
  assert.deepEqual([r.src.x, r.src.y, r.src.w, r.src.h, r.k, r.tw, r.th], [0, 3, 4000, 40, 1, 4000, 40]);
  const big = exportRegion({ x: 0, y: 0, w: 8000, h: 6000 }, 8000, 6000);
  assert.ok(big.k < 1 && big.tw * big.th <= WORK_MAX_PIXELS * 1.001 && Math.abs(big.tw / big.th - 8000 / 6000) < 0.01);
  assert.equal(exportRegion({ x: 0, y: 0, w: 4000, h: 3000 }, 4000, 3000).k, 1);          // exactly the limit: untouched
  assert.equal(exportRegion({ x: 0, y: 0, w: 1, h: 1 }, 1, 1).tw, 1);
});

// ---------- output dimensions ----------
const ok = (crop, o) => { const r = planExport(crop, o); assert.ok(r.ok, r.error && r.error.message); return r.plan; };
const bad = (crop, o, code) => { const r = planExport(crop, o); assert.equal(r.ok, false); assert.equal(r.error.code, code); return r.error.message; };

test('planExport original: crop size plus padding on every side', () => {
  assert.deepEqual(ok({ w: 400, h: 150 }, { pad: 0 }), { W: 400, H: 150, dst: { x: 0, y: 0, w: 400, h: 150 }, pad: 0, scale: 1, upscaled: false });
  const p = ok({ w: 400, h: 150 }, { pad: 20, size: { mode: 'original' } });
  assert.deepEqual([p.W, p.H, p.dst.x, p.dst.y, p.dst.w, p.dst.h], [440, 190, 20, 20, 400, 150]);
});

test('planExport width: aspect ratio preserved, padding inside the width, no enlarging by default', () => {
  const p = ok({ w: 400, h: 150 }, { pad: 10, size: { mode: 'width', width: 220 } });         // inner 200 -> scale 0.5
  assert.deepEqual([p.W, p.H, p.dst.w, p.dst.h, p.scale], [220, 95, 200, 75, 0.5]);
  assert.ok(/larger than the signature/.test(bad({ w: 400, h: 150 }, { pad: 0, size: { mode: 'width', width: 800 } }, 'upscale')));
  const up = ok({ w: 400, h: 150 }, { pad: 0, size: { mode: 'width', width: 800, allowUpscale: true } }); assert.deepEqual([up.W, up.H, up.upscaled], [800, 300, true]);
  bad({ w: 400, h: 150 }, { pad: 120, size: { mode: 'width', width: 200 } }, 'pad');
  bad({ w: 400, h: 150 }, { pad: 0, size: { mode: 'width', width: 0 } }, 'size');
});

test('planExport box: contained and centred when the aspect is kept; stretched only when asked', () => {
  const c = ok({ w: 400, h: 100 }, { pad: 0, size: { mode: 'box', width: 200, height: 200, keepAspect: true } });
  assert.deepEqual([c.W, c.H, c.dst.w, c.dst.h, c.dst.x, c.dst.y], [200, 200, 200, 50, 0, 75]);
  const s = ok({ w: 400, h: 100 }, { pad: 10, size: { mode: 'box', width: 200, height: 100, keepAspect: false } }); assert.deepEqual([s.dst.x, s.dst.y, s.dst.w, s.dst.h], [10, 10, 180, 80]);
  bad({ w: 400, h: 100 }, { pad: 0, size: { mode: 'box', width: 800, height: 800, keepAspect: true } }, 'upscale');
  const e = ok({ w: 400, h: 100 }, { pad: 0, size: { mode: 'box', width: 1000, height: 1000, keepAspect: true, allowUpscale: true } }); assert.equal(e.dst.w, 1000);
  bad({ w: 400, h: 100 }, { pad: 60, size: { mode: 'box', width: 100, height: 100 } }, 'pad');
});

test('planExport: safety limits, bad numbers, unknown mode', () => {
  assert.match(bad({ w: 100, h: 100 }, { pad: 0, size: { mode: 'width', width: MAX_SIDE + 1, allowUpscale: true } }, 'too-big'), /px per side/);
  const sq = Math.floor(Math.sqrt(MAX_OUTPUT_PIXELS)) + 10; bad({ w: 100, h: 100 }, { pad: 0, size: { mode: 'box', width: sq, height: sq, allowUpscale: true } }, 'too-big');
  bad({ w: 0, h: 10 }, {}, 'crop'); bad(null, {}, 'crop'); bad({ w: 10, h: 10 }, { pad: -1 }, 'pad'); bad({ w: 10, h: 10 }, { pad: PAD_MAX + 1 }, 'pad'); bad({ w: 10, h: 10 }, { pad: NaN }, 'pad');
  bad({ w: 10, h: 10 }, { size: { mode: 'weird' } }, 'size'); bad({ w: 10, h: 10 }, { size: { mode: 'box', width: 'x', height: 4 } }, 'size');
  assert.equal(planExport({ w: 10, h: 10 }).ok, true);
});

// ---------- colour + compose ----------
test('detectInk / resolveInk', () => {
  const d = Uint8ClampedArray.from([30, 40, 120, 255, 250, 250, 250, 255, 30, 40, 120, 255]), a = Uint8Array.from([255, 0, 255]);
  assert.deepEqual(detectInk(d, a), [30, 40, 120]);
  assert.deepEqual(detectInk(d, new Uint8Array(3)), [0, 0, 0]);
  const pale = detectInk(Uint8ClampedArray.from([220, 220, 220, 255]), Uint8Array.from([255]));
  assert.ok(0.299 * pale[0] + 0.587 * pale[1] + 0.114 * pale[2] <= 151, 'kept dark enough to read on white');
  assert.deepEqual(resolveInk({ inkColor: 'auto' }, [1, 2, 3]), [1, 2, 3]); assert.deepEqual(resolveInk({ inkColor: 'black' }, [1, 2, 3]), [0, 0, 0]);
  assert.deepEqual(resolveInk({ inkColor: 'blue' }), BLUE); assert.deepEqual(resolveInk({ inkColor: 'custom', customColor: '#102030' }), [16, 32, 48]);
  assert.deepEqual(resolveInk({ inkColor: 'custom', customColor: 'nope' }), [26, 26, 26]);        // invalid custom -> default custom colour
});

test('transparent RGBA: real alpha channel equal to the stroke strength; white RGBA: opaque and composited', () => {
  const alpha = Uint8Array.from([0, 64, 128, 255]), ink = [10, 20, 30];
  const t = composeRGBA(alpha, ink, 'transparent');
  assert.equal(t.length, 16);
  assert.deepEqual([...t], [10, 20, 30, 0, 10, 20, 30, 64, 10, 20, 30, 128, 10, 20, 30, 255]);
  const w = composeRGBA(alpha, ink, 'white');
  assert.deepEqual([w[3], w[7], w[11], w[15]], [255, 255, 255, 255], 'white mode never has transparency');
  assert.deepEqual([w[0], w[1], w[2]], [255, 255, 255]); assert.deepEqual([w[12], w[13], w[14]], [10, 20, 30]);
  assert.ok(w[4] < 255 && w[4] > 10 && w[8] < w[4], 'in-between strengths blend toward the ink');
});

// ---------- end to end in pure code: pixels -> RGBA -> real PNG bytes -> read back ----------
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), Buffer.from(data)]); return Buffer.concat([Buffer.from(be32(data.length)), body, Buffer.from(be32(crc32(body)))]); };
function encodePng(rgba, w, h, colorType) {                         // 4 = RGBA(6) or RGB(2); 8-bit, filter 0
  const bpp = colorType === 6 ? 4 : 3, raw = Buffer.alloc((w * bpp + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < bpp; c++) raw[y * (w * bpp + 1) + 1 + x * bpp + c] = rgba[(y * w + x) * 4 + c];
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', [...be32(w), ...be32(h), 8, colorType, 0, 0, 0]), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', [])]));
}
function decodePng(bytes) {
  const b = Buffer.from(bytes); let i = 8, w, h, type; const idat = [];
  while (i < b.length) { const len = b.readUInt32BE(i), t = b.toString('latin1', i + 4, i + 8); if (t === 'IHDR') { w = b.readUInt32BE(i + 8); h = b.readUInt32BE(i + 12); type = b[i + 17]; } if (t === 'IDAT') idat.push(b.subarray(i + 8, i + 8 + len)); i += 12 + len; }
  const bpp = type === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { for (let c = 0; c < bpp; c++) px[(y * w + x) * 4 + c] = raw[y * (w * bpp + 1) + 1 + x * bpp + c]; if (bpp === 3) px[(y * w + x) * 4 + 3] = 255; }
  return { w, h, type, px };
}

test('transparent PNG generation: cleaned pixels -> PNG with colour type 6 -> alpha survives a full read-back; background is genuinely transparent', () => {
  reseed();
  const w = 220, h = 120, d = paper(w, h, { base: 240, shade: 20, noise: 3 }), core = stroke(d, w, h, SIG, { r: 1.2 });
  const { alpha } = run(d, w, h, DEFAULTS), ink = [20, 20, 90];
  const bytes = encodePng(composeRGBA(alpha, ink, 'transparent'), w, h, 6);
  assert.equal(pngDeclaresAlpha(bytes), true, 'header declares alpha');
  const back = decodePng(bytes);
  assert.deepEqual([back.w, back.h, back.type], [w, h, 6]);
  let clear = 0, solid = 0, partial = 0, backgroundOpaque = 0;
  for (let i = 0; i < w * h; i++) {
    const a = back.px[i * 4 + 3]; assert.equal(a, alpha[i], 'alpha byte equals computed alpha at ' + i);
    if (a === 0) clear++; else if (a === 255) solid++; else partial++;
    const x = i % w, y = (i - x) / w;
    if (a === 255 && SIG.every((sg) => dseg(x, y, ...sg) > 4)) backgroundOpaque++;     // opaque and nowhere near a stroke
  }
  assert.ok(clear / (w * h) > 0.9, 'most of the page is fully transparent: ' + (clear / (w * h)).toFixed(3));
  assert.ok(solid > 0 && partial > 0, 'strokes are solid with anti-aliased edges');
  assert.equal(backgroundOpaque, 0, 'no opaque pixel away from the strokes');
  assert.ok(share(alpha, core, 200) > 0.8);
});

test('white-background PNG: opaque colour type, no transparent pixel, ink still visible', () => {
  reseed();
  const w = 220, h = 120, d = paper(w, h, { base: 240, noise: 3 }), core = stroke(d, w, h, SIG, { r: 1.2 });
  const { alpha } = run(d, w, h, DEFAULTS), ink = [20, 20, 90], rgba = composeRGBA(alpha, ink, 'white');
  const bytes = encodePng(rgba, w, h, 2);
  assert.equal(pngDeclaresAlpha(bytes), false, 'RGB PNG declares no alpha');
  const back = decodePng(bytes);
  let min = 255, white = 0;
  for (let i = 0; i < w * h; i++) { assert.equal(back.px[i * 4 + 3], 255); if (back.px[i * 4] === 255 && back.px[i * 4 + 1] === 255 && back.px[i * 4 + 2] === 255) white++; if (core[i]) min = Math.min(min, back.px[i * 4]); }
  assert.ok(white / (w * h) > 0.9, 'background is pure white'); assert.ok(min < 60, 'ink is dark: ' + min);
});

test('pngDeclaresAlpha: colour types 2/6, tRNS, and non-PNG bytes', () => {
  const hdr = (type, extra = []) => cat([0x89, ...A('PNG'), 13, 10, 26, 10], pngChunk('IHDR', [...be32(4), ...be32(4), 8, type, 0, 0, 0]), ...extra, pngChunk('IDAT', [1]));
  assert.equal(pngDeclaresAlpha(hdr(6)), true); assert.equal(pngDeclaresAlpha(hdr(4)), true);
  assert.equal(pngDeclaresAlpha(hdr(2)), false); assert.equal(pngDeclaresAlpha(hdr(2, [pngChunk('tRNS', [0, 0, 0, 0, 0, 0])])), true);
  assert.equal(pngDeclaresAlpha(Uint8Array.from([1, 2, 3, 4, 5])), false);
  assert.equal(pngDeclaresAlpha(new Uint8Array(0)), false);
});

// ---------- invalid images (the same gate every upload goes through) ----------
const fileOf = (bytes, name = 'x.png') => Object.assign(new Blob([bytes]), { name });
test('invalid uploads are rejected with a user-facing message before any decoding', async () => {
  const msg = async (f) => { try { await inspectImage(f); return null; } catch (e) { return e.userMessage || 'NO USER MESSAGE: ' + e.message; } };
  assert.match(await msg(fileOf(new Uint8Array(0))), /empty/);
  assert.match(await msg(fileOf(Uint8Array.from(A('this is not an image at all, just text bytes')))), /not an image/);
  assert.match(await msg(fileOf(Uint8Array.from(A('GIF89a......................................')))), /not supported|Animated/);
  assert.match(await msg(fileOf(png().subarray(0, 20))), /damaged|incomplete/);                            // truncated PNG header
  assert.match(await msg(fileOf(cat([0x89, ...A('PNG'), 13, 10, 26, 10], pngChunk('IHDR', [...be32(20000), ...be32(20000), 8, 6, 0, 0, 0])))), /megapixel/);   // 400 MP claim
  assert.equal(await msg(fileOf(cat([0x89, ...A('PNG'), 13, 10, 26, 10], pngChunk('IHDR', [...be32(300), ...be32(100), 8, 6, 0, 0, 0]), pngChunk('IDAT', [0])))), null, 'a normal RGBA PNG header passes');
  assert.match(await msg(null), /No file/);
});

test('processAlpha on a blank, a solid and a one-pixel image does not throw and gives sane output', () => {
  const blank = paper(40, 30, { base: 250 }), a = run(blank, 40, 30, DEFAULTS).alpha;
  assert.equal(a.reduce((s, v) => s + v, 0), 0, 'blank paper -> no ink');
  const black = new Uint8ClampedArray(40 * 30 * 4); for (let i = 3; i < black.length; i += 4) black[i] = 255;
  assert.doesNotThrow(() => run(black, 40, 30, DEFAULTS));
  assert.equal(run(Uint8ClampedArray.from([0, 0, 0, 255]), 1, 1, DEFAULTS).alpha.length, 1);
});
