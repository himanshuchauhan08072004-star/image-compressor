/**
 * Smart Enhancement maths. Pure (no DOM): plain filters on RGBA bytes, in place. This is not AI.
 * Order: noise reduction -> tone (levels, brightness, contrast, warmth, saturation) -> sharpen.
 * Alpha is never touched. Radii are relative to the image size, so the small preview and the full file look alike.
 */
export const RANGES = { brightness: [-100, 100], contrast: [-100, 100], saturation: [-100, 100], warmth: [-100, 100], sharpen: [0, 100], denoise: [0, 100] };
export const DEFAULTS = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, sharpen: 0, denoise: 0, auto: false };
export const PRESETS = [
  { key: 'auto', label: 'Auto fix', hint: 'Stretches dull tones to the full range, adds a little punch.', values: { auto: true, contrast: 5, saturation: 8, sharpen: 20 } },
  { key: 'photo', label: 'Vivid photo', hint: 'More contrast and colour, light sharpening.', values: { contrast: 18, saturation: 22, sharpen: 30 } },
  { key: 'lowlight', label: 'Dark photo', hint: 'Lifts shadows, calms grain.', values: { brightness: 28, contrast: 10, denoise: 45, sharpen: 15 } },
  { key: 'document', label: 'Document', hint: 'Whiter page, darker text, little colour.', values: { auto: true, brightness: 10, contrast: 35, saturation: -70, sharpen: 40 } },
  { key: 'warm', label: 'Warmer', hint: 'Slightly warmer colours.', values: { warmth: 30, saturation: 8 } },
];
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const num = (v, d, lo, hi) => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? clamp(Math.round(Number(v)), lo, hi) : d);

/** Anything in, a complete safe parameter set out. */
export function normalizeEnhance(raw = {}) {
  const o = {};
  for (const [k, [lo, hi]] of Object.entries(RANGES)) o[k] = num(raw[k], DEFAULTS[k], lo, hi);
  o.auto = raw.auto === undefined ? DEFAULTS.auto : !!raw.auto;
  return o;
}
export const isIdentity = (p) => !p.auto && Object.keys(RANGES).every((k) => p[k] === 0);

const MIN_SPAN = 110;
/** Black/white points from the 0.5 % and 99.5 % luminance percentiles (sampled, <= ~1M pixels). Ignores transparent pixels. */
export function autoLevels(data, w, h) {
  const n = w * h, step = Math.max(1, Math.floor(n / 1_000_000)), hist = new Uint32Array(256); let cnt = 0;
  for (let i = 0; i < n; i += step) { const o = i * 4; if (data[o + 3] < 128) continue; hist[(data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8]++; cnt++; }
  if (!cnt) return [0, 255];
  let acc = 0, lo = 0, hi = 255; const a = cnt * 0.005, b = cnt * 0.995;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= a) { lo = v; break; } }
  acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= b) { hi = v; break; } }
  if (hi - lo < 32) return [0, 255];   // nearly flat picture: stretching would only amplify noise
  if (hi - lo < MIN_SPAN) { const mid = (lo + hi) / 2; lo = Math.max(0, Math.round(mid - MIN_SPAN / 2)); hi = Math.min(255, lo + MIN_SPAN); lo = Math.max(0, hi - MIN_SPAN); }   // never stretch more than ~2.3x: more only amplifies grain and colour casts
  return [lo, hi];
}

/** One 256-entry curve per channel: levels, brightness, contrast, warmth. */
export function buildCurves(p, levels = [0, 255]) {
  const [lo, hi] = p.auto ? levels : [0, 255], span = hi - lo, c = 1 + p.contrast / 100, b = p.brightness * 1.275, wm = p.warmth * 0.25;
  const mk = (shift) => { const t = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) { let x = ((v - lo) / span) * 255; x = (x - 128) * c + 128 + b + shift; t[v] = Math.round(x); } return t; };
  return [mk(wm), mk(0), mk(-wm)];
}

export function boxBlurGray(src, w, h, r) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w; let s = 0;
    for (let x = -r; x <= r; x++) s += src[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) { tmp[row + x] = (s / d + 0.5) | 0; s += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0; for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = (s / d + 0.5) | 0; s += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x]; }
  }
  return out;
}

/** Edge-preserving smoothing: each pixel averages its neighbours, weighted by colour similarity, so edges stay. */
export function denoise(data, w, h, strength) {
  if (strength <= 0 || w < 3 || h < 3) return;
  const R = strength > 55 ? 2 : 1, sigma = 6 + strength * 0.45, tab = new Float32Array(256);
  for (let d = 0; d < 256; d++) tab[d] = Math.exp(-(d * d) / (2 * sigma * sigma));
  const src = new Uint8ClampedArray(data), mix = Math.min(1, 0.35 + strength / 100 * 0.65);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(h - 1, y + R);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, r0 = src[o], g0 = src[o + 1], b0 = src[o + 2], x0 = Math.max(0, x - R), x1 = Math.min(w - 1, x + R);
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        const q = (yy * w + xx) * 4, r = src[q], g = src[q + 1], b = src[q + 2], d = (Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0)) / 3, k = tab[d | 0];
        sr += r * k; sg += g * k; sb += b * k; sw += k;
      }
      data[o] = r0 + (sr / sw - r0) * mix; data[o + 1] = g0 + (sg / sw - g0) * mix; data[o + 2] = b0 + (sb / sw - b0) * mix;
    }
  }
}

/** Unsharp mask on brightness only (no colour fringes). Tiny differences are left alone so grain is not boosted. */
export function sharpen(data, w, h, amount) {
  if (amount <= 0) return;
  const n = w * h, r = clamp(Math.round(Math.max(w, h) / 1100), 1, 6), Y = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const o = i * 4; Y[i] = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8; }
  let B = boxBlurGray(Y, w, h, r); B = boxBlurGray(B, w, h, r);
  const k = (amount / 100) * 1.6, thr = 2;
  for (let i = 0; i < n; i++) {
    const diff = Y[i] - B[i], ad = Math.abs(diff); if (ad <= thr) continue;
    const dl = k * (diff > 0 ? diff - thr : diff + thr), o = i * 4;
    data[o] += dl; data[o + 1] += dl; data[o + 2] += dl;   // typed array clamps to 0..255
  }
}

/** Apply everything to RGBA bytes in place. Returns { levels } (the auto black/white points used, or null). */
export function applyEnhance(data, w, h, params) {
  const p = normalizeEnhance(params);
  if (isIdentity(p)) return { levels: null };
  if (p.denoise) denoise(data, w, h, p.denoise);
  const levels = p.auto ? autoLevels(data, w, h) : null, [cr, cg, cb] = buildCurves(p, levels || [0, 255]), sat = 1 + p.saturation / 100, n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4; let r = cr[data[o]], g = cg[data[o + 1]], b = cb[data[o + 2]];
    if (sat !== 1) { const y = (r * 77 + g * 150 + b * 29) / 256; r = y + (r - y) * sat; g = y + (g - y) * sat; b = y + (b - y) * sat; }
    data[o] = r; data[o + 1] = g; data[o + 2] = b;
  }
  if (p.sharpen) sharpen(data, w, h, p.sharpen);
  return { levels };
}

/** Plain-language notes for the UI. */
export function enhanceNotes(p, res) {
  const out = [];
  if (isIdentity(p)) out.push('No changes yet. Move a slider or pick a preset.');
  if (p.auto && res && res.levels && res.levels[0] === 0 && res.levels[1] === 255) out.push('Auto fix found nothing to stretch: this picture already uses the full tone range.');
  if (p.sharpen > 70) out.push('Strong sharpening can create bright edges (halos). Compare with the original.');
  if (p.denoise > 70) out.push('Strong noise reduction makes fine detail look smooth and plastic.');
  if (p.brightness > 70 || p.contrast > 70) out.push('Extreme brightness or contrast loses detail in the lightest and darkest parts.');
  return out;
}
