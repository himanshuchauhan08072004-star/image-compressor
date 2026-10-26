import test from 'node:test';
import assert from 'node:assert/strict';
import { planLayout, moveItem, checkItems, LAYOUT_LIMITS } from '../src/core/layout.js';
import { layoutSheet } from '../src/core/sheet.js';
import { PAPERS } from '../src/core/paper.js';

const base = (o = {}) => ({ paper: 'A4', margin: 10, hGap: 3, vGap: 3, groups: [{ w: 35, h: 45, copies: 8 }], ...o });
const plan = (o) => { const r = planLayout(base(o)); assert.ok(r.ok, r.error); return r; };
const inside = (r) => r.items.every((i) => i.x >= r.printable.x - 1e-6 && i.y >= r.printable.y - 1e-6 && i.x + i.w <= r.printable.x + r.printable.w + 1e-6 && i.y + i.h <= r.printable.y + r.printable.h + 1e-6);

test('rows, columns, count: A4 35x45 margin 10 gap 3 -> 5 x 5, 8 photos', () => {
  const r = plan(); assert.deepEqual([r.cols, r.rows, r.perPage, r.total, r.stats.pageCount], [5, 5, 25, 8, 1]);
  assert.deepEqual(r.items.slice(0, 2).map((i) => [i.x, i.y]), [[10, 10], [48, 10]]); assert.deepEqual([r.items[5].x, r.items[5].y], [10, 58]);
});
test('margins and spacing move photos exactly', () => {
  const r = plan({ margin: 20, hGap: 5, vGap: 7 }); assert.deepEqual([r.items[0].x, r.items[0].y], [20, 20]); assert.deepEqual([r.items[1].x, r.items[5].y], [60, 72]);
  assert.deepEqual([r.cols, r.rows], [4, 5]);
});
test('same result as the Phase 4 layoutSheet reference over many inputs', () => {
  // reference = the original grid formula from before Phase 7
  const ref = ({ paper, landscape, margin, gap, copies, photoW, photoH }) => {
    const p = PAPERS[paper], page = landscape ? { w: p.h, h: p.w } : { w: p.w, h: p.h }, pr = { x: margin, y: margin, w: page.w - 2 * margin, h: page.h - 2 * margin };
    const cols = Math.floor((pr.w + gap + 1e-9) / (photoW + gap)), rows = Math.floor((pr.h + gap + 1e-9) / (photoH + gap));
    if (!cols || !rows) return null; const per = cols * rows, pages = []; for (let i = 0; i < copies; i++) { const n = Math.floor(i / per), k = i % per; (pages[n] ||= []).push({ x: margin + (k % cols) * (photoW + gap), y: margin + Math.floor(k / cols) * (photoH + gap), w: photoW, h: photoH }); }
    return { cols, rows, perPage: per, pages };
  };
  let n = 0;
  for (const paper of ['A4', 'A5']) for (const landscape of [false, true]) for (const margin of [0, 5, 10, 20]) for (const gap of [0, 2, 3, 7.5]) for (const [photoW, photoH] of [[35, 45], [50.8, 50.8], [33, 48], [20, 20]]) for (const copies of [1, 8, 25, 40]) {
    const want = ref({ paper, landscape, margin, gap, copies, photoW, photoH }); if (!want || Math.ceil(copies / want.perPage) > 10) continue;
    const got = layoutSheet({ paper, landscape, margin, gap, copies, photoW, photoH }); assert.ok(got.ok, JSON.stringify([paper, landscape, margin, gap, photoW, copies]));
    assert.equal(got.cols, want.cols); assert.equal(got.rows, want.rows); assert.equal(got.perPage, want.perPage); assert.equal(got.pages.length, want.pages.length);
    got.pages.flat().forEach((r, i) => { const w = want.pages.flat()[i]; for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[k] - w[k]) < 1e-6, k); }); n++;
  }
  assert.ok(n > 300, 'compared ' + n + ' layouts');
});
test('paper sizes and orientation', () => {
  assert.deepEqual([plan({ paper: 'A5' }).page.w, plan({ paper: 'A5' }).page.h], [148, 210]);
  const l = plan({ paper: 'LETTER' }); assert.deepEqual([l.page.w, l.page.h], [215.9, 279.4]);
  const ls = plan({ landscape: true }); assert.deepEqual([ls.page.w, ls.page.h], [297, 210]); assert.deepEqual([ls.cols, ls.rows], [7, 4]);
  const c = plan({ paper: { key: 'CUSTOM', w: 4, h: 6, unit: 'in' } }); assert.deepEqual([c.page.w, c.page.h], [101.6, 152.4]); assert.ok(inside(c));
});
test('alignment: centre and right/bottom', () => {
  const c = plan({ align: { h: 'center', v: 'middle' }, groups: [{ w: 50, h: 50, copies: 1 }] }); assert.deepEqual([c.items[0].x, c.items[0].y], [80, 123.5]);
  const rb = plan({ align: { h: 'right', v: 'bottom' }, groups: [{ w: 50, h: 50, copies: 1 }] }); assert.deepEqual([rb.items[0].x, rb.items[0].y], [150, 237]);
});
test('column and row limits', () => {
  const r = plan({ cols: 2, rows: 2, groups: [{ w: 35, h: 45, copies: 9 }] }); assert.deepEqual([r.cols, r.rows, r.perPage, r.stats.pageCount], [2, 2, 4, 3]); assert.equal(r.pages[0].length, 4);
  assert.ok(planLayout(base({ cols: 51 })).ok === false); assert.ok(planLayout(base({ cols: 1.5 })).ok === false); assert.ok(planLayout(base({ rows: -1 })).ok === false);
});
test('multiple photo sizes: no overlap, inside printable area, deterministic', () => {
  const o = { groups: [{ id: 'a', w: 35, h: 45, copies: 6 }, { id: 'b', w: 70, h: 90, copies: 2 }, { id: 'c', w: 20, h: 30, copies: 5 }] };
  const r = plan(o); assert.equal(r.total, 13); assert.ok(inside(r)); assert.deepEqual(r.problems, []); assert.deepEqual(plan(o).items, r.items);
  assert.deepEqual(r.groups.map((g) => g.copies), [6, 2, 5]); r.items.forEach((i) => assert.ok(i.w > 0 && i.h > 0));
  assert.deepEqual(new Set(r.items.map((i) => i.w + 'x' + i.h)), new Set(['35x45', '70x90', '20x30']));
});
test('newRowPerGroup starts each size on its own row', () => {
  const r = plan({ newRowPerGroup: true, groups: [{ id: 'a', w: 35, h: 45, copies: 2 }, { id: 'b', w: 35, h: 45, copies: 2 }] }); assert.equal(r.items[2].y, 58); assert.equal(r.items[2].x, 10);
  const q = plan({ groups: [{ id: 'a', w: 35, h: 45, copies: 2 }, { id: 'b', w: 35, h: 45, copies: 2 }] }); assert.equal(q.items[2].y, 10);
});
test('multi-page: pages fill in order, each photo on exactly one page', () => {
  const r = plan({ groups: [{ w: 35, h: 45, copies: 30 }] }); assert.deepEqual(r.pages.map((p) => p.length), [25, 5]); assert.equal(new Set(r.items.map((i) => i.key)).size, 30);
});
test('empty / invalid layouts are errors, never exceptions', () => {
  const bad = (o, re) => { const r = planLayout(base(o)); assert.equal(r.ok, false, JSON.stringify(o)); if (re) assert.match(r.error, re); };
  bad({ groups: [] }, /at least one/i); bad({ groups: undefined }); bad({ groups: [{ w: 35, h: 45, copies: 0 }] }, /Copies/); bad({ groups: [{ w: 0, h: 45, copies: 1 }] }); bad({ groups: [{ w: -5, h: 45, copies: 1 }] });
  bad({ groups: [{ w: NaN, h: 45, copies: 1 }] }); bad({ groups: [{ w: Infinity, h: 45, copies: 1 }] }); bad({ groups: [{ w: 2, h: 45, copies: 1 }] }); bad({ groups: [{ w: 35, h: 45, copies: 1.5 }] });
  bad({ margin: -1 }, /Margin/); bad({ margin: 51 }, /Margin/); bad({ margin: NaN }); bad({ hGap: -1 }, /Spacing/); bad({ vGap: 31 }, /Spacing/); bad({ paper: 'B9' }); bad({ paper: { key: 'CUSTOM', w: 0, h: 10 } });
  bad({ align: { h: 'diagonal' } }); bad({ guides: 'lasers' }); bad({ mode: 'drag' });
  bad({ groups: Array.from({ length: 9 }, () => ({ w: 20, h: 20, copies: 1 })) }, /At most/);
  bad({ groups: [{ w: 20, h: 20, copies: 100 }, { w: 20, h: 20, copies: 100 }, { w: 20, h: 20, copies: 100 }, { w: 20, h: 20, copies: 100 }, { w: 20, h: 20, copies: 100 }], paper: 'A4' });
});
test('boundary conditions: exact fit, one micron too big, margins eat the page', () => {
  const exact = plan({ margin: 0, hGap: 0, vGap: 0, groups: [{ w: 210, h: 297, copies: 1 }] }); assert.equal(exact.items.length, 1); assert.ok(inside(exact));
  const full = plan({ margin: 0, hGap: 0, vGap: 0, groups: [{ w: 70, h: 99, copies: 9 }] }); assert.deepEqual([full.cols, full.rows, full.stats.pageCount], [3, 3, 1]);
  assert.match(planLayout(base({ margin: 0, hGap: 0, vGap: 0, groups: [{ w: 210.001, h: 297, copies: 1 }] })).error, /does not fit/);
  assert.match(planLayout(base({ paper: { key: 'CUSTOM', w: 20, h: 20, unit: 'mm' }, margin: 10, groups: [{ w: 5, h: 5, copies: 1 }] })).error, /margin/i);
  assert.match(planLayout(base({ groups: [{ w: 200, h: 100, copies: 1 }] })).error, /does not fit/);
  assert.match(planLayout(base({ groups: [{ w: 100, h: 280, copies: 1 }, { w: 20, h: 20, copies: 1 }] })).error, /Photo group 1/);
});
test('page limit', () => {
  const r = planLayout(base({ groups: [{ w: 190, h: 270, copies: 11 }] })); assert.equal(r.ok, false); assert.match(r.error, /limit/);
  assert.equal(planLayout(base({ groups: [{ w: 190, h: 270, copies: LAYOUT_LIMITS.pagesMax }] })).ok, true);
});
test('overflow and overlap detection (independent of the packer)', () => {
  const P = { x: 10, y: 10, w: 190, h: 277 };
  assert.equal(checkItems([{ key: 'a', page: 0, x: 10, y: 10, w: 50, h: 50 }, { key: 'b', page: 0, x: 60, y: 10, w: 50, h: 50 }], P).length, 0);                       // touching edges are fine
  const ov = checkItems([{ key: 'a', page: 0, x: 10, y: 10, w: 50, h: 50 }, { key: 'b', page: 0, x: 59, y: 10, w: 50, h: 50 }], P); assert.equal(ov.length, 1); assert.equal(ov[0].type, 'overlap');
  assert.equal(checkItems([{ key: 'a', page: 0, x: 10, y: 10, w: 50, h: 50 }, { key: 'b', page: 0, x: 59, y: 10, w: 50, h: 50 }], P, { allowOverlap: true }).length, 0);
  assert.equal(checkItems([{ key: 'a', page: 0, x: 10, y: 10, w: 50, h: 50 }, { key: 'b', page: 1, x: 10, y: 10, w: 50, h: 50 }], P).length, 0);                      // different pages never overlap
  const out = checkItems([{ key: 'a', page: 0, x: 160, y: 10, w: 50, h: 50 }], P); assert.equal(out[0].type, 'overflow');
  assert.equal(checkItems([{ key: 'a', page: 0, x: 5, y: 10, w: 50, h: 50 }], P)[0].type, 'overflow');
});
test('manual mode: overrides apply, clamp with a warning, overlap blocks export unless allowed', () => {
  const g = { groups: [{ id: 'a', w: 35, h: 45, copies: 2 }] };
  const m = plan({ ...g, mode: 'manual', manual: { 'a:1': { x: 100, y: 200 } } }); assert.deepEqual([m.items[1].x, m.items[1].y, m.items[1].manual], [100, 200, true]); assert.ok(m.exportable);
  const clamped = plan({ ...g, mode: 'manual', manual: { 'a:1': { x: 500, y: -5 } } }); assert.ok(inside(clamped)); assert.equal(clamped.warnings.length, 1);
  const ov = plan({ ...g, mode: 'manual', manual: { 'a:1': { x: 12, y: 12 } } }); assert.equal(ov.exportable, false); assert.equal(ov.problems[0].type, 'overlap');
  assert.equal(plan({ ...g, mode: 'manual', allowOverlap: true, manual: { 'a:1': { x: 12, y: 12 } } }).exportable, true);
  const auto = plan({ ...g, mode: 'auto', manual: { 'a:1': { x: 100, y: 200 } } }); assert.equal(auto.items[1].manual, false);                                           // auto ignores stored positions
  assert.equal(plan({ ...g, mode: 'manual', manual: { 'a:1': { x: NaN, y: 1 }, zzz: { x: 1, y: 1 } } }).items[1].manual, false);                                          // junk ignored
});
test('moveItem: clamps, refuses to land on another photo, slides along an axis', () => {
  const r = plan({ groups: [{ id: 'a', w: 35, h: 45, copies: 2 }] });
  assert.deepEqual([moveItem(r, 'a:0', -50, -50).x, moveItem(r, 'a:0', -50, -50).y], [10, 10]);
  assert.deepEqual([moveItem(r, 'a:0', 999, 999).x, moveItem(r, 'a:0', 999, 999).y], [165, 242]);
  const hit = moveItem(r, 'a:1', 20, 10); assert.ok(hit.blocked || (hit.x === 48 && hit.y === 10) || hit.x !== 20);                                                          // on top of a:0: not allowed
  const slide = moveItem(r, 'a:1', 30, 20); assert.equal(slide.y, 20); assert.equal(slide.x, 48); assert.ok(slide.moved);                                                                         // x blocked by a:0, y free: slides
  assert.equal(moveItem(r, 'a:1', 20, 10, { allowOverlap: true }).x, 20); assert.equal(moveItem(r, 'a:1', 20.3, 10, { allowOverlap: true, snap: 0.5 }).x, 20.5);
  assert.equal(moveItem(r, 'nope', 1, 1).ok, false); assert.equal(moveItem(r, 'a:0', NaN, 1).moved, false);
});
test('stats: unused area and per-page free space', () => {
  const r = plan({ groups: [{ w: 35, h: 45, copies: 8 }] }); assert.equal(r.stats.usedArea, 8 * 35 * 45); assert.equal(r.stats.printableArea, 190 * 277);
  assert.ok(Math.abs(r.stats.unusedArea - (190 * 277 - 8 * 35 * 45)) < 1e-6); assert.equal(r.stats.pages[0].freeBottom, 277 - 93); assert.equal(r.stats.pages[0].count, 8);
});
test('never produces NaN/Infinity: fuzz over odd numbers', () => {
  const vals = [0, 0.001, 1, 5, 33.3, 1200, 1e6, -1, NaN, Infinity];
  for (const w of vals) for (const m of [0, 10, 50, 60]) { const r = planLayout(base({ margin: m, groups: [{ w, h: 45, copies: 3 }] })); if (r.ok) r.items.forEach((i) => [i.x, i.y, i.w, i.h].forEach((v) => assert.ok(Number.isFinite(v)))); else assert.equal(typeof r.error, 'string'); }
});
