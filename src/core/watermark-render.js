import { ImageError } from './errors.js';
import { drawScaled, releaseCanvas, assertCanvasBacked, makeCanvas } from './render.js';
import { encodeCanvas, supportsEncode } from './encode.js';
import { assertEncodedAs } from './verify.js';
import { MAX_OUTPUT_PIXELS } from './limits.js';
import { FONTS, LOGO_MAX_SIDE, markDims, planMarks, planNotes, contrastColor, hasContent } from './watermark.js';

/** Canvas glue for Watermark Studio. All placement maths lives in core/watermark.js. */
const REF = 100;   // text is laid out at 100 px, then scaled to the final mark size

const canvasOf = (w, h) => makeCanvas(w, h, undefined);

/** A logo as a canvas, reduced (never enlarged) to LOGO_MAX_SIDE. Caller releases `.canvas`. */
export function prepareLogo(bitmap, name = 'logo') {
  const k = Math.min(1, LOGO_MAX_SIDE / Math.max(bitmap.width, bitmap.height)), w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const { canvas, ctx } = canvasOf(w, h);
  drawScaled(ctx, bitmap, { x: 0, y: 0, w: bitmap.width, h: bitmap.height }, { x: 0, y: 0, w, h });
  return { canvas, w, h, naturalW: bitmap.width, name };
}

/** Draw the mark once at its final pixel size. null when there is nothing to draw. */
export function makeMark(wm, imgW, logo) {
  if (!hasContent(wm, !!logo)) return null;
  if (wm.type === 'logo') {
    const { w, h } = markDims(imgW, logo.w / logo.h, wm), { canvas, ctx } = canvasOf(w, h);
    drawScaled(ctx, logo.canvas, { x: 0, y: 0, w: logo.w, h: logo.h }, { x: 0, y: 0, w, h });
    return { canvas, w, h, logoScale: w / logo.naturalW };
  }
  const lines = wm.text.split('\n').filter((l) => l.length), font = (wm.bold ? '700 ' : '400 ') + REF + 'px ' + FONTS[wm.font].stack;
  const probeC = canvasOf(1, 1), probe = probeC.ctx; probe.font = font;
  const pad = REF * (wm.outline ? 0.1 : 0.05), lineH = REF * 1.2;
  let textW; try { textW = Math.max(...lines.map((l) => probe.measureText(l).width)); } finally { releaseCanvas(probeC.canvas); }   // the 1x1 measuring canvas is not kept
  const cw = textW + 2 * pad, ch = lines.length * lineH + 2 * pad;
  const { w, h } = markDims(imgW, cw / ch, wm), { canvas, ctx } = canvasOf(w, h);
  ctx.scale(w / cw, h / ch); ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  lines.forEach((l, i) => {
    const y = pad + lineH * (i + 0.5);
    if (wm.outline) { ctx.lineWidth = REF * 0.16; ctx.strokeStyle = contrastColor(wm.color); ctx.strokeText(l, cw / 2, y); }
    ctx.fillStyle = wm.color; ctx.fillText(l, cw / 2, y);
  });
  return { canvas, w, h, logoScale: 1 };
}

/**
 * Stamp the watermark onto ctx (an imgW x imgH canvas that already holds the picture).
 * Returns { empty } when there is nothing to draw, { error } when the layout is refused, else { plan, notes }.
 */
export function stampWatermark(ctx, imgW, imgH, wm, logo) {
  const mark = makeMark(wm, imgW, logo);
  if (!mark) return { empty: true, notes: [] };
  try {
    const plan = planMarks(imgW, imgH, mark.w, mark.h, wm);
    if (!plan.ok) return { error: plan.error, notes: [] };
    ctx.save(); ctx.globalAlpha = wm.opacity / 100; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    for (const m of plan.marks) { ctx.setTransform(1, 0, 0, 1, m.x, m.y); ctx.rotate(plan.angle); ctx.drawImage(mark.canvas, -mark.w / 2, -mark.h / 2, mark.w, mark.h); }
    ctx.restore();
    return { plan, notes: planNotes(wm, plan, { markW: mark.w, logoScale: mark.logoScale }) };
  } finally { releaseCanvas(mark.canvas); }
}

/** The picture reduced for live preview (<= maxSide). Caller releases the canvas. */
export function previewBase(bitmap, maxSide = 1400) {
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height)), w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const { canvas, ctx } = canvasOf(w, h);
  drawScaled(ctx, bitmap, { x: 0, y: 0, w: bitmap.width, h: bitmap.height }, { x: 0, y: 0, w, h });
  return canvas;
}

/** Redraw `out` = base + watermark (preview resolution). */
export function paintPreview(out, base, wm, logo) {
  const ctx = out.getContext('2d'); ctx.clearRect(0, 0, out.width, out.height); ctx.drawImage(base, 0, 0);
  return stampWatermark(ctx, out.width, out.height, wm, logo);
}

/**
 * Full-resolution result: the picture at its own size (no resize) with the watermark, encoded as `mime`.
 * Re-encoding drops metadata (camera, location). Throws ImageError with a user-facing message.
 */
export async function watermarkBitmap(bitmap, wm, logo, { mime, quality = 0.92 }) {
  const W = bitmap.width, H = bitmap.height;
  if (W * H > MAX_OUTPUT_PIXELS) throw new ImageError('too-large', 'This image is ' + Math.round((W * H) / 1e6) + ' MP. Watermarking handles up to ' + MAX_OUTPUT_PIXELS / 1e6 + ' MP. Use Resize to make it smaller first.');
  if (!(await supportsEncode(mime))) throw new ImageError('format-unsupported', (mime === 'image/jpeg' ? 'JPG' : mime.replace('image/', '').toUpperCase()) + ' export is not supported by this browser.');
  const { canvas, ctx } = canvasOf(W, H);
  try {
    if (mime === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }   // JPG has no transparency
    ctx.drawImage(bitmap, 0, 0);
    const res = stampWatermark(ctx, W, H, wm, logo);
    if (res.error) throw new ImageError(res.error.code, res.error.message);
    if (res.empty) throw new ImageError('empty', wm.type === 'logo' ? 'Choose a logo first.' : 'Type the watermark text first.');
    const blob = await encodeCanvas(canvas, { mime, quality });
    await assertEncodedAs(blob, mime);
    return { blob, mime, width: W, height: H, notes: res.notes, count: res.plan.marks.length };
  } finally { releaseCanvas(canvas); }
}
