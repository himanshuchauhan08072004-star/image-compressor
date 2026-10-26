import test from 'node:test';
import assert from 'node:assert/strict';
import { planOutput, scalePlan, linkedSize, fitAspectRect, moveRect, resizeRect, normalizeCrop } from '../src/core/geometry.js';
import { validateFile } from '../src/core/validate.js';

const ok = (r) => { assert.equal(r.ok, true, r.error && r.error.message); return r.plan; };

test('no edits = identity plan', () => {
  const p = ok(planOutput(4000, 3000));
  assert.deepEqual([p.outW, p.outH], [4000, 3000]);
  assert.deepEqual(p.src, { x: 0, y: 0, w: 4000, h: 3000 });
});

test('crop only, portrait and landscape sources', () => {
  assert.deepEqual(ok(planOutput(3000, 4000, { crop: { x: 100, y: 200, w: 1000, h: 500 } })).src, { x: 100, y: 200, w: 1000, h: 500 });
  const p = ok(planOutput(4000, 3000, { crop: { x: 0, y: 0, w: 3000, h: 3000 } }));
  assert.deepEqual([p.outW, p.outH], [3000, 3000]);
});

test('crop is clamped inside image; garbage rejected', () => {
  assert.deepEqual(normalizeCrop({ x: -50, y: 10, w: 99999, h: 20 }, 100, 100), { x: 0, y: 10, w: 100, h: 20 });
  assert.equal(normalizeCrop(null, 10, 10), null);
});

test('scale mode downscales, blocks upscale unless allowed', () => {
  const p = ok(planOutput(4000, 3000, { resize: { mode: 'scale', width: 1000, height: 750 } }));
  assert.deepEqual([p.outW, p.outH], [1000, 750]);
  const bad = planOutput(1000, 1000, { resize: { mode: 'scale', width: 2000, height: 2000 } });
  assert.equal(bad.ok, false); assert.equal(bad.error.code, 'upscale');
  ok(planOutput(1000, 1000, { resize: { mode: 'scale', width: 2000, height: 2000, allowUpscale: true } }));
});

test('exact fill crops overflow, centred', () => {
  const p = ok(planOutput(4000, 3000, { resize: { mode: 'exact', fit: 'fill', width: 1000, height: 1000 } }));
  assert.deepEqual([p.outW, p.outH], [1000, 1000]);
  assert.deepEqual(p.src, { x: 500, y: 0, w: 3000, h: 3000 });
});

test('exact contain pads, centred', () => {
  const p = ok(planOutput(4000, 2000, { resize: { mode: 'exact', fit: 'contain', width: 1000, height: 1000 } }));
  assert.equal(p.pad, true);
  assert.deepEqual(p.dst, { x: 0, y: 250, w: 1000, h: 500 });
});

test('exact stretch', () => {
  const p = ok(planOutput(4000, 2000, { resize: { mode: 'exact', fit: 'stretch', width: 500, height: 500 } }));
  assert.deepEqual(p.dst, { x: 0, y: 0, w: 500, h: 500 });
});

test('exact needing upscale is blocked without opt-in', () => {
  assert.equal(planOutput(800, 600, { resize: { mode: 'exact', fit: 'fill', width: 1080, height: 1080 } }).error.code, 'upscale');
  // contain of a big-enough source into smaller box is fine
  ok(planOutput(4000, 2000, { resize: { mode: 'exact', fit: 'contain', width: 1080, height: 1080 } }));
});

test('resize is relative to cropped size', () => {
  const r = planOutput(4000, 3000, { crop: { x: 0, y: 0, w: 500, h: 500 }, resize: { mode: 'scale', width: 600, height: 600 } });
  assert.equal(r.error.code, 'upscale');
});

test('output caps', () => {
  assert.equal(planOutput(20000, 20000, { resize: { mode: 'scale', width: 20000, height: 20000, allowUpscale: true } }).error.code, 'too-big');
  assert.equal(planOutput(100, 100, { resize: { mode: 'scale', width: 0, height: 10 } }).error.code, 'size');
});

test('scalePlan scales dst with output', () => {
  const p = scalePlan(ok(planOutput(4000, 2000, { resize: { mode: 'exact', fit: 'contain', width: 1000, height: 1000 } })), 0.5);
  assert.deepEqual([p.outW, p.outH], [500, 500]);
  assert.deepEqual(p.dst, { x: 0, y: 125, w: 500, h: 250 });
});

test('linkedSize keeps ratio', () => {
  assert.deepEqual(linkedSize('width', 1000, 4000, 3000), { width: 1000, height: 750 });
  assert.deepEqual(linkedSize('height', 600, 4000, 3000), { width: 800, height: 600 });
  assert.deepEqual(linkedSize('width', 1000, 3000, 4000), { width: 1000, height: 1333 });
});

test('fitAspectRect for landscape and portrait sources', () => {
  assert.deepEqual(fitAspectRect(4000, 3000, 1), { x: 500, y: 0, w: 3000, h: 3000 });
  assert.deepEqual(fitAspectRect(3000, 4000, 16 / 9), { x: 0, y: 1156, w: 3000, h: 1688 });
  const r = fitAspectRect(3000, 4000, 4 / 5);
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 3000 && r.y + r.h <= 4000);
});

test('moveRect stays in bounds', () => {
  assert.deepEqual(moveRect({ x: 10, y: 10, w: 50, h: 50 }, -100, 500, { w: 100, h: 100 }), { x: 0, y: 50, w: 50, h: 50 });
});

test('resizeRect free: clamps and min size', () => {
  const b = { w: 1000, h: 800 };
  assert.deepEqual(resizeRect({ x: 100, y: 100, w: 300, h: 300 }, 'se', 2000, 2000, b), { x: 100, y: 100, w: 900, h: 700 });
  const t = resizeRect({ x: 100, y: 100, w: 300, h: 300 }, 'nw', 1000, 1000, b, null, 16);
  assert.equal(t.w, 16); assert.equal(t.h, 16);
  assert.deepEqual(resizeRect({ x: 100, y: 100, w: 300, h: 300 }, 'w', -500, 0, b), { x: 0, y: 100, w: 400, h: 300 });
});

test('resizeRect locked ratio keeps ratio and bounds', () => {
  const b = { w: 1000, h: 800 };
  for (const h of ['ne', 'nw', 'se', 'sw', 'n', 's', 'e', 'w']) {
    for (const [dx, dy] of [[50, 30], [-80, -20], [900, 900], [-900, -900]]) {
      const r = resizeRect({ x: 300, y: 200, w: 400, h: 300 }, h, dx, dy, b, 4 / 3);
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= b.w && r.y + r.h <= b.h, h + ' bounds ' + JSON.stringify(r));
      assert.ok(Math.abs(r.w - r.h * (4 / 3)) <= 1, h + ' ratio ' + JSON.stringify(r));
    }
  }
});

test('validateFile', () => {
  assert.throws(() => validateFile({ size: 0 }), { code: 'empty' });
  assert.throws(() => validateFile({ size: 200 * 1024 * 1024 }), { code: 'file-too-big' });
  assert.doesNotThrow(() => validateFile({ size: 1000 }));
});

test('too-big message is actionable: Compress (no resize) points to Resize/Crop; resize mentions limits', () => {
  const a = planOutput(8160, 6120);
  assert.equal(a.ok, false); assert.equal(a.error.code, 'too-big');
  assert.match(a.error.message, /8160 × 6120 \(50 MP\)/); assert.match(a.error.message, /Resize/); assert.doesNotMatch(a.error.message, /smaller dimensions/);
  const b = planOutput(8160, 6120, { resize: { mode: 'scale', width: 8000, height: 6000 } });
  assert.match(b.error.message, /40 MP/); assert.match(b.error.message, /16384/);
});

test('large input is fine once cropped or halved (recovery path)', () => {
  assert.equal(planOutput(8160, 6120, { resize: { mode: 'scale', width: 4080, height: 3060 } }).ok, true);
  assert.equal(planOutput(8160, 6120, { crop: { x: 0, y: 0, w: 5000, h: 5000 } }).ok, true);
});
