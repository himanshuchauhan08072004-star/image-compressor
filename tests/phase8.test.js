// Phase 8 regression tests: reliability, limits, ZIP, cleanup, HEIC lifecycle.
// Kinds, so nobody mistakes one for another:
//   [unit]   pure logic, no mocks
//   [real]   real files / real libheif-js wasm / node:zlib as an independent CRC oracle
//   [mocked] a fake `document`/canvas to observe resource cleanup (NOT a browser)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { crc32, buildZip, verifyZip, isSafeEntryName } from '../src/core/zip.js';
import { safeBase, uniqueName, outputName, createRunner } from '../src/core/batch.js';
import { userMessageOf, ImageError } from '../src/core/errors.js';
import { inspectImage } from '../src/core/decode.js';
import { validateFile } from '../src/core/validate.js';
import { planOutput } from '../src/core/geometry.js';
import { MAX_PIXELS, MAX_FILE_BYTES } from '../src/core/limits.js';
import { decodeHeicPixels, peekHeic, setHeicLoader, setHeicReleaseThreshold, HEIC_RELEASE_PIXELS } from '../src/core/heic-decoder.js';
import { createSession } from '../src/app/session.js';
import { png } from './helpers.js';

const fx = (n) => new Uint8Array(fs.readFileSync(new URL('./fixtures/heic/' + n, import.meta.url)));
const u32set = (b, i, v) => { b[i] = (v / 16777216) & 255; b[i + 1] = (v >>> 16) & 255; b[i + 2] = (v >>> 8) & 255; b[i + 3] = v & 255; };
const pngSized = (w, h) => { const b = Uint8Array.from(png()); u32set(b, 16, w); u32set(b, 20, h); return b; };
const asFile = (bytes, name = 'x.png') => ({ name, type: 'image/png', size: bytes.length, slice: (a, z) => ({ arrayBuffer: async () => bytes.slice(a, z).buffer }), arrayBuffer: async () => bytes.slice().buffer });

// ------------------------------------------------------------------ CRC-32
test('[real] crc32 (slice-by-8) equals node:zlib.crc32 for every length 0..300, odd offsets and chunk continuation', () => {
  const buf = new Uint8Array(4096); for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) >>> 24;
  for (let n = 0; n <= 300; n++) for (const off of [0, 1, 3, 7]) { const a = buf.subarray(off, off + n); assert.equal(crc32(a), zlib.crc32(a), 'len ' + n + ' off ' + off); }
  const a = buf.subarray(0, 1000), b = buf.subarray(1000, 3001);
  assert.equal(crc32(b, crc32(a)), zlib.crc32(buf.subarray(0, 3001)));                // continuation across chunks
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

// ------------------------------------------------------------------ ZIP names and verification
test('[unit] isSafeEntryName / buildZip refuse path tricks', async () => {
  for (const ok of ['a.jpg', 'originals/a (2).png', 'ünï.jpg', 'a b/c.png']) assert.ok(isSafeEntryName(ok), ok);
  for (const bad of ['', '../x.jpg', 'a/../../x', '/abs.jpg', 'C:evil.jpg', 'a\\b.jpg', 'a//b.jpg', './a.jpg', 'a/./b', 'a\u0000b', 'a\nb', 'x/', undefined, 42, 'a'.repeat(1025)]) assert.ok(!isSafeEntryName(bad), JSON.stringify(bad));
  await assert.rejects(buildZip([{ name: '../evil.jpg', data: new Uint8Array(1) }]), { code: 'zip-name' });
  await assert.rejects(buildZip([{ name: 'ok.jpg', data: new Uint8Array(1) }, { name: '/abs', data: new Uint8Array(1) }]), { code: 'zip-name' });
});

test('[real] verifyZip accepts a good ZIP; node:zlib agrees with every stored CRC; empty entries work', async () => {
  const entries = [
    { name: 'a.jpg', data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) },
    { name: 'originals/b.png', data: new Blob([new Uint8Array(70000).fill(7)]) },
    { name: 'empty.bin', data: new Uint8Array(0) },
    { name: 'ünï côdé.webp', data: new Uint8Array(1000).map((_, i) => i) },
  ];
  const zip = await buildZip(entries);
  assert.deepEqual(await verifyZip(zip, entries), { entries: 4, bytes: zip.size });
  // independent CRC check straight from the bytes: walk the central directory
  const bytes = new Uint8Array(await zip.arrayBuffer()), dv = new DataView(bytes.buffer);
  const cdAt = dv.getUint32(bytes.length - 6, true), count = dv.getUint16(bytes.length - 12, true);
  let p = cdAt;
  for (let i = 0; i < count; i++) {
    const crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), at = dv.getUint32(p + 42, true);
    const data = bytes.subarray(at + 30 + nl, at + 30 + nl + size);
    assert.equal(crc, zlib.crc32(data), entries[i].name);
    p += 46 + nl;
  }
});

test('[unit] verifyZip rejects damaged / mismatching ZIPs', async () => {
  const entries = [{ name: 'a.jpg', data: new Uint8Array(100).fill(1) }, { name: 'b.jpg', data: new Uint8Array(50).fill(2) }];
  const good = new Uint8Array(await (await buildZip(entries)).arrayBuffer());
  const blobOf = (b, type = 'application/zip') => new Blob([b], { type });
  const mut = (fn) => { const c = good.slice(); fn(c, new DataView(c.buffer)); return blobOf(c); };
  const bad = async (zip, list = entries) => assert.rejects(verifyZip(zip, list), { code: 'zip-invalid' });
  await bad(blobOf(good, 'text/plain'));                                                    // wrong type
  await bad(blobOf(good.slice(0, good.length - 5)));                                        // truncated end record
  await bad(blobOf(good.slice(0, 10)));
  await bad(mut((c, d) => d.setUint16(c.length - 12, 1, true)));                            // count lies
  await bad(blobOf(good), [entries[0]]);                                                    // caller expected a different list
  await bad(blobOf(good), [entries[1], entries[0]]);                                        // wrong order
  await bad(blobOf(good), [{ name: 'a.jpg', data: new Uint8Array(99) }, entries[1]]);       // wrong size
  await bad(mut((c, d) => d.setUint32(c.length - 6, 0, true)));                             // directory offset wrong
  await bad(mut((c, d) => d.setUint32(0, 0, true)));                                        // local header signature destroyed
  await bad(mut((c, d) => { const cd = d.getUint32(c.length - 6, true); d.setUint32(cd + 16, 0xdeadbeef, true); }));   // directory CRC differs from local header CRC
});

test('[unit] duplicate names across case and truncation: every ZIP entry name is unique and the ZIP verifies', async () => {
  const used = new Set(), names = ['IMG.jpg', 'img.JPG', 'Img.jpeg', 'a'.repeat(200) + '.png', 'a'.repeat(200) + '.png', '😀'.repeat(60) + '.png', '😀'.repeat(60) + '.png'];
  const entries = names.map((n) => ({ name: uniqueName(outputName(n, 'image/jpeg', 'compressed'), used), data: new Uint8Array([1]) }));
  assert.equal(new Set(entries.map((e) => e.name.toLowerCase())).size, names.length);
  await verifyZip(await buildZip(entries), entries);
});

// ------------------------------------------------------------------ file names
test('[unit] safeBase: no lone surrogates, no bidi overrides, no zero-width tricks, always non-empty', () => {
  const lone = (s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
  for (const n of ['a'.repeat(79) + '😀.jpg', '😀'.repeat(100) + '.png', '𠮷'.repeat(90) + '.jpg', 'x'.repeat(78) + '👨‍👩‍👧.jpg']) {
    const b = safeBase(n); assert.ok(!lone(b), n.slice(0, 12)); assert.ok(Array.from(b).length <= 80); assert.ok(b.length > 0);
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(b)), b);   // survives UTF-8 (ZIP) round trip unchanged
  }
  assert.equal(safeBase('photo\u202Egpj.exe.png'), 'photogpj.exe');
  assert.equal(safeBase('a\u200Bb\u2066c\uFEFF.jpg'), 'abc');
  assert.equal(safeBase('\u202E\u202D.png'), 'image');
  assert.equal(safeBase('CON.png'), '_CON'); assert.equal(safeBase('..\\..\\evil.jpg'), 'evil'); assert.equal(safeBase(''), 'image');
});

// ------------------------------------------------------------------ limits and dimensions
test('[unit] file-size boundary: exactly MAX_FILE_BYTES passes, one byte more fails, empty fails', () => {
  assert.doesNotThrow(() => validateFile({ size: MAX_FILE_BYTES }));
  assert.throws(() => validateFile({ size: MAX_FILE_BYTES + 1 }), { code: 'file-too-big' });
  assert.throws(() => validateFile({ size: 0 }), { code: 'empty' });
  assert.throws(() => validateFile(null), { code: 'invalid' });
  assert.throws(() => validateFile({ size: NaN }), (e) => e instanceof ImageError);       // NaN is not a usable size
});

test('[unit] pixel-count boundary via real PNG headers: MAX_PIXELS passes, +1 fails; absurd sizes fail without overflow or allocation', async () => {
  const ok = await inspectImage(asFile(pngSized(10000, 10000)));
  assert.equal(ok.width * ok.height, MAX_PIXELS);
  await assert.rejects(inspectImage(asFile(pngSized(10000, 10001))), { code: 'too-big' });
  await assert.rejects(inspectImage(asFile(pngSized(4294967295, 4294967295))), { code: 'too-big' });   // 1.8e19 px: exceeds 2^53 as a double, still rejected
  await assert.rejects(inspectImage(asFile(pngSized(0, 100))), { code: 'damaged' });
  await assert.rejects(inspectImage(asFile(png().slice(0, 20))), { code: 'damaged' });                 // truncated header
  await assert.rejects(inspectImage(asFile(new Uint8Array(500).fill(0x41))), { code: 'unknown' });     // garbage
});

test('[unit] planOutput: NaN / Infinity / absurd sizes are refused, never crash or allocate', () => {
  for (const [w, h] of [[NaN, 100], [100, NaN], [0, 5], [-5, 5], [Infinity, 10], [1e15, 1e15], [20000, 10], [16384, 16384], [10000, 10000]]) {
    const r = planOutput(4000, 3000, { resize: { mode: 'exact', fit: 'fill', width: w, height: h, allowUpscale: true } });
    assert.equal(r.ok, false, w + 'x' + h); assert.ok(r.error.message.length > 10);
  }
  assert.equal(planOutput(4000, 3000, { resize: { mode: 'exact', fit: 'fill', width: 8000, height: 5000, allowUpscale: true } }).ok, true);   // 40 MP exactly
  assert.equal(planOutput(4000, 3000, { resize: { mode: 'exact', fit: 'fill', width: 8001, height: 5000, allowUpscale: true } }).ok, false);  // 40.005 MP
});

test('[unit] userMessageOf shows only our own messages', () => {
  assert.equal(userMessageOf(new ImageError('x', 'Mine.')), 'Mine.');
  assert.equal(userMessageOf(new TypeError("Failed to execute 'drawImage'")), 'Something went wrong.');
  assert.equal(userMessageOf('plain string', 'fb'), 'fb'); assert.equal(userMessageOf(null), 'Something went wrong.'); assert.equal(userMessageOf({ userMessage: '' }, 'fb'), 'fb');
});

// ------------------------------------------------------------------ batch runner
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
test('[unit] runner property: random failures/delays, 200 jobs - exactly one terminal event per job, cap respected, queue never corrupted', async () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const jobs = Array.from({ length: 200 }, (_, id) => ({ id, pixels: 1_000_000 + Math.floor(rnd() * 20_000_000) }));
  const plan = new Map(jobs.map((j) => [j.id, { ms: Math.floor(rnd() * 4), mode: rnd() < 0.2 ? 'throw' : rnd() < 0.1 ? 'reject' : 'ok' }]));
  const terminal = new Map(); let running = 0, maxRun = 0, inPx = 0, maxPx = 0;
  const r = createRunner({
    maxParallel: 3, pixelBudget: 40_000_000,
    run: async (job) => { running++; inPx += job.pixels; maxRun = Math.max(maxRun, running); maxPx = Math.max(maxPx, inPx); const p = plan.get(job.id);
      try { if (p.mode === 'throw') throw new ImageError('t', 'boom'); await wait(p.ms); if (p.mode === 'reject') return Promise.reject(new Error('nope')); return job.id; } finally { running--; inPx -= job.pixels; } },
    onEvent: (e) => { if (e.type !== 'start') terminal.set(e.job.id, [...(terminal.get(e.job.id) || []), e.type]); },
  });
  await r.start(jobs);
  assert.equal(terminal.size, 200); for (const [id, t] of terminal) assert.equal(t.length, 1, 'job ' + id);
  for (const j of jobs) assert.equal(terminal.get(j.id)[0], plan.get(j.id).mode === 'ok' ? 'done' : 'fail');
  assert.ok(maxRun <= 3); assert.ok(maxPx <= 40_000_000 || maxRun === 1); assert.equal(r.inFlight, 0);
});

test('[unit] runner: cancel mid-run resolves, every job has exactly one outcome, a new run on the same runner works', async () => {
  const jobs = Array.from({ length: 12 }, (_, id) => ({ id, pixels: 1 })), seen = new Map(); let cancelCalls = 0;
  const events = (e) => { if (e.type !== 'start') seen.set(e.job.id, [...(seen.get(e.job.id) || []), e.type]); };
  const r = createRunner({ maxParallel: 2, onEvent: events, run: async (job, isCancelled) => { await wait(10); if (isCancelled()) cancelCalls++; return job.id; } });
  const p = r.start(jobs); await wait(15); r.cancel(); r.cancel();                      // double cancel is harmless
  await p;
  assert.equal(seen.size, 12); for (const t of seen.values()) assert.equal(t.length, 1);
  assert.ok([...seen.values()].some((t) => t[0] === 'cancelled'));                       // pending jobs were dropped
  assert.equal(r.inFlight, 0);
  seen.clear(); await r.start(jobs.slice(0, 3)); assert.equal([...seen.values()].filter((t) => t[0] === 'done').length, 3);   // reusable after a cancel
});

test('[unit] runner: cancel before start of any job, and empty job list, both resolve', async () => {
  const r = createRunner({ run: async () => 1 }); assert.deepEqual(await r.start([]), { peak: 0 });
  const r2 = createRunner({ run: async () => 1 }); const p = r2.start([{ id: 1, pixels: 1 }]); r2.cancel(); await p;
});

// ------------------------------------------------------------------ HEIC lifecycle (REAL libheif-js wasm)
test('[real] HEIC: corrupt / truncated / garbage inputs fail with an ImageError, and the decoder still works afterwards', async () => {
  const good = fx('landscape.heic');
  const inputs = [good.slice(0, 40), good.slice(0, good.length >> 1), good.slice(0, 200), new Uint8Array(good.length).fill(0x41),
    Uint8Array.from(good, (b, i) => (i > 100 && i < 400 ? b ^ 0xff : b)), new Uint8Array(0)];
  for (const [i, bad] of inputs.entries()) {
    try { await decodeHeicPixels(bad); assert.fail('input ' + i + ' decoded'); }
    catch (e) { assert.ok(e instanceof ImageError, 'input ' + i + ' threw a non-ImageError: ' + (e && e.message)); assert.match(e.code, /^heic-|^decode$|^too-big$/); assert.ok(e.userMessage.length > 10); }
  }
  const p = await decodeHeicPixels(good); assert.deepEqual([p.width, p.height], [64, 48]);                // module recovered
});
test('[real] HEIC: concurrent decodes are serialised and all return correct sizes', async () => {
  const files = ['landscape.heic', 'irot.heic', 'square.heif', 'alpha.heic', 'exif6.heic'];
  const res = await Promise.all([...files, ...files].map((f) => decodeHeicPixels(fx(f))));
  assert.deepEqual(res.map((r) => r.width + 'x' + r.height), ['64x48', '48x64', '40x40', '32x32', '64x48', '64x48', '48x64', '40x40', '32x32', '64x48']);
});
test('[real] HEIC: the wasm module is dropped after a decode at/above the threshold, kept below it', async () => {
  let loads = 0; const real = () => import('libheif-js/libheif-wasm/libheif-bundle.mjs'); const loader = () => { loads++; return real(); };
  try {
    setHeicLoader(loader); setHeicReleaseThreshold(HEIC_RELEASE_PIXELS);            // default 16 MP: tiny test images keep the warm module
    await decodeHeicPixels(fx('landscape.heic')); await decodeHeicPixels(fx('square.heif')); assert.equal(loads, 1);
    setHeicLoader(loader); loads = 0; setHeicReleaseThreshold(1);                    // every decode counts as "large"
    await decodeHeicPixels(fx('landscape.heic')); assert.equal(loads, 1);            // decode -> module dropped
    await decodeHeicPixels(fx('square.heif')); assert.equal(loads, 2);               // decode reloaded it -> dropped again
    await peekHeic(fx('alpha.heic')); assert.equal(loads, 3);                        // peek reloads, but a peek decodes no pixels and does not drop
    await decodeHeicPixels(fx('landscape.heic')); assert.equal(loads, 3);            // still warm from the peek -> no extra load
  } finally { setHeicReleaseThreshold(HEIC_RELEASE_PIXELS); setHeicLoader(real); }
});

// ------------------------------------------------------------------ session: failure keeps the old image
test('[unit] a failed load keeps the previous image, its URLs and its bitmap', async () => {
  const closed = [], revoked = []; const mk = (n) => ({ bitmap: { close: () => closed.push(n) }, width: 10, height: 10, kind: { type: 'png', mime: 'image/png' } });
  let next = mk('first');
  const s = createSession({ decode: async () => { if (next instanceof Error) throw next; return next; }, makePreview: async () => null, makeUrl: () => 'blob:' + Math.random(), revokeUrl: (u) => revoked.push(u) });
  assert.equal(await s.loadFile({ name: 'a.png' }), true);
  const before = s.getState(); next = new ImageError('damaged', 'broken');
  await assert.rejects(s.loadFile({ name: 'b.png' }), { code: 'damaged' });
  assert.equal(s.getState(), before); assert.deepEqual(closed, []); assert.deepEqual(revoked, []);        // nothing was released
  next = mk('second'); assert.equal(await s.loadFile({ name: 'c.png' }), true); assert.deepEqual(closed, ['first']);
});

// ------------------------------------------------------------------ canvas cleanup (MOCKED document, not a browser)
function fakeDom({ backed = true, failDrawAt = Infinity } = {}) {
  const made = []; let draws = 0;
  const mkCtx = (c) => ({ imageSmoothingEnabled: true, imageSmoothingQuality: 'low', fillStyle: '', fillRect() {}, clearRect() {},
    drawImage() { if (++draws >= failDrawAt) throw new Error('drawImage failed'); },
    getImageData() { return { data: [0, 0, 0, backed ? 255 : 0] }; } });
  globalThis.document = { createElement: () => { const c = { width: 0, height: 0 }; c.getContext = () => (c._ctx ||= mkCtx(c)); made.push(c); return c; } };
  return { made, released: () => made.filter((c) => c.width === 0 && c.height === 0), live: () => made.filter((c) => c.width > 0 || c.height > 0) };
}
test('[mocked] drawScaled frees every temporary canvas, also when a draw throws', async () => {
  const { drawScaled } = await import('../src/core/render.js');
  let d = fakeDom(); drawScaled({ drawImage() {}, }, {}, { x: 0, y: 0, w: 4000, h: 3000 }, { x: 0, y: 0, w: 100, h: 75 }); assert.ok(d.made.length >= 4); assert.equal(d.live().length, 0);
  d = fakeDom({ failDrawAt: 3 });
  assert.throws(() => drawScaled({ drawImage() {} }, {}, { x: 0, y: 0, w: 4000, h: 3000 }, { x: 0, y: 0, w: 100, h: 75 }), /drawImage failed/);
  assert.equal(d.live().length, 0, 'a temp canvas leaked after a failed draw');
  delete globalThis.document;
});
test('[mocked] renderPlan / makeCanvas release the output canvas when the browser cannot really back it, or a draw fails', async () => {
  const { renderPlan, makeCanvas } = await import('../src/core/render.js');
  const plan = { outW: 5000, outH: 5000, src: { x: 0, y: 0, w: 5000, h: 5000 }, dst: { x: 0, y: 0, w: 5000, h: 5000 } };   // 25 MP > probe threshold
  let d = fakeDom({ backed: false });
  assert.throws(() => renderPlan({}, plan), { code: 'canvas-limit' }); assert.equal(d.live().length, 0, 'refused big canvas stayed allocated');
  assert.throws(() => makeCanvas(5000, 5000), { code: 'canvas-limit' }); assert.equal(d.live().length, 0);
  d = fakeDom({ failDrawAt: 1 });
  assert.throws(() => renderPlan({}, { ...plan, outW: 100, outH: 100, dst: { x: 0, y: 0, w: 100, h: 100 }, src: { x: 0, y: 0, w: 100, h: 100 } }), /drawImage failed/);
  assert.equal(d.live().length, 0, 'output canvas leaked after a failed draw');
  d = fakeDom(); const ok = renderPlan({}, { ...plan, outW: 50, outH: 50, dst: { x: 0, y: 0, w: 50, h: 50 }, src: { x: 0, y: 0, w: 50, h: 50 } }); assert.equal(ok.width, 50); assert.equal(d.live().length, 1);   // success keeps it for the caller
  delete globalThis.document;
});
