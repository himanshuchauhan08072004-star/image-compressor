import { ImageError } from './errors.js';
import { MAX_SIDE, MAX_OUTPUT_PIXELS, MIN_CROP } from './limits.js';
import { normalizeHex } from './color.js';
import { parseImageHeader } from './dimensions.js';

/**
 * Signature Cleaner maths. Pure: works on RGBA byte arrays and plain numbers, no DOM, so it is unit-testable in Node.
 * Model: dark ink on lighter paper. Pipeline per pixel:
 *   grey -> flatten uneven paper (local background estimate) -> white point -> brightness -> contrast (about light grey)
 *        -> ink-darkness curve -> threshold ramp -> alpha (0..255).
 * Alpha is soft (a short ramp, not a hard 0/1 cut) so thin, faint and anti-aliased strokes survive.
 */

export const WORK_MAX_PIXELS = 12_000_000;   // largest region processed at once at full detail (RGBA + grey + alpha ~ 150 MB)
export const PREVIEW_MAX_SIDE = 1400;        // live preview is computed at this size
export const PAD_MAX = 500;                  // output padding, px per side
export const SPECK_FRACTION = 0.00002;       // noise=100 removes faint specks up to this share of the image area
export const INK_LEVEL = 26;                 // alpha (of 255) from which a pixel counts as ink for bounds / specks / crop warnings
const CONTRAST_PIVOT = 190;                  // contrast works about a LIGHT grey, so pale ink gets stronger instead of washing out
const STRONG_PEAK = 235;                     // a speck with a solid-ink pixel is treated as a real dot and kept

export const RANGES = {
  brightness: [-100, 100], contrast: [-100, 100], threshold: [0, 255], ink: [0, 100], whiten: [0, 100], noise: [0, 100],
};
export const INK_COLORS = ['auto', 'black', 'blue', 'custom'];
export const DEFAULTS = { brightness: 0, contrast: 20, threshold: 170, ink: 10, whiten: 60, noise: 20, inkColor: 'auto', customColor: '#1a1a1a' };

/** Starting points, not guarantees. Every value stays adjustable. */
export const PRESETS = [
  { key: 'balanced', label: 'Balanced', hint: 'A good starting point for most photos or scans.', values: { brightness: 0, contrast: 20, threshold: 170, ink: 10, whiten: 60, noise: 20 } },
  { key: 'light', label: 'Light Ink', hint: 'Light or thin pen: keeps pale strokes and darkens them.', values: { brightness: -5, contrast: 40, threshold: 195, ink: 40, whiten: 70, noise: 15 } },
  { key: 'dark', label: 'Dark Ink', hint: 'Heavy, dark pen on a clear page: removes more background.', values: { brightness: 10, contrast: 10, threshold: 140, ink: 0, whiten: 60, noise: 25 } },
  { key: 'faint', label: 'Faint Signature', hint: 'Very pale marks: keeps as much as possible, more noise may stay.', values: { brightness: 0, contrast: 50, threshold: 210, ink: 70, whiten: 80, noise: 10 } },
  { key: 'strong', label: 'Strong Contrast', hint: 'Shadowy or grey photos: whitens hard and removes small specks.', values: { brightness: 0, contrast: 60, threshold: 150, ink: 30, whiten: 90, noise: 30 } },
];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? clamp(Math.round(Number(v)), lo, hi) : d);

/** Clamp anything the UI (or a caller) hands over into a safe, complete parameter set. */
export function normalizeParams(p = {}) {
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(RANGES)) out[k] = num(p[k], DEFAULTS[k], lo, hi);
  out.inkColor = INK_COLORS.includes(p.inkColor) ? p.inkColor : DEFAULTS.inkColor;
  out.customColor = normalizeHex(p.customColor, DEFAULTS.customColor);
  return out;
}

/** Fail fast on arrays that do not match their claimed size. */
export function assertPixels(data, w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new ImageError('pixels', 'This image has no pixels to work with.');
  if (!data || data.length !== w * h * 4) throw new ImageError('pixels', 'The image data does not match its size.');
}

/** Luminance 0..255, with any source transparency composited over white (a transparent-PNG signature still works). */
export function toGray(rgba, w, h) {
  assertPixels(rgba, w, h);
  const n = w * h, g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = rgba[j + 3];
    const l = (299 * rgba[j] + 587 * rgba[j + 1] + 114 * rgba[j + 2]) / 1000;
    g[i] = a === 255 ? Math.round(l) : Math.round((l * a + 255 * (255 - a)) / 255);
  }
  return g;
}

/**
 * Coarse "paper brightness" map. Each block keeps its 90th-percentile grey (ink is dark, so paper wins), then the map is
 * dilated once (blocks that are mostly ink borrow from neighbours) and smoothed. Thin strokes never reach the 90th percentile.
 * The result is resolution independent: it is sampled by bgPlane() at any size.
 */
export function estimateBackground(gray, w, h) {
  if (!gray || gray.length !== w * h || w < 1 || h < 1) throw new ImageError('pixels', 'The image data does not match its size.');
  const block = clamp(Math.round(Math.min(w, h) / 20), 4, 64), gw = Math.ceil(w / block), gh = Math.ceil(h / block);
  const hist = new Uint32Array(256), raw = new Uint8Array(gw * gh);
  for (let by = 0; by < gh; by++) {
    for (let bx = 0; bx < gw; bx++) {
      hist.fill(0);
      const x1 = Math.min(w, (bx + 1) * block), y1 = Math.min(h, (by + 1) * block);
      let n = 0;
      for (let y = by * block; y < y1; y++) for (let x = bx * block, i = y * w + x; x < x1; x++, i++) { hist[gray[i]]++; n++; }
      const need = Math.ceil(n * 0.9);
      let acc = 0, v = 0;
      for (; v < 255; v++) { acc += hist[v]; if (acc >= need) break; }
      raw[by * gw + bx] = v;
    }
  }
  const pass = (src, pick) => {                                         // 3x3 neighbourhood, edges clamped
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let max = 0, sum = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const v = src[clamp(y + dy, 0, gh - 1) * gw + clamp(x + dx, 0, gw - 1)];
        if (v > max) max = v; sum += v; c++;
      }
      dst[y * gw + x] = pick === 'max' ? max : Math.round(sum / c);
    }
    return dst;
  };
  return { block, gw, gh, w, h, grid: pass(pass(raw, 'max'), 'mean') };
}

/**
 * Paper brightness for every pixel of a w x h window onto the image. view = { u0, v0, u1, v1 } in 0..1 of the whole image
 * (the estimate was made on a smaller copy, so positions are normalised). Bilinear between block centres.
 */
export function bgPlane(bg, { w, h, u0 = 0, v0 = 0, u1 = 1, v1 = 1 }) {
  const out = new Uint8Array(w * h), { block, gw, gh } = bg;
  const ix = new Int32Array(w), fx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const g = clamp(((u0 + ((x + 0.5) / w) * (u1 - u0)) * bg.w) / block - 0.5, 0, gw - 1), i = Math.min(Math.floor(g), gw - 2 < 0 ? 0 : gw - 2);
    ix[x] = i; fx[x] = gw === 1 ? 0 : g - i;
  }
  for (let y = 0; y < h; y++) {
    const g = clamp(((v0 + ((y + 0.5) / h) * (v1 - v0)) * bg.h) / block - 0.5, 0, gh - 1), j = Math.min(Math.floor(g), gh - 2 < 0 ? 0 : gh - 2), fy = gh === 1 ? 0 : g - j;
    const r0 = j * gw, r1 = Math.min(j + 1, gh - 1) * gw;
    for (let x = 0; x < w; x++) {
      const i = ix[x], i1 = Math.min(i + 1, gw - 1), f = fx[x];
      const top = bg.grid[r0 + i] * (1 - f) + bg.grid[r0 + i1] * f, bot = bg.grid[r1 + i] * (1 - f) + bg.grid[r1 + i1] * f;
      out[y * w + x] = Math.round(top * (1 - fy) + bot * fy);
    }
  }
  return out;
}

/** The 256-entry curve that turns a cleaned grey level into alpha: ink-darkness gamma, then the threshold ramp. */
export function alphaCurve(p) {
  const g = 1 / (1 + p.ink / 50), T = p.threshold, S = Math.max(1, Math.min(40, T)), lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const dark = 1 - v / 255, v2 = 255 * (1 - (dark > 0 ? Math.pow(dark, g) : 0));
    lut[v] = Math.round(clamp((T - v2) / S, 0, 1) * 255);
  }
  return lut;
}

/** Cleaned grey -> alpha for every pixel. `bgp` is the paper-brightness plane (same size as gray). Ink is the bits darker than paper. */
export function cleanAlpha(gray, bgp, params) {
  const p = normalizeParams(params), n = gray.length;
  if (bgp.length !== n) throw new ImageError('pixels', 'The image data does not match its size.');
  const wh = p.whiten / 100, wp = 255 - 40 * wh, add = p.brightness * 1.28, cc = p.contrast * 2.55, cf = (259 * (cc + 255)) / (255 * (259 - cc));
  const lut = alphaCurve(p), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const L = gray[i], B = bgp[i] < 96 ? 96 : bgp[i];
    let v = L + wh * (Math.min(255, (L * 255) / B) - L);                 // flatten uneven lighting by `whiten`
    v = Math.min(255, (v * 255) / wp) + add;                              // white point, then brightness
    v = (v - CONTRAST_PIVOT) * cf + CONTRAST_PIVOT;                       // contrast about a light grey
    out[i] = lut[v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v)];
  }
  return out;
}

/** Specks allowed to go: area (px) for the given noise setting. `refPixels` = pixel count of the WHOLE image at the processed scale. */
export const speckArea = (noise, refPixels) => Math.round((noise / 100) * SPECK_FRACTION * refPixels);

/**
 * Remove small, faint blobs. An 8-connected blob is cleared only if it is smaller than `minArea` AND has no solid-ink pixel,
 * so thin strokes (long, connected), real dots (solid) and disconnected parts of reasonable size stay.
 * Returns the number of blobs removed. Edits `alpha` in place.
 */
export function removeSpecks(alpha, w, h, minArea) {
  if (!(minArea > 1)) return 0;
  const seen = new Uint8Array(alpha.length), stack = [];
  let removed = 0;
  for (let s = 0; s < alpha.length; s++) {
    if (alpha[s] < INK_LEVEL || seen[s]) continue;
    let area = 0, peak = 0, members = [];
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop(), a = alpha[i];
      area++; if (a > peak) peak = a;
      if (members && area <= minArea) members.push(i); else members = null;   // only small blobs are worth remembering
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if ((!dx && !dy) || xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!seen[j] && alpha[j] >= INK_LEVEL) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    if (members && area < minArea && peak < STRONG_PEAK) { for (const i of members) alpha[i] = 0; removed++; }
  }
  return removed;
}

/** Tight box around all ink (alpha >= level). null when there is none. */
export function inkBounds(alpha, w, h, level = INK_LEVEL) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0, i = y * w; x < w; x++, i++) {
    if (alpha[i] >= level) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Scale a rect between coordinate spaces, rounding OUTWARD plus `margin` so a crop made from it never clips a stroke. */
export function scaleRectOut(r, fx, fy, margin, maxW, maxH) {
  const x0 = clamp(Math.floor(r.x * fx - margin), 0, maxW - 1), y0 = clamp(Math.floor(r.y * fy - margin), 0, maxH - 1);
  const x1 = clamp(Math.ceil((r.x + r.w) * fx + margin), x0 + 1, maxW), y1 = clamp(Math.ceil((r.y + r.h) * fy + margin), y0 + 1, maxH);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** How much ink lies outside a crop (preview coordinates). Used to warn before strokes are cut off. */
export function inkOutsideCrop(alpha, w, h, crop, level = INK_LEVEL) {
  let total = 0, outside = 0;
  for (let y = 0; y < h; y++) for (let x = 0, i = y * w; x < w; x++, i++) {
    if (alpha[i] < level) continue;
    total++;
    if (x < crop.x || x >= crop.x + crop.w || y < crop.y || y >= crop.y + crop.h) outside++;
  }
  return { total, outside };
}

const parseHex = (hex) => { const c = normalizeHex(hex, '#000000'); return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); };

/** Average colour of the solid ink, kept dark enough to read on white. Black when there is no solid ink. */
export function detectInk(rgba, alpha) {
  let max = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] > max) max = alpha[i];
  if (!max) return [0, 0, 0];
  const cut = Math.max(INK_LEVEL, Math.min(200, Math.round(max * 0.8)));
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) if (alpha[i] >= cut && rgba[j + 3] === 255) { r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; n++; }
  if (!n) return [0, 0, 0];
  const c = [r / n, g / n, b / n], lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2], k = lum > 150 ? 150 / lum : 1;
  return c.map((v) => Math.round(v * k));
}

export const BLUE = [26, 52, 160];
/** Final ink colour: the detected one, black, blue, or a validated custom hex. */
export function resolveInk(params, detected = [0, 0, 0]) {
  const p = normalizeParams(params);
  return p.inkColor === 'black' ? [0, 0, 0] : p.inkColor === 'blue' ? BLUE.slice() : p.inkColor === 'custom' ? parseHex(p.customColor) : detected;
}

/**
 * Alpha + ink colour -> RGBA bytes.
 * 'transparent': every pixel carries the ink colour, alpha = the stroke strength (a real alpha channel).
 * 'white': the strokes are composited over opaque white, alpha is 255 everywhere.
 */
export function composeRGBA(alpha, ink, mode) {
  const n = alpha.length, out = new Uint8ClampedArray(n * 4);
  if (mode === 'transparent') {
    for (let i = 0, j = 0; i < n; i++, j += 4) { out[j] = ink[0]; out[j + 1] = ink[1]; out[j + 2] = ink[2]; out[j + 3] = alpha[i]; }
  } else {
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = alpha[i] / 255;
      out[j] = Math.round(255 - a * (255 - ink[0])); out[j + 1] = Math.round(255 - a * (255 - ink[1])); out[j + 2] = Math.round(255 - a * (255 - ink[2])); out[j + 3] = 255;
    }
  }
  return out;
}

/** Whole clean-up for one window of pixels. Returns the alpha plane and number of specks removed. */
export function processAlpha(gray, bgp, w, h, params, refPixels) {
  const p = normalizeParams(params), alpha = cleanAlpha(gray, bgp, p);
  const specks = removeSpecks(alpha, w, h, speckArea(p.noise, refPixels));
  return { alpha, specks };
}

/**
 * Which part of the source to process for a crop, and at what size. Crops up to WORK_MAX_PIXELS are processed 1:1;
 * a larger crop is first reduced (never enlarged) so memory stays bounded.
 */
export function exportRegion(crop, srcW, srcH) {
  const c = { x: clamp(Math.round(crop.x), 0, srcW - 1), y: clamp(Math.round(crop.y), 0, srcH - 1) };
  c.w = clamp(Math.round(crop.w), 1, srcW - c.x); c.h = clamp(Math.round(crop.h), 1, srcH - c.y);
  const k = c.w * c.h > WORK_MAX_PIXELS ? Math.sqrt(WORK_MAX_PIXELS / (c.w * c.h)) : 1;
  return { src: c, tw: Math.max(1, Math.round(c.w * k)), th: Math.max(1, Math.round(c.h * k)), k };
}

const fail = (code, message) => ({ ok: false, error: { code, message } });

/**
 * Final size. `crop` = { w, h } of the chosen area in source px.
 * size = { mode: 'original' | 'width' | 'box', width, height, keepAspect, allowUpscale }; pad = px per side, INSIDE the final size.
 *   original: the crop at its own size + padding.
 *   width:    final width W (padding included); height follows the crop's aspect ratio.
 *   box:      final W x H (padding included). keepAspect fits the signature inside, centred; otherwise it is stretched to fill.
 * Never enlarges unless allowUpscale. Same size limits as every other tool.
 */
export function planExport(crop, { pad = 0, size = { mode: 'original' } } = {}) {
  const cw = Math.round(crop && crop.w), ch = Math.round(crop && crop.h);
  if (!(cw >= 1 && ch >= 1)) return fail('crop', 'The crop area is empty.');
  const p = Math.round(Number(pad));
  if (!Number.isFinite(p) || p < 0 || p > PAD_MAX) return fail('pad', 'Padding must be a whole number from 0 to ' + PAD_MAX + ' px.');
  const mode = size.mode || 'original';
  let W, H, cwOut, chOut;
  if (mode === 'original') {
    cwOut = cw; chOut = ch; W = cw + 2 * p; H = ch + 2 * p;
  } else if (mode === 'width') {
    W = Math.round(Number(size.width));
    if (!(W >= 1)) return fail('size', 'Enter a width of at least 1 px.');
    if (W - 2 * p < 1) return fail('pad', 'The padding is wider than the image. Lower the padding or raise the width.');
    cwOut = W - 2 * p; chOut = Math.max(1, Math.round((ch * cwOut) / cw)); H = chOut + 2 * p;
  } else if (mode === 'box') {
    W = Math.round(Number(size.width)); H = Math.round(Number(size.height));
    if (!(W >= 1 && H >= 1)) return fail('size', 'Enter a width and height of at least 1 px.');
    const iw = W - 2 * p, ih = H - 2 * p;
    if (iw < 1 || ih < 1) return fail('pad', 'The padding is larger than the image. Lower the padding or raise the size.');
    if (size.keepAspect === false) { cwOut = iw; chOut = ih; }
    else { const s = Math.min(iw / cw, ih / ch); cwOut = Math.max(1, Math.round(cw * s)); chOut = Math.max(1, Math.round(ch * s)); }
  } else return fail('size', 'Unknown size option.');

  if (W > MAX_SIDE || H > MAX_SIDE || W * H > MAX_OUTPUT_PIXELS) {
    return fail('too-big', 'That output would be ' + W + ' × ' + H + ' px. The limit is ' + MAX_OUTPUT_PIXELS / 1e6 + ' MP and ' + MAX_SIDE + ' px per side.');
  }
  const scale = Math.max(cwOut / cw, chOut / ch);
  if (scale > 1 + 1e-9 && !size.allowUpscale) {
    return fail('upscale', 'That is larger than the signature itself (' + cw + ' × ' + ch + ' px). Tick “Allow enlarging” to make it bigger, or choose a smaller size.');
  }
  const dst = { x: p + Math.floor((W - 2 * p - cwOut) / 2), y: p + Math.floor((H - 2 * p - chOut) / 2), w: cwOut, h: chOut };
  return { ok: true, plan: { W, H, dst, pad: p, scale, upscaled: scale > 1 + 1e-9 } };
}

/** True when PNG bytes declare an alpha channel (colour type 4/6, or a tRNS chunk). Reads the header only. */
export function pngDeclaresAlpha(bytes) {
  const r = parseImageHeader(bytes, 'png');
  return r.status === 'ok' && r.alpha === true;
}

/** Smallest crop side the editor allows, re-exported so the UI and tests share one number. */
export const MIN_SIGNATURE_CROP = MIN_CROP;
