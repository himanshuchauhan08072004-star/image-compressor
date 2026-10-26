import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sniffImage } from '../src/core/sniff.js';
import { parseHeicHeader, keepMime, claimsHeic, isHeic } from '../src/core/heic.js';
import { decodeHeicPixels, peekHeic, setHeicLoader } from '../src/core/heic-decoder.js';
import { buildRecipe, outputMime, outputName, uniqueName, extFor, normalizeSettings, DEFAULT_SETTINGS } from '../src/core/batch.js';
import { createSession } from '../src/app/session.js';

// REAL HEIC files (generated with pillow-heif/libheif; irot.heic has an irot box added by hand). Decoded by the real libheif-js wasm.
const fx = (n) => new Uint8Array(fs.readFileSync(new URL('./fixtures/heic/' + n, import.meta.url)));
const str = (s) => [...s].map((c) => c.charCodeAt(0));
const ftyp = (major, ...compat) => { const t = [...str('ftyp'), ...str(major), 0, 0, 0, 0, ...compat.flatMap(str)]; const n = t.length + 4; return new Uint8Array([0, 0, 0, n, ...t, ...new Array(32).fill(0)]); };

test('sniff: HEIC by major or compatible brand, not by name', () => {
  assert.equal(sniffImage(ftyp('heic')).type, 'heic');
  assert.equal(sniffImage(ftyp('mif1', 'heic')).type, 'heic');
  assert.equal(sniffImage(ftyp('mif1', 'miaf')).type, 'heic');          // generic HEIF: decoder decides
  assert.equal(sniffImage(ftyp('mif1', 'avif')).type, 'avif');          // AVIF stays unsupported
  assert.equal(sniffImage(ftyp('isom', 'mp41')), null);                 // MP4 is not an image
  assert.equal(sniffImage(fx('landscape.heic')).type, 'heic');
  assert.equal(sniffImage(fx('square.heif')).type, 'heic');
});
test('name/MIME hints are only hints', () => {
  assert.ok(claimsHeic({ name: 'IMG_1.HEIC', type: '' }));
  assert.ok(claimsHeic({ name: 'x', type: 'image/heif' }));
  assert.ok(!claimsHeic({ name: 'x.jpg', type: 'image/jpeg' }));
});
test('header parser: size from ispe+clap+irot matches real decode (real files)', async () => {
  for (const [f, w, h] of [['landscape.heic', 64, 48], ['exif6.heic', 64, 48], ['irot.heic', 48, 64], ['alpha.heic', 32, 32], ['square.heif', 40, 40]]) {
    const r = parseHeicHeader(fx(f));
    assert.deepEqual([r.status, r.width, r.height], ['ok', w, h], f);
    const p = await decodeHeicPixels(fx(f));
    assert.deepEqual([p.width, p.height], [w, h], f);
  }
});
test('header parser: truncated, garbage', () => {
  const b = fx('landscape.heic');
  assert.equal(parseHeicHeader(b.slice(0, 20)).status, 'more');
  assert.equal(parseHeicHeader(new Uint8Array([0, 0, 0, 4, 1, 2, 3, 4])).status, 'bad');
  assert.notEqual(parseHeicHeader(ftyp('heic')).status, 'ok');
});
test('REAL decode: pixels upright, orientation not applied twice', async () => {
  const p = await decodeHeicPixels(fx('landscape.heic'));
  assert.deepEqual([...p.data.slice(0, 3)].map((v) => Math.round(v / 10)), [3, 20, 3]);          // top-left green marker
  const last = (p.width * p.height - 1) * 4;
  assert.ok(p.data[last + 2] > 150 && p.data[last] < 80);                                         // bottom-right blue
  assert.equal(p.hasAlpha, false);
  const r = await decodeHeicPixels(fx('irot.heic'));                                              // irot applied once by libheif: 64x48 → 48x64
  assert.deepEqual([r.width, r.height], [48, 64]);
  const e = await decodeHeicPixels(fx('exif6.heic'));                                             // EXIF-only tag is ignored for HEIC (irot is authoritative)
  assert.deepEqual([e.width, e.height], [64, 48]);
});
test('REAL decode: alpha detected', async () => {
  const p = await decodeHeicPixels(fx('alpha.heic'));
  assert.equal(p.hasAlpha, true);
  assert.equal(p.data[3], 255);
  assert.equal(p.data[(p.width - 1) * 4 + 3], 0);
});
test('REAL decode failures give user-facing errors', async () => {
  for (const bad of [new Uint8Array(16), fx('landscape.heic').slice(0, 300), ftyp('heic')]) {
    await assert.rejects(() => decodeHeicPixels(bad), (e) => e.code === 'heic-unsupported' && /HEIC/.test(e.userMessage));
  }
  await assert.rejects(() => peekHeic(new Uint8Array(8)), (e) => e.code === 'heic-unsupported');
  const ok = await decodeHeicPixels(fx('square.heif'));                                           // decoder still usable after failures
  assert.equal(ok.width, 40);
});
test('MOCKED decoder: load failure and display failure (mock, not real HEIC)', async () => {
  setHeicLoader(() => Promise.reject(new Error('net')));
  await assert.rejects(() => decodeHeicPixels(fx('square.heif')), (e) => e.code === 'heic-load');
  const img = { get_width: () => 10, get_height: () => 10, is_primary: () => true, free() { this.freed = true; }, display: (o, cb) => cb(null) };
  setHeicLoader(async () => ({ default: () => ({ HeifDecoder: class { decode() { return [img]; } } }) }));
  await assert.rejects(() => decodeHeicPixels(new Uint8Array(4)), (e) => e.code === 'heic-unsupported');
  assert.ok(img.freed, 'image handle freed');
  const huge = { get_width: () => 20000, get_height: () => 20000, is_primary: () => true, free() {}, display: () => { throw new Error('must not decode'); } };
  setHeicLoader(async () => ({ default: () => ({ HeifDecoder: class { decode() { return [huge]; } } }) }));
  await assert.rejects(() => decodeHeicPixels(new Uint8Array(4)), (e) => e.code === 'too-big');    // size limit enforced before pixels
  setHeicLoader(() => import('libheif-js/libheif-wasm/libheif-bundle.mjs'));
});
test('HEIC "keep format" saves JPG; names, extensions, batch recipe', () => {
  const kind = { type: 'heic', mime: 'image/heic' };
  assert.ok(isHeic(kind)); assert.equal(keepMime(kind), 'image/jpeg'); assert.equal(keepMime({ type: 'png', mime: 'image/png' }), 'image/png');
  const s = normalizeSettings({ ...DEFAULT_SETTINGS, format: 'keep', compress: 'quality' }).settings;
  assert.equal(outputMime(s, kind), 'image/jpeg');
  const r = buildRecipe({ ...s, compress: 'off', strip: true }, { width: 10, height: 10, kind });
  assert.equal(r.strategy, 'canvas'); assert.equal(r.recipe.strip.method, 'reencode'); assert.equal(r.recipe.output.mime, 'image/jpeg');
  assert.ok(r.notes.some((n) => /JPG/.test(n)));
  for (const [fmt, mime, ext] of [['jpeg', 'image/jpeg', 'jpg'], ['png', 'image/png', 'png'], ['webp', 'image/webp', 'webp']]) {
    const o = buildRecipe({ ...s, format: fmt }, { width: 10, height: 10, kind });
    assert.equal(o.recipe.output.mime, mime);
    assert.equal(outputName('IMG_0001.HEIC', mime, 'converted'), 'IMG_0001-converted.' + ext);
  }
  assert.equal(extFor('image/heic'), 'heic');
  const used = new Set();                                                                          // same stem, different original extensions
  assert.deepEqual(['IMG.heic', 'IMG.heif', 'IMG.jpg'].map((n) => uniqueName(outputName(n, 'image/jpeg', 'converted'), used)),
    ['IMG-converted.jpg', 'IMG-converted (2).jpg', 'IMG-converted (3).jpg']);
});
test('session: HEIC gets a separate preview blob and revokes both URLs (stubs)', async () => {
  const urls = [], revoked = [];
  const mk = (kind) => async () => ({ bitmap: { close() {} }, width: 2, height: 2, kind, hasAlpha: false });
  const s = createSession({ decode: mk({ type: 'heic', mime: 'image/heic' }), makePreview: async () => 'PREVIEW', makeUrl: (x) => { urls.push(x); return 'u' + urls.length; }, revokeUrl: (u) => revoked.push(u) });
  await s.loadFile({ name: 'a.heic' });
  assert.deepEqual(urls, ['PREVIEW']); assert.equal(s.getState().recipe.output.mime, 'image/jpeg');
  s.clear(); assert.deepEqual(revoked, ['u1']);
});
