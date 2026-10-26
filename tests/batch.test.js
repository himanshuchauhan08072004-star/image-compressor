import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, buildRecipe, suffixFor, outputName, safeBase, uniqueName, checkLimits, createRunner, DEFAULT_SETTINGS, REENCODE_QUALITY } from '../src/core/batch.js';
import { planOutput } from '../src/core/geometry.js';
import { MAX_BATCH_FILES, MAX_BATCH_BYTES } from '../src/core/limits.js';

const ok = (o) => { const r = normalizeSettings({ ...DEFAULT_SETTINGS, ...o, resize: { ...DEFAULT_SETTINGS.resize, ...(o.resize || {}) } }); assert.ok(r.ok, r.error); return r.settings; };
const jpg = { mime: 'image/jpeg', type: 'jpeg' }, png = { mime: 'image/png', type: 'png' };
const img = (width, height, kind = jpg) => ({ width, height, kind });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('normalizeSettings: validates every field, rejects no-op and bad numbers', () => {
  assert.equal(normalizeSettings({ compress: 'off' }).ok, false);                                          // nothing to do
  assert.match(normalizeSettings({ compress: 'off' }).error, /at least one/);
  assert.equal(normalizeSettings({ resize: { mode: 'width', width: 0 }, compress: 'off' }).ok, false);
  assert.equal(normalizeSettings({ resize: { mode: 'width', width: 99999 }, compress: 'off' }).ok, false);
  assert.equal(normalizeSettings({ resize: { mode: 'box', width: 100, height: 'x' }, compress: 'off' }).ok, false);
  assert.equal(normalizeSettings({ compress: 'target', targetKB: 0 }).ok, false);
  assert.equal(normalizeSettings({ compress: 'target', targetKB: 'abc' }).ok, false);
  const s = normalizeSettings({ format: 'gif', compress: 'quality', quality: 5000, resize: { mode: 'nope' } }).settings;
  assert.deepEqual([s.format, s.quality, s.resize.mode], ['keep', 95, 'off']);                              // unknown values fall back safely
  assert.equal(normalizeSettings({ strip: true, compress: 'off' }).ok, true);                              // metadata alone is a valid job
});
test('buildRecipe: width / height keep aspect, never enlarge by default, say so', () => {
  let r = buildRecipe(ok({ resize: { mode: 'width', width: 1000 } }), img(4000, 3000));
  assert.deepEqual([r.recipe.resize.width, r.recipe.resize.height, r.recipe.resize.mode], [1000, 750, 'scale']);
  r = buildRecipe(ok({ resize: { mode: 'height', height: 500 } }), img(4000, 3000)); assert.deepEqual([r.recipe.resize.width, r.recipe.resize.height], [667, 500]);
  r = buildRecipe(ok({ resize: { mode: 'width', width: 1000 } }), img(800, 600)); assert.equal(r.recipe.resize, null); assert.match(r.notes[0], /size was kept/);
  r = buildRecipe(ok({ resize: { mode: 'width', width: 1000, allowUpscale: true } }), img(800, 600)); assert.deepEqual([r.recipe.resize.width, r.recipe.resize.height, r.recipe.resize.allowUpscale], [1000, 750, true]);
});
test('buildRecipe: box = fit inside (aspect kept) or exact stretch', () => {
  let r = buildRecipe(ok({ resize: { mode: 'box', width: 1080, height: 1080, keepAspect: true } }), img(4000, 3000)); assert.deepEqual([r.recipe.resize.width, r.recipe.resize.height], [1080, 810]);
  r = buildRecipe(ok({ resize: { mode: 'box', width: 1080, height: 1080, keepAspect: true } }), img(3000, 4000)); assert.deepEqual([r.recipe.resize.width, r.recipe.resize.height], [810, 1080]);
  r = buildRecipe(ok({ resize: { mode: 'box', width: 1080, height: 1080, keepAspect: true } }), img(500, 400)); assert.equal(r.recipe.resize, null);
  r = buildRecipe(ok({ resize: { mode: 'box', width: 300, height: 300, keepAspect: false } }), img(4000, 3000)); assert.deepEqual([r.recipe.resize.width, r.recipe.resize.height], [300, 300]);
});
test('buildRecipe output: every recipe it makes is accepted by the real planner (no resize ever enlarges silently)', () => {
  for (const [w, h] of [[4000, 3000], [3000, 4000], [200, 200], [1, 1], [16000, 100], [123, 4567]]) {
    for (const rz of [{ mode: 'width', width: 1000 }, { mode: 'height', height: 640 }, { mode: 'box', width: 1080, height: 1080, keepAspect: true }]) {
      const { recipe } = buildRecipe(ok({ resize: rz }), img(w, h)); const p = planOutput(w, h, recipe);
      assert.ok(p.ok, JSON.stringify([w, h, rz, p.error]));
      assert.ok(p.plan.outW <= w && p.plan.outH <= h, 'must not enlarge');
    }
  }
});
test('buildRecipe: format, compress mode and quality', () => {
  let r = buildRecipe(ok({ format: 'webp', compress: 'quality', quality: 60 }), img(100, 100, png)); assert.deepEqual([r.recipe.output.mime, r.recipe.output.mode, r.recipe.output.quality], ['image/webp', 'quality', 60]);
  r = buildRecipe(ok({ compress: 'target', targetKB: 150 }), img(100, 100)); assert.deepEqual([r.recipe.output.mime, r.recipe.output.mode, r.recipe.output.targetKB], ['image/jpeg', 'target', 150]);
  r = buildRecipe(ok({ compress: 'target', targetKB: 150 }), img(100, 100, png)); assert.match(r.notes.join(' '), /PNG is lossless/);
  r = buildRecipe(ok({ format: 'png', compress: 'off' }), img(100, 100)); assert.equal(r.recipe.output.quality, REENCODE_QUALITY);
});
test('buildRecipe: strip strategy (lossless only when nothing else changes), copy when there is nothing to do', () => {
  let r = buildRecipe(ok({ strip: true, compress: 'off' }), img(100, 100)); assert.deepEqual([r.strategy, r.recipe.strip.method], ['lossless', 'lossless']);
  r = buildRecipe(ok({ strip: true, compress: 'quality' }), img(100, 100)); assert.deepEqual([r.strategy, r.recipe.strip.method, r.recipe.strip.keepIcc], ['canvas', 'reencode', false]);
  r = buildRecipe(ok({ strip: true, compress: 'off', format: 'png' }), img(100, 100)); assert.equal(r.strategy, 'canvas');
  r = buildRecipe(ok({ strip: true, compress: 'off', resize: { mode: 'width', width: 50 } }), img(100, 100)); assert.equal(r.strategy, 'canvas');
  r = buildRecipe(ok({ strip: true, compress: 'off', resize: { mode: 'width', width: 500 } }), img(100, 100)); assert.equal(r.strategy, 'lossless');   // resize was a no-op for this image
  r = buildRecipe(ok({ strip: false, compress: 'off', resize: { mode: 'width', width: 500 } }), img(100, 100)); assert.equal(r.strategy, 'copy');
  r = buildRecipe(ok({ strip: false }), img(100, 100)); assert.equal(r.recipe.strip, null);
});
test('suffixFor', () => {
  assert.equal(suffixFor(ok({ compress: 'quality' })), 'compressed'); assert.equal(suffixFor(ok({ compress: 'off', strip: true })), 'clean');
  assert.equal(suffixFor(ok({ compress: 'off', format: 'webp' })), 'converted'); assert.equal(suffixFor(ok({ compress: 'off', resize: { mode: 'width', width: 5 } })), 'resized');
  assert.equal(suffixFor(ok({ compress: 'quality', strip: true })), 'edited');
});
test('safeBase / outputName: unsafe characters, paths, reserved names, extensions follow the output MIME', () => {
  assert.equal(safeBase('my:photo?*.JPG'), 'my_photo__'); assert.equal(safeBase('../../etc/passwd.png'), 'passwd'); assert.equal(safeBase('C:\\x\\y\\pic.png'), 'pic');
  assert.equal(safeBase('  ..hidden. '), 'hidden'); assert.equal(safeBase(''), 'image'); assert.equal(safeBase('.png'), 'image'); assert.equal(safeBase('CON.jpg'), '_CON'); assert.equal(safeBase('a\u0000b\u001fc'), 'a_b_c');
  assert.equal(safeBase('x'.repeat(300)).length, 80); assert.equal(safeBase('Ünï cödé 日本.jpg'), 'Ünï cödé 日本');
  assert.equal(outputName('Holiday.PNG', 'image/webp', 'converted'), 'Holiday-converted.webp'); assert.equal(outputName('a.webp', 'image/jpeg', 'edited'), 'a-edited.jpg');
});
test('uniqueName: duplicates never overwrite, case-insensitively, extensions preserved', () => {
  const used = new Set();
  const names = ['a-x.jpg', 'a-x.jpg', 'A-X.JPG', 'a-x.png', 'a-x (2).jpg'].map((n) => uniqueName(n, used));
  assert.deepEqual(names, ['a-x.jpg', 'a-x (2).jpg', 'A-X (3).JPG', 'a-x.png', 'a-x (2) (2).jpg']);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length);
});
test('checkLimits: count and combined bytes', () => {
  assert.equal(checkLimits({ count: 0, bytes: 0 }, { size: 10 }).ok, true);
  const c = checkLimits({ count: MAX_BATCH_FILES, bytes: 0 }, { size: 10 }); assert.equal(c.ok, false); assert.match(c.message, /at most 50/);
  const b = checkLimits({ count: 1, bytes: MAX_BATCH_BYTES - 5 }, { size: 10 }); assert.equal(b.ok, false); assert.match(b.message, /500 MB/);
  assert.equal(checkLimits({ count: 1, bytes: MAX_BATCH_BYTES - 10 }, { size: 10 }).ok, true);
});

test('runner: concurrency never exceeds the cap; every job finishes; order of starts is queue order', async () => {
  let live = 0, peakSeen = 0; const started = [];
  const r = createRunner({ maxParallel: 2, pixelBudget: 1e12, run: async (j) => { live++; peakSeen = Math.max(peakSeen, live); started.push(j.id); await sleep(5 + (j.id % 3) * 3); live--; return j.id; } });
  const ev = []; const rr = createRunner({ maxParallel: 2, pixelBudget: 1e12, onEvent: (e) => ev.push(e.type + e.job.id), run: async (j) => { await sleep(2); return j.id; } });
  const out = await r.start(Array.from({ length: 12 }, (_, i) => ({ id: i, pixels: 1 })));
  assert.ok(peakSeen <= 2 && peakSeen === 2 && out.peak === 2); assert.deepEqual(started, [...started].sort((a, b) => a - b)); assert.equal(started.length, 12);
  await rr.start([{ id: 1, pixels: 1 }, { id: 2, pixels: 1 }]); assert.equal(ev.filter((e) => e.startsWith('done')).length, 2);
});
test('runner: pixel budget limits what runs together; an oversized job still runs, alone', async () => {
  let livePx = 0, peakPx = 0, soloOk = true; const jobs = [{ id: 0, pixels: 30 }, { id: 1, pixels: 30 }, { id: 2, pixels: 200 }, { id: 3, pixels: 10 }, { id: 4, pixels: 10 }];
  const r = createRunner({ maxParallel: 4, pixelBudget: 50, run: async (j) => { livePx += j.pixels; peakPx = Math.max(peakPx, livePx); if (j.id === 2 && livePx !== 200) soloOk = false; await sleep(5); livePx -= j.pixels; } });
  await r.start(jobs); assert.ok(soloOk, 'oversized job ran alone'); assert.ok(peakPx <= 200); 
  let live2 = 0, peak2 = 0; const r2 = createRunner({ maxParallel: 4, pixelBudget: 50, run: async (j) => { live2 += j.pixels; peak2 = Math.max(peak2, live2); await sleep(5); live2 -= j.pixels; } });
  await r2.start([30, 30, 10, 10, 10].map((p, id) => ({ id, pixels: p }))); assert.ok(peak2 <= 50, 'budget respected: ' + peak2);
});
test('runner: one failure does not stop the rest; errors are reported per job', async () => {
  const ev = []; const r = createRunner({ maxParallel: 2, onEvent: (e) => ev.push([e.type, e.job.id]), run: async (j) => { await sleep(1); if (j.id === 1) throw new Error('boom'); return 'ok'; } });
  await r.start([0, 1, 2, 3].map((id) => ({ id, pixels: 1 })));
  assert.deepEqual(ev.filter(([t]) => t === 'fail').map(([, id]) => id), [1]); assert.deepEqual(ev.filter(([t]) => t === 'done').map(([, id]) => id).sort(), [0, 2, 3]);
});
test('runner: cancel drops unstarted jobs, lets running ones see isCancelled, and still resolves', async () => {
  const ev = []; let sawCancel = false;
  const r = createRunner({ maxParallel: 1, onEvent: (e) => ev.push([e.type, e.job.id]), run: async (j, isCancelled) => { await sleep(15); sawCancel = sawCancel || isCancelled(); return j.id; } });
  const p = r.start([0, 1, 2, 3, 4].map((id) => ({ id, pixels: 1 }))); await sleep(5); r.cancel(); await p;
  assert.deepEqual(ev.filter(([t]) => t === 'cancelled').map(([, id]) => id), [1, 2, 3, 4]); assert.deepEqual(ev.filter(([t]) => t === 'start').map(([, id]) => id), [0]); assert.ok(sawCancel);
  const again = createRunner({ run: async () => 1 }); assert.deepEqual(await again.start([]), { peak: 0 });
});
test('runner: a throwing UI callback does not break the batch', async () => {
  let n = 0; const r = createRunner({ onEvent: () => { throw new Error('ui'); }, run: async () => { n++; } }); await r.start([{ id: 1, pixels: 1 }, { id: 2, pixels: 1 }]); assert.equal(n, 2);
});
