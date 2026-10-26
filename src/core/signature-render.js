import { ImageError } from './errors.js';
import { drawScaled, releaseCanvas, assertCanvasBacked } from './render.js';
import { encodeCanvas, supportsEncode } from './encode.js';
import { assertEncodedAs } from './verify.js';
import {
  PREVIEW_MAX_SIDE, toGray, estimateBackground, bgPlane, processAlpha, detectInk, resolveInk, composeRGBA, exportRegion, planExport, pngDeclaresAlpha,
} from './signature.js';

/** Canvas glue for the Signature Cleaner. All numbers come from core/signature.js; this file only moves pixels in and out of canvases. */
const nextTask = () => new Promise((r) => setTimeout(r, 0));   // let the UI paint between heavy synchronous steps
const Cancelled = () => Object.assign(new Error('cancelled'), { cancelled: true });
export const isCancelled = (e) => !!(e && e.cancelled);

function makeCanvas(w, h, readback = false) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  try {
    const ctx = canvas.getContext('2d', readback ? { willReadFrequently: true } : undefined);
    if (!ctx) throw new ImageError('canvas', 'This image is too large for your browser to process.');
    assertCanvasBacked(canvas, ctx);
    return { canvas, ctx };
  } catch (e) { releaseCanvas(canvas); throw e; }       // a refused canvas must not linger at full size
}

/**
 * Everything the live preview needs, computed once per image: a reduced copy (long side <= PREVIEW_MAX_SIDE), its pixels, grey,
 * and the paper-brightness map. The caller owns `canvas` (the original, reduced) and must releaseCanvas() it.
 */
export function buildPreviewSource(bitmap) {
  const k = Math.min(1, PREVIEW_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const { canvas, ctx } = makeCanvas(w, h, true);
  drawScaled(ctx, bitmap, { x: 0, y: 0, w: bitmap.width, h: bitmap.height }, { x: 0, y: 0, w, h });
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = toGray(rgba, w, h), bg = estimateBackground(gray, w, h);
  return { canvas, w, h, rgba, gray, bg, bgp: bgPlane(bg, { w, h }), srcW: bitmap.width, srcH: bitmap.height };
}

/** Clean the preview copy. Returns the alpha plane and the ink colour the export must reuse so both look the same. */
export function cleanPreview(src, params) {
  const { alpha, specks } = processAlpha(src.gray, src.bgp, src.w, src.h, params, src.w * src.h);
  const detected = detectInk(src.rgba, alpha);
  return { alpha, specks, detected, ink: resolveInk(params, detected) };
}

/** Paint a cleaned alpha plane onto a canvas: 'transparent' keeps the alpha channel, 'white' composites onto white. */
export function paintClean(canvas, alpha, ink, mode) {
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(composeRGBA(alpha, ink, mode), canvas.width, canvas.height), 0, 0);
}

/**
 * Read the produced file back and report what is really in it (not what we meant to write):
 * does the PNG header declare alpha, and what share of pixels is not fully opaque (sampled at <= 1024 px, nearest neighbour).
 */
export async function inspectTransparency(blob) {
  const header = pngDeclaresAlpha(new Uint8Array(await blob.slice(0, 4096).arrayBuffer()));
  const bm = await createImageBitmap(blob);
  let c = null;
  try {
    const k = Math.min(1, 1024 / Math.max(bm.width, bm.height)), w = Math.max(1, Math.round(bm.width * k)), h = Math.max(1, Math.round(bm.height * k));
    const made = makeCanvas(w, h, true); c = made.canvas;
    made.ctx.imageSmoothingEnabled = false;
    made.ctx.drawImage(bm, 0, 0, w, h);
    const d = made.ctx.getImageData(0, 0, w, h).data;
    let clear = 0, partial = 0, solid = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] === 0) clear++; else if (d[i] < 255) partial++; else solid++; }
    const total = w * h;
    return { header, clearPct: (clear / total) * 100, partialPct: (partial / total) * 100, solidPct: (solid / total) * 100, hasTransparency: header && clear + partial > 0 };
  } finally { bm.close(); if (c) releaseCanvas(c); }
}

/**
 * Process the chosen crop at full detail (bounded by WORK_MAX_PIXELS) and write the file.
 *   bitmap: the upright decoded image.  bg: estimateBackground() result from the preview.  ink: [r,g,b] from cleanPreview().
 *   crop: source-pixel rect or null (whole image).  output: { format: 'transparent'|'white-png'|'white-jpg', pad, size }.
 * Resolves { blob, width, height, mime, report }. Throws ImageError (user-facing) or a cancellation (see isCancelled).
 */
export async function exportSignature({ bitmap, bg, params, ink, crop, output, stale = () => false }) {
  const srcW = bitmap.width, srcH = bitmap.height;
  const region = exportRegion(crop || { x: 0, y: 0, w: srcW, h: srcH }, srcW, srcH), { src, tw, th, k } = region;
  const planned = planExport({ w: src.w, h: src.h }, output);
  if (!planned.ok) throw new ImageError('plan', planned.error.message);
  const { plan } = planned, transparent = output.format === 'transparent', mime = output.format === 'white-jpg' ? 'image/jpeg' : 'image/png';
  if (!(await supportsEncode(mime))) throw new ImageError('format-unsupported', (mime === 'image/png' ? 'PNG' : 'JPG') + ' export is not supported by this browser.');
  const check = () => { if (stale()) throw Cancelled(); };
  await nextTask(); check();

  let pixels = null, workCanvas = null, cleaned = null, final = null;
  try {
    const w = makeCanvas(tw, th, true); workCanvas = w.canvas;
    drawScaled(w.ctx, bitmap, src, { x: 0, y: 0, w: tw, h: th });
    pixels = w.ctx.getImageData(0, 0, tw, th).data;
    releaseCanvas(workCanvas); workCanvas = null;
    await nextTask(); check();

    const gray = toGray(pixels, tw, th); pixels = null;
    const bgp = bgPlane(bg, { w: tw, h: th, u0: src.x / srcW, v0: src.y / srcH, u1: (src.x + src.w) / srcW, v1: (src.y + src.h) / srcH });
    const { alpha, specks } = processAlpha(gray, bgp, tw, th, params, srcW * srcH * k * k);
    const rgba = composeRGBA(alpha, ink, transparent ? 'transparent' : 'white');
    const c = makeCanvas(tw, th); cleaned = c.canvas;
    c.ctx.putImageData(new ImageData(rgba, tw, th), 0, 0);
    await nextTask(); check();

    const f = makeCanvas(plan.W, plan.H); final = f.canvas;
    if (!transparent) { f.ctx.fillStyle = '#ffffff'; f.ctx.fillRect(0, 0, plan.W, plan.H); }
    drawScaled(f.ctx, cleaned, { x: 0, y: 0, w: tw, h: th }, plan.dst);
    releaseCanvas(cleaned); cleaned = null;
    check();

    const blob = await encodeCanvas(final, { mime, quality: 0.92 });
    releaseCanvas(final); final = null;
    await assertEncodedAs(blob, mime);
    check();
    const report = { format: output.format, plan, region: { w: src.w, h: src.h, processedW: tw, processedH: th, reduced: k < 1 }, specks, alpha: transparent ? await inspectTransparency(blob) : null };
    return { blob, width: plan.W, height: plan.H, mime, report };
  } finally {
    for (const c of [workCanvas, cleaned, final]) if (c) releaseCanvas(c);
  }
}
