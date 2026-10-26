import test from 'node:test';
import assert from 'node:assert/strict';
import { PAPERS, resolvePaper, pageSize, toMm, fromMm, paperPoints, PAPER_MIN_MM, PAPER_MAX_MM } from '../src/core/paper.js';

test('standard paper dimensions', () => {
  assert.deepEqual([PAPERS.A4.w, PAPERS.A4.h], [210, 297]);
  assert.deepEqual([PAPERS.A5.w, PAPERS.A5.h], [148, 210]);
  assert.deepEqual([PAPERS.LETTER.w, PAPERS.LETTER.h], [215.9, 279.4]);
});
test('portrait and landscape: short side is the width, landscape swaps', () => {
  const a4 = resolvePaper('A4').paper;
  assert.deepEqual(pageSize(a4, false), { w: 210, h: 297 });
  assert.deepEqual(pageSize(a4, true), { w: 297, h: 210 });
  const c = resolvePaper({ key: 'CUSTOM', w: 300, h: 200, unit: 'mm' }).paper;             // entered "wide": portrait is still narrow-side-first
  assert.deepEqual(pageSize(c, false), { w: 200, h: 300 });
  assert.deepEqual(pageSize(c, true), { w: 300, h: 200 });
});
test('unit conversion is exact enough for print', () => {
  assert.equal(toMm(1, 'in'), 25.4); assert.equal(toMm(8.5, 'in'), 215.9); assert.equal(toMm(11, 'in'), 279.4);
  assert.equal(fromMm(25.4, 'in'), 1); assert.equal(fromMm(210, 'mm'), 210);
  assert.ok(Math.abs(fromMm(toMm(3.37, 'in'), 'in') - 3.37) < 1e-9);
});
test('Letter is exactly 612 x 792 pt, A4 is 595.276 x 841.89 pt', () => {
  const l = paperPoints(pageSize(PAPERS.LETTER)), a = paperPoints(pageSize(PAPERS.A4));
  assert.ok(Math.abs(l.w - 612) < 1e-9 && Math.abs(l.h - 792) < 1e-9);
  assert.ok(Math.abs(a.w - 595.2756) < 1e-3 && Math.abs(a.h - 841.8898) < 1e-3);
});
test('custom paper: mm and inches', () => {
  const mm = resolvePaper({ key: 'CUSTOM', w: 100, h: 150, unit: 'mm' }); assert.ok(mm.ok); assert.deepEqual([mm.paper.w, mm.paper.h], [100, 150]);
  const inch = resolvePaper({ key: 'CUSTOM', w: 4, h: 6, unit: 'in' }); assert.ok(inch.ok); assert.deepEqual([inch.paper.w, inch.paper.h], [101.6, 152.4]);
  assert.equal(resolvePaper({ key: 'CUSTOM', w: 100, h: 150 }).paper.w, 100);   // unit defaults to mm
});
test('custom paper validation: zero, negative, NaN, text, too small, too large, unknown unit/key', () => {
  const bad = (p) => assert.equal(resolvePaper(p).ok, false, JSON.stringify(p));
  bad({ key: 'CUSTOM', w: 0, h: 100 }); bad({ key: 'CUSTOM', w: -5, h: 100 }); bad({ key: 'CUSTOM', w: NaN, h: 100 }); bad({ key: 'CUSTOM', w: '100', h: 100 }); bad({ key: 'CUSTOM', w: Infinity, h: 100 });
  bad({ key: 'CUSTOM', w: PAPER_MIN_MM - 1, h: 100 }); bad({ key: 'CUSTOM', w: 100, h: PAPER_MAX_MM + 1 }); bad({ key: 'CUSTOM', w: 100, h: 100, unit: 'cm' });
  bad({ key: 'B9' }); bad(null); bad(undefined); bad({});
  assert.ok(resolvePaper({ key: 'CUSTOM', w: PAPER_MIN_MM, h: PAPER_MAX_MM }).ok);          // boundaries are allowed
  assert.match(resolvePaper({ key: 'CUSTOM', w: 0, h: 5 }).error, /greater than zero/);
  assert.match(resolvePaper({ key: 'CUSTOM', w: 5000, h: 5 }, 'x').error || resolvePaper({ key: 'CUSTOM', w: 5000, h: 100 }).error, /between/);
});
test('limit message follows the chosen unit', () => {
  assert.match(resolvePaper({ key: 'CUSTOM', w: 100, h: 100, unit: 'in' }).error, /in\./);
});
