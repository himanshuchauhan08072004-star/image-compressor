import { h } from '../dom.js';
import { fitAspectRect, moveRect, resizeRect } from '../../core/geometry.js';
import { MIN_CROP } from '../../core/limits.js';

const RATIOS = [['Free', null], ['Original', 'orig'], ['1:1', 1], ['4:5', 4 / 5], ['3:4', 3 / 4], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9], ['9:16', 9 / 16]];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export default {
  mount(el, { session }) {
    const { width: sw, height: sh, bitmap } = session.getState().decoded;   // bitmap is already EXIF-oriented
    const bounds = { w: sw, h: sh };
    let ratio = null, ratioKey = 'Free', drag = null;

    // Draw the (oriented) bitmap once. Overlay positions are percentages, so resizing needs no JS.
    const canvas = h('canvas', { class: 'crop-canvas', 'aria-label': 'Image to crop' });
    const cw = Math.min(sw, 1400); canvas.width = cw; canvas.height = Math.max(1, Math.round((cw * sh) / sw));
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const shade = h('div', { class: 'crop-shade' });
    const box = h('div', { class: 'crop-box', tabindex: '0', role: 'group', 'aria-label': 'Crop area. Use arrow keys to move.' },
      HANDLES.map((k) => h('div', { class: 'crop-h crop-h-' + k, 'data-h': k })));
    const stage = h('div', { class: 'crop-stage' }, canvas, h('div', { class: 'crop-clip' }, shade), box);
    stage.style.setProperty('--ar', String(sw / sh));

    const readout = h('p', { class: 'tool-hint' });
    const chips = RATIOS.map(([label, val]) => h('button', { type: 'button', class: 'chip', 'data-k': label, onClick: () => pick(label, val) }, label));
    const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { ratio = null; ratioKey = 'Free'; session.setRecipe({ crop: null }); } }, 'Reset crop');
    el.append(h('div', { class: 'chips', role: 'group', 'aria-label': 'Aspect ratio' }, chips), stage,
      h('div', { class: 'tool-row' }, readout, h('div', { class: 'spacer' }), resetBtn));

    const full = (r) => r.x === 0 && r.y === 0 && r.w === sw && r.h === sh;
    const rect = () => session.getState().recipe.crop || { x: 0, y: 0, w: sw, h: sh };
    const setCrop = (r) => session.setRecipe({ crop: full(r) ? null : r });

    function pick(label, val) {
      ratioKey = label;
      if (val === null) { ratio = null; session.setRecipe({}); return; }
      ratio = val === 'orig' ? sw / sh : val;
      setCrop(fitAspectRect(sw, sh, ratio));
    }

    stage.addEventListener('pointerdown', (e) => {
      const handle = e.target.dataset && e.target.dataset.h ? e.target.dataset.h : (e.target === box ? 'move' : null);
      if (!handle) return;
      e.preventDefault();
      e.target.setPointerCapture(e.pointerId);
      drag = { handle, x: e.clientX, y: e.clientY, rect: rect(), k: sw / stage.getBoundingClientRect().width };
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = (e.clientX - drag.x) * drag.k, dy = (e.clientY - drag.y) * drag.k;
      setCrop(drag.handle === 'move' ? moveRect(drag.rect, dx, dy, bounds) : resizeRect(drag.rect, drag.handle, dx, dy, bounds, ratio, MIN_CROP));
    });
    const end = () => { drag = null; };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    box.addEventListener('keydown', (e) => {
      const step = Math.max(1, Math.round(sw * 0.01));
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault(); setCrop(moveRect(rect(), d[0], d[1], bounds));
    });

    function render() {
      const r = rect();
      for (const n of [box, shade]) {
        n.style.left = (r.x / sw) * 100 + '%'; n.style.top = (r.y / sh) * 100 + '%';
        n.style.width = (r.w / sw) * 100 + '%'; n.style.height = (r.h / sh) * 100 + '%';
      }
      box.classList.toggle('whole', full(r));   // whole-image box must not trap vertical touch scrolling
      chips.forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.k === ratioKey)));
      readout.textContent = full(r) ? 'Whole image selected (' + sw + ' × ' + sh + ' px). Drag the box or its handles to crop.'
        : 'Crop: ' + r.w + ' × ' + r.h + ' px';
    }
    render();
    return session.subscribe(render);
  },
};
