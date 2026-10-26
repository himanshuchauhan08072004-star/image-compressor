import { ImageError } from './errors.js';
import { drawScaled, releaseCanvas, assertCanvasBacked, makeCanvas } from './render.js';
import { encodeCanvas, supportsEncode } from './encode.js';
import { assertEncodedAs } from './verify.js';
import { MAX_OUTPUT_PIXELS } from './limits.js';
import { applyEnhance, enhanceNotes, normalizeEnhance } from './enhance.js';

/** Canvas glue for Smart Enhancement. All the maths lives in core/enhance.js. */
const canvasOf = (w, h) => makeCanvas(w, h, { willReadFrequently: true });

/** The picture reduced for live preview (<= maxSide). Caller releases the canvas. */
export function previewBase(bitmap, maxSide = 1400) {
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height)), w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const { canvas, ctx } = canvasOf(w, h);
  drawScaled(ctx, bitmap, { x: 0, y: 0, w: bitmap.width, h: bitmap.height }, { x: 0, y: 0, w, h });
  return canvas;
}

/** Redraw `out` = base + enhancement (preview resolution). Returns { notes, ms }. */
export function paintEnhance(out, base, params) {
  const p = normalizeEnhance(params), t0 = performance.now(), ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, out.width, out.height); ctx.drawImage(base, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height), res = applyEnhance(img.data, out.width, out.height, p);
  ctx.putImageData(img, 0, 0);
  return { notes: enhanceNotes(p, res), ms: Math.round(performance.now() - t0) };
}

/** Full-resolution result at the picture's own size, encoded as `mime`. Re-encoding drops metadata. Throws ImageError. */
export async function enhanceBitmap(bitmap, params, { mime, quality = 0.92 }) {
  const W = bitmap.width, H = bitmap.height, p = normalizeEnhance(params);
  if (W * H > MAX_OUTPUT_PIXELS) throw new ImageError('too-large', 'This image is ' + Math.round((W * H) / 1e6) + ' MP. Enhancement handles up to ' + MAX_OUTPUT_PIXELS / 1e6 + ' MP. Use Resize to make it smaller first.');
  if (!(await supportsEncode(mime))) throw new ImageError('format-unsupported', (mime === 'image/jpeg' ? 'JPG' : mime.replace('image/', '').toUpperCase()) + ' export is not supported by this browser.');
  const { canvas, ctx } = canvasOf(W, H);
  try {
    if (mime === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, W, H), res = applyEnhance(img.data, W, H, p); ctx.putImageData(img, 0, 0);
    const blob = await encodeCanvas(canvas, { mime, quality });
    await assertEncodedAs(blob, mime);
    return { blob, mime, width: W, height: H, notes: enhanceNotes(p, res) };
  } finally { releaseCanvas(canvas); }
}
