import { h } from '../dom.js';
import { linkedSize } from '../../core/geometry.js';

const SIZES = [['1080 × 1080', 1080, 1080], ['1080 × 1350', 1080, 1350], ['1080 × 1920', 1080, 1920],
  ['1200 × 630', 1200, 630], ['1280 × 720', 1280, 720], ['1920 × 1080', 1920, 1080], ['400 × 400', 400, 400]];
const PERCENTS = [75, 50, 25];

export default {
  mount(el, { session }) {
    const ui = { mode: 'scale', lock: true, allowUpscale: false, fit: 'fill' };
    const first = session.getState().recipe.resize;
    if (first) Object.assign(ui, { mode: first.mode, lock: first.lock !== false, allowUpscale: !!first.allowUpscale, fit: first.fit || 'fill' });

    const base = () => { const s = session.getState(); const c = s.recipe.crop; return c ? { w: c.w, h: c.h } : { w: s.decoded.width, h: s.decoded.height }; };
    const current = () => { const r = session.getState().recipe.resize; const b = base(); return r ? { width: r.width, height: r.height } : { width: b.w, height: b.h }; };

    function emit(dims) {
      const b = base();
      const noop = ui.mode === 'scale' && dims.width === b.w && dims.height === b.h && !ui.allowUpscale;
      session.setRecipe({ resize: noop ? null : { mode: ui.mode, width: dims.width, height: dims.height, fit: ui.fit, allowUpscale: ui.allowUpscale, lock: ui.lock } });
    }

    const seg = (label, mode) => h('button', { type: 'button', 'aria-pressed': 'false', 'data-mode': mode, onClick: () => {
      ui.mode = mode; const d = current();
      if (mode === 'scale' && ui.lock) { const b = base(); emit(linkedSize('width', d.width, b.w, b.h)); } else emit(d);
    } }, label);
    const bScale = seg('Scale', 'scale'), bExact = seg('Exact size', 'exact');
    const wIn = h('input', { type: 'number', min: '1', inputmode: 'numeric', 'aria-label': 'Width in pixels', id: 'rw' });
    const hIn = h('input', { type: 'number', min: '1', inputmode: 'numeric', 'aria-label': 'Height in pixels', id: 'rh' });
    const lock = h('input', { type: 'checkbox', id: 'rlock' });
    const up = h('input', { type: 'checkbox', id: 'rup' });
    const fit = h('select', { id: 'rfit', 'aria-label': 'How to fit the image' },
      h('option', { value: 'fill' }, 'Fill — crop edges to fit'), h('option', { value: 'contain' }, 'Fit inside — add white borders'),
      h('option', { value: 'stretch' }, 'Stretch — may distort'));
    const hint = h('p', { class: 'tool-hint' });
    const lockRow = h('label', { class: 'check' }, lock, 'Keep proportions');
    const fitRow = h('div', { class: 'ctrl-group' }, h('label', { for: 'rfit' }, 'Fit'), fit);
    const pct = h('div', { class: 'chips', 'aria-label': 'Scale presets' }, PERCENTS.map((p) => h('button', { type: 'button', class: 'chip', onClick: () => {
      ui.mode = 'scale'; const b = base(); emit({ width: Math.max(1, Math.round(b.w * p / 100)), height: Math.max(1, Math.round(b.h * p / 100)) });
    } }, p + '%')));
    const sizes = h('div', { class: 'chips', 'aria-label': 'Common sizes' }, SIZES.map(([label, w, hh]) => h('button', { type: 'button', class: 'chip', onClick: () => {
      ui.mode = 'exact'; ui.fit = 'fill'; emit({ width: w, height: hh });
    } }, label)));
    const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => session.setRecipe({ resize: null }) }, 'Reset size');

    wIn.addEventListener('input', () => {
      const v = parseInt(wIn.value, 10); if (!(v >= 1)) return;
      const b = base(), d = current();
      emit(ui.mode === 'scale' && ui.lock ? linkedSize('width', v, b.w, b.h) : { width: v, height: d.height });
    });
    hIn.addEventListener('input', () => {
      const v = parseInt(hIn.value, 10); if (!(v >= 1)) return;
      const b = base(), d = current();
      emit(ui.mode === 'scale' && ui.lock ? linkedSize('height', v, b.w, b.h) : { width: d.width, height: v });
    });
    lock.addEventListener('change', () => { ui.lock = lock.checked; const d = current(), b = base(); emit(ui.lock && ui.mode === 'scale' ? linkedSize('width', d.width, b.w, b.h) : d); });
    up.addEventListener('change', () => { ui.allowUpscale = up.checked; emit(current()); });
    fit.addEventListener('change', () => { ui.fit = fit.value; emit(current()); });

    el.append(
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Resize mode' }, bScale, bExact),
      h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', { for: 'rw' }, 'Width'), wIn, h('span', { class: 'readout' }, '×'),
        h('label', { for: 'rh' }, 'Height'), hIn, h('span', { class: 'readout' }, 'px')), lockRow, fitRow,
        h('label', { class: 'check' }, up, 'Allow enlarging')),
      h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', {}, 'Scale'), pct),
        h('div', { class: 'ctrl-group' }, h('label', {}, 'Sizes'), sizes), resetBtn),
      hint);

    function render(s) {
      if (!s.decoded) return;
      const b = base(), d = current();
      bScale.setAttribute('aria-pressed', String(ui.mode === 'scale'));
      bExact.setAttribute('aria-pressed', String(ui.mode === 'exact'));
      if (document.activeElement !== wIn) wIn.value = d.width;
      if (document.activeElement !== hIn) hIn.value = d.height;
      lock.checked = ui.lock; up.checked = ui.allowUpscale; fit.value = ui.fit;
      lockRow.classList.toggle('hidden', ui.mode !== 'scale');
      fitRow.classList.toggle('hidden', ui.mode !== 'exact');
      pct.parentElement.classList.toggle('hidden', ui.mode !== 'scale');
      hint.textContent = 'Original' + (s.recipe.crop ? ' (after crop)' : '') + ': ' + b.w + ' × ' + b.h + ' px. ' +
        (ui.mode === 'scale' ? (ui.lock ? 'Width and height stay in proportion.' : 'Proportions unlocked: the image can look stretched.')
          : 'Output is exactly the size you enter.');
    }
    render(session.getState());
    return session.subscribe(render);
  },
};
