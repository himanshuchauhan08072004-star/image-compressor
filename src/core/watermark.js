import { normalizeHex } from './color.js';

/**
 * Watermark Studio maths. Pure (no DOM): parameters, mark size and where the copies go.
 * A mark is drawn once to its own canvas, then stamped at each placement with one global opacity, so overlaps and the
 * text outline never double-darken. Size is a % of the image WIDTH, margin a % of the SHORTER side, so one setting
 * looks the same on a phone photo and a 24 MP camera file (that is what makes batch watermarking sensible).
 */
export const FONTS = {
  sans: { label: 'Sans', stack: 'system-ui, "Segoe UI", Helvetica, Arial, sans-serif' },
  serif: { label: 'Serif', stack: 'Georgia, "Times New Roman", Times, serif' },
  mono: { label: 'Mono', stack: 'ui-monospace, Menlo, Consolas, "Courier New", monospace' },
};
export const POSITIONS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
export const POSITION_LABELS = { tl: 'Top left', tc: 'Top centre', tr: 'Top right', ml: 'Middle left', mc: 'Centre', mr: 'Middle right', bl: 'Bottom left', bc: 'Bottom centre', br: 'Bottom right' };
export const RANGES = { size: [1, 100], opacity: [0, 100], rotation: [-180, 180], margin: [0, 25], gap: [0, 200] };
export const MAX_TEXT = 200, MAX_LINES = 3;
export const MAX_MARKS = 1500;            // tiled copies drawn per image
export const MAX_MARK_PIXELS = 16_000_000; // one mark canvas
export const LOGO_MAX_SIDE = 2048;         // logos are reduced to this before use (never enlarged)
export const DEFAULTS = { type: 'text', text: '© Your name', font: 'sans', bold: true, color: '#ffffff', outline: true, size: 24, opacity: 60, rotation: 0, mode: 'single', position: 'br', margin: 3, gap: 60, stagger: true };

export const PRESETS = [
  { key: 'corner', label: 'Copyright corner', hint: 'Small text in the bottom-right corner.', values: { type: 'text', mode: 'single', position: 'br', size: 22, opacity: 65, rotation: 0, margin: 3, bold: true, color: '#ffffff', outline: true } },
  { key: 'diagonal', label: 'Diagonal tiled', hint: 'Repeated diagonal text across the whole image.', values: { type: 'text', mode: 'tile', size: 20, opacity: 28, rotation: -30, gap: 70, stagger: true, bold: true, color: '#ffffff', outline: true } },
  { key: 'center', label: 'Centre stamp', hint: 'One large, faint mark in the middle.', values: { type: 'text', mode: 'single', position: 'mc', size: 55, opacity: 35, rotation: -20, bold: true, color: '#ffffff', outline: true } },
  { key: 'logo', label: 'Logo corner', hint: 'Your logo, bottom-right (upload a logo first).', values: { type: 'logo', mode: 'single', position: 'br', size: 16, opacity: 85, rotation: 0, margin: 3 } },
];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const num = (v, d, lo, hi) => (v !== '' && v !== null && Number.isFinite(Number(v)) ? clamp(Math.round(Number(v)), lo, hi) : d);

/** Anything in, a complete safe parameter set out. Text is data only: it is only ever drawn on a canvas. */
export function normalizeWatermark(raw = {}) {
  const o = {};
  for (const [k, [lo, hi]] of Object.entries(RANGES)) o[k] = num(raw[k], DEFAULTS[k], lo, hi);
  o.type = raw.type === 'logo' ? 'logo' : 'text';
  o.text = typeof raw.text === 'string' ? raw.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').split('\n').slice(0, MAX_LINES).map((l) => l.trim()).join('\n').slice(0, MAX_TEXT) : DEFAULTS.text;
  o.font = Object.hasOwn(FONTS, raw.font) ? raw.font : DEFAULTS.font;
  o.bold = raw.bold === undefined ? DEFAULTS.bold : !!raw.bold;
  o.outline = raw.outline === undefined ? DEFAULTS.outline : !!raw.outline;
  o.stagger = raw.stagger === undefined ? DEFAULTS.stagger : !!raw.stagger;
  o.color = normalizeHex(raw.color, DEFAULTS.color);
  o.mode = raw.mode === 'tile' ? 'tile' : 'single';
  o.position = POSITIONS.includes(raw.position) ? raw.position : DEFAULTS.position;
  return o;
}

/** Is there anything to draw? (empty text, or a logo mark with no logo loaded, draws nothing.) */
export const hasContent = (wm, hasLogo) => (wm.type === 'logo' ? !!hasLogo : wm.text.trim().length > 0);

/** Outline colour that stays readable against the text colour. */
export function contrastColor(hex) {
  const c = normalizeHex(hex, '#ffffff'), [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#000000' : '#ffffff';
}

/** Mark size in px for an image. `aspect` = width / height of the mark content. Capped so one mark never exceeds MAX_MARK_PIXELS. */
export function markDims(imgW, aspect, wm) {
  let w = Math.max(1, Math.round((wm.size / 100) * imgW)), h = Math.max(1, Math.round(w / aspect));
  if (w * h > MAX_MARK_PIXELS) { const k = Math.sqrt(MAX_MARK_PIXELS / (w * h)); w = Math.max(1, Math.floor(w * k)); h = Math.max(1, Math.floor(h * k)); }
  return { w, h };
}

/** Half-extents of the box around a w x h mark rotated by `angle` radians. */
export const halfBox = (w, h, angle) => {
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  return { hw: (w * c + h * s) / 2, hh: (w * s + h * c) / 2 };
};

/**
 * Where the copies of a mw x mh mark go on an imgW x imgH image.
 * single: the chosen 3x3 anchor, kept INSIDE the image (the rotated box is measured, not the unrotated one);
 *         `clipped` is set when the mark is bigger than the image and cannot fit.
 * tile:   a grid (optionally brick-staggered) laid out around the image centre, rotated by the same angle as each mark,
 *         copies fully outside the image dropped; refuses an absurd count.
 * Returns { ok, marks: [{ x, y }] (centres), angle, clipped } or { ok: false, error }.
 */
export function planMarks(imgW, imgH, mw, mh, wm) {
  const angle = (wm.rotation * Math.PI) / 180, { hw, hh } = halfBox(mw, mh, angle);
  if (!(imgW >= 1 && imgH >= 1 && mw >= 1 && mh >= 1)) return { ok: false, error: { code: 'size', message: 'Nothing to draw: the watermark or the image has no size.' } };
  if (wm.mode === 'single') {
    const m = (wm.margin / 100) * Math.min(imgW, imgH), row = wm.position[0], col = wm.position[1];
    const clipped = 2 * hw > imgW || 2 * hh > imgH;
    const at = (side, mid, full, half) => (clipped && 2 * half > full ? full / 2 : side === 'm' || side === 'c' ? full / 2 : side === 't' || side === 'l' ? m + half : full - m - half);
    const x = at(col === 'c' ? 'c' : col, 'c', imgW, hw), y = at(row === 'm' ? 'm' : row, 'm', imgH, hh);
    return { ok: true, marks: [{ x: clamp(x, Math.min(hw, imgW / 2), Math.max(imgW - hw, imgW / 2)), y: clamp(y, Math.min(hh, imgH / 2), Math.max(imgH - hh, imgH / 2)) }], angle, clipped };
  }
  const cellW = mw * (1 + wm.gap / 100), cellH = mh * (1 + wm.gap / 100), R = Math.hypot(imgW, imgH) / 2 + Math.max(mw, mh);
  const nI = Math.ceil(R / cellW) + 1, nJ = Math.ceil(R / cellH) + 1;
  if ((2 * nI + 1) * (2 * nJ + 1) > MAX_MARKS * 6) return { ok: false, error: { code: 'too-many', message: 'That would repeat the watermark far too many times. Make it bigger or increase the spacing.' } };
  const cos = Math.cos(angle), sin = Math.sin(angle), marks = [];
  for (let j = -nJ; j <= nJ; j++) {
    for (let i = -nI; i <= nI; i++) {
      const u = i * cellW + (wm.stagger && Math.abs(j) % 2 === 1 ? cellW / 2 : 0), v = j * cellH;
      const x = imgW / 2 + u * cos - v * sin, y = imgH / 2 + u * sin + v * cos;
      if (Math.abs(x - imgW / 2) < imgW / 2 + hw && Math.abs(y - imgH / 2) < imgH / 2 + hh) marks.push({ x, y });
    }
  }
  if (marks.length > MAX_MARKS) return { ok: false, error: { code: 'too-many', message: 'That would repeat the watermark ' + marks.length + ' times (limit ' + MAX_MARKS + '). Make it bigger or increase the spacing.' } };
  return { ok: true, marks, angle, clipped: false };
}

/** Plain-language notes about a plan (shown next to the preview). */
export function planNotes(wm, plan, { markW, logoScale } = {}) {
  const n = [];
  if (!plan.ok) return n;
  if (plan.clipped) n.push('The watermark is larger than the image, so parts of it are cut off. Lower the size.');
  if (markW < 24) n.push('The watermark is very small and may be hard to read.');
  if (wm.type === 'logo' && logoScale > 1.001) n.push('The logo is enlarged to ' + Math.round(logoScale * 100) + '% of its own size, so it may look soft. Use a larger logo file or a smaller size.');
  if (wm.opacity < 5) n.push('Opacity is almost zero: the watermark is nearly invisible.');
  if (wm.mode === 'tile') n.push(plan.marks.length + ' copies.');
  return n;
}
