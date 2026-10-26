import { ImageError } from './errors.js';
import { MAX_PIXELS } from './limits.js';

/**
 * HEIC/HEIF decoding through libheif-js (WebAssembly, loaded only when a HEIC file is opened).
 * libheif applies irot/imir itself, so the pixels come out upright: EXIF orientation must NOT be applied again.
 * Decodes run one at a time (the wasm heap and RGBA buffer are large); the loader is injectable for tests.
 */
let loader = () => import('libheif-js/libheif-wasm/libheif-bundle.mjs');
let libP = null;
export function setHeicLoader(fn) { loader = fn; libP = null; }

/**
 * The wasm heap only grows, it never shrinks. After a big decode the module (and its heap, ~1x the RGBA size measured in Node)
 * would stay allocated for the rest of the session. So after a decode of this many pixels or more the module is dropped and
 * rebuilt on the next HEIC (measured cost: ~0.25 s extra per decode at 12 MP; small images keep the warm module).
 */
export const HEIC_RELEASE_PIXELS = 16_000_000;
let releaseAbove = HEIC_RELEASE_PIXELS;
export function setHeicReleaseThreshold(n) { releaseAbove = n; }

const unsupported = () => new ImageError('heic-unsupported', 'Could not decode this HEIC/HEIF file. It may be damaged, or use a HEIF variant Shrinkit cannot read (Shrinkit does not claim to support every HEIC/HEIF file).');
const tooBig = (w, h) => new ImageError('too-big', 'This image is ' + w + ' × ' + h + ' (' + Math.round((w * h) / 1e6) + ' megapixels), over the ' + MAX_PIXELS / 1e6 + ' megapixel limit.');

function getLib() {
  if (!libP) {
    libP = loader().then((m) => Promise.resolve((m.default || m)())).then((lib) => {
      if (!lib || !lib.HeifDecoder) throw new Error('bad decoder module');
      return lib;
    });
    libP.catch(() => { libP = null; });   // allow a retry; a crashed module is rebuilt next time
  }
  return libP.catch(() => { throw new ImageError('heic-load', 'The HEIC decoder could not be loaded. Check your connection and reload the page.'); });
}

let chain = Promise.resolve();
const serial = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };

/** Parse the container and return handles to its images. Cheap: no pixels are decoded. */
async function open(bytes) {
  const lib = await getLib();
  let imgs;
  try { imgs = new lib.HeifDecoder().decode(bytes); }
  catch (e) { throw unsupported(); }
  if (!imgs || !imgs.length) throw unsupported();
  const primary = imgs.find((i) => { try { return i.is_primary(); } catch (e) { return false; } }) || imgs[0];
  imgs.forEach((i) => { if (i !== primary) { try { i.free(); } catch (e) { /* ignore */ } } });
  return primary;
}
const free = (img) => { try { img.free(); } catch (e) { /* ignore */ } };

/** Final (upright) size from the decoder, without decoding pixels. */
export function peekHeic(bytes) {
  return serial(async () => {
    const img = await open(bytes);
    try { return { width: img.get_width(), height: img.get_height() }; } finally { free(img); }
  });
}

/** Decode the primary image to RGBA. Size is checked against MAX_PIXELS BEFORE the pixel buffer is allocated. */
export function decodeHeicPixels(bytes) {
  return serial(async () => {
    const img = await open(bytes);
    try {
      const width = img.get_width(), height = img.get_height();
      if (!(width >= 1 && height >= 1)) throw unsupported();
      if (width * height > MAX_PIXELS) throw tooBig(width, height);
      let data;
      try { data = new Uint8ClampedArray(width * height * 4); }
      catch (e) { throw new ImageError('decode', 'Could not open this image. It is too large for this browser.'); }
      const out = { data, width, height };
      const ok = await new Promise((res) => { try { img.display(out, (r) => res(!!r)); } catch (e) { res(false); } });
      if (!ok) { libP = null; throw unsupported(); }   // drop the module: a failed wasm decode may leave it unusable
      let hasAlpha = false;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { hasAlpha = true; break; }
      if (width * height >= releaseAbove) libP = null;   // give the big wasm heap back (see HEIC_RELEASE_PIXELS)
      return { data, width, height, hasAlpha };
    } finally { free(img); }
  });
}
