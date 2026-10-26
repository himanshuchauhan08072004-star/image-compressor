import { PAPERS as PAPER_TABLE, resolvePaper } from './paper.js';
import { planLayout, LAYOUT_LIMITS } from './layout.js';

/**
 * Classic single-size print sheet (Phase 4 API, unchanged for callers). Since Phase 7 it is a thin wrapper around the shared
 * layout engine in layout.js, so the preview, the PDF and this function can never disagree. Paper is a key ('A4', 'A5',
 * 'LETTER'); for custom paper or several photo sizes call planLayout() directly.
 */
export const PAPERS = PAPER_TABLE;
export const LIMITS = { marginMax: LAYOUT_LIMITS.marginMax, gapMax: LAYOUT_LIMITS.gapMax, copiesMax: LAYOUT_LIMITS.copiesMax, pagesMax: LAYOUT_LIMITS.pagesMax };

export function validateSheet(o) {
  const rp = resolvePaper(o.paper); if (!rp.ok) return { ok: false, error: 'Choose a paper size.' };
  const { margin, gap, copies } = o;
  if (![margin, gap, copies].every(Number.isFinite)) return { ok: false, error: 'Enter numbers for margin, spacing and copies.' };
  if (margin < 0 || margin > LIMITS.marginMax) return { ok: false, error: 'Margin must be 0 to ' + LIMITS.marginMax + ' mm.' };
  if (gap < 0 || gap > LIMITS.gapMax) return { ok: false, error: 'Spacing must be 0 to ' + LIMITS.gapMax + ' mm.' };
  if (!Number.isInteger(copies) || copies < 1 || copies > LIMITS.copiesMax) return { ok: false, error: 'Copies must be a whole number from 1 to ' + LIMITS.copiesMax + '.' };
  return { ok: true, paper: rp.paper };
}

/**
 * Grid of one photo size on a page. Rows are filled left to right from the top-left of the printable area.
 * Never clips: if even one photo does not fit inside the margins, returns an error. More copies than fit on a page
 * continue on extra pages. Returns { ok, page, printable, cols, rows, perPage, pages: [[{x,y,w,h}]], total }.
 */
export function layoutSheet({ paper = 'A4', landscape = false, margin, gap, copies, photoW, photoH }) {
  const v = validateSheet({ paper, margin, gap, copies }); if (!v.ok) return v;
  if (!(photoW > 0 && photoH > 0)) return { ok: false, error: 'The photo size is not set.' };
  const r = planLayout({ paper, landscape, margin, hGap: gap, vGap: gap, groups: [{ w: photoW, h: photoH, copies }] });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, page: r.page, printable: r.printable, cols: r.cols, rows: r.rows, perPage: r.perPage, total: r.total, pages: r.pages.map((p) => p.map(({ x, y, w, h }) => ({ x, y, w, h }))) };
}
