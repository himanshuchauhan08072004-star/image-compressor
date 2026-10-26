import { MAX_OUTPUT_PIXELS, MAX_SIDE } from './limits.js';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const fail = (code, message) => ({ ok: false, error: { code, message } });

/** Keep a crop rect integer and inside the image. Returns null if unusable. */
export function normalizeCrop(c, sw, sh) {
  if (!c) return null;
  const x = clamp(Math.round(c.x), 0, sw - 1);
  const y = clamp(Math.round(c.y), 0, sh - 1);
  const w = clamp(Math.round(c.w), 1, sw - x);
  const h = clamp(Math.round(c.h), 1, sh - y);
  return w >= 1 && h >= 1 ? { x, y, w, h } : null;
}

/**
 * Single source of truth for geometry: source size + {crop, resize} -> draw plan.
 * resize = { mode:'scale'|'exact', width, height, fit:'fill'|'contain'|'stretch', allowUpscale }
 * Coordinates are in the already-oriented bitmap (EXIF applied at decode time).
 */
export function planOutput(sw, sh, { crop = null, resize = null } = {}) {
  const c = crop ? normalizeCrop(crop, sw, sh) : { x: 0, y: 0, w: sw, h: sh };
  if (!c) return fail('crop', 'The crop area is outside the image.');

  let outW = c.w, outH = c.h;
  let src = { ...c };
  let dst = { x: 0, y: 0, w: outW, h: outH };
  let pad = false;

  if (resize) {
    const tw = Math.round(resize.width), th = Math.round(resize.height);
    if (!(tw >= 1 && th >= 1)) return fail('size', 'Enter a width and height of at least 1 px.');
    outW = tw; outH = th;
    const rx = tw / c.w, ry = th / c.h;
    let scale = Math.max(rx, ry);
    dst = { x: 0, y: 0, w: tw, h: th };

    if (resize.mode === 'exact' && resize.fit === 'fill') {
      const rw = tw / scale, rh = th / scale;
      src = { x: c.x + (c.w - rw) / 2, y: c.y + (c.h - rh) / 2, w: rw, h: rh };
    } else if (resize.mode === 'exact' && resize.fit === 'contain') {
      scale = Math.min(rx, ry);
      const dw = c.w * scale, dh = c.h * scale;
      dst = { x: (tw - dw) / 2, y: (th - dh) / 2, w: dw, h: dh };
      pad = dw < tw - 0.5 || dh < th - 0.5;
    }
    if (scale > 1 + 1e-9 && !resize.allowUpscale) {
      return fail('upscale', 'That is larger than the original (' + c.w + ' × ' + c.h + '). Tick “Allow enlarging” to make it bigger.');
    }
  }

  if (outW > MAX_SIDE || outH > MAX_SIDE || outW * outH > MAX_OUTPUT_PIXELS) {
    const mp = Math.round((outW * outH) / 1e6), cap = MAX_OUTPUT_PIXELS / 1e6;
    return fail('too-big', resize
      ? 'That output would be ' + outW + ' × ' + outH + ' (' + mp + ' MP). The limit is ' + cap + ' MP and ' + MAX_SIDE + ' px per side.'
      : 'This image is ' + outW + ' × ' + outH + ' (' + mp + ' MP), over the ' + cap + ' MP output limit. Use Resize (for example 50%) or Crop to make it smaller first.');
  }
  return { ok: true, plan: { outW, outH, src, dst, pad } };
}

/** Shrink a plan uniformly (used by the target-size solver). */
export function scalePlan(plan, s) {
  const outW = Math.max(1, Math.round(plan.outW * s));
  const outH = Math.max(1, Math.round(plan.outH * s));
  const fx = outW / plan.outW, fy = outH / plan.outH;
  const d = plan.dst;
  return { ...plan, outW, outH, dst: { x: d.x * fx, y: d.y * fy, w: d.w * fx, h: d.h * fy } };
}

/** Aspect-linked dimension. changed = 'width' | 'height'. */
export function linkedSize(changed, value, baseW, baseH) {
  const v = Math.max(1, Math.round(value));
  return changed === 'width'
    ? { width: v, height: Math.max(1, Math.round((v * baseH) / baseW)) }
    : { width: Math.max(1, Math.round((v * baseW) / baseH)), height: v };
}

/** Largest centred rect with the given ratio (w/h) inside sw x sh. */
export function fitAspectRect(sw, sh, ratio) {
  let w = sw, h = Math.round(sw / ratio);
  if (h > sh) { h = sh; w = Math.round(sh * ratio); }
  return { x: Math.round((sw - w) / 2), y: Math.round((sh - h) / 2), w, h };
}

export function moveRect(r, dx, dy, b) {
  return { ...r, x: Math.round(clamp(r.x + dx, 0, b.w - r.w)), y: Math.round(clamp(r.y + dy, 0, b.h - r.h)) };
}

/**
 * Drag a handle ('n','s','e','w','ne','nw','se','sw') by (dx,dy) source px.
 * ratio = w/h to lock aspect, or null for free. Always stays inside bounds {w,h}.
 */
export function resizeRect(r, handle, dx, dy, b, ratio = null, min = 16) {
  const hasE = handle.includes('e'), hasW = handle.includes('w');
  const hasN = handle.includes('n'), hasS = handle.includes('s');

  if (!ratio) {
    let l = r.x, t = r.y, rt = r.x + r.w, bt = r.y + r.h;
    if (hasW) l = clamp(l + dx, 0, rt - min);
    if (hasE) rt = clamp(rt + dx, l + min, b.w);
    if (hasN) t = clamp(t + dy, 0, bt - min);
    if (hasS) bt = clamp(bt + dy, t + min, b.h);
    return { x: Math.round(l), y: Math.round(t), w: Math.round(rt - l), h: Math.round(bt - t) };
  }

  const minW = Math.max(min, min * ratio);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  let W, H, x, y;

  if ((hasE || hasW) && (hasN || hasS)) {           // corner: anchor opposite corner
    const ax = hasE ? r.x : r.x + r.w, ay = hasS ? r.y : r.y + r.h;
    const reqW = r.w + (hasE ? dx : -dx), reqH = r.h + (hasS ? dy : -dy);
    W = Math.abs(dx) >= Math.abs(dy * ratio) ? reqW : reqH * ratio;
    const maxW = Math.min(hasE ? b.w - ax : ax, (hasS ? b.h - ay : ay) * ratio);
    W = clamp(W, Math.min(minW, maxW), maxW);
    H = W / ratio;
    x = hasE ? ax : ax - W; y = hasS ? ay : ay - H;
  } else if (hasE || hasW) {                        // left/right edge: grow about vertical centre
    const ax = hasE ? r.x : r.x + r.w;
    const maxW = Math.min(hasE ? b.w - ax : ax, 2 * Math.min(cy, b.h - cy) * ratio);
    W = clamp(r.w + (hasE ? dx : -dx), Math.min(minW, maxW), maxW);
    H = W / ratio;
    x = hasE ? ax : ax - W; y = cy - H / 2;
  } else {                                          // top/bottom edge: grow about horizontal centre
    const ay = hasS ? r.y : r.y + r.h;
    const maxH = Math.min(hasS ? b.h - ay : ay, (2 * Math.min(cx, b.w - cx)) / ratio);
    H = clamp(r.h + (hasS ? dy : -dy), Math.min(minW / ratio, maxH), maxH);
    W = H * ratio;
    y = hasS ? ay : ay - H; x = cx - W / 2;
  }
  const out = { x: Math.round(x), y: Math.round(y), w: Math.round(W), h: Math.round(H) };
  out.x = clamp(out.x, 0, b.w - out.w); out.y = clamp(out.y, 0, b.h - out.h);
  return out;
}
