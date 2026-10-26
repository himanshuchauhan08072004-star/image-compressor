import { normalizeHex } from './color.js';

/**
 * Region redaction (blur / pixelate / solid).
 * Pure parts (normalize, mapping, pixel maths on typed arrays) have no browser dependency and are unit-tested.
 * Only applyRegions touches a canvas. No ctx.filter anywhere (unsupported in Safari).
 */
export const MAX_REGIONS = 50;
export const MIN_REGION = 8;                    // smallest region side the editor allows, source px
export const MODES = ['blur', 'pixelate', 'solid'];
export const STRENGTHS = [1, 2, 3, 4, 5];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const EPS = 1e-6;                               // absorb float noise so exact integers do not grow by a pixel

/** Cell size as a fraction of the region's short side, per strength. */
const PIXEL_FRACTION = [0.06, 0.10, 0.15, 0.22, 0.32];
/** Blur radius as a fraction of the (down-scaled) region's short side, per strength. */
const BLUR_FRACTION = [0.06, 0.10, 0.15, 0.22, 0.30];
const BLUR_MAX_SIDE = 400;
const BLUR_PASSES = 3;
const BAND_PIXELS = 2_000_000;                  // pixelate works in horizontal bands of at most this many pixels

/** Clean one region. Returns null when unusable. Everything is integer, inside the image, with a validated colour. */
export function normalizeRegion(r, sw, sh) {
  if (!r || typeof r !== 'object') return null;
  const nums = [r.x, r.y, r.w, r.h];
  if (!nums.every((n) => Number.isFinite(n))) return null;
  const x = clamp(Math.round(r.x), 0, sw - 1);
  const y = clamp(Math.round(r.y), 0, sh - 1);
  const w = clamp(Math.round(r.w), 1, sw - x);
  const h = clamp(Math.round(r.h), 1, sh - y);
  const mode = MODES.includes(r.mode) ? r.mode : 'blur';
  const strength = clamp(Math.round(Number.isFinite(r.strength) ? r.strength : 3), 1, 5);
  return { id: String(r.id ?? ''), x, y, w, h, mode, strength, color: normalizeHex(r.color, '#000000') };
}

/** Clean a list: drop unusable entries, cap the count. */
export function normalizeRegions(list, sw, sh) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    if (out.length >= MAX_REGIONS) break;
    const n = normalizeRegion(r, sw, sh);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Map a region from source (upright bitmap) pixels to output canvas pixels through the draw plan.
 * Rounds OUTWARD (floor/ceil) so the covered area is never smaller than the chosen one, then clips to the
 * area the picture occupies (not letterbox padding) and to the canvas. Returns null when nothing is left.
 */
export function regionToOutput(region, plan) {
  const { src, dst } = plan;
  const kx = dst.w / src.w, ky = dst.h / src.h;
  let x0 = dst.x + (region.x - src.x) * kx, x1 = dst.x + (region.x + region.w - src.x) * kx;
  let y0 = dst.y + (region.y - src.y) * ky, y1 = dst.y + (region.y + region.h - src.y) * ky;
  const L = Math.max(0, Math.floor(dst.x + EPS)), T = Math.max(0, Math.floor(dst.y + EPS));
  const R = Math.min(plan.outW, Math.ceil(dst.x + dst.w - EPS)), B = Math.min(plan.outH, Math.ceil(dst.y + dst.h - EPS));
  const ix0 = Math.max(L, Math.floor(x0 + EPS)), iy0 = Math.max(T, Math.floor(y0 + EPS));
  const ix1 = Math.min(R, Math.ceil(x1 - EPS)), iy1 = Math.min(B, Math.ceil(y1 - EPS));
  if (ix1 <= ix0 || iy1 <= iy0) return null;
  return { x: ix0, y: iy0, w: ix1 - ix0, h: iy1 - iy0 };
}

export const pixelCell = (w, h, strength) => Math.max(2, Math.round(Math.min(w, h) * PIXEL_FRACTION[clamp(strength, 1, 5) - 1]));
export const blurRadius = (w, h, strength) => Math.max(2, Math.round(Math.min(w, h) * BLUR_FRACTION[clamp(strength, 1, 5) - 1]));

// ---------------------------------------------------------------- pure pixel maths (RGBA, 4 bytes/pixel)

/** Replace every cell x cell block (grid anchored at the buffer's top-left) with its alpha-weighted average. In place. */
export function pixelateRGBA(data, w, h, cell) {
  const c = Math.max(1, Math.floor(cell));
  for (let cy = 0; cy < h; cy += c) {
    for (let cx = 0; cx < w; cx += c) {
      const x1 = Math.min(w, cx + c), y1 = Math.min(h, cy + c);
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = cy; y < y1; y++) {
        for (let x = cx; x < x1; x++) {
          const i = (y * w + x) * 4, al = data[i + 3];
          r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al;
        }
      }
      const n = (x1 - cx) * (y1 - cy);
      const R = a > 0 ? Math.round(r / a) : 0, G = a > 0 ? Math.round(g / a) : 0, B = a > 0 ? Math.round(b / a) : 0, A = Math.round(a / n);
      for (let y = cy; y < y1; y++) {
        for (let x = cx; x < x1; x++) {
          const i = (y * w + x) * 4;
          data[i] = R; data[i + 1] = G; data[i + 2] = B; data[i + 3] = A;
        }
      }
    }
  }
}

function blurPass(src, dst, w, h, r, horizontal) {
  const n = horizontal ? w : h, lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4, lineStep = horizontal ? w * 4 : 4;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    for (let c = 0; c < 4; c++) {
      let sum = 0, cnt = 0;
      for (let i = 0; i <= Math.min(r, n - 1); i++) { sum += src[base + i * step + c]; cnt++; }
      for (let i = 0; i < n; i++) {
        dst[base + i * step + c] = sum / cnt;
        const add = i + r + 1, rem = i - r;
        if (add < n) { sum += src[base + add * step + c]; cnt++; }
        if (rem >= 0) { sum -= src[base + rem * step + c]; cnt--; }
      }
    }
  }
}

/** Box blur (3 passes ~ gaussian) on RGBA bytes, premultiplied internally so transparent areas do not darken. In place. */
export function boxBlurRGBA(data, w, h, radius, passes = BLUR_PASSES) {
  const r = Math.max(1, Math.floor(radius));
  const n = w * h * 4;
  let a = new Float64Array(n), b = new Float64Array(n);
  for (let i = 0; i < n; i += 4) {
    const al = data[i + 3] / 255;
    a[i] = data[i] * al; a[i + 1] = data[i + 1] * al; a[i + 2] = data[i + 2] * al; a[i + 3] = data[i + 3];
  }
  for (let p = 0; p < passes; p++) {
    blurPass(a, b, w, h, r, true); [a, b] = [b, a];
    blurPass(a, b, w, h, r, false); [a, b] = [b, a];
  }
  for (let i = 0; i < n; i += 4) {
    const al = a[i + 3];
    const k = al > 0 ? 255 / al : 0;
    data[i] = clamp(Math.round(a[i] * k), 0, 255); data[i + 1] = clamp(Math.round(a[i + 1] * k), 0, 255);
    data[i + 2] = clamp(Math.round(a[i + 2] * k), 0, 255); data[i + 3] = clamp(Math.round(al), 0, 255);
  }
}

// ---------------------------------------------------------------- canvas side

function pixelateBox(ctx, box, strength) {
  const cell = pixelCell(box.w, box.h, strength);
  const rows = Math.max(cell, Math.floor(BAND_PIXELS / box.w / cell) * cell);   // multiples of cell keep the grid aligned across bands
  for (let y = 0; y < box.h; y += rows) {
    const bh = Math.min(rows, box.h - y);
    const img = ctx.getImageData(box.x, box.y + y, box.w, bh);
    pixelateRGBA(img.data, box.w, bh, cell);
    ctx.putImageData(img, box.x, box.y + y);
  }
}

function blurBox(ctx, canvas, box, strength) {
  const k = Math.min(1, BLUR_MAX_SIDE / Math.max(box.w, box.h));
  const tw = Math.max(1, Math.round(box.w * k)), th = Math.max(1, Math.round(box.h * k));
  const tmp = document.createElement('canvas');
  tmp.width = tw; tmp.height = th;
  try {
    const tc = tmp.getContext('2d');
    tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
    tc.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, tw, th);
    const img = tc.getImageData(0, 0, tw, th);
    boxBlurRGBA(img.data, tw, th, blurRadius(tw, th, strength));
    tc.putImageData(img, 0, 0);
    ctx.save();
    try {
      ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
      ctx.globalCompositeOperation = 'copy';                                   // replace, never blend with the sharp pixels below
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tmp, 0, 0, tw, th, box.x, box.y, box.w, box.h);
    } finally { ctx.restore(); }
  } finally { tmp.width = 0; tmp.height = 0; }
}

/**
 * Paint every region onto the already-rendered output canvas. `regions` must be normalized (see normalizeRegions);
 * `plan` is the plan the canvas was rendered with. The result is plain pixels: nothing underneath survives.
 */
export function applyRegions(canvas, plan, regions) {
  if (!regions || !regions.length) return 0;
  const ctx = canvas.getContext('2d');
  let n = 0;
  for (const r of regions) {
    const box = regionToOutput(r, plan);
    if (!box) continue;
    if (r.mode === 'solid') { ctx.fillStyle = normalizeHex(r.color, '#000000'); ctx.fillRect(box.x, box.y, box.w, box.h); }
    else if (r.mode === 'pixelate') pixelateBox(ctx, box, r.strength);
    else blurBox(ctx, canvas, box, r.strength);
    n++;
  }
  return n;
}
