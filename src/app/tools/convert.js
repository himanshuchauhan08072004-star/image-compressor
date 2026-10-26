import { h } from '../dom.js';
import { supportsEncode } from '../../core/encode.js';

const FORMATS = [['JPG', 'image/jpeg', '.jpg'], ['PNG', 'image/png', '.png'], ['WEBP', 'image/webp', '.webp']];
const NAME = { jpeg: 'JPG', png: 'PNG', webp: 'WEBP', heic: 'HEIC' };
const TIPS = {
  'image/jpeg': 'JPG is small and works everywhere, but cannot store transparency.',
  'image/png': 'PNG is lossless and keeps transparency, but files are usually larger.',
  'image/webp': 'WEBP is small and keeps transparency. Very old software may not open it.',
};

export default {
  mount(el, { session }) {
    session.setSuffix('converted');
    const { kind, width, height, hasAlpha } = session.getState().decoded;

    const from = h('p', { class: 'convert-from' }, 'Original: ', h('strong', {}, NAME[kind.type]), ' · ' + width + ' × ' + height + ' px · ' +
      (hasAlpha ? 'has a transparency channel' : 'no transparency'));
    const buttons = FORMATS.map(([label, mime]) => h('button', { type: 'button', 'aria-pressed': 'false', 'data-mime': mime, onClick: () => {
      session.setRecipe({ output: { mime, mode: mime === 'image/png' ? 'quality' : session.getState().recipe.output.mode } },
        mime === 'image/png' && session.getState().recipe.output.mode === 'target' ? 'Target size works with JPG and WEBP, so PNG uses lossless mode.' : '');
    } }, label));
    const heicNote = h('p', { class: 'tool-hint' }, kind.type === 'heic' ? 'HEIC/HEIF decoded in your browser. Colours are read as sRGB and 8-bit; the HEIC file itself is not changed.' : '');
    const unsupported = h('p', { class: 'tool-hint', role: 'status' });
    FORMATS.forEach(([label, mime], i) => supportsEncode(mime).then((ok) => {
      if (ok) return;
      buttons[i].disabled = true;
      buttons[i].title = 'This browser cannot create ' + label + ' files';
      unsupported.textContent = (unsupported.textContent ? unsupported.textContent + ' ' : '') + label + ' output is not available in this browser.';
    }));

    const color = h('input', { type: 'color', id: 'bgcolor', value: '#ffffff', 'aria-label': 'Background colour for transparent areas' });
    color.addEventListener('input', () => session.setRecipe({ output: { background: color.value } }));
    const swatches = [['White', '#ffffff'], ['Black', '#000000'], ['Light gray', '#eeeeee']].map(([label, hex]) =>
      h('button', { type: 'button', class: 'chip', onClick: () => session.setRecipe({ output: { background: hex } }) }, label));
    const bgRow = h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', { for: 'bgcolor' }, 'Fill transparent areas with'), color), h('div', { class: 'chips' }, swatches));

    const to = h('p', { class: 'convert-to', role: 'status' });
    const tip = h('p', { class: 'tool-hint' });
    el.append(from, h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', {}, 'Convert to'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Output format' }, buttons))), unsupported, bgRow, to, tip, heicNote);

    function render(s) {
      if (!s.decoded) return;
      const o = s.recipe.output, res = s.result;
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mime === o.mime)));
      bgRow.classList.toggle('hidden', !(o.mime === 'image/jpeg' && hasAlpha));
      if (document.activeElement !== color) color.value = o.background || '#ffffff';
      const sel = FORMATS.find((f) => f[1] === o.mime);
      tip.textContent = TIPS[o.mime] + (NAME[kind.type] === sel[0] ? ' (Same format: this only re-compresses.)' : '');
      // Report what was ACTUALLY produced, not what was requested.
      if (res.status === 'ready') {
        const got = FORMATS.find((f) => f[1] === res.mime);
        to.textContent = 'Result: ' + NAME[kind.type] + ' → ' + got[0] + ' (' + res.mime + '), saved as ' + got[2] + ' · ' + res.width + ' × ' + res.height + ' px';
      } else to.textContent = res.status === 'working' ? 'Converting…' : '';
    }
    render(session.getState());
    const off = session.subscribe(render);
    return () => { off(); session.setSuffix(''); };
  },
};
