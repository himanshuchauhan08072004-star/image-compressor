import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegion, normalizeRegions, regionToOutput, pixelateRGBA, boxBlurRGBA, pixelCell, blurRadius, MAX_REGIONS } from '../src/core/redact.js';
import { planOutput, scalePlan } from '../src/core/geometry.js';

const plan = (sw, sh, o) => planOutput(sw, sh, o).plan;
const buf = (w, h, fn) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, a = 255] = fn(x, y); d.set([r, g, b, a], (y * w + x) * 4); } return d; };

test('normalizeRegion: integers, inside image, safe colour, defaults', () => {
  const r = normalizeRegion({ id: 'a', x: -5.4, y: 10.6, w: 9999, h: 20.2, mode: 'zzz', strength: 99, color: 'red;evil' }, 100, 50);
  assert.deepEqual(r, { id: 'a', x: 0, y: 11, w: 100, h: 20, mode: 'blur', strength: 5, color: '#000000' });
  assert.equal(normalizeRegion({ x: NaN, y: 0, w: 5, h: 5 }, 10, 10), null);
  assert.equal(normalizeRegion(null, 10, 10), null);
  assert.equal(normalizeRegion({ x: 0, y: 0, w: 5, h: 5, color: '#ABCDEF' }, 10, 10).color, '#abcdef');
});
test('normalizeRegions caps count and drops junk', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ id: 'r' + i, x: 0, y: 0, w: 5, h: 5 }));
  assert.equal(normalizeRegions([...many, null], 50, 50).length, MAX_REGIONS);
  assert.deepEqual(normalizeRegions('nope', 5, 5), []);
});
test('regionToOutput: identity plan', () => {
  assert.deepEqual(regionToOutput({ x: 10, y: 20, w: 30, h: 40 }, plan(100, 100, {})), { x: 10, y: 20, w: 30, h: 40 });
});
test('regionToOutput: crop offsets, clips regions outside crop, null when fully outside', () => {
  const p = plan(200, 200, { crop: { x: 50, y: 50, w: 100, h: 100 } });
  assert.deepEqual(regionToOutput({ x: 60, y: 70, w: 20, h: 20 }, p), { x: 10, y: 20, w: 20, h: 20 });
  assert.deepEqual(regionToOutput({ x: 0, y: 0, w: 80, h: 80 }, p), { x: 0, y: 0, w: 30, h: 30 });
  assert.equal(regionToOutput({ x: 0, y: 0, w: 40, h: 40 }, p), null);
});
test('regionToOutput: rounds OUTWARD when downscaling', () => {
  const p = plan(100, 100, { resize: { mode: 'scale', width: 33, height: 33 } });   // factor 0.33
  const b = regionToOutput({ x: 10, y: 10, w: 10, h: 10 }, p);                       // 3.3 .. 6.6 -> 3 .. 7
  assert.deepEqual(b, { x: 3, y: 3, w: 4, h: 4 });
});
test('regionToOutput: exact integer scale does not grow by a pixel', () => {
  const p = plan(200, 200, { resize: { mode: 'scale', width: 100, height: 100 } });
  assert.deepEqual(regionToOutput({ x: 20, y: 40, w: 60, h: 20 }, p), { x: 10, y: 20, w: 30, h: 10 });
});
test('regionToOutput: contain-fit padding is never painted', () => {
  const p = plan(200, 100, { resize: { mode: 'exact', width: 100, height: 100, fit: 'contain' } });   // picture occupies y 25..75
  const b = regionToOutput({ x: 0, y: 0, w: 200, h: 100 }, p);
  assert.deepEqual(b, { x: 0, y: 25, w: 100, h: 50 });
});
test('regionToOutput: stays aligned on target-size scaled plans', () => {
  const p = plan(1000, 500, {}), q = scalePlan(p, 0.5);
  assert.deepEqual(regionToOutput({ x: 100, y: 100, w: 200, h: 100 }, q), { x: 50, y: 50, w: 100, h: 50 });
});
test('pixelateRGBA: every cell becomes one colour; outside buffer untouched', () => {
  const d = buf(8, 8, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0]));
  pixelateRGBA(d, 8, 8, 4);
  for (const [cx, cy] of [[0, 0], [4, 0], [0, 4], [4, 4]]) {
    const first = [...d.slice((cy * 8 + cx) * 4, (cy * 8 + cx) * 4 + 4)];
    for (let y = cy; y < cy + 4; y++) for (let x = cx; x < cx + 4; x++) assert.deepEqual([...d.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)], first);
    assert.ok(first[0] >= 127 && first[0] <= 128);
  }
});
test('pixelateRGBA: partial edge cells and transparent pixels do not darken colour', () => {
  const d = buf(5, 5, () => [200, 100, 50, 0]); d.set([200, 100, 50, 255], 0);
  pixelateRGBA(d, 5, 5, 4);
  assert.deepEqual([...d.slice(0, 3)], [200, 100, 50]);
});
test('boxBlurRGBA: flat stays flat, checkerboard variance collapses, no edge darkening', () => {
  const flat = buf(20, 20, () => [90, 120, 200]); boxBlurRGBA(flat, 20, 20, 5);
  assert.ok([...flat].every((v, i) => (i % 4 === 3 ? v === 255 : true)) && flat[0] === 90 && flat[1] === 120 && flat[2] === 200);
  const cb = buf(60, 60, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? [255, 255, 255] : [0, 0, 0]));
  const variance = (a) => { let s = 0, s2 = 0, n = 0; for (let i = 0; i < a.length; i += 4) { s += a[i]; s2 += a[i] * a[i]; n++; } return s2 / n - (s / n) ** 2; };
  const before = variance(cb); boxBlurRGBA(cb, 60, 60, 12);
  assert.ok(variance(cb) < before * 0.05, 'variance ' + before + ' -> ' + variance(cb));
});
test('boxBlurRGBA: transparent pixels stay transparent', () => {
  const d = buf(10, 10, () => [0, 0, 0, 0]); boxBlurRGBA(d, 10, 10, 3);
  assert.ok([...d].every((v) => v === 0));
});
test('strength grows cell size and radius', () => {
  for (let s = 1; s < 5; s++) { assert.ok(pixelCell(300, 200, s + 1) >= pixelCell(300, 200, s)); assert.ok(blurRadius(300, 200, s + 1) >= blurRadius(300, 200, s)); }
  assert.ok(pixelCell(4, 4, 1) >= 2);
});
