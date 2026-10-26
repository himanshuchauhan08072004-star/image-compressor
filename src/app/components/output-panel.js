import { h } from '../dom.js';

const TARGETS = [['50 KB', 50], ['100 KB', 100], ['200 KB', 200], ['500 KB', 500], ['1 MB', 1024]];
const suffixFor = (s) => s.suffix || (s.recipe.crop && s.recipe.resize ? 'edited' : s.recipe.crop ? 'cropped' : s.recipe.resize ? 'resized' : s.recipe.regions.length ? 'redacted' : 'compressed');

/** Output controls shared by every tool: format, quality or target size, download. */
export function mountOutputPanel(el, session) {
  const fmt = h('select', { id: 'format', 'aria-label': 'Output format' },
    h('option', { value: 'image/jpeg' }, 'JPG'), h('option', { value: 'image/webp' }, 'WEBP'), h('option', { value: 'image/png' }, 'PNG'));
  const bQuality = h('button', { type: 'button', 'aria-pressed': 'true' }, 'Quality');
  const bTarget = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Target size');
  const quality = h('input', { type: 'range', id: 'quality', min: '10', max: '95', step: '5', value: '70', 'aria-label': 'Quality' });
  const qualityOut = h('span', { class: 'readout' }, '70%');
  const target = h('input', { type: 'number', id: 'targetKB', min: '1', max: '50000', step: '1', inputmode: 'numeric', 'aria-label': 'Target size in KB' });
  const chips = TARGETS.map(([label, kb]) => h('button', { type: 'button', class: 'chip', 'data-kb': kb, 'aria-pressed': 'false' }, label));
  const qualityGroup = h('div', { class: 'ctrl-group' }, h('label', { for: 'quality' }, 'Quality'), quality, qualityOut);
  const targetGroup = h('div', { class: 'ctrl-group target-group' },
    h('label', { for: 'targetKB' }, 'Max size'), target, h('span', { class: 'readout' }, 'KB'),
    h('div', { class: 'chips' }, chips));
  const lockNote = h('p', { class: 'tool-hint lock-note hidden', role: 'status' }, 'Lossless clean-up keeps the original format and quality, so these controls are off.');
  const reset = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Start over');
  const download = h('button', { type: 'button', class: 'btn btn-primary', disabled: true }, 'Download result');

  el.className = 'controls';
  el.append(
    h('div', { class: 'ctrl-group' }, h('label', { for: 'format' }, 'Format'), fmt),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Compression mode' }, bQuality, bTarget),
    qualityGroup, targetGroup, lockNote, h('div', { class: 'spacer' }), reset, download);

  const out = () => session.getState().recipe.output;
  const set = (output, notice) => session.setRecipe({ output }, notice);

  fmt.addEventListener('change', () => {
    if (fmt.value === 'image/png' && out().mode === 'target') set({ mime: fmt.value, mode: 'quality' }, 'Target size works with JPG and WEBP, so PNG uses lossless mode.');
    else set({ mime: fmt.value });
  });
  bQuality.addEventListener('click', () => set({ mode: 'quality' }));
  bTarget.addEventListener('click', () => {
    if (out().mime === 'image/png') set({ mode: 'target', mime: 'image/jpeg' }, 'Target size needs JPG or WEBP. Switched to JPG.');
    else set({ mode: 'target' });
  });
  quality.addEventListener('input', () => { qualityOut.textContent = quality.value + '%'; set({ quality: parseInt(quality.value, 10) }); });
  target.addEventListener('input', () => {
    const v = parseFloat(target.value);
    const valid = Number.isFinite(v) && v >= 1 && v <= 50000;
    target.setAttribute('aria-invalid', valid ? 'false' : 'true');
    if (valid) set({ targetKB: v });
  });
  chips.forEach((c) => c.addEventListener('click', () => set({ targetKB: Number(c.dataset.kb) })));
  reset.addEventListener('click', () => session.clear());
  download.addEventListener('click', () => {
    const s = session.getState();
    if (s.result.status !== 'ready') return;
    const ext = s.result.mime === 'image/jpeg' ? 'jpg' : s.result.mime.split('/')[1];
    const a = h('a', { href: URL.createObjectURL(s.result.blob), download: (s.file.name || 'image').replace(/\.[^/.]+$/, '') + '-' + suffixFor(s) + '.' + ext });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  function render(s) {
    if (!s.decoded) return;
    const o = s.recipe.output, isTarget = o.mode === 'target';
    fmt.value = o.mime;
    bQuality.setAttribute('aria-pressed', String(!isTarget));
    bTarget.setAttribute('aria-pressed', String(isTarget));
    qualityGroup.classList.toggle('hidden', isTarget);
    targetGroup.classList.toggle('hidden', !isTarget);
    if (document.activeElement !== quality) quality.value = o.quality;
    qualityOut.textContent = o.quality + '%';
    if (document.activeElement !== target) { target.value = o.targetKB; target.setAttribute('aria-invalid', 'false'); }
    chips.forEach((c) => c.setAttribute('aria-pressed', String(Number(c.dataset.kb) === o.targetKB)));
    const lossless = !!(s.recipe.strip && s.recipe.strip.method === 'lossless');
    for (const c of [fmt, bQuality, bTarget, quality, target, ...chips]) c.disabled = lossless || (c === quality && o.mime === 'image/png');
    lockNote.classList.toggle('hidden', !lossless);
    download.disabled = s.result.status !== 'ready';
  }
  render(session.getState());
  return session.subscribe(render);
}
