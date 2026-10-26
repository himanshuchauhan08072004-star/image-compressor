import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseImageHeader } from '../src/core/dimensions.js';
import { orientationTransform } from '../src/core/orient.js';

const A = (s) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n) => [(n >> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >> 8) & 255];
const le32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const U = (...parts) => Uint8Array.from(parts.flat());

const png = (w, h) => U([0x89, ...A('PNG'), 13, 10, 26, 10], be32(13), A('IHDR'), be32(w), be32(h), [8, 6, 0, 0, 0]);
const exif = (o, le) => {
  const w16 = le ? le16 : be16, w32 = le ? le32 : (n) => be32(n);
  const tiff = [...(le ? A('II') : A('MM')), ...w16(42), ...w32(8), ...w16(1), ...w16(0x0112), ...w16(3), ...w32(1), ...w16(o), 0, 0, ...w32(0)];
  const data = [...A('Exif'), 0, 0, ...tiff];
  return [0xff, 0xe1, ...be16(data.length + 2), ...data];
};
const sof = (w, h, m = 0xc0) => [0xff, m, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
const jpeg = (...segs) => U([0xff, 0xd8], ...segs);

test('PNG: dims, huge values stay unsigned, truncated asks for more, bad IHDR rejected', () => {
  assert.deepEqual(parseImageHeader(png(800, 600), 'png'), { status: 'ok', width: 800, height: 600, orientation: 1, alpha: true });
  assert.equal(parseImageHeader(png(60000, 60000), 'png').width, 60000);
  assert.equal(parseImageHeader(png(4000000000, 3), 'png').width, 4000000000);
  assert.equal(parseImageHeader(png(800, 600).slice(0, 18), 'png').status, 'more');
  assert.equal(parseImageHeader(png(0, 600), 'png').status, 'bad');
  const x = png(10, 10); x[12] = 0x58; assert.equal(parseImageHeader(x, 'png').status, 'bad');
});

test('JPEG: baseline, progressive, fill bytes, other markers before SOF', () => {
  assert.equal(parseImageHeader(jpeg(sof(4000, 3000)), 'jpeg').width, 4000);
  assert.equal(parseImageHeader(jpeg(sof(1200, 800, 0xc2)), 'jpeg').height, 800);
  assert.equal(parseImageHeader(jpeg([0xff, 0xff], [0xff, 0xe0, 0, 4, 0, 0], sof(10, 20)), 'jpeg').height, 20);
  const dht = [0xff, 0xc4, ...be16(4), 0, 0];   // DHT (C4) must NOT be mistaken for a frame header
  assert.equal(parseImageHeader(jpeg(dht, sof(33, 44)), 'jpeg').width, 33);
});

test('JPEG: EXIF orientation both byte orders; ignores invalid; non-Exif APP1 skipped', () => {
  assert.equal(parseImageHeader(jpeg(exif(6, true), sof(2000, 1500)), 'jpeg').orientation, 6);
  assert.equal(parseImageHeader(jpeg(exif(8, false), sof(2000, 1500)), 'jpeg').orientation, 8);
  assert.equal(parseImageHeader(jpeg(exif(9, true), sof(2000, 1500)), 'jpeg').orientation, 1);
  const xmp = [0xff, 0xe1, ...be16(2 + 11), ...A('http://ns.a')];
  assert.equal(parseImageHeader(jpeg(xmp, sof(5, 5)), 'jpeg').width, 5);
});

test('JPEG: huge metadata before SOF asks for more bytes, then succeeds', () => {
  const big = [0xff, 0xe2, ...be16(60000), ...new Array(59998).fill(0)];
  const full = jpeg(big, big, big, sof(777, 555));
  let r = parseImageHeader(full.slice(0, 65536), 'jpeg');
  assert.equal(r.status, 'more');
  r = parseImageHeader(full.slice(0, r.need), 'jpeg');
  while (r.status === 'more') r = parseImageHeader(full.slice(0, r.need), 'jpeg');
  assert.deepEqual([r.status, r.width, r.height], ['ok', 777, 555]);
});

test('JPEG: malformed inputs rejected, never loop forever', () => {
  assert.equal(parseImageHeader(jpeg([0x00, 0x11, 0x22, 0x33]), 'jpeg').status, 'bad');
  assert.equal(parseImageHeader(jpeg([0xff, 0xda, 0, 2, 0, 0]), 'jpeg').status, 'bad');       // SOS before SOF
  assert.equal(parseImageHeader(jpeg([0xff, 0xe0, 0, 1, 0, 0]), 'jpeg').status, 'bad');       // length < 2
  assert.equal(parseImageHeader(jpeg(sof(0, 10)), 'jpeg').status, 'bad');
  assert.equal(parseImageHeader(jpeg(sof(10, 10)).slice(0, 8), 'jpeg').status, 'more');
});

test('WebP: VP8X, lossy VP8, lossless VP8L', () => {
  const head = (tag, size) => [...A('RIFF'), ...le32(100), ...A('WEBP'), ...A(tag), ...le32(size)];
  const x = U(head('VP8X', 10), [0, 0, 0, 0], [(4000 - 1) & 255, ((4000 - 1) >> 8) & 255, 0], [(3000 - 1) & 255, ((3000 - 1) >> 8) & 255, 0]);
  assert.deepEqual([parseImageHeader(x, 'webp').width, parseImageHeader(x, 'webp').height], [4000, 3000]);
  const l = U(head('VP8 ', 10), [0, 0, 0], [0x9d, 0x01, 0x2a], le16(640), le16(480));
  assert.deepEqual([parseImageHeader(l, 'webp').width, parseImageHeader(l, 'webp').height], [640, 480]);
  const bits = ((321 - 1) | ((123 - 1) << 14)) >>> 0;
  const ll = U(head('VP8L', 10), [0x2f], le32(bits));
  assert.deepEqual([parseImageHeader(ll, 'webp').width, parseImageHeader(ll, 'webp').height], [321, 123]);
  assert.equal(parseImageHeader(U(head('VP8 ', 10), [0, 0, 0], [1, 2, 3], le16(1), le16(1)), 'webp').status, 'bad');
  assert.equal(parseImageHeader(U(head('JUNK', 10), new Array(20).fill(0)), 'webp').status, 'bad');
});

test('real fixtures agree with PIL (skipped if fixtures not generated)', { skip: !fs.existsSync('tests/e2e/fixtures/photo.jpg') }, () => {
  const rd = (n) => new Uint8Array(fs.readFileSync('tests/e2e/fixtures/' + n));
  const cases = [['photo.jpg', 'jpeg', 3000, 2000, 1], ['prog.jpg', 'jpeg', 1200, 800, 1], ['rotated.jpg', 'jpeg', 2000, 1500, 6], ['alpha.png', 'png', 800, 600, 1], ['huge.png', 'png', 11000, 10000, 1]];
  for (const [n, t, w, h, o] of cases) {
    let buf = rd(n).subarray(0, 65536), r = parseImageHeader(buf, t);
    assert.deepEqual([r.status, r.width, r.height, r.orientation], ['ok', w, h, o], n);
  }
  const bm = rd('bigmeta.jpg'); let len = 65536, r = parseImageHeader(bm.subarray(0, len), 'jpeg');
  while (r.status === 'more') { len = Math.max(r.need, len * 2); r = parseImageHeader(bm.subarray(0, len), 'jpeg'); }
  assert.deepEqual([r.status, r.width, r.height], ['ok', 1200, 800]);
  assert.equal(parseImageHeader(rd('anim.webp').subarray(0, 65536), 'webp').width, 64);
});

test('orientation transforms: corners land where EXIF says', () => {
  const map = (o, x, y, w = 4, h = 2) => { const t = orientationTransform(o, w, h), [a, b, c, d, e, f] = t.m; return [a * x + c * y + e, b * x + d * y + f, t.width, t.height]; };
  assert.deepEqual(map(1, 0, 0), [0, 0, 4, 2]);
  assert.deepEqual(map(3, 0, 0), [4, 2, 4, 2]);        // 180
  assert.deepEqual(map(6, 0, 0), [2, 0, 2, 4]);        // 90 CW: top-left -> top-right
  assert.deepEqual(map(8, 0, 0), [0, 4, 2, 4]);        // 90 CCW: top-left -> bottom-left
  assert.deepEqual(map(2, 0, 0), [4, 0, 4, 2]);        // mirror
  assert.deepEqual(map(5, 4, 0), [0, 4, 2, 4]);        // transpose
  assert.deepEqual(map(7, 0, 0), [2, 4, 2, 4]);        // transverse
  for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {          // every transform stays inside its output box
    for (const [x, y] of [[0, 0], [4, 0], [0, 2], [4, 2]]) {
      const [px, py, W, H] = map(o, x, y); assert.ok(px >= 0 && px <= W && py >= 0 && py <= H, `o${o} (${x},${y}) -> ${px},${py}`);
    }
  }
});
