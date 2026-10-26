/**
 * Paper sizes and units. Pure. Everything inside the layout engine is millimetres; inches exist only at the edges
 * (input fields and display). Screen pixels never appear here: physical size comes from millimetres, and the PDF
 * writer turns millimetres into points (1/72 in).
 */
export const PAPERS = {
  A4: { label: 'A4', w: 210, h: 297 },
  A5: { label: 'A5', w: 148, h: 210 },
  LETTER: { label: 'US Letter', w: 215.9, h: 279.4 },          // 8.5 × 11 in
};
export const CUSTOM = 'CUSTOM';
export const PAPER_MIN_MM = 20, PAPER_MAX_MM = 1200;               // 1200 mm = 47.2 in, well inside the PDF page limit (14400 pt)
export const UNITS = { mm: { label: 'mm', mm: 1 }, in: { label: 'in', mm: 25.4 } };
export const MM_PER_IN = 25.4;

const r6 = (v) => Math.round(v * 1e6) / 1e6;
export const r2 = (v) => Math.round(v * 100) / 100;
export const toMm = (v, unit = 'mm') => r6(v * UNITS[unit].mm);
export const fromMm = (mm, unit = 'mm') => r6(mm / UNITS[unit].mm);
export const isUnit = (u) => Object.prototype.hasOwnProperty.call(UNITS, u);
export const isPaperKey = (k) => Object.prototype.hasOwnProperty.call(PAPERS, k) || k === CUSTOM;

/**
 * paper: 'A4' | { key:'A4'|'A5'|'LETTER' } | { key:'CUSTOM', w, h, unit:'mm'|'in' }.
 * Returns { ok, paper:{ key, label, w, h (mm, as defined), custom } } or { ok:false, error }.
 */
export function resolvePaper(p) {
  if (typeof p === 'string') p = { key: p };
  if (!p || typeof p !== 'object' || !isPaperKey(p.key)) return { ok: false, error: 'Choose a paper size.' };
  if (p.key !== CUSTOM) { const s = PAPERS[p.key]; return { ok: true, paper: { key: p.key, label: s.label, w: s.w, h: s.h, custom: false } }; }
  const unit = p.unit == null ? 'mm' : p.unit;
  if (!isUnit(unit)) return { ok: false, error: 'Choose millimetres or inches for the paper size.' };
  if (typeof p.w !== 'number' || typeof p.h !== 'number' || !Number.isFinite(p.w) || !Number.isFinite(p.h)) return { ok: false, error: 'Enter a width and a height for the paper.' };
  if (p.w <= 0 || p.h <= 0) return { ok: false, error: 'Paper width and height must be greater than zero.' };
  const w = toMm(p.w, unit), h = toMm(p.h, unit);
  if (w < PAPER_MIN_MM - 1e-9 || h < PAPER_MIN_MM - 1e-9 || w > PAPER_MAX_MM + 1e-9 || h > PAPER_MAX_MM + 1e-9) {
    return { ok: false, error: 'Each paper side must be between ' + r2(fromMm(PAPER_MIN_MM, unit)) + ' and ' + r2(fromMm(PAPER_MAX_MM, unit)) + ' ' + unit + '.' };
  }
  return { ok: true, paper: { key: CUSTOM, label: 'Custom', w, h, custom: true } };
}

/** Page in millimetres. Portrait = the short side is the width; landscape swaps. Same rule for every paper. */
export function pageSize(paper, landscape = false) {
  const lo = Math.min(paper.w, paper.h), hi = Math.max(paper.w, paper.h);
  return landscape ? { w: hi, h: lo } : { w: lo, h: hi };
}

export const paperPoints = (page) => ({ w: (page.w / MM_PER_IN) * 72, h: (page.h / MM_PER_IN) * 72 });
