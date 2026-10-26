import { ImageError } from './errors.js';
import { sniffImage } from './sniff.js';
import { validateFile } from './validate.js';
import { MAX_PIXELS } from './limits.js';
import { parseImageHeader } from './dimensions.js';
import { applyOrientation } from './orient.js';
import { parseHeicHeader, claimsHeic } from './heic.js';
import { peekHeic, decodeHeicPixels } from './heic-decoder.js';

export { MAX_PIXELS };
const SUPPORTED = ['jpeg', 'png', 'webp'];
const FIRST_READ = 64 * 1024;
const MAX_HEADER_SCAN = 8 * 1024 * 1024;   // give up looking for a JPEG frame header after this much metadata

const readPrefix = async (file, n) => new Uint8Array(await file.slice(0, n).arrayBuffer());
const damaged = () => new ImageError('damaged', 'This image looks damaged or incomplete, so it cannot be opened safely.');

const tooBigMsg = (w, h) => 'This image is ' + w + ' × ' + h + ' (' + Math.round((w * h) / 1e6) + ' megapixels), over the ' + MAX_PIXELS / 1e6 + ' megapixel limit.';

/** HEIC: header guard first (no wasm, reads only the meta box); if the header cannot tell, ask the decoder for the size (no pixels). */
async function inspectHeic(file, kind, buf, len) {
  let dims = null;
  for (;;) {
    const r = parseHeicHeader(buf);
    if (r.status === 'ok') { dims = r; break; }
    if (r.status === 'bad') throw new ImageError('heic-invalid', 'This HEIC/HEIF file looks damaged or incomplete, so it cannot be opened safely.');
    if (r.status === 'unknown' || len >= file.size || r.need > MAX_HEADER_SCAN) break;
    len = Math.min(file.size, MAX_HEADER_SCAN, Math.max(r.need, len * 2));
    buf = await readPrefix(file, len);
  }
  if (!dims) dims = await peekHeic(new Uint8Array(await file.arrayBuffer()));   // not cached: queued batch files must not pin their bytes
  if (dims.width * dims.height > MAX_PIXELS) throw new ImageError('too-big', tooBigMsg(dims.width, dims.height));
  return { kind, width: dims.width, height: dims.height, orientation: 1, alpha: false, heic: true };
}

/** Everything we can learn and enforce BEFORE the browser allocates pixels. */
export async function inspectImage(file) {
  validateFile(file);
  let len = Math.min(file.size, FIRST_READ);
  let buf = await readPrefix(file, len);
  const kind = sniffImage(buf);

  if (!kind && claimsHeic(file)) throw new ImageError('heic-invalid', 'This file is named like a HEIC/HEIF photo, but its contents are not a HEIC/HEIF image. It may be damaged or renamed.');
  if (kind && kind.type === 'heic') return inspectHeic(file, kind, buf, len);
  if (!kind) throw new ImageError('unknown', 'This file is not an image Shrinkit can read. Try a JPG, PNG, WEBP or HEIC.');
  if (!SUPPORTED.includes(kind.type)) throw new ImageError('unsupported', kind.type.toUpperCase() + ' is not supported yet. Try a JPG, PNG, or WEBP.');
  if (kind.animated) throw new ImageError('animated', 'Animated images are not supported yet. Only a still frame would be kept.');

  let info;
  for (;;) {
    const r = parseImageHeader(buf, kind.type);
    if (r.status === 'ok') { info = r; break; }
    if (r.status === 'bad' || len >= file.size || r.need > MAX_HEADER_SCAN) throw damaged();
    len = Math.min(file.size, MAX_HEADER_SCAN, Math.max(r.need, len * 2));
    buf = await readPrefix(file, len);
  }
  if (info.width * info.height > MAX_PIXELS) {
    throw new ImageError('too-big', 'This image is ' + info.width + ' × ' + info.height + ' (' + Math.round((info.width * info.height) / 1e6) +
      ' megapixels), over the ' + MAX_PIXELS / 1e6 + ' megapixel limit.');
  }
  return { kind, width: info.width, height: info.height, orientation: info.orientation, alpha: info.alpha };
}

/** Older engines reject the imageOrientation enum (TypeError) or the options bag entirely. */
async function toBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { return await createImageBitmap(file); }
}

/** Decode once into an ImageBitmap that is already upright. Throws ImageError with a user-facing message. */
export async function decodeImage(file) {
  const info = await inspectImage(file);
  if (info.kind.type === 'heic') return decodeHeic(file, info);
  let bitmap;
  try { bitmap = await toBitmap(file); }
  catch (e) { throw new ImageError('decode', 'Could not open this image. It may be damaged, or too large for this browser.'); }

  // Safety net: if the engine ignored EXIF orientation (detectable when it swaps width/height), fix it ourselves.
  const o = info.orientation;
  if (o >= 5 && bitmap.width === info.width && bitmap.height === info.height && info.width !== info.height) {
    try { bitmap = await applyOrientation(bitmap, o); }
    catch (e) { bitmap.close(); throw new ImageError('decode', 'Could not open this image. It may be damaged, or too large for this browser.'); }
  }
  if (bitmap.width * bitmap.height > MAX_PIXELS) {
    bitmap.close();
    throw new ImageError('too-big', 'This image is over the ' + MAX_PIXELS / 1e6 + ' megapixel limit.');
  }
  return { bitmap, width: bitmap.width, height: bitmap.height, kind: info.kind, hasAlpha: info.alpha };
}

/** HEIC → RGBA (already upright: libheif applied irot/imir, EXIF orientation is NOT applied again) → one ImageBitmap. */
async function decodeHeic(file, info) {
  const px = await decodeHeicPixels(new Uint8Array(await file.arrayBuffer()));
  let bitmap;
  try { bitmap = await createImageBitmap(new ImageData(px.data, px.width, px.height)); }
  catch (e) { throw new ImageError('decode', 'Could not open this image. It may be too large for this browser.'); }
  if (bitmap.width * bitmap.height > MAX_PIXELS) { bitmap.close(); throw new ImageError('too-big', 'This image is over the ' + MAX_PIXELS / 1e6 + ' megapixel limit.'); }
  return { bitmap, width: bitmap.width, height: bitmap.height, kind: info.kind, hasAlpha: px.hasAlpha };
}
