// Node + REAL libheif-js wasm. Measures decode time and process memory (RSS / external) for the generated HEIC fixtures.
// Usage: node --expose-gc bench/measure-heic.mjs [file ...]   (run bench/make_fixtures.py first)
import fs from 'node:fs';
import { decodeHeicPixels, peekHeic, setHeicLoader } from '../src/core/heic-decoder.js';
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['bench/fixtures/photo12mp.heic', 'bench/fixtures/photo24mp.heic'];
const MB = (n) => Math.round(n / 1048576);
const mem = () => { global.gc && global.gc(); const m = process.memoryUsage(); return { rss: MB(m.rss), ext: MB(m.external + m.arrayBuffers) }; };
const t = async (fn) => { const s = performance.now(); const r = await fn(); return [r, Math.round(performance.now() - s)]; };
const dropModule = process.env.DROP === '1';
console.log('dropModuleAfterDecode =', dropModule, '| node', process.version);
for (const f of files) {
  const bytes = new Uint8Array(fs.readFileSync(f));
  console.log('\n' + f, MB(bytes.length) + ' MB file');
  console.log(' baseline        ', JSON.stringify(mem()));
  const [pk, ms0] = await t(() => peekHeic(bytes));
  console.log(' peek            ', pk.width + 'x' + pk.height, ms0 + ' ms', JSON.stringify(mem()));
  for (let i = 1; i <= 3; i++) {
    let [px, ms] = await t(() => decodeHeicPixels(bytes));
    const during = process.memoryUsage().rss;
    console.log(' decode #' + i + '       ', ms + ' ms', 'rss while pixels alive', MB(during), 'MB');
    px = null;
    if (dropModule) setHeicLoader(() => import('libheif-js/libheif-wasm/libheif-bundle.mjs'));   // resets the cached module: old wasm heap becomes garbage
    console.log('   after release ', JSON.stringify(mem()));
  }
}
