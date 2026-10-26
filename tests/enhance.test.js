import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, PRESETS, RANGES, normalizeEnhance, isIdentity, autoLevels, buildCurves, applyEnhance, denoise, sharpen, enhanceNotes } from '../src/core/enhance.js';

const solid = (w, h, r, g, b, a = 255) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set([r, g, b, a], i * 4); return d; };
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

test('normalizeEnhance: defaults, clamping, garbage in; presets stay in range', () => {
  assert.deepEqual(normalizeEnhance(), DEFAULTS);
  const p = normalizeEnhance({ brightness: 999, contrast: -999, saturation: 'x', warmth: NaN, sharpen: -4, denoise: 1e9, auto: 1 });
  assert.deepEqual([p.brightness, p.contrast, p.saturation, p.warmth, p.sharpen, p.denoise, p.auto], [100, -100, 0, 0, 0, 100, true]);
  for (const pr of PRESETS) for (const [k, v] of Object.entries(pr.values)) if (RANGES[k]) assert.ok(v >= RANGES[k][0] && v <= RANGES[k][1], pr.key + k);
  assert.ok(isIdentity(normalizeEnhance())); assert.ok(!isIdentity(normalizeEnhance({ auto: true })));
});

test('identity leaves bytes exactly unchanged', () => {
  const d = solid(8, 8, 12, 99, 200); const c = new Uint8ClampedArray(d); applyEnhance(d, 8, 8, {}); assert.deepEqual(d, c);
});

test('brightness and contrast: direction and pivot', () => {
  const up = solid(2, 2, 100, 100, 100); applyEnhance(up, 2, 2, { brightness: 40 }); assert.ok(up[0] > 100);
  const dn = solid(2, 2, 100, 100, 100); applyEnhance(dn, 2, 2, { brightness: -40 }); assert.ok(dn[0] < 100);
  const hi = solid(2, 2, 200, 200, 200); applyEnhance(hi, 2, 2, { contrast: 50 }); assert.ok(hi[0] > 200);
  const lo = solid(2, 2, 60, 60, 60); applyEnhance(lo, 2, 2, { contrast: 50 }); assert.ok(lo[0] < 60);
  const mid = solid(2, 2, 128, 128, 128); applyEnhance(mid, 2, 2, { contrast: 80 }); assert.equal(mid[0], 128);
  const c = buildCurves(normalizeEnhance({ brightness: 100 })); assert.ok(c[0].length === 256 && c[1][255] === 255 && c[1][0] > 100);
});

test('saturation: -100 gives grey, +50 pushes channels apart, grey stays grey', () => {
  const g = solid(2, 2, 200, 100, 50); applyEnhance(g, 2, 2, { saturation: -100 }); assert.ok(g[0] === g[1] && g[1] === g[2], [...g.slice(0, 3)].join());
  const v = solid(2, 2, 200, 100, 50); applyEnhance(v, 2, 2, { saturation: 50 }); assert.ok(v[0] - v[2] > 150);
  const n = solid(2, 2, 90, 90, 90); applyEnhance(n, 2, 2, { saturation: 80 }); assert.deepEqual([...n.slice(0, 3)], [90, 90, 90]);
});

test('warmth: red up, blue down, green alone; cool is the reverse', () => {
  const w = solid(2, 2, 100, 100, 100); applyEnhance(w, 2, 2, { warmth: 60 }); assert.ok(w[0] > 100 && w[2] < 100 && w[1] === 100);
  const c = solid(2, 2, 100, 100, 100); applyEnhance(c, 2, 2, { warmth: -60 }); assert.ok(c[0] < 100 && c[2] > 100);
});

test('alpha is never touched', () => {
  const d = solid(4, 4, 100, 150, 200, 77); applyEnhance(d, 4, 4, { brightness: 50, contrast: 30, saturation: 30, sharpen: 80, denoise: 80, auto: true });
  for (let i = 0; i < 16; i++) assert.equal(d[i * 4 + 3], 77);
});

test('autoLevels: dull picture is stretched; flat or empty pictures are left alone', () => {
  const w = 64, h = 64, d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { const v = 80 + (i % 64) * 1.5; d.set([v, v, v, 255], i * 4); }
  const [lo, hi] = autoLevels(d, w, h); assert.ok(hi - lo === 110 && lo >= 65 && lo <= 80, 'span of ~94 is widened to 110 (max 2.3x stretch): ' + lo + ',' + hi);
  const nar = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { const v = 100 + (i % 64) * 0.7; nar.set([v, v, v, 255], i * 4); }
  const [nl, nh] = autoLevels(nar, w, h); assert.ok(nh - nl === 110 && nl <= 100 && nh >= 144, 'narrow range is widened, not stretched to the full range: ' + nl + ',' + nh);
  applyEnhance(d, w, h, { auto: true }); let mn = 255, mx = 0; for (let i = 0; i < w * h; i++) { mn = Math.min(mn, d[i * 4]); mx = Math.max(mx, d[i * 4]); }
  assert.ok(mn <= 25 && mx >= 225, mn + ',' + mx);
  assert.deepEqual(autoLevels(solid(8, 8, 120, 120, 120), 8, 8), [0, 255]);
  assert.deepEqual(autoLevels(solid(8, 8, 120, 120, 120, 0), 8, 8), [0, 255]);
});

test('denoise: cuts random grain, keeps a hard edge', () => {
  const w = 48, h = 48, d = new Uint8ClampedArray(w * h * 4); const clean = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = x < 24 ? 60 : 190, o = (y * w + x) * 4, n = (rnd() - 0.5) * 24; d.set([v + n, v + n, v + n, 255], o); clean.set([v, v, v, 255], o); }
  const err = (a) => { let s = 0, c = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (Math.abs(x - 23.5) < 3) continue; s += Math.abs(a[(y * w + x) * 4] - clean[(y * w + x) * 4]); c++; } return s / c; };
  const before = err(d); denoise(d, w, h, 60); assert.ok(err(d) < before * 0.6, before + ' -> ' + err(d));
  const L = d[(24 * w + 10) * 4], R = d[(24 * w + 38) * 4]; assert.ok(R - L > 110, 'edge kept: ' + L + ' ' + R);
});

test('sharpen: edge contrast grows, flat areas and tiny noise do not change', () => {
  const w = 64, h = 32, d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = x < 32 ? 100 : 160, o = (y * w + x) * 4; d.set([v, v, v, 255], o); }
  const c = new Uint8ClampedArray(d); sharpen(d, w, h, 80);
  assert.ok(d[(10 * w + 31) * 4] < c[(10 * w + 31) * 4] && d[(10 * w + 32) * 4] > c[(10 * w + 32) * 4], 'overshoot both sides');
  assert.equal(d[(10 * w + 5) * 4], 100); assert.equal(d[(10 * w + 58) * 4], 160);
  const q = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) q.set([100 + (i % 2), 100 + (i % 2), 100 + (i % 2), 255], i * 4);
  const q0 = new Uint8ClampedArray(q); sharpen(q, w, h, 100); assert.deepEqual(q, q0);
});

test('tiny and odd sizes do not crash', () => {
  for (const [w, h] of [[1, 1], [2, 1], [1, 5], [3, 3]]) { const d = solid(w, h, 90, 120, 150); applyEnhance(d, w, h, { brightness: 10, sharpen: 100, denoise: 100, auto: true }); assert.equal(d.length, w * h * 4); }
});

test('notes: warn on extremes and on nothing to do', () => {
  assert.ok(enhanceNotes(normalizeEnhance(), null)[0].startsWith('No changes'));
  assert.ok(enhanceNotes(normalizeEnhance({ sharpen: 90 }), null).some((m) => m.includes('halos')));
  assert.ok(enhanceNotes(normalizeEnhance({ denoise: 90 }), null).some((m) => m.includes('plastic')));
  assert.ok(enhanceNotes(normalizeEnhance({ auto: true }), { levels: [0, 255] }).some((m) => m.includes('nothing to stretch')));
});
