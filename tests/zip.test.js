import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { crc32, buildZip, dosDateTime } from '../src/core/zip.js';

const bytes = (s) => new TextEncoder().encode(s);
/** Independent reader: walks the central directory, then each local header. */
async function readZip(blob) {
  const b = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(b.buffer);
  const eocd = b.length - 22; assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  const n = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
  assert.equal(cdOff + cdSize, eocd);
  const out = []; let p = cdOff;
  for (let i = 0; i < n; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), lo = dv.getUint32(p + 42, true), name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
    assert.equal(dv.getUint32(lo, true), 0x04034b50); assert.equal(dv.getUint32(lo + 14, true), crc);
    const ln = dv.getUint16(lo + 26, true), le = dv.getUint16(lo + 28, true), start = lo + 30 + ln + le;
    out.push({ name, flags, method, crc, csize, usize, data: b.subarray(start, start + usize) });
    p += 46 + nl;
  }
  return out;
}

test('crc32 known vectors and chunk continuation', () => {
  assert.equal(crc32(bytes('123456789')), 0xcbf43926);
  assert.equal(crc32(bytes('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(bytes('6789'), crc32(bytes('12345'))), 0xcbf43926);
  if (zlib.crc32) { const r = Uint8Array.from({ length: 5000 }, (_, i) => (i * 31 + 7) & 255); assert.equal(crc32(r), zlib.crc32(r)); }
});
test('buildZip: structure, STORE, UTF-8 names, CRC and bytes round-trip (Blob and Uint8Array input)', async () => {
  const img = Uint8Array.from({ length: 3000 }, (_, i) => (i * 13) & 255);
  const z = await buildZip([{ name: 'a.jpg', data: new Blob([img]) }, { name: 'sub/é ü 日本.png', data: img.subarray(0, 10) }, { name: 'empty.bin', data: new Uint8Array(0) }], { now: new Date(2024, 4, 6, 7, 8, 10) });
  assert.equal(z.type, 'application/zip');
  const e = await readZip(z);
  assert.deepEqual(e.map((x) => x.name), ['a.jpg', 'sub/é ü 日本.png', 'empty.bin']);
  for (const x of e) { assert.equal(x.method, 0); assert.equal(x.csize, x.usize); assert.equal(x.flags & 0x0800, 0x0800); assert.equal(crc32(x.data), x.crc); }
  assert.deepEqual([...e[0].data], [...img]); assert.deepEqual([...e[1].data], [...img.subarray(0, 10)]); assert.equal(e[2].usize, 0);
  if (zlib.crc32) for (const x of e) assert.equal(zlib.crc32(x.data), x.crc);
});
test('buildZip: DOS date/time, empty list, bad names, cancellation', async () => {
  assert.deepEqual(dosDateTime(new Date(2024, 4, 6, 7, 8, 10)), { date: ((2024 - 1980) << 9) | (5 << 5) | 6, time: (7 << 11) | (8 << 5) | 5 });
  assert.equal(dosDateTime(new Date(1970, 0, 1)).date >> 9, 0);
  await assert.rejects(buildZip([]), (e) => e.code === 'zip-empty');
  await assert.rejects(buildZip([{ name: '', data: new Uint8Array(1) }]), (e) => e.code === 'zip-name');
  await assert.rejects(buildZip([{ name: 'x'.repeat(70000), data: new Uint8Array(1) }]), (e) => e.code === 'zip-name');
  await assert.rejects(buildZip([{ name: 'a', data: new Uint8Array(1) }], { isCancelled: () => true }), (e) => e.code === 'zip-cancelled');
});
