import { MAX_SIDE, MAX_OUTPUT_PIXELS, MIN_CROP } from './limits.js';

/** Passport-photo maths. Pure: millimetres/DPI <-> pixels, crop from zoom+centre, output size without upscaling. */
export const DPI_MIN = 72, DPI_MAX = 1200, DPI_DEFAULT = 300, DPI_OPTIONS = [150, 300, 600];
export const MM_MIN = 10, MM_MAX = 300, ZOOM_MAX = 8;
/** General sizes only. Rules differ by country and document type; none of these is a guarantee of acceptance. */
export const PRESETS = [
  { key: '35x45', label: '35 × 45 mm', w: 35, h: 45 },
  { key: '2x2in', label: '2 × 2 in (50.8 × 50.8 mm)', w: 50.8, h: 50.8 },
  { key: '33x48', label: '33 × 48 mm', w: 33, h: 48 },
  { key: '40x50', label: '40 × 50 mm', w: 40, h: 50 },
];
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
export const mmToPx = (mm, dpi) => Math.round((mm / 25.4) * dpi);
export const pxToMm = (px, dpi) => (px / dpi) * 25.4;

/** Validate a photo size. Returns { ok, spec:{wMM,hMM,dpi,wPx,hPx,aspect} } or { ok:false, error }. Uses the app-wide output limits. */
export function validateSpec({ wMM, hMM, dpi }) {
  if (![wMM, hMM, dpi].every(Number.isFinite)) return { ok: false, error: 'Enter numbers for width, height and DPI.' };
  if (!Number.isInteger(dpi) || dpi < DPI_MIN || dpi > DPI_MAX) return { ok: false, error: 'DPI must be a whole number from ' + DPI_MIN + ' to ' + DPI_MAX + '.' };
  if (wMM < MM_MIN || hMM < MM_MIN || wMM > MM_MAX || hMM > MM_MAX) return { ok: false, error: 'Width and height must each be between ' + MM_MIN + ' and ' + MM_MAX + ' mm.' };
  const wPx = mmToPx(wMM, dpi), hPx = mmToPx(hMM, dpi);
  if (wPx < 1 || hPx < 1) return { ok: false, error: 'That size is too small to produce any pixels.' };
  if (wPx > MAX_SIDE || hPx > MAX_SIDE) return { ok: false, error: 'At ' + dpi + ' DPI this is ' + wPx + ' × ' + hPx + ' px. One side may not exceed ' + MAX_SIDE + ' px. Lower the DPI or the size.' };
  if (wPx * hPx > MAX_OUTPUT_PIXELS) return { ok: false, error: 'At ' + dpi + ' DPI this is ' + wPx + ' × ' + hPx + ' px, over the ' + Math.round(MAX_OUTPUT_PIXELS / 1e6) + ' megapixel output limit. Lower the DPI or the size.' };
  return { ok: true, spec: { wMM, hMM, dpi, wPx, hPx, aspect: wPx / hPx } };
}

/** Largest crop of `aspect` that fits inside the image (zoom 1). */
export function baseCrop(sw, sh, aspect) {
  return sw / sh > aspect ? { w: sh * aspect, h: sh } : { w: sw, h: sw / aspect };
}
export function maxZoom(sw, sh, aspect) {
  const b = baseCrop(sw, sh, aspect);
  return Math.max(1, Math.min(ZOOM_MAX, Math.min(b.w, b.h) / MIN_CROP));
}

/**
 * Crop rectangle (integer source px) of the given aspect, `zoom` times smaller than the largest fit, centred on (cx, cy)
 * but kept inside the image. The aspect comes from the target pixels, so the picture is never stretched.
 */
export function computeCrop(sw, sh, aspect, zoom = 1, cx = sw / 2, cy = sh / 2) {
  const b = baseCrop(sw, sh, aspect), z = clamp(Number.isFinite(zoom) ? zoom : 1, 1, maxZoom(sw, sh, aspect));
  let w = Math.max(1, Math.round(b.w / z)), h = Math.max(1, Math.round(w / aspect));
  if (h > sh) { h = sh; w = Math.max(1, Math.round(h * aspect)); }
  if (w > sw) { w = sw; h = Math.max(1, Math.round(w / aspect)); }
  const x = clamp(Math.round(cx - w / 2), 0, sw - w), y = clamp(Math.round(cy - h / 2), 0, sh - h);
  return { x, y, w, h, zoom: z };
}

/**
 * Output pixel size for a crop. Never upscales: if the crop has fewer pixels than the target, the output keeps the crop's
 * native size (same aspect) and the effective resolution is reported. `resize` is null when no resampling is needed.
 */
export function outputPlan(crop, spec) {
  const enough = crop.w >= spec.wPx && crop.h >= spec.hPx;
  const w = enough ? spec.wPx : crop.w, h = enough ? spec.hPx : crop.h;
  const resize = w === crop.w && h === crop.h ? null : { mode: 'scale', width: w, height: h, fit: 'fill', allowUpscale: false, lock: true };
  return { w, h, resize, upscaleAvoided: !enough, effectiveDpi: Math.round(w / (spec.wMM / 25.4)) };
}

/** Everything the pipeline recipe needs for the passport photo. background: 'keep' | 'white'. */
export function passportRecipeParts(sw, sh, spec, view, background) {
  const crop = computeCrop(sw, sh, spec.aspect, view.zoom, view.cx, view.cy), out = outputPlan(crop, spec);
  return { crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h }, resize: out.resize, flatten: background === 'white', out, zoom: crop.zoom };
}
