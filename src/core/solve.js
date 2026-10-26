export const Q_MAX = 0.92;        // never above this: bigger files, no visible gain
export const Q_FLOOR = 0.45;      // lowest quality ever used
export const MIN_SIDE = 32;       // never shrink the short side below this many px
export const ABS_MIN_SCALE = 0.05;

const AIM = 0.5;                  // when shrinking, aim floor-quality size at ~half the target, leaving room to raise quality
const FIT_FLOOR = 0.35;           // a floor-quality fit this close to the target is good enough to stop searching scale
const DEFAULT_SLOPE = 3.5;        // typical d(ln bytes)/d(quality) for JPEG/WEBP; replaced by measurements
const MAX_SCALE_PROBES = 6;
const MAX_REFINE = 4;
const CLOSE_ENOUGH = 0.97;

export class Cancelled extends Error {}

/**
 * Best-looking encode that fits under `targetBytes`, with as few encodes as possible.
 *   A. Full size at floor quality (skipped when the target is tiny next to the original file).
 *      If it fits, only quality is raised (refine). Dimensions untouched.
 *   B. Otherwise search for a smaller size with floor-quality probes, refitting the bytes-vs-pixels
 *      curve from measured points each time (noisy images shrink faster than "bytes ~ pixels").
 *   C. Raise quality at the chosen size with a model-guided secant search (no max-quality probe needed).
 *   D. Nothing fits: return the smallest result with reached=false.
 *
 * render(scale) -> Promise<canvasLike {width,height}>      encode(canvas, q) -> Promise<{size}>
 * release(canvas), isCancelled(), hintBytes (original file size, optional), onProgress(n)
 */
export async function fitToBytes({ render, encode, release = () => {}, isCancelled = () => false,
  targetBytes, baseW, baseH, hintBytes = 0, onProgress = () => {} }) {
  let iterations = 0, renders = 0, fullSizeEncodes = 0;
  const check = () => { if (isCancelled()) throw new Cancelled(); };
  const enc = async (h, q) => {
    check(); iterations++; if (h.w === baseW && h.h === baseH) fullSizeEncodes++;
    const b = await encode(h.c, q); check(); onProgress(iterations); return b;
  };
  const minScale = Math.min(1, Math.max(ABS_MIN_SCALE, MIN_SIDE / Math.max(1, Math.min(baseW, baseH))));
  const open = async (scale) => { renders++; const c = await render(scale); const h = { c, w: c.width, h: c.height }; held.add(h); return h; };
  const held = new Set();
  const drop = (h) => { if (h && held.delete(h)) release(h.c); };
  const areaOf = (h) => (h.w * h.h) / (baseW * baseH);
  const result = (h, blob, q, fits) => ({ fits, blob, quality: q, scale: h.w / baseW, width: h.w, height: h.h });

  /** Raise quality from a known-fitting `lo` toward the target. */
  async function refine(h, lo, hi) {
    let slope = hi && hi.q > lo.q && hi.size > lo.blob.size ? Math.log(hi.size / lo.blob.size) / (hi.q - lo.q) : DEFAULT_SLOPE;
    for (let i = 0; i < MAX_REFINE; i++) {
      if (lo.blob.size >= targetBytes * CLOSE_ENOUGH || lo.q >= Q_MAX) break;
      if (hi && hi.q - lo.q <= 0.02) break;
      let q = lo.q + Math.log((targetBytes * 0.985) / lo.blob.size) / slope;
      q = Math.min(Q_MAX, Math.max(lo.q + 0.02, q));
      if (hi) q = Math.min(q, hi.q - 0.01);
      const b = await enc(h, q);
      if (b.size <= targetBytes) lo = { q, blob: b }; else hi = { q, size: b.size };
      if (hi && hi.q > lo.q && hi.size > lo.blob.size) slope = Math.max(0.5, Math.log(hi.size / lo.blob.size) / (hi.q - lo.q));
    }
    return lo;
  }

  try {
    let top = null, smallest = null;
    const note = (h, blob, q) => { if (!smallest || blob.size < smallest.blob.size) smallest = { blob, q, w: h.w, h: h.h, scale: h.w / baseW }; };
    const measured = [];   // {a: area fraction, size} at floor quality

    const skipFull = hintBytes > 0 && targetBytes < hintBytes * 0.02;
    if (!skipFull) {
      const h1 = await open(1);
      if (hintBytes > 0 && targetBytes >= hintBytes * 0.9) {            // target is near/above the original: likely fits at high quality
        top = await enc(h1, Q_MAX);
        if (top.size <= targetBytes) return { ...result(h1, top, Q_MAX, true), reached: true, targetBytes, iterations, renders, fullSizeEncodes };
      }
      const floor = await enc(h1, Q_FLOOR);
      note(h1, floor, Q_FLOOR);
      if (floor.size <= targetBytes) {
        const lo = await refine(h1, { q: Q_FLOOR, blob: floor }, top && { q: Q_MAX, size: top.size });
        return { ...result(h1, lo.blob, lo.q, true), reached: true, targetBytes, iterations, renders, fullSizeEncodes };
      }
      measured.push({ a: 1, size: floor.size });
      drop(h1);
    }

    // B. choose a smaller size
    let fit = null;                                  // best floor-quality fit so far: {h, blob, a}
    let noFitA = 1.0001;                             // smallest area known NOT to fit (full size failed, or is untested if skipped)
    if (skipFull) noFitA = Infinity;
    let guessSize = skipFull ? hintBytes * 0.25 : null;   // untested guess of full-size floor bytes
    for (let i = 0; i < MAX_SCALE_PROBES; i++) {
      // next area from the latest measurement (or the guess), exponent refit from the last two measurements
      let k = 1.3;
      if (measured.length >= 2) {
        const p = measured[measured.length - 1], q = measured[measured.length - 2];
        if (Math.abs(Math.log(p.a / q.a)) > 0.1 && p.size !== q.size) k = Math.min(3.5, Math.max(0.9, Math.log(p.size / q.size) / Math.log(p.a / q.a)));
      }
      const ref = measured.length ? measured[measured.length - 1] : { a: 1, size: guessSize };
      let a = ref.a * Math.pow((AIM * targetBytes) / ref.size, 1 / k);
      if (fit) a = Math.max(a, fit.a * 1.05);
      if (isFinite(noFitA)) a = Math.min(a, noFitA * 0.95);
      a = Math.min(1, Math.max(minScale * minScale, a));
      if (fit && a <= fit.a * 1.02) break;           // interval collapsed

      const h = await open(Math.sqrt(a));
      const blob = await enc(h, Q_FLOOR);
      const am = areaOf(h);
      note(h, blob, Q_FLOOR);
      measured.push({ a: am, size: blob.size });
      if (blob.size <= targetBytes) {
        if (!fit || am > fit.a) { drop(fit && fit.h); fit = { h, blob, a: am }; } else drop(h);
        if (blob.size >= targetBytes * FIT_FLOOR || am >= 0.999) break;   // good enough, or already full size
      } else {
        drop(h);
        noFitA = Math.min(noFitA, am);
        if (h.w <= Math.round(baseW * minScale) + 1 || h.h <= Math.round(baseH * minScale) + 1) break;   // cannot shrink further
      }
    }

    if (fit) {
      const lo = await refine(fit.h, { q: Q_FLOOR, blob: fit.blob }, null);
      return { ...result(fit.h, lo.blob, lo.q, true), reached: true, targetBytes, iterations, renders, fullSizeEncodes };
    }
    // D. unreachable: hand back the smallest thing we produced
    return { fits: false, blob: smallest.blob, quality: smallest.q, scale: smallest.scale, width: smallest.w, height: smallest.h,
      reached: false, atMinimum: true, targetBytes, iterations, renders, fullSizeEncodes };
  } finally {
    held.forEach((h) => release(h.c));
    held.clear();
  }
}
