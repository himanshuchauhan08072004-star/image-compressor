import { ImageError } from './errors.js';
import { baseCrop, mmToPx } from './passport.js';
import { planOutput } from './geometry.js';
import { renderPlan, releaseCanvas } from './render.js';
import { encodeCanvas } from './encode.js';
import { assertEncodedAs } from './verify.js';
import { MAX_SIDE, MAX_OUTPUT_PIXELS } from './limits.js';

/**
 * Pictures for the print sheet. planGroupImage() is pure (so it is unit-tested); renderGroupJpeg() is the canvas glue.
 * Rule: a photo is never enlarged and never stretched. `cover` takes the largest centred crop with the photo's shape;
 * `contain` fits the whole picture inside the photo area and pads with white.
 */
export const GROUP_JPEG_QUALITY = 0.9;

/** Pixel plan for one photo group: { crop, resize, width, height, effectiveDpi } for planOutput(). */
export function planGroupImage(sw, sh, group, dpi) {
  if (!(sw >= 1 && sh >= 1)) throw new ImageError('sheet-image', 'The picture has no size.');
  let tw = Math.max(1, mmToPx(group.w, dpi)), th = Math.max(1, mmToPx(group.h, dpi));
  const cap = Math.min(1, MAX_SIDE / Math.max(tw, th), Math.sqrt(MAX_OUTPUT_PIXELS / (tw * th)));          // stay inside the app-wide output limits
  if (cap < 1) { tw = Math.max(1, Math.floor(tw * cap)); th = Math.max(1, Math.floor(th * cap)); }
  if (group.fit === 'contain') {
    const k = Math.min(tw / sw, th / sh);
    if (k > 1) { tw = Math.max(1, Math.floor(tw / k)); th = Math.max(1, Math.floor(th / k)); }              // never enlarge
    return { crop: null, resize: { mode: 'exact', fit: 'contain', width: tw, height: th, allowUpscale: true }, width: tw, height: th, effectiveDpi: Math.round(tw / (group.w / 25.4)) };
  }
  const aspect = group.w / group.h, b = baseCrop(sw, sh, aspect), cw = Math.min(sw, Math.max(1, Math.round(b.w))), ch = Math.min(sh, Math.max(1, Math.round(b.h)));
  const crop = { x: Math.floor((sw - cw) / 2), y: Math.floor((sh - ch) / 2), w: cw, h: ch };
  if (cw < tw || ch < th) { tw = cw; th = ch; }                                                              // not enough pixels: keep the real ones
  const resize = tw === cw && th === ch ? null : { mode: 'scale', width: tw, height: th, allowUpscale: false };
  return { crop, resize, width: tw, height: th, effectiveDpi: Math.round(tw / (group.w / 25.4)) };
}

/** source: { width, height } drawable (ImageBitmap or canvas). Resolves { bytes, width, height, effectiveDpi } (JPEG). */
export async function renderGroupJpeg(source, group, { dpi, quality = GROUP_JPEG_QUALITY }) {
  const p = planGroupImage(source.width, source.height, group, dpi), planned = planOutput(source.width, source.height, { crop: p.crop, resize: p.resize });
  if (!planned.ok) throw new ImageError(planned.error.code || 'sheet-image', planned.error.message);
  const canvas = renderPlan(source, planned.plan, { flatten: true, background: '#ffffff' });
  try {
    const blob = await encodeCanvas(canvas, { mime: 'image/jpeg', quality });
    await assertEncodedAs(blob, 'image/jpeg');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: planned.plan.outW, height: planned.plan.outH, effectiveDpi: p.effectiveDpi };
  } finally { releaseCanvas(canvas); }
}

/** Source rectangle used to draw a group's picture in the preview (same rule as the export). */
export function previewSourceRect(sw, sh, group) {
  if (group.fit === 'contain') return { x: 0, y: 0, w: sw, h: sh, contain: true };
  const b = baseCrop(sw, sh, group.w / group.h);
  return { x: (sw - b.w) / 2, y: (sh - b.h) / 2, w: b.w, h: b.h, contain: false };
}
