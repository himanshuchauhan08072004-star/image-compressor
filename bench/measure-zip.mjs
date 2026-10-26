// Node. CRC-32 throughput and buildZip time/peak heap for a batch-shaped workload (50 x 4 MB entries = 200 MB of Uint8Array).
// Usage: node --expose-gc bench/measure-zip.mjs
import { crc32, buildZip } from '../src/core/zip.js';
const MB = (n) => Math.round(n / 1048576);
const buf = new Uint8Array(64 * 1024 * 1024);
for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) >>> 24;
const reps = 5, times = [];
for (let r = 0; r < reps; r++) { const s = performance.now(); crc32(buf); times.push(performance.now() - s); }
times.sort((a, b) => a - b);
console.log('crc32 64 MiB: median', Math.round(times[2]), 'ms =', Math.round(64 / (times[2] / 1000)), 'MiB/s  (runs: ' + times.map((t) => Math.round(t)).join(', ') + ')');
console.log('crc32 check value (123456789):', crc32(new TextEncoder().encode('123456789')).toString(16), '(expect cbf43926)');
const entries = Array.from({ length: 50 }, (_, i) => ({ name: 'img-' + i + '.jpg', data: new Blob([buf.subarray(i * 1024, i * 1024 + 4 * 1024 * 1024)]) }));
global.gc && global.gc();
const before = process.memoryUsage().rss;
let peak = before; const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
const s = performance.now();
const zip = await buildZip(entries);
const ms = performance.now() - s; clearInterval(iv);
console.log('buildZip 50 x 4 MiB Blobs:', Math.round(ms), 'ms, zip', MB(zip.size), 'MiB, rss before', MB(before), 'peak sampled', MB(peak), 'MiB');
