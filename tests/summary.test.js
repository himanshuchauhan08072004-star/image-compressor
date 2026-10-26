import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/core/summary.js';

const base = { width: 800, height: 600, mime: 'image/jpeg', hasGeometryEdits: false };

test('quality mode label', () => {
  const s = summarize({ ...base, fileSize: 1000, blob: { size: 400 }, report: { mode: 'quality', quality: 70 } });
  assert.equal(s.label, 'JPG · quality 70%'); assert.equal(s.savedText, '−60% smaller'); assert.equal(s.statSaved, '−60%');
});
test('png is lossless, larger output shows +', () => {
  const s = summarize({ ...base, mime: 'image/png', fileSize: 1000, blob: { size: 1500 }, report: { mode: 'quality', quality: 70 } });
  assert.equal(s.label, 'PNG · lossless'); assert.equal(s.statSaved, '+50%'); assert.match(s.savedText, /no reduction/);
});
test('target reached with scaling explains itself', () => {
  const s = summarize({ ...base, fileSize: 900000, blob: { size: 48000 }, report: { mode: 'target', targetBytes: 51200, reached: true, quality: 0.6, scale: 0.5 } });
  assert.match(s.label, /target 50\.0 KB/); assert.match(s.label, /scaled to 50%/); assert.equal(s.notes.length, 1);
});
test('target impossible is explained, not an error', () => {
  const s = summarize({ ...base, fileSize: 900000, blob: { size: 9000 }, report: { mode: 'target', targetBytes: 1024, reached: false, quality: 0.5, scale: 0.05 } });
  assert.match(s.notes[0], /Could not get under 1\.0 KB/); assert.match(s.notes[0], /WEBP/);
});
test('already under target note only without geometry edits', () => {
  const r = { mode: 'target', targetBytes: 500000, reached: true, quality: 0.92, scale: 1 };
  assert.equal(summarize({ ...base, fileSize: 100000, blob: { size: 90000 }, report: r }).notes.length, 1);
  assert.equal(summarize({ ...base, hasGeometryEdits: true, fileSize: 100000, blob: { size: 90000 }, report: r }).notes.length, 0);
});

test('lossless strip: lists what was removed, checked categories only when clean, never says everything is gone', () => {
  const verify = { clean: true, remaining: [], checked: ['gps', 'camera'], keptIcc: true };
  const s = summarize({ ...base, fileSize: 1000, blob: { size: 900 }, report: { mode: 'strip', method: 'lossless', removed: ['gps', 'camera'], verify, keptRotationFlag: true } });
  const t = s.notes.join(' | ');
  assert.match(s.label, /lossless clean-up/);
  assert.match(t, /Removed from the file: GPS location; Camera/); assert.match(t, /Checked the new file for: GPS location; Camera.*None found/);
  assert.match(t, /rotation flag/); assert.match(t, /colour profile/);
  assert.doesNotMatch(t, /all metadata|everything/i);
});
test('strip: leftovers are reported, no \"none found\" claim', () => {
  const verify = { clean: false, remaining: ['xmp'], checked: ['xmp'], keptIcc: false };
  const t = summarize({ ...base, fileSize: 1000, blob: { size: 900 }, report: { mode: 'strip', method: 'lossless', removed: [], verify } }).notes.join(' | ');
  assert.match(t, /Still present in the new file: XMP/); assert.doesNotMatch(t, /None found/);
});
test('rebuild: says it was redrawn; verify failure is admitted', () => {
  const t = summarize({ ...base, fileSize: 1000, blob: { size: 400 }, report: { mode: 'quality', quality: 70, rebuilt: true, verifyError: true } }).notes.join(' | ');
  assert.match(t, /redrawn/); assert.match(t, /do not assume it is clean/);
});
test('regions note', () => {
  assert.match(summarize({ ...base, fileSize: 1000, blob: { size: 400 }, report: { mode: 'quality', quality: 70, regions: 2 } }).notes.join(' '), /2 regions were/);
});
test('rebuild with a colour profile: reported as present, not as a leak', () => {
  const t = summarize({ ...base, fileSize: 1000, blob: { size: 400 }, report: { mode: 'quality', quality: 70, rebuilt: true, verify: { clean: true, remaining: [], checked: ['gps'], keptIcc: true } } }).notes.join(' | ');
  assert.match(t, /None found/); assert.match(t, /contains a colour profile/); assert.doesNotMatch(t, /Still present/);
});
