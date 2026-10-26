import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, PRESETS, RANGES, normalizeBackground, colorDist, estimateBackground, removeBackground, fillBackground, cutOut, backgroundNotes, hexToRgb } from '../src/core/background.js';

const W = 80, H = 60;
const make = (bg, fg, rect = [25, 15, 55, 45], extra = () => null) => {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4, inn = x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3], c = extra(x, y) || (inn ? fg : bg); d.set([...c, 255], o); }
  return d;
};
const px = (d, x, y) => { const o = (y * W + x) * 4; return [d[o], d[o + 1], d[o + 2], d[o + 3]]; };

test('normalizeBackground: defaults, clamping, garbage; presets valid', () => {
  assert.deepEqual(normalizeBackground(), DEFAULTS);
  const p = normalizeBackground({ tolerance: 999, feather: -3, specks: 'x', mode: 'weird', fill: 'blue', fillColor: 'nope' });
  assert.deepEqual([p.tolerance, p.feather, p.specks, p.mode, p.fill, p.fillColor], [100, 0, 20, 'edge', 'transparent', '#ffffff']);
  for (const pr of PRESETS) for (const [k, v] of Object.entries(pr.values)) if (RANGES[k]) assert.ok(v >= RANGES[k][0] && v <= RANGES[k][1], pr.key + k);
});

test('colorDist: zero for same, large for black vs white, symmetric', () => {
  assert.equal(colorDist(5, 5, 5, 5, 5, 5), 0); assert.ok(colorDist(0, 0, 0, 255, 255, 255) > 600);
  assert.ok(Math.abs(colorDist(10, 200, 30, 90, 20, 250) - colorDist(90, 20, 250, 10, 200, 30)) < 1e-9);
});

test('estimateBackground: finds the border colour; two-tone border gives two colours; busy border gives low coverage', () => {
  const d = make([240, 240, 235], [200, 30, 30]); const e = estimateBackground(d, W, H);
  assert.equal(e.colors.length, 1); assert.ok(colorDist(...e.colors[0], 240, 240, 235) < 6 && e.coverage > 0.95);
  const two = make([250, 250, 250], [20, 20, 20], [30, 20, 50, 40], (x) => (x < 40 && (x < 30 || x >= 50) ? [30, 120, 200] : null)); const e2 = estimateBackground(two, W, H);
  assert.equal(e2.colors.length, 2);
  let seed = 3; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const busy = make([0, 0, 0], [0, 0, 0], [0, 0, 0, 0], () => [rnd() * 255, rnd() * 255, rnd() * 255]); assert.ok(estimateBackground(busy, W, H).coverage < 0.5);
});

test('removeBackground: background clear, subject opaque and unchanged, size of cut right', () => {
  const d = make([240, 240, 235], [200, 30, 30]), e = estimateBackground(d, W, H); const res = removeBackground(d, W, H, { feather: 0, specks: 0 }, e.colors);
  assert.equal(px(d, 2, 2)[3], 0); assert.equal(px(d, 77, 57)[3], 0);
  assert.deepEqual(px(d, 40, 30), [200, 30, 30, 255]);
  assert.ok(Math.abs(res.removed - (1 - 30 * 30 / (W * H))) < 0.01, String(res.removed));
});

test('edge mode keeps enclosed background-coloured parts; all mode removes them', () => {
  const ring = (x, y) => (x >= 35 && x < 45 && y >= 25 && y < 35 ? [245, 245, 245] : null);   // white patch inside the subject
  const a = make([245, 245, 245], [200, 30, 30], [25, 15, 55, 45], ring), b = new Uint8ClampedArray(a), c = estimateBackground(a, W, H).colors;
  removeBackground(a, W, H, { mode: 'edge', feather: 0, specks: 0 }, c); assert.equal(px(a, 40, 30)[3], 255);
  removeBackground(b, W, H, { mode: 'all', feather: 0, specks: 0 }, c); assert.equal(px(b, 40, 30)[3], 0);
});

test('tolerance: faint shading is removed at high tolerance but kept at low', () => {
  const shade = (x, y) => (x < 20 ? [225, 225, 220] : null), mk = () => make([245, 245, 240], [200, 30, 30], [25, 15, 55, 45], shade);
  const lowT = mk(), hiT = mk(), c = [[245, 245, 240]];
  removeBackground(lowT, W, H, { tolerance: 2, feather: 0, specks: 0 }, c); removeBackground(hiT, W, H, { tolerance: 40, feather: 0, specks: 0 }, c);
  assert.equal(px(lowT, 5, 5)[3], 255); assert.equal(px(hiT, 5, 5)[3], 0);
});

test('specks: stray island removed, main subject and disconnected big parts kept', () => {
  const sp = (x, y) => (x >= 5 && x < 8 && y >= 5 && y < 8 ? [200, 30, 30] : null), d = make([240, 240, 240], [200, 30, 30], [25, 15, 55, 45], sp);
  removeBackground(d, W, H, { feather: 0, specks: 50 }, [[240, 240, 240]]); assert.equal(px(d, 6, 6)[3], 0); assert.equal(px(d, 40, 30)[3], 255);
  const d2 = make([240, 240, 240], [200, 30, 30], [25, 15, 55, 45], sp); removeBackground(d2, W, H, { feather: 0, specks: 0 }, [[240, 240, 240]]); assert.equal(px(d2, 6, 6)[3], 255);
});

test('edge pixels lose the background tint (decontamination) and feather makes a soft edge', () => {
  const d = make([255, 255, 255], [200, 0, 0], [25, 15, 55, 45], (x, y) => (x === 24 && y >= 15 && y < 45 ? [227, 127, 127] : null));   // 50 % mix of red and white
  removeBackground(d, W, H, { feather: 0, specks: 0, tolerance: 20 }, [[255, 255, 255]]); const e = px(d, 24, 30);
  assert.ok(e[3] > 0 && e[3] < 255 && e[0] >= 190 && e[1] < 60, e.join());
  const f = make([255, 255, 255], [200, 0, 0]); removeBackground(f, W, H, { feather: 6, specks: 0 }, [[255, 255, 255]]);
  const soft = []; for (let x = 18; x < 32; x++) soft.push(px(f, x, 30)[3]); assert.ok(soft.some((a) => a > 10 && a < 245), soft.join());
});

test('fill: white and colour composite over transparency; alpha ends at 255', () => {
  const d = new Uint8ClampedArray([200, 0, 0, 255, 0, 0, 0, 0, 100, 100, 100, 128]); fillBackground(d, [255, 255, 255]);
  assert.deepEqual([...d.slice(0, 4)], [200, 0, 0, 255]); assert.deepEqual([...d.slice(4, 8)], [255, 255, 255, 255]); assert.ok(d[8] > 170 && d[8] < 185 && d[11] === 255);
  assert.deepEqual(hexToRgb('#102030'), [16, 32, 48]);
});

test('cutOut: picked colour, fills, notes', () => {
  const d = make([10, 120, 10], [240, 240, 240]); const r = cutOut(d, W, H, { fill: 'white', feather: 0, specks: 0 }, [10, 120, 10]);
  assert.equal(px(d, 2, 2)[3], 255); assert.deepEqual(px(d, 2, 2).slice(0, 3), [255, 255, 255]); assert.ok(r.removed > 0.5 && r.coverage > 0.95);
  assert.ok(backgroundNotes(normalizeBackground(), { removed: 0, coverage: 1 }).some((m) => m.includes('Almost nothing')));
  assert.ok(backgroundNotes(normalizeBackground(), { removed: 0.99, coverage: 1 }).some((m) => m.includes('Almost everything')));
  assert.ok(backgroundNotes(normalizeBackground(), { removed: 0.4, coverage: 0.3 }).some((m) => m.includes('not one plain colour')));
  assert.deepEqual(backgroundNotes(normalizeBackground(), { removed: 0.4, coverage: 0.99 }), []);
});

test('tiny sizes do not crash', () => {
  for (const [w, h] of [[1, 1], [2, 2], [3, 1]]) { const d = new Uint8ClampedArray(w * h * 4).fill(255); cutOut(d, w, h, {}); assert.equal(d.length, w * h * 4); }
});
