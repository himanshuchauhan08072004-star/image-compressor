import { normalizeHex } from './color.js';
import { boxBlurGray } from './enhance.js';

/**
 * Background Remover maths. Pure (no DOM), plain colour maths, NOT a neural network.
 * It finds the background colour from the picture's border, then removes pixels near that colour that are connected to the border.
 * Works on plain or evenly lit backgrounds (studio wall, sheet of paper, product shot). It cannot separate a person from a busy street.
 */
export const RANGES = { tolerance: [1, 100], feather: [0, 10], specks: [0, 100] };
export const DEFAULTS = { tolerance: 30, feather: 2, specks: 20, mode: 'edge', fill: 'transparent', fillColor: '#ffffff' };
export const MAX_WORK_PIXELS = 12_000_000;   // larger pictures are reduced to this before the cut-out (the UI says so)
export const PRESETS = [
  { key: 'studio', label: 'Studio / product', hint: 'Even light background, clean edges.', values: { tolerance: 28, feather: 2, specks: 25, mode: 'edge' } },
  { key: 'paper', label: 'Paper / scan', hint: 'Removes the paper everywhere, also inside letters and loops.', values: { tolerance: 35, feather: 1, specks: 5, mode: 'all' } },
  { key: 'shadow', label: 'Soft shadows', hint: 'Higher tolerance for uneven or shaded backgrounds.', values: { tolerance: 55, feather: 3, specks: 30, mode: 'edge' } },
];
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const num = (v, d, lo, hi) => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? clamp(Math.round(Number(v)), lo, hi) : d);

export function normalizeBackground(raw = {}) {
  const o = {};
  for (const [k, [lo, hi]] of Object.entries(RANGES)) o[k] = num(raw[k], DEFAULTS[k], lo, hi);
  o.mode = raw.mode === 'all' ? 'all' : 'edge';
  o.fill = raw.fill === 'white' || raw.fill === 'color' ? raw.fill : 'transparent';
  o.fillColor = normalizeHex(raw.fillColor, DEFAULTS.fillColor);
  return o;
}
export const hexToRgb = (hex) => { const c = normalizeHex(hex, '#ffffff'); return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); };

/** Colour distance ("redmean" weighting), 0 = same, about 765 = black vs white. */
export function colorDist(r1, g1, b1, r2, g2, b2) {
  const rm = (r1 + r2) / 2, dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}
const lowOf = (tol) => tol * 1.6, highOf = (tol) => tol * 1.6 + Math.max(10, tol * 1.1);   // opaque above high, clear below low, soft between

/** Pixels on the picture's border ring (opaque only), up to ~6000 samples. */
function borderSamples(data, w, h) {
  const t = Math.max(1, Math.round(Math.min(w, h) * 0.01)), out = [], step = Math.max(1, Math.floor((2 * (w + h) * t) / 6000));
  let k = 0;
  for (let y = 0; y < h; y++) {
    const edgeRow = y < t || y >= h - t;
    for (let x = 0; x < w; x += edgeRow ? 1 : Math.max(1, w - 2 * t)) {
      if (!edgeRow && !(x < t || x >= w - t)) { x = Math.max(x, w - t - 1); continue; }
      if (k++ % step) continue; const o = (y * w + x) * 4; if (data[o + 3] >= 128) out.push([data[o], data[o + 1], data[o + 2]]);
    }
  }
  return out;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/** Background colours from the border: the median colour, plus a second cluster if a big, different part of the border needs it. */
export function estimateBackground(data, w, h) {
  const s = borderSamples(data, w, h); if (!s.length) return { colors: [[255, 255, 255]], coverage: 0 };
  const c1 = [0, 1, 2].map((i) => median(s.map((p) => p[i])));
  const far = s.filter((p) => colorDist(p[0], p[1], p[2], ...c1) > 60), colors = [c1];
  if (far.length >= s.length * 0.15) { const c2 = [0, 1, 2].map((i) => median(far.map((p) => p[i]))); if (colorDist(...c1, ...c2) > 60) colors.push(c2); }
  return { colors, coverage: coverageOf(s, colors, 40) };
}
const coverageOf = (samples, colors, tol) => (samples.length ? samples.filter((p) => colors.some((c) => colorDist(p[0], p[1], p[2], ...c) <= tol * 1.6 + 10)).length / samples.length : 0);

/**
 * Cut the background out, in place: alpha is set (0 = background), edge pixels lose the background colour they picked up.
 * `colors` = [[r,g,b], ...] background colours (from estimateBackground or picked by the user).
 * Returns { removed (0..1 of pixels), coverage (share of border pixels that match the background) }.
 */
export function removeBackground(data, w, h, params, colors) {
  const p = normalizeBackground(params), n = w * h, lo = lowOf(p.tolerance), hi = highOf(p.tolerance), span = hi - lo;
  const dist = new Float32Array(n), near = new Uint8Array(n);   // near = index of closest background colour
  for (let i = 0; i < n; i++) {
    const o = i * 4; let best = 1e9, bi = 0;
    for (let c = 0; c < colors.length; c++) { const d = colorDist(data[o], data[o + 1], data[o + 2], colors[c][0], colors[c][1], colors[c][2]); if (d < best) { best = d; bi = c; } }
    dist[i] = best; near[i] = bi;
  }
  // region of background: connected to the border (edge mode) or anywhere (all mode)
  const reg = new Uint8Array(n);
  if (p.mode === 'all') { for (let i = 0; i < n; i++) if (dist[i] < hi) reg[i] = 1; }
  else {
    const stack = new Int32Array(n); let sp = 0;
    const push = (i) => { if (!reg[i] && dist[i] < hi) { reg[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); } for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) { const i = stack[--sp], x = i % w, y = (i / w) | 0; if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w); }
  }
  let alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = !reg[i] ? 255 : dist[i] <= lo ? 0 : Math.round(((dist[i] - lo) / span) * 255);
  const fringe = matteEdges(data, w, h, reg, alpha, colors, near, p.tolerance);
  removeSpecks(alpha, w, h, Math.round(n * 0.0001 * p.specks));
  if (p.feather > 0) { const r = Math.max(1, Math.round(p.feather * Math.max(w, h) / 2000 * 0.6 + 0.4)); alpha = boxBlurGray(boxBlurGray(alpha, w, h, r), w, h, r); }
  let clear = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4, a = Math.min(alpha[i], data[o + 3]);
    if (a > 0 && a < 255 && (reg[i] || fringe[i])) {   // un-mix the background colour from edge pixels: C = (I - (1 - a) B) / a
      const B = colors[near[i]], k = a / 255;
      for (let c = 0; c < 3; c++) data[o + c] = clamp(Math.round((data[o + c] - (1 - k) * B[c]) / k), 0, 255);
    }
    data[o + 3] = a; if (a < 128) clear++;
  }
  return { removed: clear / n, coverage: 0 };
}

/**
 * Soft edge for anti-aliased pixels that sit just inside the subject: they are a mix of subject and background colour, so
 * a hard cut would leave a pale fringe. The subject colour F is estimated from solid subject pixels nearby (>= 3 px from the background);
 * a pixel lying on the line between background B and F gets alpha = its position on that line.
 * Writes alpha for those pixels; returns a mask of the pixels it treated.
 */
function matteEdges(data, w, h, reg, alpha, colors, near, tol) {
  const n = w * h, core = new Uint8Array(n), fringe = new Uint8Array(n), maxRes = 30 + tol * 0.6;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (reg[i]) continue; let ok = 1;
    for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && reg[yy * w + xx]) { ok = 0; break; } }
    core[i] = ok;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (reg[i] || core[i]) continue;
    let r = 0, g = 0, b = 0, c = 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const j = yy * w + xx; if (core[j]) { const o = j * 4; r += data[o]; g += data[o + 1]; b += data[o + 2]; c++; } }
    if (!c) continue;
    const F = [r / c, g / c, b / c], B = colors[near[i]], o = i * 4, vx = F[0] - B[0], vy = F[1] - B[1], vz = F[2] - B[2], len2 = vx * vx + vy * vy + vz * vz;
    if (len2 < 900) continue;   // subject colour too close to the background to tell them apart
    const t = ((data[o] - B[0]) * vx + (data[o + 1] - B[1]) * vy + (data[o + 2] - B[2]) * vz) / len2;
    if (t >= 0.97) continue;
    const t0 = Math.max(0, t), res = colorDist(data[o], data[o + 1], data[o + 2], B[0] + t0 * vx, B[1] + t0 * vy, B[2] + t0 * vz);
    if (res > maxRes) continue;   // not a mix of these two colours: ordinary subject detail, keep it opaque
    alpha[i] = Math.round(Math.max(0, Math.min(1, t)) * 255); fringe[i] = 1;
  }
  return fringe;
}

/** Remove opaque 8-connected islands smaller than `minArea` pixels (the largest piece is always kept). Holes are not filled. */
function removeSpecks(alpha, w, h, minArea) {
  if (minArea < 2) return;
  const n = w * h, label = new Int32Array(n), stack = new Int32Array(n), comps = []; let id = 0;
  for (let s = 0; s < n; s++) {
    if (alpha[s] < 128 || label[s]) continue; id++; let sp = 0, size = 0; label[s] = id; stack[sp++] = s; const members = [];
    while (sp) {
      const i = stack[--sp]; size++; members.push(i); const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx; if (alpha[j] >= 128 && !label[j]) { label[j] = id; stack[sp++] = j; }
      }
    }
    comps.push({ size, members });
  }
  const biggest = comps.reduce((m, c) => (c.size > m ? c.size : m), 0);
  for (const c of comps) if (c.size < minArea && c.size < biggest) for (const i of c.members) alpha[i] = 0;
}

/** Composite onto a solid colour, in place (alpha becomes 255). */
export function fillBackground(data, rgb) {
  for (let o = 0; o < data.length; o += 4) { const a = data[o + 3] / 255; if (a === 1) continue; for (let c = 0; c < 3; c++) data[o + c] = Math.round(data[o + c] * a + rgb[c] * (1 - a)); data[o + 3] = 255; }
}

/** Full pipeline on RGBA bytes. `bg` = user-picked [r,g,b] or null for automatic. */
export function cutOut(data, w, h, params, bg = null) {
  const p = normalizeBackground(params), est = bg ? { colors: [bg], coverage: coverageOf(borderSamples(data, w, h), [bg], p.tolerance) } : estimateBackground(data, w, h);
  const res = removeBackground(data, w, h, p, est.colors);
  if (p.fill === 'white') fillBackground(data, [255, 255, 255]); else if (p.fill === 'color') fillBackground(data, hexToRgb(p.fillColor));
  return { removed: res.removed, coverage: est.coverage, colors: est.colors };
}

export function backgroundNotes(p, res) {
  const out = [];
  if (res.coverage < 0.75) out.push('The edges of this picture are not one plain colour, so the cut-out may be poor. Click the background in the picture to pick its colour, or use a plainer picture.');
  if (res.removed < 0.01) out.push('Almost nothing was removed. Raise Tolerance, or click the background to pick its colour.');
  else if (res.removed > 0.97) out.push('Almost everything was removed. Lower Tolerance.');
  return out;
}
