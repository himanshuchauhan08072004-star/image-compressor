import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMetadata, stripMetadata, verifyMetadata } from '../src/core/metadata.js';
import { A, cat, has, find, concat, tiff, ascii0, FULL_TIFF, jpeg, png, webp, seg, SOF, SOS, ENTROPY, be16 } from './helpers.js';

const out = (r) => concat(r.parts);
const MARKS = ['TESTMAKER', 'TESTMODEL', 'TESTSOFT', 'TESTARTIST', 'TESTSERIAL', 'TESTMAKERNOTE', 'TESTXMP', 'TESTIPTC', 'TESTCOMMENT', 'TESTMPF', 'TESTTRAIL', 'TESTTEXT', 'TESTPRIV', '2024:01:02'];
const noMarks = (b) => MARKS.every((m) => !has(b, m));

const RICH_JPEG = (o = 6, le = false) => jpeg({ jfif: { tw: 2, th: 2, thumb: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }, exif: FULL_TIFF(o, le), xmp: 'TESTXMP', iptc: 'TESTIPTC', comment: 'TESTCOMMENT', icc: true, mpf: true, adobe: true, trailing: 'TESTTRAIL\xff\xd8\xff\xd9' });

test('JPEG inspect: finds every category, both byte orders', () => {
  for (const le of [false, true]) {
    const r = inspectMetadata(RICH_JPEG(6, le), 'jpeg');
    for (const k of ['gps', 'camera', 'datetime', 'serial', 'person', 'software', 'makernote', 'thumbnail', 'xmp', 'iptc', 'comment', 'icc', 'extra', 'trailing']) assert.ok(r.found.includes(k), `${k} (le=${le}) in ${r.found}`);
    assert.equal(r.orientation, 6);
  }
});

test('JPEG strip: markers gone, picture data byte-identical, rotation kept via an orientation-only EXIF', () => {
  const src = RICH_JPEG(6);
  const r = stripMetadata(src, 'jpeg', { keepIcc: false }), o = out(r);
  assert.ok(noMarks(o), 'a marker string survived');
  assert.ok(!has(o, 'ICC_PROFILE') && !has(o, 'TESTICC') && !has(o, 'MPF'));
  const v = verifyMetadata(o, 'jpeg'); assert.deepEqual(v.remaining, []); assert.equal(v.clean, true); assert.equal(v.orientation, 6);
  assert.equal(r.keptRotationFlag, true);
  const e = find(o, 'Exif'); assert.ok(e > 0); const tags = inspectMetadata(o, 'jpeg'); assert.deepEqual(tags.found, []);   // EXIF holds only orientation
  const sosAt = (b) => { for (let i = 0; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === 0xda) return i; return -1; };
  assert.deepEqual([...o.subarray(sosAt(o))], [...src.subarray(sosAt(src), sosAt(src) + SOS.length + ENTROPY.length + 2)], 'scan data must be untouched');
  assert.deepEqual(o.subarray(o.length - 2), Uint8Array.of(0xff, 0xd9));
  assert.ok(o.length < src.length);
});

test('JPEG strip: keepIcc keeps only the profile; orientation 1 leaves no EXIF; JFIF thumbnail dropped', () => {
  const o = out(stripMetadata(RICH_JPEG(1), 'jpeg', { keepIcc: true }));
  assert.ok(has(o, 'ICC_PROFILE') && noMarks(o) && !has(o, 'Exif'));
  assert.deepEqual(verifyMetadata(o, 'jpeg', { keepIcc: true }).remaining, []);
  assert.equal(verifyMetadata(o, 'jpeg', { keepIcc: false }).clean, false);   // icc counts as leftover when not allowed
  const j = out(stripMetadata(jpeg({ jfif: { tw: 2, th: 2, thumb: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9] } }), 'jpeg'));
  assert.ok(!has(j, '\x09\x09\x09\x09') && j[2] === 0xff && j[3] === 0xe0 && j[4] === 0 && j[5] === 16 && j[18] === 0 && j[19] === 0, 'JFIF kept at 16 bytes, no thumbnail');
});

test('JPEG strip: multi-scan (progressive) files keep every scan; stuffed FF00 / RST / fake D9 inside data do not end the image', () => {
  const src = jpeg({ progressive: true, exif: FULL_TIFF(1), trailing: 'TESTTRAIL' });
  const o = out(stripMetadata(src, 'jpeg'));
  assert.equal(o.filter((x, i) => x === 0xff && o[i + 1] === 0xda).length, 2);
  assert.ok(noMarks(o)); assert.equal(inspectMetadata(o, 'jpeg').found.length, 0);
});

test('JPEG strip: idempotent', () => {
  const once = out(stripMetadata(RICH_JPEG(8), 'jpeg', { keepIcc: true }));
  const twice = out(stripMetadata(once, 'jpeg', { keepIcc: true }));
  assert.deepEqual([...twice], [...once]);
});

test('PNG inspect + strip: text/XMP/eXIf/tIME/private/trailing removed, CRC-bearing image chunks copied verbatim', () => {
  const src = png({ text: 'TESTTEXT', xmp: 'TESTXMP', exif: FULL_TIFF(1), time: true, priv: 'TESTPRIV', icc: true, phys: true, trns: true, trailing: 'TESTTRAIL' });
  const r = inspectMetadata(src, 'png');
  for (const k of ['gps', 'camera', 'text', 'xmp', 'timestamp', 'extra', 'icc', 'trailing']) assert.ok(r.found.includes(k), k + ' in ' + r.found);
  const o = out(stripMetadata(src, 'png', { keepIcc: false }));
  assert.ok(noMarks(o) && !has(o, 'tEXt') && !has(o, 'eXIf') && !has(o, 'tIME') && !has(o, 'iCCP') && !has(o, 'prVT'));
  for (const t of ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'pHYs', 'gAMA']) assert.ok(has(o, t), t + ' kept');
  assert.deepEqual(verifyMetadata(o, 'png').remaining, []);
  assert.deepEqual([...o.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(has(out(stripMetadata(src, 'png', { keepIcc: true })), 'iCCP'));
});

test('PNG: rotation flag refuses lossless (would be lost); animated PNG refused', () => {
  assert.throws(() => stripMetadata(png({ exif: FULL_TIFF(6) }), 'png'), { code: 'orientation' });
  assert.equal(inspectMetadata(png({ exif: FULL_TIFF(6) }), 'png').orientation, 6);
  assert.throws(() => inspectMetadata(png({ actl: true }), 'png'), { code: 'animated' });
});

test('WebP inspect + strip: EXIF/XMP/ICCP/unknown/trailing gone, flags and RIFF size patched, odd-sized chunks ok', () => {
  for (const exifPrefix of [false, true]) {
    const src = webp({ exif: FULL_TIFF(1), xmp: 'TESTXMP', icc: true, alpha: true, extra: 'TESTPRIV!', trailing: 'TESTTRAIL', exifPrefix });
    const r = inspectMetadata(src, 'webp');
    for (const k of ['gps', 'camera', 'xmp', 'icc', 'extra', 'trailing']) assert.ok(r.found.includes(k), `${k} (prefix=${exifPrefix})`);
    const o = out(stripMetadata(src, 'webp', { keepIcc: false }));
    assert.ok(noMarks(o) && !has(o, 'EXIF') && !has(o, 'XMP ') && !has(o, 'ICCP') && !has(o, 'ZZZZ'));
    assert.equal(o[20] & 0x2c, 0, 'EXIF, XMP, ICC flags cleared'); assert.equal(o[20] & 0x10, 0x10, 'alpha flag kept');
    assert.equal(o[4] + (o[5] << 8) + (o[6] << 16) + o[7] * 16777216, o.length - 8, 'RIFF size matches');
    assert.ok(has(o, 'ALPH') && has(o, 'VP8 '));
    assert.deepEqual(verifyMetadata(o, 'webp').remaining, []);
  }
  assert.ok(has(out(stripMetadata(webp({ icc: true }), 'webp', { keepIcc: true })), 'ICCP'));
  const s = webp({ simple: true }); assert.deepEqual([...out(stripMetadata(s, 'webp'))], [...s]);
  assert.throws(() => stripMetadata(webp({ exif: FULL_TIFF(8) }), 'webp'), { code: 'orientation' });
});

test('malformed and truncated files fail safely with ImageError (never a raw exception)', () => {
  const samples = { jpeg: jpeg({ exif: FULL_TIFF(6), xmp: 'TESTXMP', comment: 'TESTCOMMENT' }), png: png({ text: 'TESTTEXT' }), webp: webp({ exif: FULL_TIFF(1) }) };
  for (const [type, good] of Object.entries(samples)) {
    for (const cut of [0, 1, 3, 10, 20, Math.floor(good.length / 2), good.length - 1]) {
      assert.throws(() => stripMetadata(good.subarray(0, cut), type), (e) => e.code === 'damaged' || e.code === 'orientation', `${type} cut ${cut}`);
    }
    assert.throws(() => stripMetadata(Uint8Array.from(A('not an image at all, just text')), type), { code: 'damaged' });
    assert.throws(() => stripMetadata(new Uint8Array(0), type), { code: 'damaged' });
  }
  assert.throws(() => stripMetadata(new Uint8Array(10), 'gif'), { code: 'unsupported' });
  const bad = png({}); bad[8] = 0xff;   // absurd chunk length
  assert.throws(() => stripMetadata(bad, 'png'), { code: 'damaged' });
});

test('mutation fuzz: strip either throws ImageError or yields an inspectable, idempotent file', () => {
  let seed = 987654321; const rnd = (n) => ((seed = (seed * 1664525 + 1013904223) >>> 0) % n);
  const bases = { jpeg: RICH_JPEG(6), png: png({ text: 'TESTTEXT', exif: FULL_TIFF(1), time: true, trailing: 'x' }), webp: webp({ exif: FULL_TIFF(1), xmp: 'TESTXMP', icc: true }) };
  const t0 = Date.now(); let okCount = 0, errCount = 0;
  for (const [type, base] of Object.entries(bases)) {
    for (let i = 0; i < 400; i++) {
      const m = Uint8Array.from(base);
      for (let k = 0, n = 1 + rnd(4); k < n; k++) m[rnd(m.length)] = rnd(256);
      const input = rnd(5) === 0 ? m.subarray(0, rnd(m.length)) : m;
      let r;
      try { r = stripMetadata(input, type, { keepIcc: rnd(2) === 0 }); }
      catch (e) { assert.ok(e.code, `non-ImageError: ${e && e.stack}`); errCount++; continue; }
      okCount++;
      const o = out(r);
      assert.doesNotThrow(() => inspectMetadata(o, type), `${type} output must re-parse`);
      assert.deepEqual([...out(stripMetadata(o, type, { keepIcc: true }))].length <= o.length, true);
    }
  }
  assert.ok(Date.now() - t0 < 5000, 'fuzz too slow');
  console.log('      fuzz:', okCount, 'parsed,', errCount, 'rejected');
});

test('verifyMetadata never overclaims: it lists what is still present', () => {
  const v = verifyMetadata(RICH_JPEG(6), 'jpeg');
  assert.equal(v.clean, false); assert.ok(v.remaining.includes('gps') && v.remaining.includes('trailing'));
  assert.ok(v.checked.includes('gps') && v.checked.includes('xmp') && !v.checked.includes('icc'));
});
