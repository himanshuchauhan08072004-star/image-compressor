import { h } from '../dom.js';
import { PRESETS, DPI_OPTIONS, DPI_DEFAULT, MM_MIN, MM_MAX, validateSpec, pxToMm, passportRecipeParts, maxZoom } from '../../core/passport.js';
import { createSheetPanel } from '../components/sheet-panel.js';

const r2 = (n) => Math.round(n * 100) / 100;
const PRINT_QUALITY = 90;                         // the quality slider moves in steps of 5, so 90 is what it can show

export default {
  mount(el, { session }) {
    session.setSuffix('passport');
    const { width: sw, height: sh, bitmap } = session.getState().decoded;       // upright bitmap (EXIF applied)
    const ui = { wMM: 35, hMM: 45, dpi: DPI_DEFAULT, lock: false, ratio: 35 / 45, bg: 'keep', zoom: 1, cx: sw / 2, cy: sh / 2 };
    const o0 = session.getState().recipe.output, bumped = o0.mode === 'quality' && o0.quality < PRINT_QUALITY;
    let alive = true, drag = null, last = null, vs = null, parts = null;

    // ---- 1. photo size
    const presetBtns = PRESETS.map((p) => h('button', { type: 'button', class: 'chip', 'data-key': p.key, onClick: () => { ui.wMM = p.w; ui.hMM = p.h; ui.lock = false; sync(); } }, p.label));
    const mmIn = (id, label) => h('input', { type: 'number', id, min: String(MM_MIN), max: String(MM_MAX), step: '0.1', inputmode: 'decimal', 'aria-label': label });
    const pxIn = (id, label) => h('input', { type: 'number', id, min: '1', step: '1', inputmode: 'numeric', 'aria-label': label });
    const wMm = mmIn('pp-wmm', 'Photo width in millimetres'), hMm = mmIn('pp-hmm', 'Photo height in millimetres'), wPx = pxIn('pp-wpx', 'Photo width in pixels'), hPx = pxIn('pp-hpx', 'Photo height in pixels');
    const dpi = h('select', { id: 'pp-dpi', 'aria-label': 'Resolution in DPI' }, DPI_OPTIONS.map((d) => h('option', { value: String(d) }, d + ' DPI' + (d === 300 ? ' (print)' : ''))));
    const lock = h('input', { type: 'checkbox', id: 'pp-lock' });
    const swap = h('button', { type: 'button', class: 'btn btn-ghost', id: 'pp-swap', onClick: () => { [ui.wMM, ui.hMM] = [ui.hMM, ui.wMM]; ui.ratio = ui.wMM / ui.hMM; sync(); } }, 'Swap width / height');
    const specErr = h('p', { class: 'dz-error', role: 'alert', hidden: true, id: 'pp-spec-error' });
    const summary = h('p', { class: 'tool-hint pp-summary', id: 'pp-summary', role: 'status' });
    const edit = (key, fromPx) => (e) => {
      const v = Number(e.target.value); if (!Number.isFinite(v) || e.target.value === '') { ui[key] = NaN; return sync(); }
      const mm = fromPx ? pxToMm(v, ui.dpi) : v; ui[key] = mm;
      if (ui.lock && ui.ratio > 0) { if (key === 'wMM') ui.hMM = mm / ui.ratio; else ui.wMM = mm * ui.ratio; }
      sync();
    };
    wMm.addEventListener('input', edit('wMM', false)); hMm.addEventListener('input', edit('hMM', false)); wPx.addEventListener('input', edit('wMM', true)); hPx.addEventListener('input', edit('hMM', true));
    dpi.addEventListener('change', () => { ui.dpi = Number(dpi.value); sync(); });
    lock.addEventListener('change', () => { ui.lock = lock.checked; if (ui.lock && ui.hMM > 0) ui.ratio = ui.wMM / ui.hMM; });

    // ---- 2. crop & position
    const canvas = h('canvas', { class: 'pp-canvas', 'aria-label': 'Your photo with the crop frame' });
    const cw = Math.min(sw, 1400), ch = Math.max(1, Math.round((cw * sh) / sw)); canvas.width = cw; canvas.height = ch;
    const cx2 = canvas.getContext('2d'); cx2.imageSmoothingQuality = 'high'; cx2.drawImage(bitmap, 0, 0, cw, ch);
    const frame = h('div', { class: 'pp-frame', tabindex: '0', role: 'group', 'aria-label': 'Crop frame. Drag to move; arrow keys nudge; plus and minus zoom.' });
    const stage = h('div', { class: 'pp-stage' }, canvas, frame);
    const zoom = h('input', { type: 'range', id: 'pp-zoom', min: '1', step: '0.05', value: '1', 'aria-label': 'Zoom' }), zoomOut = h('span', { class: 'readout', id: 'pp-zoom-out' });
    const zBtn = (label, f, id) => h('button', { type: 'button', class: 'btn btn-ghost', id, 'aria-label': label === '−' ? 'Zoom out' : 'Zoom in', onClick: () => { ui.zoom = Math.max(1, ui.zoom * f); sync(); } }, label);
    const recenter = h('button', { type: 'button', class: 'btn btn-ghost', id: 'pp-center', onClick: () => { ui.cx = sw / 2; ui.cy = sh / 2; sync(); } }, 'Recenter');
    const reset = h('button', { type: 'button', class: 'btn btn-ghost', id: 'pp-reset', onClick: () => { ui.zoom = 1; ui.cx = sw / 2; ui.cy = sh / 2; sync(); } }, 'Reset crop');
    const cropInfo = h('p', { class: 'tool-hint', id: 'pp-crop-info', role: 'status' }), warn = h('p', { class: 'tool-hint pp-warn hidden', id: 'pp-warn' });
    zoom.addEventListener('input', () => { ui.zoom = Number(zoom.value); sync(); });
    const k = () => sw / canvas.getBoundingClientRect().width;                     // source px per screen px (follows preview resizes)
    frame.addEventListener('pointerdown', (e) => { if (!parts) return; e.preventDefault(); frame.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, cx: ui.cx, cy: ui.cy }; frame.focus({ preventScroll: true }); });
    frame.addEventListener('pointermove', (e) => { if (!drag) return; ui.cx = drag.cx + (e.clientX - drag.x) * k(); ui.cy = drag.cy + (e.clientY - drag.y) * k(); sync(); });
    const endDrag = () => { drag = null; }; frame.addEventListener('pointerup', endDrag); frame.addEventListener('pointercancel', endDrag);
    frame.addEventListener('keydown', (e) => {
      const st = Math.max(1, Math.round(sw * 0.01)), d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
      if (d) { e.preventDefault(); ui.cx += d[0]; ui.cy += d[1]; sync(); } else if (e.key === '+' || e.key === '=') { e.preventDefault(); ui.zoom *= 1.1; sync(); } else if (e.key === '-') { e.preventDefault(); ui.zoom = Math.max(1, ui.zoom / 1.1); sync(); }
    });

    // ---- 3. background
    const bgBtn = (label, v) => h('button', { type: 'button', 'aria-pressed': 'false', 'data-bg': v, onClick: () => { ui.bg = v; sync(); } }, label);
    const bgKeep = bgBtn('Keep original', 'keep'), bgWhite = bgBtn('White fill', 'white');
    const sheet = createSheetPanel({ session, mode: 'passport', setPhotoSize: (w, h) => { ui.wMM = w; ui.hMM = h; ui.lock = false; sync(); } });

    el.append(
      h('p', { class: 'tool-title' }, '1 · Photo size'),
      h('div', { class: 'chips', 'aria-label': 'General preset sizes' }, presetBtns),
      h('p', { class: 'tool-hint' }, 'These are general sizes, not a guarantee that any authority will accept the photo. Requirements differ by country and by document type (and can change), so check the official rules for yours before printing or submitting.'),
      h('div', { class: 'tool-row' },
        h('div', { class: 'ctrl-group' }, h('label', { for: 'pp-wmm' }, 'Width'), wMm, h('span', { class: 'readout' }, 'mm'), h('label', { for: 'pp-hmm' }, 'Height'), hMm, h('span', { class: 'readout' }, 'mm')),
        h('div', { class: 'ctrl-group' }, h('label', { for: 'pp-wpx' }, 'Width'), wPx, h('span', { class: 'readout' }, 'px'), h('label', { for: 'pp-hpx' }, 'Height'), hPx, h('span', { class: 'readout' }, 'px'))),
      h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', { for: 'pp-dpi' }, 'Resolution'), dpi), h('label', { class: 'check' }, lock, 'Keep aspect ratio when I change a size'), swap),
      specErr, summary,
      h('p', { class: 'tool-title' }, '2 · Crop and position'),
      h('p', { class: 'tool-hint' }, 'The whole picture is shown. Drag the frame to move it, zoom to include less of the picture. The frame keeps the photo’s proportions, so faces are never stretched.'),
      stage,
      h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', { for: 'pp-zoom' }, 'Zoom'), zBtn('−', 1 / 1.1, 'pp-zout'), zoom, zBtn('+', 1.1, 'pp-zin'), zoomOut), recenter, reset),
      cropInfo, warn,
      h('p', { class: 'tool-title' }, '3 · Background'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Background' }, bgKeep, bgWhite),
      h('p', { class: 'tool-hint' }, 'White fill only paints a white background behind transparent pixels (for example a transparent PNG). It does not remove or replace the background of an ordinary photograph; the original background stays. Automatic background removal is not part of this tool.'),
      h('p', { class: 'tool-title' }, '4 · Export the photo'),
      h('p', { class: 'tool-hint' }, 'Pick the format and quality below the preview, then use “Download result” for the single photo. The print sheet comes after it.'),
      sheet.el);

    // ---- sync: ui -> recipe -> panels
    function sync() {
      if (!alive) return;
      vs = validateSpec(ui);
      specErr.hidden = vs.ok; specErr.textContent = vs.ok ? '' : vs.error;
      const act = document.activeElement;
      if (act !== wMm) wMm.value = Number.isFinite(ui.wMM) ? r2(ui.wMM) : ''; if (act !== hMm) hMm.value = Number.isFinite(ui.hMM) ? r2(ui.hMM) : '';
      dpi.value = String(ui.dpi); lock.checked = ui.lock;
      if (vs.ok) { if (act !== wPx) wPx.value = vs.spec.wPx; if (act !== hPx) hPx.value = vs.spec.hPx; }
      presetBtns.forEach((b) => { const p = PRESETS.find((x) => x.key === b.dataset.key); b.setAttribute('aria-pressed', String(Math.abs(p.w - ui.wMM) < 0.005 && Math.abs(p.h - ui.hMM) < 0.005)); });
      bgKeep.setAttribute('aria-pressed', String(ui.bg === 'keep')); bgWhite.setAttribute('aria-pressed', String(ui.bg === 'white'));
      if (!vs.ok) { summary.textContent = 'Fix the size to update the crop and the photo.'; parts = null; frame.classList.add('hidden'); sheet.update({ spec: null, out: null }); return; }
      parts = passportRecipeParts(sw, sh, vs.spec, ui, ui.bg);
      ui.zoom = parts.zoom;
      const mx = parts.crop.x + parts.crop.w / 2, my = parts.crop.y + parts.crop.h / 2;                               // keep the user's centre unless the image edge clamped it (avoids rounding drift)
      if (!Number.isFinite(ui.cx) || Math.abs(mx - ui.cx) > 0.75) ui.cx = mx; if (!Number.isFinite(ui.cy) || Math.abs(my - ui.cy) > 0.75) ui.cy = my;
      const mz = maxZoom(sw, sh, vs.spec.aspect); zoom.max = String(mz); if (act !== zoom) zoom.value = String(ui.zoom); zoomOut.textContent = r2(ui.zoom) + '×';
      const c = parts.crop, o = parts.out;
      frame.classList.remove('hidden');
      frame.style.left = (c.x / sw) * 100 + '%'; frame.style.top = (c.y / sh) * 100 + '%'; frame.style.width = (c.w / sw) * 100 + '%'; frame.style.height = (c.h / sh) * 100 + '%';
      summary.textContent = 'Final photo: ' + o.w + ' × ' + o.h + ' px · ' + r2(vs.spec.wMM) + ' × ' + r2(vs.spec.hMM) + ' mm · ' + vs.spec.dpi + ' DPI target.';
      cropInfo.textContent = 'Crop: ' + c.w + ' × ' + c.h + ' px taken from the original at (' + c.x + ', ' + c.y + ') of ' + sw + ' × ' + sh + '. Output ' + o.w + ' × ' + o.h + ' px, about ' + o.effectiveDpi + ' DPI at ' + r2(vs.spec.wMM) + ' mm wide.';
      warn.classList.toggle('hidden', !o.upscaleAvoided);
      warn.textContent = o.upscaleAvoided ? 'This crop has only ' + c.w + ' × ' + c.h + ' px, fewer than the ' + vs.spec.wPx + ' × ' + vs.spec.hPx + ' px needed at ' + vs.spec.dpi + ' DPI. It is not enlarged, so the photo keeps its real pixels (about ' + o.effectiveDpi + ' DPI). Zoom out or use a larger original for sharper prints.' : '';
      const cur = session.getState().recipe, patch = { crop: parts.crop, resize: parts.resize, output: { ...cur.output, flatten: parts.flatten, ...(bumped && cur.output.quality < PRINT_QUALITY ? { quality: PRINT_QUALITY } : {}) } };
      const key = JSON.stringify(patch); if (key !== last) { last = key; session.setRecipe(patch); }
      sheet.update({ spec: vs.spec, out: o });
    }
    sync();
    const off = session.subscribe((s) => { if (alive && parts && (!s.recipe.crop || JSON.stringify(s.recipe.crop) !== JSON.stringify(parts.crop))) { last = null; sync(); } });   // this tool owns the crop while it is open

    return () => {
      alive = false; off(); sheet.dispose(); session.setSuffix('');
      const cur = session.getState().recipe, o = { ...cur.output }; delete o.flatten; if (bumped && o.quality === PRINT_QUALITY) o.quality = o0.quality;
      session.setRecipe({ output: o });
    };
  },
};
