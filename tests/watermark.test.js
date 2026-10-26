import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, PRESETS, RANGES, FONTS, POSITIONS, MAX_TEXT, MAX_MARKS, MAX_MARK_PIXELS, normalizeWatermark, hasContent, contrastColor, markDims, halfBox, planMarks, planNotes } from '../src/core/watermark.js';

const wm = (o) => normalizeWatermark({ ...DEFAULTS, ...o });

test('normalizeWatermark: defaults, clamping, garbage in', () => {
  assert.deepEqual(normalizeWatermark(), DEFAULTS);
  const p = normalizeWatermark({ size: 999, opacity: -5, rotation: 400, margin: 'x', gap: NaN, type: 'weird', font: 'comic', position: 'zz', mode: 'diag', color: 'red', bold: 0, outline: 0, stagger: 0 });
  assert.deepEqual([p.size, p.opacity, p.rotation, p.margin, p.gap], [100, 0, 180, DEFAULTS.margin, DEFAULTS.gap]);
  assert.deepEqual([p.type, p.font, p.position, p.mode, p.color, p.bold, p.outline, p.stagger], ['text', 'sans', 'br', 'single', '#ffffff', false, false, false]);
  assert.equal(normalizeWatermark({ font: '__proto__' }).font, 'sans');
  for (const pr of PRESETS) for (const [k, v] of Object.entries(pr.values)) if (RANGES[k]) assert.ok(v >= RANGES[k][0] && v <= RANGES[k][1], pr.key + k);
  assert.ok(POSITIONS.length === 9 && Object.keys(FONTS).length === 3);
});

test('text: trimmed, control characters removed, at most 3 lines and 200 characters', () => {
  assert.equal(wm({ text: '  a\u0000b \r\n  second  \n\n\nfourth' }).text, 'ab\nsecond\n');
  assert.equal(wm({ text: 'x'.repeat(500) }).text.length, MAX_TEXT);
  assert.equal(wm({ text: 42 }).text, DEFAULTS.text);
  assert.equal(wm({ text: '<img src=x onerror=1>' }).text, '<img src=x onerror=1>');   // kept as plain text: it is only drawn on a canvas, never as HTML
  assert.equal(hasContent(wm({ text: '   ' }), false), false); assert.equal(hasContent(wm({ text: 'A' }), false), true);
  assert.equal(hasContent(wm({ type: 'logo' }), false), false); assert.equal(hasContent(wm({ type: 'logo' }), true), true);
});

test('contrastColor and markDims', () => {
  assert.equal(contrastColor('#ffffff'), '#000000'); assert.equal(contrastColor('#101010'), '#ffffff'); assert.equal(contrastColor('nope'), '#000000');
  assert.deepEqual(markDims(1000, 4, wm({ size: 20 })), { w: 200, h: 50 });
  assert.deepEqual(markDims(1000, 0.5, wm({ size: 1 })), { w: 10, h: 20 });
  const big = markDims(16000, 0.1, wm({ size: 100 })); assert.ok(big.w * big.h <= MAX_MARK_PIXELS);
  assert.deepEqual(markDims(1, 100, wm({ size: 1 })), { w: 1, h: 1 });
});

test('halfBox: rotated bounding box', () => {
  assert.deepEqual(halfBox(100, 20, 0), { hw: 50, hh: 10 });
  const q = halfBox(100, 20, Math.PI / 2); assert.ok(Math.abs(q.hw - 10) < 1e-9 && Math.abs(q.hh - 50) < 1e-9);
  const d = halfBox(100, 20, Math.PI / 4); assert.ok(Math.abs(d.hw - 60 * Math.SQRT1_2) < 1e-9 && Math.abs(d.hw - d.hh) < 1e-9);
});

test('single placement: all nine anchors land where they say, inside the margin', () => {
  const W = 1000, H = 600, mw = 200, mh = 50, m = 0.03 * 600;
  const at = (pos) => planMarks(W, H, mw, mh, wm({ position: pos, margin: 3 })).marks[0];
  assert.deepEqual(at('tl'), { x: m + 100, y: m + 25 }); assert.deepEqual(at('br'), { x: W - m - 100, y: H - m - 25 });
  assert.deepEqual(at('mc'), { x: 500, y: 300 }); assert.deepEqual(at('tc'), { x: 500, y: m + 25 }); assert.deepEqual(at('ml'), { x: m + 100, y: 300 });
  assert.deepEqual(at('tr'), { x: W - m - 100, y: m + 25 }); assert.deepEqual(at('bl'), { x: m + 100, y: H - m - 25 });
  assert.deepEqual(at('bc'), { x: 500, y: H - m - 25 }); assert.deepEqual(at('mr'), { x: W - m - 100, y: 300 });
  assert.equal(planMarks(W, H, mw, mh, wm({})).clipped, false);
});

test('single placement: a rotated mark stays inside the image (its rotated box is measured)', () => {
  for (const rot of [-180, -90, -45, -30, 17, 45, 90, 135]) for (const pos of POSITIONS) {
    const p = planMarks(1000, 600, 300, 60, wm({ rotation: rot, position: pos, margin: 2 })), { hw, hh } = halfBox(300, 60, p.angle), { x, y } = p.marks[0];
    assert.ok(x - hw >= -1e-6 && x + hw <= 1000 + 1e-6 && y - hh >= -1e-6 && y + hh <= 600 + 1e-6, rot + ' ' + pos);
  }
});

test('single placement: a mark bigger than the image is centred on that axis and reported as clipped', () => {
  const p = planMarks(300, 200, 500, 50, wm({ position: 'tl' }));
  assert.equal(p.clipped, true); assert.equal(p.marks[0].x, 150);
  assert.ok(planNotes(wm({}), p, { markW: 500 }).some((n) => /cut off/.test(n)));
  assert.equal(planMarks(0, 10, 5, 5, wm({})).ok, false); assert.equal(planMarks(10, 10, 0, 5, wm({})).error.code, 'size');
});

test('tile: covers the whole image, brick stagger offsets odd rows, bounded count', () => {
  const W = 1000, H = 600, t = (o) => planMarks(W, H, 120, 30, wm({ mode: 'tile', rotation: 0, gap: 50, ...o }));
  const a = t({ stagger: false }), b = t({ stagger: true });
  assert.ok(a.ok && a.marks.length > 20 && a.marks.length <= MAX_MARKS);
  const xs = (p, y) => p.marks.filter((m) => Math.abs(m.y - y) < 1).map((m) => m.x).sort((p1, p2) => p1 - p2);
  const row0 = xs(b, 300), row1 = xs(b, 300 + 45);
  assert.ok(row0.length && row1.length && Math.abs((row1[0] - row0[0]) % 180) > 1, 'odd rows are shifted by half a cell');
  for (const q of [a, b]) { assert.ok(q.marks.some((m) => m.x < 150) && q.marks.some((m) => m.x > 850) && q.marks.some((m) => m.y < 100) && q.marks.some((m) => m.y > 500), 'reaches every edge region'); }
  assert.ok(a.marks.every((m) => m.x > -60 - 1 && m.x < W + 60 + 1 && m.y > -15 - 1 && m.y < H + 15 + 1), 'no copy lies fully outside the image');
});

test('tile: a rotated pattern still reaches all four corners; copies carry the same angle', () => {
  const p = planMarks(1000, 600, 200, 40, wm({ mode: 'tile', rotation: -30, gap: 80 })), { hw, hh } = halfBox(200, 40, p.angle);
  assert.ok(p.ok && Math.abs(p.angle + Math.PI / 6) < 1e-9);
  for (const [cx, cy] of [[100, 100], [900, 100], [100, 500], [900, 500]]) assert.ok(p.marks.some((m) => Math.abs(m.x - cx) < 220 && Math.abs(m.y - cy) < 150), 'corner ' + cx + ',' + cy);
  assert.ok(p.marks.every((m) => Math.abs(m.x - 500) < 500 + hw && Math.abs(m.y - 300) < 300 + hh));
  assert.ok(planNotes(wm({ mode: 'tile' }), p, { markW: 200 }).some((n) => /copies/.test(n)));
});

test('tile: refuses an absurd number of copies instead of freezing the browser', () => {
  const r = planMarks(8000, 6000, 4, 4, wm({ mode: 'tile', gap: 0 }));
  assert.equal(r.ok, false); assert.equal(r.error.code, 'too-many'); assert.match(r.error.message, /Make it bigger|increase the spacing/);
  const edge = planMarks(4000, 3000, 80, 20, wm({ mode: 'tile', gap: 0 }));
  assert.ok(edge.ok === false || edge.marks.length <= MAX_MARKS);
});

test('planNotes: small mark, enlarged logo, nearly invisible', () => {
  const ok = planMarks(1000, 600, 10, 10, wm({}));
  assert.ok(planNotes(wm({}), ok, { markW: 10 }).some((n) => /very small/.test(n)));
  assert.ok(planNotes(wm({ type: 'logo' }), ok, { markW: 100, logoScale: 2.5 }).some((n) => /250%/.test(n)));
  assert.ok(planNotes(wm({ opacity: 2 }), ok, { markW: 100 }).some((n) => /invisible/.test(n)));
  assert.deepEqual(planNotes(wm({}), { ok: false }, {}), []);
  assert.deepEqual(planNotes(wm({}), ok, { markW: 100 }), []);
});
