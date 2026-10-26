import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, sizeDelta } from '../src/core/format.js';
import { sniffImage } from '../src/core/sniff.js';

const pad = (arr, n = 32) => Uint8Array.from([...arr, ...new Array(Math.max(0, n - arr.length)).fill(0)]);
const str = (s) => [...s].map((c) => c.charCodeAt(0));

test('formatBytes', () => {
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
});

test('sizeDelta signed correctly', () => {
  assert.deepEqual(sizeDelta(1000, 400), { pct: 60, smaller: true, magnitude: 60 });
  const bigger = sizeDelta(1000, 1500);
  assert.equal(bigger.smaller, false);
  assert.equal(bigger.magnitude, 50);
});

test('sniff jpeg/png', () => {
  assert.equal(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0])).type, 'jpeg');
  assert.equal(sniffImage(pad([0x89, ...str('PNG'), 0x0d, 0x0a, 0x1a, 0x0a])).type, 'png');
});

test('sniff webp static vs animated', () => {
  const still = pad([...str('RIFF'), 0, 0, 0, 0, ...str('WEBP'), ...str('VP8X'), 0, 0, 0, 0, 0x00]);
  const anim = pad([...str('RIFF'), 0, 0, 0, 0, ...str('WEBP'), ...str('VP8X'), 0, 0, 0, 0, 0x02]);
  assert.equal(sniffImage(still).animated, false);
  assert.equal(sniffImage(anim).animated, true);
});

test('sniff heic, gif, unknown', () => {
  assert.equal(sniffImage(pad([0, 0, 0, 24, ...str('ftyp'), ...str('heic')])).type, 'heic');
  assert.equal(sniffImage(pad(str('GIF89a'))).type, 'gif');
  assert.equal(sniffImage(pad(str('hello world'))), null);
});

import { isHexColor, normalizeHex } from '../src/core/color.js';
import { assertEncodedAs } from '../src/core/verify.js';
import { parseImageHeader } from '../src/core/dimensions.js';

test('color: only #rrggbb passes; anything else falls back (no CSS injection into canvas)', () => {
  assert.equal(isHexColor('#a1B2c3'), true);
  for (const bad of ['red', '#fff', '#12345g', 'url(x)', '#ffffff;', '', null, undefined, 5]) assert.equal(isHexColor(bad), false, String(bad));
  assert.equal(normalizeHex('#AABBCC'), '#aabbcc');
  assert.equal(normalizeHex('javascript:1', '#000000'), '#000000');
});

test('assertEncodedAs: trusts magic bytes, not the blob.type label', async () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  await assertEncodedAs(new Blob([JPG], { type: 'image/jpeg' }), 'image/jpeg');
  await assert.rejects(assertEncodedAs(new Blob([PNG], { type: 'image/webp' }), 'image/webp'), { code: 'format-unsupported' });   // browser emitted PNG for a WEBP request
  await assert.rejects(assertEncodedAs(new Blob([PNG], { type: 'image/png' }), 'image/jpeg'), { code: 'format-unsupported' });    // label matches neither
  await assert.rejects(assertEncodedAs(new Blob([JPG], { type: 'image/png' }), 'image/jpeg'), { code: 'format-unsupported' });    // right bytes, wrong label
});

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const A = (s) => [...s].map((c) => c.charCodeAt(0));
const pngWith = (colorType, chunks = []) => Uint8Array.from([0x89, ...A('PNG'), 13, 10, 26, 10, ...be32(13), ...A('IHDR'), ...be32(10), ...be32(10), 8, colorType, 0, 0, 0, 0, 0, 0, 0,
  ...chunks.flatMap(([t, d]) => [...be32(d.length), ...A(t), ...d, 0, 0, 0, 0]), ...be32(0), ...A('IDAT'), 0, 0, 0, 0]);

test('alpha detection: PNG colour types, tRNS before IDAT, WebP flags', () => {
  assert.equal(parseImageHeader(pngWith(6), 'png').alpha, true);
  assert.equal(parseImageHeader(pngWith(4), 'png').alpha, true);
  assert.equal(parseImageHeader(pngWith(2), 'png').alpha, false);
  assert.equal(parseImageHeader(pngWith(0), 'png').alpha, false);
  assert.equal(parseImageHeader(pngWith(3, [['PLTE', [1, 2, 3]]]), 'png').alpha, false);
  assert.equal(parseImageHeader(pngWith(3, [['PLTE', [1, 2, 3]], ['tRNS', [0]]]), 'png').alpha, true);
  assert.equal(parseImageHeader(pngWith(2, [['tRNS', [0, 0, 0, 0, 0, 0]]]), 'png').alpha, true);
  const head = (tag) => [...A('RIFF'), 100, 0, 0, 0, ...A('WEBP'), ...A(tag), 10, 0, 0, 0];
  const x = (flags) => Uint8Array.from([...head('VP8X'), flags, 0, 0, 0, 9, 0, 0, 9, 0, 0]);
  assert.equal(parseImageHeader(x(0x10), 'webp').alpha, true);
  assert.equal(parseImageHeader(x(0x00), 'webp').alpha, false);
  const l = (alphaBit) => Uint8Array.from([...head('VP8L'), 0x2f, ...[(10 - 1) | ((10 - 1) << 14) | (alphaBit << 28)].flatMap((v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255])]);
  assert.equal(parseImageHeader(l(1), 'webp').alpha, true);
  assert.equal(parseImageHeader(l(0), 'webp').alpha, false);
});
