import { h } from '../dom.js';
import { moveRect, resizeRect } from '../../core/geometry.js';
import { MAX_REGIONS, MIN_REGION, MODES, normalizeRegions, applyRegions } from '../../core/redact.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MODE_LABEL = { blur: 'Blur', pixelate: 'Pixelate', solid: 'Solid' };
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export default {
  mount(el, { session }) {
    session.setSuffix('redacted');
    const { width: sw, height: sh, bitmap } = session.getState().decoded;   // bitmap is already EXIF-oriented
    const bounds = { w: sw, h: sh };
    const minSide = Math.max(1, Math.min(MIN_REGION, sw, sh));
    let selected = null, drag = null, seq = 0, raf = 0, alive = true, listKey = '', paintedFor = null;
    let lastMode = 'blur', lastStrength = 4, lastColor = '#000000';
    const regions = () => session.getState().recipe.regions;
    regions().forEach((r) => { const n = parseInt(String(r.id).slice(1), 10); if (n > seq) seq = n; });
    const setRegions = (list) => session.setRecipe({ regions: list });
    const patch = (id, p) => setRegions(regions().map((r) => (r.id === id ? { ...r, ...p } : r)));
    const find = (id) => regions().find((r) => r.id === id) || null;
    const newRegion = (rect) => ({ id: 'r' + (++seq), ...rect, mode: lastMode, strength: lastStrength, color: lastColor });

    // ---- picture: the preview canvas is the real redaction code run at preview scale
    const cw = Math.min(sw, 1400), ch = Math.max(1, Math.round((cw * sh) / sw));
    const base = document.createElement('canvas'); base.width = cw; base.height = ch;
    const bctx = base.getContext('2d'); bctx.imageSmoothingQuality = 'high'; bctx.drawImage(bitmap, 0, 0, cw, ch);
    const canvas = h('canvas', { class: 'crop-canvas', 'aria-label': 'Image preview with protected regions' });
    canvas.width = cw; canvas.height = ch;
    const plan = { outW: cw, outH: ch, src: { x: 0, y: 0, w: sw, h: sh }, dst: { x: 0, y: 0, w: cw, h: ch } };
    const paint = () => {
      raf = 0; if (!alive) return;
      const list = regions(); paintedFor = list;
      const ctx = canvas.getContext('2d'); ctx.drawImage(base, 0, 0);
      applyRegions(canvas, plan, normalizeRegions(list, sw, sh));
    };
    const schedulePaint = () => { if (!raf) raf = requestAnimationFrame(paint); };

    const layer = h('div', { class: 'rd-layer' });
    const stage = h('div', { class: 'crop-stage rd-stage' }, canvas, layer);
    stage.style.setProperty('--ar', String(sw / sh));
    const boxes = new Map();

    // ---- controls
    const addBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => {
      const n = regions().length; if (n >= MAX_REGIONS) return;
      const w = Math.max(minSide, Math.round(sw * 0.3)), hh = Math.max(minSide, Math.round(sh * 0.2));
      const off = (n % 5) * 0.03;
      const r = newRegion({ x: Math.round(clamp((sw - w) / 2 + off * sw, 0, sw - w)), y: Math.round(clamp((sh - hh) / 2 + off * sh, 0, sh - hh)), w, h: hh });
      selected = r.id; setRegions([...regions(), r]); focusBox(r.id);
    } }, 'Add region');
    const delBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => removeSelected() }, 'Delete region');
    const modeBtns = MODES.map((m) => h('button', { type: 'button', 'aria-pressed': 'false', 'data-mode': m, onClick: () => { lastMode = m; if (selected) patch(selected, { mode: m }); } }, MODE_LABEL[m]));
    const strength = h('input', { type: 'range', id: 'rd-strength', min: '1', max: '5', step: '1', value: '4', 'aria-label': 'Strength' });
    const strengthOut = h('span', { class: 'readout' }, '4');
    strength.addEventListener('input', () => { lastStrength = parseInt(strength.value, 10); strengthOut.textContent = strength.value; if (selected) patch(selected, { strength: lastStrength }); });
    const color = h('input', { type: 'color', id: 'rd-color', value: '#000000', 'aria-label': 'Cover colour' });
    color.addEventListener('input', () => { lastColor = color.value; if (selected) patch(selected, { color: color.value }); });
    const swatches = [['Black', '#000000'], ['White', '#ffffff']].map(([label, hex]) => h('button', { type: 'button', class: 'chip', onClick: () => { lastColor = hex; if (selected) patch(selected, { color: hex }); else render(session.getState()); } }, label));
    const colorGroup = h('div', { class: 'ctrl-group' }, h('label', { for: 'rd-color' }, 'Cover colour'), color, h('div', { class: 'chips' }, swatches));
    const strengthGroup = h('div', { class: 'ctrl-group' }, h('label', { for: 'rd-strength' }, 'Strength'), strength, strengthOut);
    const list = h('ul', { class: 'rd-list', 'aria-label': 'Protected regions' });
    const readout = h('p', { class: 'tool-hint', role: 'status' });
    const warning = h('p', { class: 'tool-hint rd-warning', role: 'note' },
      'Check the exported file before you share it. Blur and pixelation can sometimes be partly reversed, especially on small text and faces. For text, number plates and numbers, use Solid.');
    el.append(
      h('p', { class: 'tool-hint' }, 'Drag on the picture to draw a region, or press “Add region”. Click a region to move or resize it. On touch screens use “Add region”, then drag the box.'),
      stage,
      h('div', { class: 'tool-row' }, addBtn, delBtn, h('div', { class: 'seg', role: 'group', 'aria-label': 'Protection type' }, modeBtns), strengthGroup, colorGroup),
      list, readout, warning);

    // ---- selection + editing
    function focusBox(id) { const b = boxes.get(id); if (b) b.focus({ preventScroll: true }); else requestAnimationFrame(() => { const b2 = boxes.get(id); if (b2) b2.focus({ preventScroll: true }); }); }
    function removeSelected() {
      if (!selected) return;
      const i = regions().findIndex((r) => r.id === selected);
      const rest = regions().filter((r) => r.id !== selected);
      selected = rest.length ? rest[Math.min(i, rest.length - 1)].id : null;
      setRegions(rest);
      if (selected) focusBox(selected); else addBtn.focus();
    }
    const select = (id) => { selected = id; render(session.getState()); focusBox(id); };

    function makeBox(id) {
      const box = h('div', { class: 'crop-box rd-box', tabindex: '0', role: 'group', 'data-id': id }, HANDLES.map((k) => h('div', { class: 'crop-h crop-h-' + k, 'data-h': k })));
      box.addEventListener('focus', () => { if (selected !== id) { selected = id; render(session.getState()); } });
      box.addEventListener('keydown', (e) => {
        const r = find(id); if (!r) return;
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); selected = id; removeSelected(); return; }
        const step = Math.max(1, Math.round(sw * 0.01));
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!d) return;
        e.preventDefault();
        patch(id, e.shiftKey ? resizeRect(r, 'se', d[0], d[1], bounds, null, minSide) : moveRect(r, d[0], d[1], bounds));
      });
      return box;
    }

    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const sr = stage.getBoundingClientRect(), k = sw / sr.width;
      const boxEl = e.target.closest ? e.target.closest('.rd-box') : null;
      if (boxEl) {
        const id = boxEl.dataset.id, handle = e.target.dataset && e.target.dataset.h ? e.target.dataset.h : 'move';
        e.preventDefault(); e.target.setPointerCapture(e.pointerId);
        selected = id; drag = { type: handle, id, x: e.clientX, y: e.clientY, rect: find(id), k };
        render(session.getState()); boxEl.focus({ preventScroll: true });
        return;
      }
      e.preventDefault(); stage.setPointerCapture(e.pointerId);
      drag = { type: 'draw', id: null, x0: (e.clientX - sr.left) * k, y0: (e.clientY - sr.top) * k, k, sr };
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.type === 'draw') {
        const x1 = clamp((e.clientX - drag.sr.left) * drag.k, 0, sw), y1 = clamp((e.clientY - drag.sr.top) * drag.k, 0, sh);
        const w = Math.abs(x1 - drag.x0), hh = Math.abs(y1 - drag.y0);
        if (!drag.id && (w < minSide || hh < minSide)) return;
        const rw = Math.max(minSide, Math.round(w)), rh = Math.max(minSide, Math.round(hh));
        const rect = { x: Math.round(clamp(Math.min(drag.x0, x1), 0, sw - rw)), y: Math.round(clamp(Math.min(drag.y0, y1), 0, sh - rh)), w: rw, h: rh };
        if (!drag.id) {
          if (regions().length >= MAX_REGIONS) return;
          const r = newRegion(rect); drag.id = r.id; selected = r.id; setRegions([...regions(), r]);
        } else patch(drag.id, rect);
        return;
      }
      const dx = (e.clientX - drag.x) * drag.k, dy = (e.clientY - drag.y) * drag.k;
      patch(drag.id, drag.type === 'move' ? moveRect(drag.rect, dx, dy, bounds) : resizeRect(drag.rect, drag.type, dx, dy, bounds, null, minSide));
    });
    const end = () => {
      if (drag && drag.type === 'draw' && !drag.id) { selected = null; render(session.getState()); }   // a plain click on empty picture deselects
      drag = null;
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);

    function render(s) {
      if (!alive || !s.decoded) return;
      const rs = s.recipe.regions;
      for (const [id, b] of boxes) if (!rs.some((r) => r.id === id)) { b.remove(); boxes.delete(id); }
      if (selected && !rs.some((r) => r.id === selected)) selected = null;
      rs.forEach((r, i) => {
        let b = boxes.get(r.id);
        if (!b) { b = makeBox(r.id); boxes.set(r.id, b); layer.append(b); }
        b.style.left = (r.x / sw) * 100 + '%'; b.style.top = (r.y / sh) * 100 + '%';
        b.style.width = (r.w / sw) * 100 + '%'; b.style.height = (r.h / sh) * 100 + '%';
        b.classList.toggle('sel', r.id === selected);
        b.setAttribute('aria-label', 'Region ' + (i + 1) + ', ' + MODE_LABEL[r.mode] + '. Arrow keys move, Shift plus arrows resize, Delete removes.');
      });
      const sel = rs.find((r) => r.id === selected) || null;
      modeBtns.forEach((b) => { b.disabled = !sel; b.setAttribute('aria-pressed', String(!!sel && sel.mode === b.dataset.mode)); });
      strength.disabled = !sel || sel.mode === 'solid'; delBtn.disabled = !sel;
      const showMode = sel ? sel.mode : lastMode;
      strengthGroup.classList.toggle('hidden', showMode === 'solid'); colorGroup.classList.toggle('hidden', showMode !== 'solid');
      if (sel && document.activeElement !== strength) { strength.value = sel.strength; strengthOut.textContent = String(sel.strength); }
      if (sel && document.activeElement !== color) color.value = sel.color;
      addBtn.disabled = rs.length >= MAX_REGIONS;
      const key = rs.map((r) => r.id + r.mode).join(',') + '|' + selected;
      if (key !== listKey) {
        listKey = key;
        list.replaceChildren(...rs.map((r, i) => h('li', {}, h('button', { type: 'button', class: 'chip', 'aria-pressed': String(r.id === selected), onClick: () => select(r.id) }, 'Region ' + (i + 1) + ' · ' + MODE_LABEL[r.mode]))));
      }
      readout.textContent = rs.length
        ? rs.length + ' of ' + MAX_REGIONS + ' regions' + (sel ? '. Selected: ' + sel.w + ' × ' + sel.h + ' px.' : '. Select one to change it.')
        : 'No regions yet. The picture is unchanged until you add one.';
      if (rs !== paintedFor) schedulePaint();
    }
    render(session.getState());
    paint();
    const off = session.subscribe(render);
    return () => { alive = false; off(); if (raf) cancelAnimationFrame(raf); session.setSuffix(''); base.width = 0; base.height = 0; };
  },
};
