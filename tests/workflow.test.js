import test from 'node:test';
import assert from 'node:assert/strict';
import { makeOp, addOp, removeOp, moveOp, updateOp, validateWorkflow, paramError, runWorkflow, TEMPLATES, MAX_IMAGES, MAX_OPS, defaultParams } from '../src/core/workflow.js';

const img = (name, w = 1000, h = 1500) => ({ name, bitmap: { id: name, closed: false }, width: w, height: h, hasAlpha: false, kind: 'jpeg' });
/** Fake executors: record calls, produce new "bitmaps", count closes. */
function fakeExec({ failOn = null, failImage = null } = {}) {
  const log = [], closed = [];
  const exec = {
    log, closed,
    async image(op, item) {
      log.push(op.type + ':' + item.name);
      if (failOn === op.type && (!failImage || failImage === item.name)) throw Object.assign(new Error('boom in ' + op.type), { userMessage: 'Could not ' + op.type + ' ' + item.name });
      if (op.type === 'convert') return { ...item, target: { mime: op.params.mime, quality: op.params.quality } };
      return { ...item, bitmap: { id: item.bitmap.id + '>' + op.type, closed: false }, owned: true };
    },
    async sheet(op, items) { log.push('sheet:' + items.map((i) => i.name).join(',')); if (failOn === 'sheet') throw Object.assign(new Error('internal sheet detail'), { userMessage: 'sheet exploded' }); return { blob: { pdf: true }, notes: ['n1'], info: { pages: 1, photos: items.length * op.params.copies } }; },
    async finalize(item) { log.push('finalize:' + item.name); if (failOn === 'finalize') throw Object.assign(new Error('internal encode detail'), { userMessage: 'encode failed' }); return { name: item.name + '.out', blob: { ops: item.bitmap.id, target: item.target || null }, mime: 'image/jpeg' }; },
    release(item) { closed.push(item.bitmap.id); item.bitmap.closed = true; },
  };
  return exec;
}
const ops = (...t) => t.map((x) => makeOp(x));

test('templates are valid and match the two requested workflows', () => {
  for (const t of TEMPLATES) assert.ok(validateWorkflow(t.make(), { imageCount: 1 }).ok, t.id);
  assert.deepEqual(TEMPLATES[0].make().map((o) => o.type), ['crop', 'resize', 'sheet']); assert.deepEqual(TEMPLATES[1].make().map((o) => o.type), ['resize', 'convert', 'watermark']);
});
test('operation ordering helpers: add, move, remove, update never mutate', () => {
  const a = ops('crop', 'resize', 'convert'), ids = a.map((o) => o.id), snapshot = JSON.stringify(a);
  const m = moveOp(a, ids[2], -1); assert.deepEqual(m.map((o) => o.type), ['crop', 'convert', 'resize']); assert.equal(JSON.stringify(a), snapshot);
  assert.equal(moveOp(a, ids[0], -1), a); assert.equal(moveOp(a, ids[2], 1), a); assert.equal(moveOp(a, 'nope', 1), a);
  assert.deepEqual(removeOp(a, ids[1]).map((o) => o.type), ['crop', 'convert']); assert.equal(a.length, 3);
  assert.deepEqual(addOp(a, 'watermark').map((o) => o.type), ['crop', 'resize', 'convert', 'watermark']);
  const u = updateOp(a, ids[0], { aw: 4, ah: 5 }); assert.deepEqual([u[0].params.aw, a[0].params.aw], [4, 35]); assert.throws(() => makeOp('rotate'), /Unknown/);
});
test('validation: structure rules', () => {
  const v = (list, n = 1) => validateWorkflow(list, { imageCount: n });
  assert.equal(v([]).ok, false); assert.match(v([]).errors[0].message, /at least one step/i);
  assert.ok(v(ops('crop', 'resize', 'watermark', 'convert')).ok);                                                           // convert before or after watermark: both fine
  assert.ok(v(ops('crop', 'convert', 'watermark')).ok);
  const dup = v([...ops('crop'), ...ops('crop')]); assert.equal(dup.ok, false); assert.match(dup.errors[0].message, /more than once/);
  const sheetFirst = v(ops('sheet', 'crop')); assert.equal(sheetFirst.ok, false); assert.match(sheetFirst.errors[0].message, /last step/);
  const conflict = v(ops('crop', 'convert', 'sheet')); assert.equal(conflict.ok, false); assert.match(conflict.errors.map((e) => e.message).join(' '), /cannot be combined with Convert/);
  assert.equal(v([{ id: 'x', type: 'blur', params: {} }]).ok, false); assert.equal(v([null]).ok, false);
  assert.equal(v(ops('crop'), 0).ok, false); assert.match(v(ops('crop'), 0).errors[0].message, /at least one image/i); assert.equal(v(ops('crop'), MAX_IMAGES + 1).ok, false); assert.ok(v(ops('crop'), MAX_IMAGES).ok);
  const many = Array.from({ length: MAX_OPS + 1 }, () => makeOp('crop')); assert.match(v(many).errors[0].message, /At most/);
  const w = v(ops('resize', 'crop')); assert.ok(w.ok); assert.equal(w.warnings.length, 1); assert.match(w.warnings[0].message, /before Crop/);
});
test('validation: invalid operation settings', () => {
  const bad = (type, patch, re) => { const e = paramError({ type, params: { ...defaultParams(type), ...patch } }); assert.ok(e, type + JSON.stringify(patch)); if (re) assert.match(e, re); };
  assert.equal(paramError(makeOp('crop')), null);
  bad('crop', { aw: 0 }, /greater than zero/); bad('crop', { ah: -3 }); bad('crop', { aw: NaN }); bad('crop', { aw: 1000, ah: 1 }, /ratio/);
  bad('resize', { width: 0 }); bad('resize', { width: 1.5 }); bad('resize', { width: NaN }); bad('resize', { width: 99999 }, /exceed/); bad('resize', { width: 20000, height: 20000 }, /megapixel|exceed/); bad('resize', { fit: 'stretch' });
  bad('watermark', { text: '   ' }, /type the text/i); bad('watermark', { text: '' });
  bad('convert', { mime: 'image/gif' }); bad('convert', { quality: 0 }); bad('convert', { quality: 101 }); bad('convert', { quality: 50.5 });
  bad('sheet', { copies: 0 }, /Copies/); bad('sheet', { photoW: 300 }, /does not fit/); bad('sheet', { margin: 200 }, /Margin/); bad('sheet', { dpi: 10 }, /DPI/); bad('sheet', { paper: { key: 'B9' } }); bad('sheet', { guides: 'x' });
  assert.equal(paramError(makeOp('sheet', { paper: { key: 'LETTER' }, photoW: 50.8, photoH: 50.8 })), null);
  const v = validateWorkflow([makeOp('crop', { aw: 0 }), makeOp('convert')], { imageCount: 1 }); assert.deepEqual(v.errors.map((e) => e.index), [0]);
});
test('runner refuses an invalid workflow without touching executors', async () => {
  const e = fakeExec(), r = await runWorkflow(ops('sheet', 'crop'), [img('a')], e); assert.equal(r.ok, false); assert.equal(r.code, 'invalid'); assert.deepEqual(e.log, []);
});
test('sequential processing: every image through every step in list order, then finalize', async () => {
  const e = fakeExec(), input = [img('a'), img('b')], seen = [];
  const r = await runWorkflow(ops('crop', 'resize', 'convert'), input, e, { onProgress: (p) => seen.push(p.step + ':' + p.status) });
  assert.ok(r.ok); assert.equal(r.kind, 'images'); assert.deepEqual(e.log, ['crop:a', 'crop:b', 'resize:a', 'resize:b', 'convert:a', 'convert:b', 'finalize:a', 'finalize:b']);
  assert.deepEqual(r.files.map((f) => f.name), ['a.out', 'b.out']); assert.equal(r.files[0].blob.ops, 'a>crop>resize'); assert.deepEqual(r.files[0].blob.target, { mime: 'image/jpeg', quality: 92 });
  assert.deepEqual(r.steps.map((s) => s.status), ['done', 'done', 'done', 'done']); assert.ok(seen.indexOf('0:running') < seen.indexOf('0:done') && seen.indexOf('0:done') < seen.indexOf('1:running'));
});
test('reordering changes the processing order', async () => {
  const e = fakeExec(), a = ops('crop', 'resize'), r = await runWorkflow(moveOp(a, a[1].id, -1), [img('a')], e); assert.ok(r.ok); assert.equal(r.files[0].blob.ops, 'a>resize>crop');
});
test('passport workflow: pictures -> sheet PDF', async () => {
  const e = fakeExec(), r = await runWorkflow(TEMPLATES[0].make(), [img('a'), img('b')], e); assert.ok(r.ok); assert.equal(r.kind, 'pdf'); assert.deepEqual(r.pdf, { pdf: true }); assert.deepEqual(r.notes, ['n1']); assert.equal(r.info.photos, 16);
  assert.deepEqual(e.log.filter((l) => l.startsWith('sheet')), ['sheet:a,b']); assert.ok(!e.log.some((l) => l.startsWith('finalize')));
  assert.deepEqual(r.steps.map((s) => s.status), ['done', 'done', 'done', 'done']);
});
test('failure is reported with step and image, stops the run, skips nothing silently', async () => {
  const e = fakeExec({ failOn: 'resize', failImage: 'b' }), input = [img('a'), img('b'), img('c')], r = await runWorkflow(ops('crop', 'resize', 'convert'), input, e);
  assert.equal(r.ok, false); assert.equal(r.step, 1); assert.equal(r.op, 'resize'); assert.equal(r.image, 'b'); assert.match(r.error, /Could not resize b/);
  assert.deepEqual(r.steps.map((s) => s.status), ['done', 'failed', 'pending', 'pending']); assert.equal(r.steps[1].message, r.error); assert.ok(!e.log.includes('resize:c') && !e.log.includes('convert:a') && !e.log.some((l) => l.startsWith('finalize')));
});
test('failure in the sheet step and in final encoding are also reported', async () => {
  const s = await runWorkflow(TEMPLATES[0].make(), [img('a')], fakeExec({ failOn: 'sheet' })); assert.equal(s.ok, false); assert.equal(s.op, 'sheet'); assert.match(s.error, /sheet exploded/);
  const f = await runWorkflow(ops('crop'), [img('a')], fakeExec({ failOn: 'finalize' })); assert.equal(f.ok, false); assert.equal(f.op, 'output'); assert.equal(f.image, 'a'); assert.match(f.error, /encode failed/);
  const odd = await runWorkflow(ops('crop'), [img('a')], { async image() { throw 'plain string'; }, release() {} }); assert.equal(odd.ok, false); assert.equal(odd.error, 'Something went wrong.');
  // Phase 8: a raw browser/library Error (no userMessage) is NOT shown to the user
  const raw = await runWorkflow(ops('crop'), [img('a')], { async image() { throw new Error("Failed to execute 'drawImage' on 'CanvasRenderingContext2D': at foo.js:12"); }, release() {} });
  assert.equal(raw.ok, false); assert.equal(raw.error, 'Something went wrong.'); assert.doesNotMatch(JSON.stringify(raw.steps), /drawImage|foo\.js/);
});
test('Phase 8: a step that reports its own cancel is a cancel, not a failure (and still releases)', async () => {
  const input = [img('a')], e = fakeExec(); e.sheet = async () => { throw Object.assign(new Error('x'), { code: 'cancelled', userMessage: 'Cancelled.' }); };
  const r = await runWorkflow(TEMPLATES[0].make(), input, e);
  assert.equal(r.ok, false); assert.equal(r.cancelled, true); assert.equal(r.steps.at(-2).status, 'cancelled'); assert.ok(input.every((i) => !i.bitmap.closed));
});
test('original input is preserved: same objects, never closed, never mutated, restart works', async () => {
  const input = [img('a'), img('b')], before = JSON.stringify(input), bitmaps = input.map((i) => i.bitmap);
  const ok = fakeExec(); await runWorkflow(ops('crop', 'resize', 'convert'), input, ok); assert.equal(JSON.stringify(input), before); assert.ok(input.every((i, k) => i.bitmap === bitmaps[k] && !i.bitmap.closed && !('owned' in i) && !('target' in i)));
  const bad = fakeExec({ failOn: 'resize', failImage: 'b' }); await runWorkflow(ops('crop', 'resize'), input, bad); assert.equal(JSON.stringify(input), before); assert.ok(input.every((i) => !i.bitmap.closed));
  const again = await runWorkflow(ops('crop', 'resize'), input, fakeExec()); assert.ok(again.ok);                                                           // restart from the same input
  assert.ok(ok.closed.every((id) => !['a', 'b'].includes(id)) && bad.closed.every((id) => !['a', 'b'].includes(id)));
});
test('working copies are released exactly once: on success, on failure, on cancel; shared bitmaps (convert) not double-closed', async () => {
  const e1 = fakeExec(); await runWorkflow(ops('crop', 'resize', 'convert'), [img('a')], e1); assert.deepEqual(e1.closed.sort(), ['a>crop', 'a>crop>resize']); assert.equal(new Set(e1.closed).size, e1.closed.length);
  const e2 = fakeExec({ failOn: 'resize', failImage: 'b' }); await runWorkflow(ops('crop', 'resize'), [img('a'), img('b')], e2); assert.equal(new Set(e2.closed).size, e2.closed.length); assert.deepEqual(e2.closed.sort(), ['a>crop', 'a>crop>resize', 'b>crop']);
  const e3 = fakeExec(); await runWorkflow(TEMPLATES[0].make(), [img('a')], e3); assert.equal(new Set(e3.closed).size, e3.closed.length); assert.ok(e3.closed.includes('a>crop>resize'));
  let n = 0; const e4 = fakeExec(), c = await runWorkflow(ops('crop', 'resize'), [img('a'), img('b')], e4, { isCancelled: () => ++n > 3 }); assert.equal(c.ok, false); assert.equal(c.cancelled, true); assert.equal(new Set(e4.closed).size, e4.closed.length);
  assert.ok(c.steps.some((s) => s.status === 'cancelled'));
});
test('a release error does not hide the real failure', async () => {
  const e = fakeExec({ failOn: 'resize' }); e.release = () => { throw new Error('close failed'); }; const r = await runWorkflow(ops('crop', 'resize'), [img('a')], e); assert.equal(r.ok, false); assert.match(r.error, /Could not resize/);
});
test('progress callback gets one event per state change and total = steps + output', async () => {
  const ev = []; await runWorkflow(ops('crop', 'convert'), [img('a')], fakeExec(), { onProgress: (p) => ev.push(p) }); assert.ok(ev.every((p) => p.total === 3)); assert.equal(ev.filter((p) => p.status === 'done').length, 3);
});
