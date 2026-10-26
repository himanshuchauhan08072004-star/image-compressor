import test from 'node:test';
import assert from 'node:assert/strict';
import { fitToBytes, Cancelled } from '../src/core/solve.js';

// Fake codec: size grows with pixels and quality (monotonic, like JPEG)
const mk = (base = 1_000_000) => ({
  render: async (s) => ({ width: Math.round(4000 * s), height: Math.round(3000 * s), s }),
  encode: async (c, q) => ({ size: Math.round(base * c.s * c.s * (0.05 + q * q * 0.4)) }),
});
const run = (target, extra = {}) => fitToBytes({ ...mk(), targetBytes: target, baseW: 4000, baseH: 3000, ...extra });

test('target near/above original (hint given): one encode at top quality', async () => {
  const r = await run(5_000_000, { hintBytes: 3_000_000 });
  assert.equal(r.reached, true); assert.equal(r.iterations, 1); assert.equal(r.scale, 1); assert.equal(r.quality, 0.92);
});

test('target above size at max quality, no hint: still cheap (<=3 encodes)', async () => {
  const r = await run(5_000_000);
  assert.equal(r.reached, true); assert.ok(r.iterations <= 3, String(r.iterations)); assert.equal(r.scale, 1);
});

test('mid target: quality search at full size, close to target', async () => {
  const r = await run(200_000);
  assert.equal(r.reached, true); assert.equal(r.scale, 1);
  assert.ok(r.blob.size <= 200_000 && r.blob.size >= 200_000 * 0.9, 'size ' + r.blob.size);
  assert.ok(r.quality >= 0.45 && r.quality <= 0.92);
  assert.ok(r.iterations <= 9);
});

test('low target: shrinks dimensions and still lands under target', async () => {
  const r = await run(30_000);
  assert.equal(r.reached, true); assert.ok(r.scale < 1);
  assert.ok(r.blob.size <= 30_000);
  assert.ok(r.iterations <= 30);
});

test('impossible target: graceful, returns smallest, reached=false', async () => {
  const r = await run(10);
  assert.equal(r.reached, false); assert.equal(r.atMinimum, true);
  assert.ok(r.blob.size > 10);
  assert.ok(Math.min(r.width, r.height) >= 32 - 1);
});

test('low target never wastes a full-size encode on max quality', async () => {
  const qs = [];
  const m = mk();
  await fitToBytes({ render: m.render, encode: async (c, q) => { if (c.width === 4000) qs.push(q); return m.encode(c, q); }, targetBytes: 100_000, baseW: 4000, baseH: 3000, hintBytes: 3_000_000 });
  assert.deepEqual(qs, [0.45]);     // exactly one full-size probe, at floor quality
});

test('tiny target vs original skips full-size encoding entirely', async () => {
  const sizes = [];
  const m = mk();
  const r = await fitToBytes({ render: m.render, encode: async (c, q) => { sizes.push(c.width); return m.encode(c, q); }, targetBytes: 20_000, baseW: 4000, baseH: 3000, hintBytes: 5_000_000 });
  assert.equal(r.reached, true); assert.ok(!sizes.includes(4000), 'encoded full size: ' + sizes);
  assert.equal(r.fullSizeEncodes, 0);
});

test('skipped full-size guess that was too aggressive self-corrects upward', async () => {
  // original claims to be huge but the image is actually easy: target fits at full size after all
  const m = mk(50_000);
  const r = await fitToBytes({ render: m.render, encode: m.encode, targetBytes: 20_000, baseW: 4000, baseH: 3000, hintBytes: 2_000_000 });
  assert.equal(r.reached, true); assert.ok(r.blob.size <= 20_000); assert.ok(r.scale > 0.6, 'scale ' + r.scale);
});

test('property sweep: always <= target when reached, bounded work, no leaked canvases', async () => {
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let worst = 0, n = 0;
  for (const k of [1, 1.6, 2.5]) for (const base of [150_000, 1_200_000, 9_000_000, 40_000_000]) for (const target of [800, 5_000, 20_000, 60_000, 200_000, 1_000_000, 6_000_000]) {
    let made = 0, freed = 0;
    const enc = async (c, q) => ({ size: Math.max(300, Math.round(base * Math.pow((c.width * c.height) / 12e6, k) * (0.05 + q * q * 0.4))) });
    const hint = Math.round(base * 0.36 * (0.8 + rnd() * 0.4));
    const r = await fitToBytes({ render: async (s) => { made++; return { width: Math.round(4000 * s), height: Math.round(3000 * s) }; }, encode: enc,
      release: () => freed++, targetBytes: target, baseW: 4000, baseH: 3000, hintBytes: hint });
    n++; worst = Math.max(worst, r.iterations);
    assert.equal(made, freed, `leak k=${k} base=${base} t=${target}`);
    assert.ok(r.iterations <= 16, `too many encodes ${r.iterations} k=${k} base=${base} t=${target}`);
    if (r.reached) {
      assert.ok(r.blob.size <= target, `over target ${r.blob.size}>${target} k=${k} base=${base}`);
      assert.ok(r.quality >= 0.45 - 1e-9 && r.quality <= 0.92 + 1e-9);
      if (r.quality < 0.92 - 1e-9) assert.ok(r.blob.size >= target * 0.5, `wasteful ${r.blob.size} for ${target} (q=${r.quality.toFixed(2)} s=${r.scale.toFixed(2)}) k=${k} base=${base}`);
    } else {
      assert.ok(Math.min(r.width, r.height) >= 31, 'shrunk below minimum');
    }
  }
  console.log('      sweep cases:', n, 'worst encode count:', worst);
});

test('cancel stops the search', async () => {
  let n = 0;
  await assert.rejects(run(100_000, { isCancelled: () => ++n > 3 }), Cancelled);
});

test('release is called for every rendered canvas', async () => {
  let made = 0, freed = 0;
  const m = mk();
  await fitToBytes({ render: async (s) => { made++; return m.render(s); }, encode: m.encode, release: () => freed++, targetBytes: 30_000, baseW: 4000, baseH: 3000 });
  assert.equal(made, freed);
});
