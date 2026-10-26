import { ImageError } from './errors.js';
import { drawScaled, releaseCanvas, assertCanvasBacked, makeCanvas } from './render.js';
import { encodeCanvas, supportsEncode } from './encode.js';
import { assertEncodedAs } from './verify.js';
import { MAX_OUTPUT_PIXELS } from './limits.js';
import { MAX_WORK_PIXELS, cutOut, backgroundNotes, normalizeBackground } from './background.js';

/** Canvas glue for Background Remover. All the maths lives in core/background.js. */
const canvasOf = (w, h) => makeCanvas(w, h, { willReadFrequently: true });
export { previewBase } from './enhance-render.js';

/** Redraw `out` = cut-out of `base` (preview resolution). Returns { notes, ms, removed, coverage }. */
export function paintCutout(out, base, params, bg) {
  const p = normalizeBackground(params), t0 = performance.now(), ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, out.width, out.height); ctx.drawImage(base, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height), res = cutOut(img.data, out.width, out.height, p, bg);
  ctx.putImageData(img, 0, 0);
  return { notes: backgroundNotes(p, res), ms: Math.round(performance.now() - t0), removed: res.removed, coverage: res.coverage, colors: res.colors };
}

/** The colour of one pixel of the preview base, [r,g,b] or null when transparent. */
export function pixelAt(base, x, y) {
  const d = base.getContext('2d', { willReadFrequently: true }).getImageData(Math.min(base.width - 1, Math.max(0, x)), Math.min(base.height - 1, Math.max(0, y)), 1, 1).data;
  return d[3] < 128 ? null : [d[0], d[1], d[2]];
}

/**
 * Full-size result. Pictures over 12 MP are reduced to 12 MP first (reported in `reduced`). JPG cannot be transparent, so it
 * is always filled (white unless the user chose a colour). Throws ImageError with a user-facing message.
 */
export async function cutOutBitmap(bitmap, params, bg, { mime, quality = 0.92 }) {
  const sw = bitmap.width, sh = bitmap.height;
  if (sw * sh > MAX_OUTPUT_PIXELS) throw new ImageError('too-large', 'This image is ' + Math.round((sw * sh) / 1e6) + ' MP. The background remover handles up to ' + MAX_OUTPUT_PIXELS / 1e6 + ' MP. Use Resize to make it smaller first.');
  if (!(await supportsEncode(mime))) throw new ImageError('format-unsupported', (mime === 'image/jpeg' ? 'JPG' : mime.replace('image/', '').toUpperCase()) + ' export is not supported by this browser.');
  const k = Math.min(1, Math.sqrt(MAX_WORK_PIXELS / (sw * sh))), W = k < 1 ? Math.max(1, Math.floor(sw * k)) : sw, H = k < 1 ? Math.max(1, Math.floor(sh * k)) : sh, reduced = W !== sw || H !== sh;
  let p = normalizeBackground(params); if (mime === 'image/jpeg' && p.fill === 'transparent') p = { ...p, fill: 'white' };
  const { canvas, ctx } = canvasOf(W, H);
  try {
    drawScaled(ctx, bitmap, { x: 0, y: 0, w: sw, h: sh }, { x: 0, y: 0, w: W, h: H });
    const img = ctx.getImageData(0, 0, W, H), res = cutOut(img.data, W, H, p, bg); ctx.putImageData(img, 0, 0);
    const blob = await encodeCanvas(canvas, { mime, quality });
    await assertEncodedAs(blob, mime);
    return { blob, mime, width: W, height: H, reduced, from: [sw, sh], notes: backgroundNotes(p, res), removed: res.removed, transparent: p.fill === 'transparent' };
  } finally { releaseCanvas(canvas); }
}
