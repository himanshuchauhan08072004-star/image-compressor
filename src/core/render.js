import { ImageError } from './errors.js';
import { normalizeHex } from './color.js';

const free = (c) => { c.width = 0; c.height = 0; };
export const releaseCanvas = free;

/** Draw src rect -> dst rect, halving step by step so big downscales stay sharp. Temporary canvases are freed even if a draw throws. */
export function drawScaled(ctx, source, src, dst) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  let cur = source, sx = src.x, sy = src.y, sw = src.w, sh = src.h, prev = null;
  try {
    while (sw / 2 >= dst.w && sh / 2 >= dst.h) {
      const tw = Math.max(1, Math.ceil(sw / 2)), th = Math.max(1, Math.ceil(sh / 2));
      const t = document.createElement('canvas');
      t.width = tw; t.height = th;
      try {
        const tc = t.getContext('2d');
        if (!tc) throw new ImageError('canvas', 'This image is too large for your browser to process.');
        tc.imageSmoothingQuality = 'high';
        tc.drawImage(cur, sx, sy, sw, sh, 0, 0, tw, th);
      } catch (e) { free(t); throw e; }
      if (prev) free(prev);
      prev = t; cur = t; sx = 0; sy = 0; sw = tw; sh = th;
    }
    ctx.drawImage(cur, sx, sy, sw, sh, dst.x, dst.y, dst.w, dst.h);
  } finally { if (prev) free(prev); }
}

const PROBE_ABOVE = 16_000_000;   // some mobile engines silently fail above ~16.7 MP

/** Very large canvases can "succeed" yet draw nothing. Check one far pixel before trusting one. */
export function assertCanvasBacked(canvas, ctx) {
  const { width: w, height: h } = canvas;
  if (w * h <= PROBE_ABOVE) return;
  ctx.fillStyle = '#000';
  ctx.fillRect(w - 1, h - 1, 1, 1);
  const ok = ctx.getImageData(w - 1, h - 1, 1, 1).data[3] === 255;
  ctx.clearRect(w - 1, h - 1, 1, 1);
  if (!ok) {
    throw new ImageError('canvas-limit', 'Your browser cannot process an image this large (' + Math.round((w * h) / 1e6) +
      ' megapixels). Use Resize to make it smaller first.');
  }
}

/**
 * A checked canvas: 2D context exists and (for very large sizes) really is backed by memory.
 * If anything fails the canvas is released before the error propagates, so a refused big canvas never lingers.
 * Returns { canvas, ctx }; the caller releases the canvas.
 */
export function makeCanvas(w, h, ctxOptions) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  try {
    const ctx = canvas.getContext('2d', ctxOptions);
    if (!ctx) throw new ImageError('canvas', 'This image is too large for your browser to process.');
    assertCanvasBacked(canvas, ctx);
    return { canvas, ctx };
  } catch (e) { free(canvas); throw e; }
}

/** Render a plan from geometry.planOutput into a canvas. Caller must releaseCanvas() it. */
export function renderPlan(bitmap, plan, { flatten = false, background = '#ffffff' } = {}) {
  const { canvas, ctx } = makeCanvas(plan.outW, plan.outH);
  try {
    if (flatten || plan.pad) { ctx.fillStyle = normalizeHex(background); ctx.fillRect(0, 0, plan.outW, plan.outH); }
    drawScaled(ctx, bitmap, plan.src, plan.dst);
    return canvas;
  } catch (e) { free(canvas); throw e; }
}
