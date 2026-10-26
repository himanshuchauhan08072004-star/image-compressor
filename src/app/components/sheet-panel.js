import { h } from '../dom.js';
import { planLayout, moveItem, LAYOUT_LIMITS, ALIGN_H, ALIGN_V } from '../../core/layout.js';
import { PAPERS, CUSTOM, UNITS, resolvePaper, toMm, fromMm, r2, PAPER_MIN_MM, PAPER_MAX_MM } from '../../core/paper.js';
import { createPresetStore, BUILTIN_PRESETS, sanitizeSettings } from '../../core/presets.js';
import { renderGroupJpeg, previewSourceRect } from '../../core/sheet-images.js';
import { exportSheetPdf } from '../../core/sheet-export.js';
import { runPipeline } from '../../core/pipeline.js';
import { jpegInfo } from '../../core/pdf.js';
import { decodeImage } from '../../core/decode.js';
import { drawScaled } from '../../core/render.js';
import { ImageError } from '../../core/errors.js';
import { formatBytes } from '../../core/format.js';

const PDF_QUALITY = 95, PX_PER_MM = 3, EXTRA_MAX = 4, EXTRA_SIDE = 3200;
const num = (el) => (el.value === '' ? NaN : Number(el.value));
const r1 = (n) => Math.round(n * 10) / 10;

function safeStorage() {
  try { const k = '__shrinkit_t'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return localStorage; }
  catch (e) { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } }; }   // storage blocked: presets last for this visit only
}

/**
 * Print-sheet workspace: layout controls, live preview (pager, manual placement), presets, PDF export.
 * ONE layout model: core/layout.js planLayout() feeds the preview below and the PDF writer in core/sheet-export.js.
 * mode 'passport': group 1 is the passport photo (size from the tool above, picture from the session). 'standalone': images are added here.
 * Ids kept from Phase 4 (#sh-paper, #sh-margin, #sh-gap, #sh-copies, #sh-fill, #sh-preview, #sh-info, #sh-error, #sh-pdf, #sh-status).
 */
export function createSheetPanel({ session = null, mode = 'passport', setPhotoSize = null } = {}) {
  const passport = mode === 'passport';
  const S = { paperKey: 'A4', cw: 210, ch: 297, unit: 'mm', landscape: false, margin: 10, hGap: 3, vGap: 3, cols: 0, rows: 0, alignH: 'left', alignV: 'top', guides: 'none', mode: 'auto', newRow: false, overlap: false, manual: {}, dpi: 300, page: 0, sel: null,
    groups: [{ id: 'g0', w: 35, h: 45, copies: 8, source: passport ? 'main' : null, fit: 'cover' }] };
  let nextGroup = 1, spec = null, out = null, alive = true, busy = false, resultBitmap = null, lastBlob = null, layout = null, drag = null, ro = null;
  const extras = new Map(), urls = new Map(), store = createPresetStore(safeStorage());

  // ---------- basic controls (Phase 4 ids)
  const paper = h('select', { id: 'sh-paper', 'aria-label': 'Paper size' }, [...Object.entries(PAPERS).map(([k, p]) => h('option', { value: k }, p.label + ' (' + r2(p.w) + ' × ' + r2(p.h) + ' mm)')), h('option', { value: CUSTOM }, 'Custom size…')]);
  const bPortrait = h('button', { type: 'button', 'aria-pressed': 'true', id: 'sh-portrait', onClick: () => { S.landscape = false; draw(); } }, 'Portrait');
  const bLandscape = h('button', { type: 'button', 'aria-pressed': 'false', id: 'sh-landscape', onClick: () => { S.landscape = true; draw(); } }, 'Landscape');
  const field = (id, label, value, min, max, step) => h('input', { type: 'number', id, value: String(value), min: String(min), max: String(max), step: String(step), inputmode: 'decimal', 'aria-label': label });
  const margin = field('sh-margin', 'Margin in millimetres', 10, 0, LAYOUT_LIMITS.marginMax, 0.5), gap = field('sh-gap', 'Spacing in millimetres', 3, 0, LAYOUT_LIMITS.gapMax, 0.5), copies = field('sh-copies', 'Number of copies', 8, 1, LAYOUT_LIMITS.copiesMax, 1);
  const fill = h('button', { type: 'button', class: 'btn btn-ghost', id: 'sh-fill', onClick: () => { if (layout && layout.ok && S.groups.length === 1) { S.groups[0].copies = layout.perPage; copies.value = layout.perPage; draw(); } } }, 'Fill one page');
  const dpiSel = h('select', { id: 'sh-dpi', 'aria-label': 'Print resolution in DPI' }, [150, 300, 600].map((d) => h('option', { value: String(d), selected: d === 300 }, d + ' DPI')));
  const paperDims = h('p', { class: 'tool-hint', id: 'sh-paper-dims', role: 'status' });

  // ---------- advanced
  const cw = field('sh-cw', 'Custom paper width', 210, 0, 5000, 0.1), ch = field('sh-ch', 'Custom paper height', 297, 0, 5000, 0.1);
  const cunit = h('select', { id: 'sh-cunit', 'aria-label': 'Paper size unit' }, Object.entries(UNITS).map(([k, u]) => h('option', { value: k }, u.label)));
  const customRow = h('div', { class: 'tool-row', id: 'sh-custom', hidden: true }, h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-cw' }, 'Paper width'), cw, h('label', { for: 'sh-ch' }, 'height'), ch, h('label', { for: 'sh-cunit' }, 'Unit'), cunit));
  const hgap = field('sh-hgap', 'Horizontal spacing in millimetres', 3, 0, LAYOUT_LIMITS.gapMax, 0.5), vgap = field('sh-vgap', 'Vertical spacing in millimetres', 3, 0, LAYOUT_LIMITS.gapMax, 0.5);
  const cols = field('sh-cols', 'Columns per row, 0 for automatic', 0, 0, LAYOUT_LIMITS.gridMax, 1), rows = field('sh-rows', 'Rows per page, 0 for automatic', 0, 0, LAYOUT_LIMITS.gridMax, 1);
  const sel = (id, label, opts) => h('select', { id, 'aria-label': label }, opts.map(([v, t]) => h('option', { value: v }, t)));
  const alignH = sel('sh-alignh', 'Horizontal alignment', ALIGN_H.map((v) => [v, v[0].toUpperCase() + v.slice(1)])), alignV = sel('sh-alignv', 'Vertical alignment', ALIGN_V.map((v) => [v, v[0].toUpperCase() + v.slice(1)]));
  const guides = sel('sh-guides', 'Cutting guides', [['none', 'None'], ['box', 'Outline around each photo']]);
  const newRow = h('input', { type: 'checkbox', id: 'sh-newrow' }), overlap = h('input', { type: 'checkbox', id: 'sh-overlap' });
  const bAuto = h('button', { type: 'button', id: 'sh-mode-auto', 'aria-pressed': 'true', onClick: () => { S.mode = 'auto'; draw(); } }, 'Automatic');
  const bManual = h('button', { type: 'button', id: 'sh-mode-manual', 'aria-pressed': 'false', onClick: () => { S.mode = 'manual'; draw(); } }, 'Manual');
  const resetPos = h('button', { type: 'button', class: 'btn btn-ghost', id: 'sh-reset-pos', onClick: () => { S.manual = {}; draw(); } }, 'Reset positions');
  const selPrev = h('button', { type: 'button', class: 'btn btn-ghost', id: 'sh-sel-prev', onClick: () => cycle(-1) }, 'Previous photo'), selNext = h('button', { type: 'button', class: 'btn btn-ghost', id: 'sh-sel-next', onClick: () => cycle(1) }, 'Next photo');
  const selX = field('sh-sel-x', 'Selected photo, distance from left edge in millimetres', 0, 0, 5000, 0.5), selY = field('sh-sel-y', 'Selected photo, distance from top edge in millimetres', 0, 0, 5000, 0.5);
  const manualRow = h('div', { class: 'tool-row', id: 'sh-manual-tools', hidden: true }, selPrev, selNext, h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-sel-x' }, 'X'), selX, h('label', { for: 'sh-sel-y' }, 'Y'), selY, h('span', { class: 'readout' }, 'mm')), resetPos);
  const manualHint = h('p', { class: 'tool-hint', id: 'sh-manual-hint', hidden: true }, 'Manual: click a photo in the preview and drag it, or use the arrow keys (Shift = 5 mm), or type X and Y. Photos stay inside the printable area and cannot overlap unless you allow it.');

  // groups
  const groupsBox = h('div', { id: 'sh-groups', class: 'sh-groups' });
  const addGroup = h('button', { type: 'button', class: 'btn btn-ghost', id: 'sh-add-group', onClick: () => { if (S.groups.length >= LAYOUT_LIMITS.groupsMax) return; S.groups.push({ id: 'g' + nextGroup++, w: 50, h: 70, copies: 1, source: defaultSource(), fit: 'cover' }); renderGroups(); draw(); } }, 'Add photo size');
  const addImage = h('input', { type: 'file', id: 'sh-add-image', accept: 'image/*,.heic,.heif', 'aria-label': 'Add another picture to use on the sheet' });
  const addNote = h('p', { class: 'tool-hint', id: 'sh-add-note', role: 'status' });

  // presets
  const presetSel = h('select', { id: 'sh-preset', 'aria-label': 'Layout preset' }), presetName = h('input', { type: 'text', id: 'sh-preset-name', maxlength: '40', placeholder: 'Name', 'aria-label': 'Layout name' });
  const presetStatus = h('p', { class: 'tool-hint', id: 'sh-preset-status', role: 'status' });
  const pBtn = (id, label, fn) => h('button', { type: 'button', class: 'btn btn-ghost', id, onClick: fn }, label);

  // ---------- preview + output
  const canvas = h('canvas', { id: 'sh-preview', class: 'sh-preview', tabindex: '0', 'aria-label': 'Preview of the print sheet, page 1' });
  const pPrev = h('button', { type: 'button', class: 'btn btn-ghost', id: 'sh-prev', onClick: () => { S.page = Math.max(0, S.page - 1); draw(); } }, 'Previous page'), pNext = h('button', { type: 'button', class: 'btn btn-ghost', id: 'sh-next', onClick: () => { S.page += 1; draw(); } }, 'Next page');
  const pageLabel = h('span', { class: 'readout', id: 'sh-page-label' });
  const info = h('p', { class: 'tool-hint', id: 'sh-info' }), error = h('p', { class: 'dz-error', role: 'alert', hidden: true, id: 'sh-error' });
  const space = h('p', { class: 'tool-hint', id: 'sh-space' }), scale = h('p', { class: 'tool-hint', id: 'sh-scale' });
  const warn = h('ul', { class: 'sh-warn', id: 'sh-warn', role: 'status' }), legend = h('ul', { class: 'sh-legend', id: 'sh-legend' });
  const pdfBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'sh-pdf', onClick: () => makePdf() }, 'Download PDF');
  const status = h('p', { class: 'tool-hint', id: 'sh-status', role: 'status' });

  const advanced = h('details', { class: 'sh-adv', id: 'sh-advanced' }, h('summary', {}, 'Advanced layout'),
    customRow,
    h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-hgap' }, 'Horizontal spacing'), hgap, h('span', { class: 'readout' }, 'mm')), h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-vgap' }, 'Vertical spacing'), vgap, h('span', { class: 'readout' }, 'mm'))),
    h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-cols' }, 'Columns (0 = auto)'), cols), h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-rows' }, 'Rows (0 = auto)'), rows), h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-dpi' }, 'Resolution'), dpiSel)),
    h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-alignh' }, 'Align horizontally'), alignH), h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-alignv' }, 'Align vertically'), alignV), h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-guides' }, 'Cutting guides'), guides)),
    h('div', { class: 'tool-row' }, h('label', { class: 'check' }, newRow, 'Start each photo size on a new row'), h('label', { class: 'check' }, overlap, 'Allow photos to overlap')),
    h('p', { class: 'tool-title' }, 'Photo sizes on this sheet'),
    h('p', { class: 'tool-hint' }, 'Each group has its own size, copies and picture. Photos are packed row by row in the order listed (rows only, no rotation), so a different order can give a different result.'),
    groupsBox, h('div', { class: 'tool-row' }, addGroup, h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-add-image' }, 'Add a picture'), addImage)), addNote,
    h('p', { class: 'tool-title' }, 'Layout mode'),
    h('div', { class: 'tool-row' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Layout mode' }, bAuto, bManual)), manualHint, manualRow,
    h('p', { class: 'tool-title' }, 'Layout presets'),
    h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-preset' }, 'Preset'), presetSel), pBtn('sh-preset-apply', 'Apply', applyPreset), pBtn('sh-preset-rename', 'Rename', renamePreset), pBtn('sh-preset-delete', 'Delete', deletePreset)),
    h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-preset-name' }, 'Name'), presetName), pBtn('sh-preset-save', 'Save current layout', savePreset)),
    h('p', { class: 'tool-hint' }, 'A preset keeps layout settings only (paper, margins, spacing, photo sizes, copies). It never contains your pictures. Saved presets stay in this browser.'), presetStatus);

  const el = h('section', { class: 'tool-area sheet-panel', 'aria-label': 'Print sheet' },
    h('p', { class: 'tool-title' }, 'Print sheet'),
    h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-paper' }, 'Paper'), paper), h('div', { class: 'seg', role: 'group', 'aria-label': 'Page orientation' }, bPortrait, bLandscape)),
    paperDims,
    h('div', { class: 'tool-row' },
      h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-margin' }, 'Margin'), margin, h('span', { class: 'readout' }, 'mm')),
      h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-gap' }, 'Spacing'), gap, h('span', { class: 'readout' }, 'mm')),
      h('div', { class: 'ctrl-group' }, h('label', { for: 'sh-copies' }, 'Copies'), copies), fill),
    advanced, error, warn,
    h('div', { class: 'tool-row sh-pager' }, pPrev, pageLabel, pNext),
    h('div', { class: 'sh-wrap' }, canvas), scale, info, space, legend,
    h('div', { class: 'tool-row' }, pdfBtn), status,
    h('p', { class: 'tool-hint' }, 'The preview is scaled to fit your screen; the PDF is made at the real paper size. Photos are placed at their physical size. The PDF embeds each photo as a JPEG whatever format you pick above. Print at 100% / “actual size”, with no “fit to page”.'));

  // ---------- state <-> inputs
  const hasSource = (id) => id === 'main' ? passport : extras.has(id);
  function defaultSource() { return passport ? 'main' : (extras.size ? [...extras.keys()][0] : null); }
  function paperObj() { return S.paperKey === CUSTOM ? { key: CUSTOM, w: S.cw, h: S.ch, unit: S.unit } : { key: S.paperKey }; }
  function snapshot() {
    return { paper: paperObj(), landscape: S.landscape, margin: S.margin, hGap: S.hGap, vGap: S.vGap, cols: S.cols, rows: S.rows, align: { h: S.alignH, v: S.alignV }, guides: S.guides, newRowPerGroup: S.newRow,
      groups: S.groups.map((g, i) => ({ w: passport && i === 0 && spec ? spec.wMM : g.w, h: passport && i === 0 && spec ? spec.hMM : g.h, copies: g.copies, fit: g.fit })) };
  }
  function writeInputs() {
    paper.value = S.paperKey; cw.value = S.cw; ch.value = S.ch; cunit.value = S.unit; margin.value = S.margin; hgap.value = S.hGap; vgap.value = S.vGap;
    gap.value = S.hGap === S.vGap ? S.hGap : ''; gap.disabled = S.hGap !== S.vGap; gap.placeholder = gap.disabled ? 'see advanced' : '';
    copies.value = S.groups[0].copies; cols.value = S.cols; rows.value = S.rows; alignH.value = S.alignH; alignV.value = S.alignV; guides.value = S.guides; newRow.checked = S.newRow; overlap.checked = S.overlap; dpiSel.value = String(S.dpi);
  }
  const bind = (inp, fn, ev = 'input') => inp.addEventListener(ev, () => { fn(); draw(); });
  paper.addEventListener('change', () => { S.paperKey = paper.value; draw(); });
  bind(cw, () => { S.cw = num(cw); }); bind(ch, () => { S.ch = num(ch); });
  cunit.addEventListener('change', () => { const to = cunit.value; if (Number.isFinite(S.cw)) S.cw = r2(fromMm(toMm(S.cw, S.unit), to)); if (Number.isFinite(S.ch)) S.ch = r2(fromMm(toMm(S.ch, S.unit), to)); S.unit = to; cw.value = S.cw; ch.value = S.ch; draw(); });
  bind(margin, () => { S.margin = num(margin); }); bind(gap, () => { S.hGap = S.vGap = num(gap); hgap.value = gap.value; vgap.value = gap.value; });
  bind(hgap, () => { S.hGap = num(hgap); syncGap(); }); bind(vgap, () => { S.vGap = num(vgap); syncGap(); });
  function syncGap() { const same = S.hGap === S.vGap; gap.disabled = !same; gap.value = same ? S.hGap : ''; gap.placeholder = same ? '' : 'see advanced'; }
  bind(copies, () => { S.groups[0].copies = num(copies); });
  bind(cols, () => { S.cols = num(cols); }); bind(rows, () => { S.rows = num(rows); });
  bind(alignH, () => { S.alignH = alignH.value; }, 'change'); bind(alignV, () => { S.alignV = alignV.value; }, 'change'); bind(guides, () => { S.guides = guides.value; }, 'change');
  bind(newRow, () => { S.newRow = newRow.checked; }, 'change'); bind(overlap, () => { S.overlap = overlap.checked; }, 'change'); bind(dpiSel, () => { S.dpi = Number(dpiSel.value); }, 'change');

  // ---------- groups editor
  function renderGroups() {
    groupsBox.replaceChildren(...S.groups.map((g, i) => {
      const n = i + 1, wI = field('sh-g' + n + '-w', 'Photo group ' + n + ' width in millimetres', g.w, 5, 1200, 0.1), hI = field('sh-g' + n + '-h', 'Photo group ' + n + ' height in millimetres', g.h, 5, 1200, 0.1), cI = field('sh-g' + n + '-copies', 'Photo group ' + n + ' copies', g.copies, 1, LAYOUT_LIMITS.copiesMax, 1);
      const src = h('select', { id: 'sh-g' + n + '-src', 'aria-label': 'Photo group ' + n + ' picture' }, [...(passport ? [h('option', { value: 'main' }, 'Current photo')] : [h('option', { value: '' }, 'Choose a picture…')]), ...[...extras.values()].map((x) => h('option', { value: x.id }, x.name))]);
      src.value = g.source ?? '';
      const fit = h('select', { id: 'sh-g' + n + '-fit', 'aria-label': 'Photo group ' + n + ' fit' }, [h('option', { value: 'cover' }, 'Crop to fill'), h('option', { value: 'contain' }, 'Fit whole picture')]); fit.value = g.fit;
      const lockedSize = passport && i === 0;
      if (lockedSize) { wI.disabled = hI.disabled = true; wI.value = spec ? r2(spec.wMM) : ''; hI.value = spec ? r2(spec.hMM) : ''; }
      bind(wI, () => { g.w = num(wI); }); bind(hI, () => { g.h = num(hI); }); bind(cI, () => { g.copies = num(cI); if (i === 0) copies.value = cI.value; });
      src.addEventListener('change', () => { g.source = src.value || null; draw(); }); fit.addEventListener('change', () => { g.fit = fit.value; draw(); });
      const rm = h('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Remove photo group ' + n, onClick: () => { S.groups.splice(i, 1); S.manual = {}; renderGroups(); draw(); } }, 'Remove');
      return h('div', { class: 'sh-group-row', role: 'group', 'aria-label': 'Photo group ' + n },
        h('strong', {}, lockedSize ? 'Passport photo' : 'Size ' + n),
        h('div', { class: 'ctrl-group' }, h('label', { for: wI.id }, 'W'), wI, h('label', { for: hI.id }, 'H'), hI, h('span', { class: 'readout' }, 'mm')),
        i === 0 ? h('span', { class: 'readout' }, 'copies: set above') : h('div', { class: 'ctrl-group' }, h('label', { for: cI.id }, 'Copies'), cI),
        h('div', { class: 'ctrl-group' }, h('label', { for: src.id }, 'Picture'), src), h('div', { class: 'ctrl-group' }, h('label', { for: fit.id }, 'Fit'), fit), i > 0 ? rm : null);
    }));
  }

  async function addExtra(file) {
    addNote.textContent = '';
    if (extras.size >= EXTRA_MAX) { addNote.textContent = 'You can add up to ' + EXTRA_MAX + ' extra pictures. Remove a photo size that uses one, or reload.'; return; }
    addNote.textContent = 'Reading ' + file.name + '…';
    let decoded;
    try { decoded = await decodeImage(file); } catch (err) { addNote.textContent = err.userMessage || 'That file could not be opened.'; return; }
    try {
      const k = Math.min(1, EXTRA_SIDE / Math.max(decoded.width, decoded.height)), w = Math.max(1, Math.round(decoded.width * k)), hh = Math.max(1, Math.round(decoded.height * k));
      const c = document.createElement('canvas'); c.width = w; c.height = hh; drawScaled(c.getContext('2d'), decoded.bitmap, { x: 0, y: 0, w: decoded.width, h: decoded.height }, { x: 0, y: 0, w, h: hh });
      const bitmap = await createImageBitmap(c); c.width = 0; c.height = 0;
      if (!alive) { bitmap.close(); return; }
      const id = 'x' + nextGroup++; extras.set(id, { id, name: file.name, bitmap, width: w, height: hh });
      S.groups.forEach((g) => { if (!g.source) g.source = id; });
      addNote.textContent = file.name + ' added' + (k < 1 ? ' (reduced to ' + w + ' × ' + hh + ' px for the sheet)' : '') + '.';
    } catch (err) { addNote.textContent = err.userMessage || 'That picture could not be prepared.'; }
    finally { decoded.bitmap.close(); }
    renderGroups(); draw();
  }
  addImage.addEventListener('change', async () => { const f = addImage.files && addImage.files[0]; addImage.value = ''; if (f) await addExtra(f); });

  // ---------- presets
  function refreshPresets(keep) {
    const all = store.all(); presetSel.replaceChildren(h('optgroup', { label: 'Built-in' }, BUILTIN_PRESETS.map((p) => h('option', { value: p.id }, p.name))), ...(all.presets.some((p) => !p.builtin) ? [h('optgroup', { label: 'Saved' }, all.presets.filter((p) => !p.builtin).map((p) => h('option', { value: p.id }, p.name)))] : []));
    if (keep && [...presetSel.options].some((o) => o.value === keep)) presetSel.value = keep;
    const notes = []; if (all.corrupt) notes.push('Saved layouts could not be read and were ignored.'); if (all.dropped) notes.push(all.dropped + ' saved layout' + (all.dropped === 1 ? ' was' : 's were') + ' damaged and skipped.'); if (all.unavailable) notes.push('Saving is not available in this browser.');
    if (notes.length) presetStatus.textContent = notes.join(' ');
  }
  function applyPreset() {
    const p = store.get(presetSel.value); if (!p) { presetStatus.textContent = 'Choose a preset first.'; return; }
    const v = sanitizeSettings(p.settings); if (!v.ok) { presetStatus.textContent = 'That preset is not valid: ' + v.error; return; }
    const s = v.settings, pp = s.paper;
    S.paperKey = pp.key; if (pp.key === CUSTOM) { S.cw = pp.w; S.ch = pp.h; S.unit = pp.unit; }
    Object.assign(S, { landscape: s.landscape, margin: s.margin, hGap: s.hGap, vGap: s.vGap, cols: s.cols, rows: s.rows, alignH: s.align.h, alignV: s.align.v, guides: s.guides, newRow: s.newRowPerGroup, manual: {}, sel: null, page: 0, mode: 'auto' });
    const old = S.groups; S.groups = s.groups.map((g, i) => ({ id: old[i] ? old[i].id : 'g' + nextGroup++, w: g.w, h: g.h, copies: g.copies, fit: g.fit, source: old[i] && hasSource(old[i].source) ? old[i].source : defaultSource() }));
    if (passport && setPhotoSize) setPhotoSize(s.groups[0].w, s.groups[0].h);
    writeInputs(); renderGroups(); draw(); presetStatus.textContent = 'Applied “' + p.name + '”.';
  }
  function savePreset() { const r = store.save(presetName.value, snapshot()); if (r.ok) { presetName.value = ''; refreshPresets(r.preset.id); presetStatus.textContent = 'Saved “' + r.preset.name + '”.'; } else presetStatus.textContent = r.error; }
  function renamePreset() { const r = store.rename(presetSel.value, presetName.value); if (r.ok) { presetName.value = ''; refreshPresets(r.preset.id); presetStatus.textContent = 'Renamed to “' + r.preset.name + '”.'; } else presetStatus.textContent = r.error; }
  function deletePreset() { const p = store.get(presetSel.value), r = store.remove(presetSel.value); refreshPresets(); presetStatus.textContent = r.ok ? 'Deleted “' + p.name + '”.' : r.error; }

  // ---------- layout + preview
  function readLayout() {
    if (passport && !spec) return null;
    const groups = S.groups.map((g, i) => ({ ...g, w: passport && i === 0 ? spec.wMM : g.w, h: passport && i === 0 ? spec.hMM : g.h }));
    return planLayout({ paper: paperObj(), landscape: S.landscape, margin: S.margin, hGap: S.hGap, vGap: S.vGap, cols: S.cols, rows: S.rows, align: { h: S.alignH, v: S.alignV }, guides: S.guides, mode: S.mode, manual: S.manual, newRowPerGroup: S.newRow, allowOverlap: S.overlap, groups });
  }
  const drawableOf = (g) => (g.source === 'main' ? resultBitmap : g.source && extras.has(g.source) ? extras.get(g.source).bitmap : null);
  const imagesReady = () => !!layout && layout.ok && layout.groups.every((g) => (g.source === 'main' ? !!session && session.getState().result.status === 'ready' : !!g.source && extras.has(g.source)));
  const spacingText = () => (S.hGap === S.vGap ? 'spacing ' + S.hGap + ' mm' : 'spacing ' + S.hGap + ' mm × ' + S.vGap + ' mm');

  function draw() {
    if (!alive) return;
    bPortrait.setAttribute('aria-pressed', String(!S.landscape)); bLandscape.setAttribute('aria-pressed', String(S.landscape));
    bAuto.setAttribute('aria-pressed', String(S.mode === 'auto')); bManual.setAttribute('aria-pressed', String(S.mode === 'manual'));
    customRow.hidden = S.paperKey !== CUSTOM; manualRow.hidden = manualHint.hidden = S.mode !== 'manual'; canvas.classList.toggle('sh-manual', S.mode === 'manual');
    layout = readLayout();
    const ok = !!layout && layout.ok;
    error.hidden = ok || !layout; error.textContent = ok || !layout ? '' : layout.error;
    const rp = resolvePaper(paperObj()), pg = rp.ok ? (() => { const lo = Math.min(rp.paper.w, rp.paper.h), hi = Math.max(rp.paper.w, rp.paper.h); return S.landscape ? { w: hi, h: lo } : { w: lo, h: hi }; })() : null;
    paperDims.textContent = rp.ok ? 'Page: ' + r2(pg.w) + ' × ' + r2(pg.h) + ' mm (' + r2(fromMm(pg.w, 'in')) + ' × ' + r2(fromMm(pg.h, 'in')) + ' in)' + (S.landscape ? ', landscape' : ', portrait') : rp.error + ' (' + PAPER_MIN_MM + ' to ' + PAPER_MAX_MM + ' mm).';
    if (ok) S.page = Math.min(S.page, layout.pages.length - 1);
    const readyImg = imagesReady();
    pdfBtn.disabled = !ok || !layout.exportable || busy || !readyImg; fill.disabled = !ok || S.groups.length > 1;
    pPrev.disabled = !ok || S.page <= 0; pNext.disabled = !ok || S.page >= layout.pages.length - 1; pageLabel.textContent = ok ? 'Page ' + (S.page + 1) + ' of ' + layout.pages.length : '';
    const ctx = canvas.getContext('2d'), page = ok ? layout.page : pg || (S.landscape ? { w: 297, h: 210 } : { w: 210, h: 297 });
    canvas.width = Math.round(page.w * PX_PER_MM); canvas.height = Math.round(page.h * PX_PER_MM); canvas.style.aspectRatio = page.w + ' / ' + page.h;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    warn.replaceChildren(); legend.replaceChildren();
    if (!ok) { info.textContent = layout || !passport || spec ? '' : 'Set a valid photo size above to see the layout.'; space.textContent = ''; scale.textContent = ''; canvas.setAttribute('aria-label', 'Preview of the print sheet (no layout)'); return; }

    const Sx = PX_PER_MM;
    ctx.setLineDash([6, 6]); ctx.strokeStyle = '#c4502e'; ctx.lineWidth = 1; const pr = layout.printable; ctx.strokeRect(pr.x * Sx + 0.5, pr.y * Sx + 0.5, pr.w * Sx, pr.h * Sx); ctx.setLineDash([]);   // printable area
    const bad = new Set(layout.problems.flatMap((p) => p.keys)), seenGroup = new Set();
    ctx.font = '11px sans-serif'; ctx.textBaseline = 'top';
    for (const it of layout.pages[S.page]) {
      const x = it.x * Sx, y = it.y * Sx, w = it.w * Sx, hh = it.h * Sx, g = layout.groups[it.group], src = drawableOf(g);
      ctx.fillStyle = '#d9d6cf'; ctx.fillRect(x, y, w, hh);
      if (src) { const r = previewSourceRect(src.width, src.height, g); if (r.contain) { const k = Math.min(w / src.width, hh / src.height), dw = src.width * k, dh = src.height * k; ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, hh); ctx.drawImage(src, x + (w - dw) / 2, y + (hh - dh) / 2, dw, dh); } else ctx.drawImage(src, r.x, r.y, r.w, r.h, x, y, w, hh); }
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
      if (layout.guides === 'box') { ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.setLineDash([3, 3]); ctx.strokeRect(x, y, w, hh); ctx.setLineDash([]); }
      if (!seenGroup.has(it.group) && w > 50) { seenGroup.add(it.group); const t = r1(it.w) + '×' + r1(it.h); ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(x + 2, y + 2, ctx.measureText(t).width + 6, 15); ctx.fillStyle = '#222'; ctx.fillText(t, x + 5, y + 4); }
      if (bad.has(it.key)) { ctx.strokeStyle = '#d02020'; ctx.lineWidth = 3; ctx.strokeRect(x + 1.5, y + 1.5, w - 3, hh - 3); }
      if (S.mode === 'manual' && S.sel === it.key) { ctx.strokeStyle = '#1f6feb'; ctx.lineWidth = 3; ctx.strokeRect(x + 1.5, y + 1.5, w - 3, hh - 3); }
    }
    const one = layout.groups.length === 1, g0 = layout.groups[0];
    info.textContent = layout.paper.label + (S.landscape ? ' landscape' : ' portrait') + ' · page ' + r2(page.w) + ' × ' + r2(page.h) + ' mm · ' +
      (one ? 'photo ' + r1(g0.w) + ' × ' + r1(g0.h) + ' mm' : layout.groups.map((g) => r1(g.w) + ' × ' + r1(g.h) + ' mm ×' + g.copies).join(', ')) + ' · margin ' + S.margin + ' mm · ' + spacingText() + ' · ' + S.dpi + ' DPI · ' +
      (one ? layout.cols + ' × ' + layout.rows + ' per page (' + layout.perPage + ') · ' : '') + layout.total + (layout.total === 1 ? ' copy on ' : ' copies on ') + layout.pages.length + (layout.pages.length === 1 ? ' page.' : ' pages.') +
      (one && out ? ' Photo pixels: ' + out.w + ' × ' + out.h + ' (about ' + out.effectiveDpi + ' DPI at this size).' : '');
    const ps = layout.stats.pages[S.page];
    space.textContent = 'Page ' + (S.page + 1) + ': ' + ps.count + (ps.count === 1 ? ' photo' : ' photos') + ' · unused at the right ' + r1(ps.freeRight) + ' mm, below ' + r1(ps.freeBottom) + ' mm · ' + Math.round(layout.stats.unusedPct) + '% of the printable area is empty over all pages.';
    const dispW = canvas.getBoundingClientRect().width;
    scale.textContent = dispW > 0 ? 'Preview scale: about ' + Math.round((dispW / ((page.w / 25.4) * 96)) * 100) + '% of real size. The PDF page is exactly ' + r2(page.w) + ' × ' + r2(page.h) + ' mm.' : '';
    canvas.setAttribute('aria-label', 'Preview of the print sheet, page ' + (S.page + 1) + ' of ' + layout.pages.length + ': ' + ps.count + ' photos');
    layout.groups.forEach((g, i) => legend.append(h('li', {}, 'Size ' + (i + 1) + ': ' + r1(g.w) + ' × ' + r1(g.h) + ' mm, ' + g.copies + (g.copies === 1 ? ' copy' : ' copies') + (g.fit === 'contain' ? ', whole picture' : ''))));
    for (const m of layout.problems) { const seen = warn.textContent.includes(m.message); if (!seen) warn.append(h('li', { class: 'dz-error' }, m.message + (m.type === 'overlap' ? ' Move them apart or tick “Allow photos to overlap”.' : ''))); }
    for (const m of new Set(layout.warnings)) warn.append(h('li', {}, m));
    if (!readyImg && !busy) warn.append(h('li', {}, passport ? 'The photo is still being prepared.' : 'Choose a picture for every photo size (Advanced layout › Add a picture).'));
    if (S.mode === 'manual') { const it = layout.items.find((i) => i.key === S.sel); if (it) { if (document.activeElement !== selX) selX.value = r1(it.x); if (document.activeElement !== selY) selY.value = r1(it.y); } }
  }

  // ---------- manual placement
  const cycle = (d) => { if (!layout || !layout.ok) return; const list = layout.pages[S.page]; const i = list.findIndex((it) => it.key === S.sel); S.sel = list[(i + d + list.length) % list.length].key; draw(); };
  const place = (key, x, y) => { const r = moveItem(layout, key, x, y, { allowOverlap: S.overlap, snap: 0.5 }); if (r.moved) S.manual[key] = { x: r.x, y: r.y }; status.textContent = r.blocked ? 'That spot is outside the printable area or on top of another photo.' : ''; draw(); };
  const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * layout.page.w, y: ((e.clientY - r.top) / r.height) * layout.page.h }; };
  canvas.addEventListener('pointerdown', (e) => {
    if (S.mode !== 'manual' || !layout || !layout.ok) return;
    const p = pt(e), hit = [...layout.pages[S.page]].reverse().find((it) => p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h);
    S.sel = hit ? hit.key : null; if (hit) { drag = { key: hit.key, dx: p.x - hit.x, dy: p.y - hit.y }; canvas.setPointerCapture(e.pointerId); e.preventDefault(); } draw();
  });
  canvas.addEventListener('pointermove', (e) => { if (drag && layout && layout.ok) { const p = pt(e); place(drag.key, p.x - drag.dx, p.y - drag.dy); } });
  const endDrag = () => { drag = null; }; canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('keydown', (e) => {
    if (S.mode !== 'manual' || !layout || !layout.ok) return;
    const it = layout.items.find((i) => i.key === S.sel), st = e.shiftKey ? 5 : 0.5, d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
    if (e.key === 'Tab' && !e.shiftKey && !it) { S.sel = layout.pages[S.page][0].key; draw(); return; }
    if (d && it) { e.preventDefault(); place(it.key, it.x + d[0], it.y + d[1]); }
  });
  const commitXY = () => { if (layout && layout.ok && S.sel) { const it = layout.items.find((i) => i.key === S.sel); if (it && Number.isFinite(num(selX)) && Number.isFinite(num(selY))) place(it.key, num(selX), num(selY)); } };
  selX.addEventListener('change', commitXY); selY.addEventListener('change', commitXY);

  // ---------- export
  async function makePdf() {
    draw();
    if (busy || !layout || !layout.ok || !layout.exportable || !imagesReady()) return;
    busy = true; draw(); status.textContent = 'Building the PDF…';
    const L = layout; let tmp = null;
    try {
      let main = null;
      if (L.groups.some((g) => g.source === 'main')) {
        const s = session.getState(); if (!s.decoded) throw new ImageError('pdf-image', 'The photo is not loaded.');
        const recipe = { ...s.recipe, strip: null, output: { ...s.recipe.output, mime: 'image/jpeg', mode: 'quality', quality: PDF_QUALITY } };   // same crop/resize/background as the photo
        const res = await runPipeline(s.decoded, recipe, { file: s.file, hintBytes: s.file.size });
        if (res.blocked) throw Object.assign(new Error(res.blocked.message), { userMessage: res.blocked.message });
        main = { blob: res.blob, bytes: new Uint8Array(await res.blob.arrayBuffer()) };
      }
      const images = [];
      for (const g of L.groups) {
        if (g.source === 'main') {
          if (spec && g.fit === 'cover' && Math.abs(g.w / g.h / (spec.wMM / spec.hMM) - 1) < 0.005) images.push({ bytes: main.bytes });      // the photo exactly as cropped above (embedded untouched)
          else { tmp = tmp || await createImageBitmap(main.blob); images.push(await renderGroupJpeg(tmp, g, { dpi: S.dpi })); }
        } else images.push(await renderGroupJpeg(extras.get(g.source).bitmap, g, { dpi: S.dpi }));
      }
      const { blob, check, infos } = await exportSheetPdf({ layout: L, images, title: passport ? 'Shrinkit photo sheet' : 'Shrinkit print sheet' });
      if (!alive) return;
      save(blob, passport ? 'passport-sheet.pdf' : 'print-sheet.pdf');
      status.textContent = 'PDF ready: ' + check.pages + (check.pages === 1 ? ' page, ' : ' pages, ') + check.photos + ' photos, ' + formatBytes(blob.size) + '. ' +
        (infos.length === 1 ? 'Embedded photo ' + infos[0].width + ' × ' + infos[0].height + ' px.' : 'Embedded photos: ' + infos.map((i) => i.width + ' × ' + i.height + ' px').join(', ') + '.') +
        ' The PDF passed its own structure check, including each photo’s size and position; it has not been checked against any authority’s rules.';
    } catch (err) { if (alive) status.textContent = err.userMessage || 'Could not build the PDF.'; }
    finally { if (tmp) tmp.close(); }
    busy = false; draw();
  }
  function save(blob, name) {
    const url = URL.createObjectURL(blob), a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    urls.set(url, setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 4000));
  }

  async function syncBitmap(s) {
    if (!session) return;
    const blob = s.result.status === 'ready' ? s.result.blob : null;
    if (blob === lastBlob) return;
    lastBlob = blob;
    const old = resultBitmap; resultBitmap = null;
    if (blob) { try { const bm = await createImageBitmap(blob); if (alive && blob === lastBlob) resultBitmap = bm; else bm.close(); } catch (e) { /* preview falls back to grey boxes */ } }
    if (old) old.close();
    draw();
  }
  const off = session ? session.subscribe((s) => { syncBitmap(s); pdfBtn.disabled = busy || !layout || !layout.ok || !layout.exportable || !imagesReady(); }) : () => {};
  if (session) syncBitmap(session.getState());
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => { if (alive && layout && layout.ok) { const dw = canvas.getBoundingClientRect().width; if (dw > 0) scale.textContent = 'Preview scale: about ' + Math.round((dw / ((layout.page.w / 25.4) * 96)) * 100) + '% of real size. The PDF page is exactly ' + r2(layout.page.w) + ' × ' + r2(layout.page.h) + ' mm.'; } }); ro.observe(canvas); }
  renderGroups(); refreshPresets(); writeInputs(); if (!passport) draw();

  return {
    el,
    update(next) { spec = next.spec; out = next.out; if (spec) { S.groups[0].w = spec.wMM; S.groups[0].h = spec.hMM; } const act = document.activeElement; if (!(act && groupsBox.contains(act))) renderGroups(); draw(); },
    dispose() { alive = false; off(); if (ro) ro.disconnect(); if (resultBitmap) resultBitmap.close(); extras.forEach((x) => x.bitmap.close()); extras.clear(); urls.forEach((t, u) => { clearTimeout(t); URL.revokeObjectURL(u); }); urls.clear(); },
  };
}
