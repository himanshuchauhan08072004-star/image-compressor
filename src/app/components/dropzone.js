import { h } from '../dom.js';
import { icon } from '../icons.js';
import { session } from '../session.js';
import { userMessageOf } from '../../core/errors.js';
import { MAX_FILE_BYTES } from '../../core/limits.js';

const IDLE_TITLE = 'Drop an image here, or click to choose';
const LIMITS = 'Up to ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB per file';

/** Drop / click / keyboard file picker. Loads into the shared session; validation and errors come from the existing core (shown inline). */
export function createDropzone({ label = 'Choose an image', limits = LIMITS } = {}) {
  const error = h('p', { class: 'dz-error', role: 'alert', hidden: true });
  const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif' });
  const zone = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': label });
  const badge = h('span', { class: 'dz-badge' }, icon('upload', { size: 24 }));
  const title = h('p', { class: 'dz-title' }, IDLE_TITLE);
  zone.append(badge, title,
    h('p', { class: 'dz-sub' }, 'JPG · PNG · WEBP · HEIC'),
    h('p', { class: 'dz-limits' }, limits + ' · stays on this device'),
    input);

  let busy = false, dragging = false;
  const paintTitle = () => { title.textContent = busy ? 'Opening your image…' : dragging ? 'Release to open' : IDLE_TITLE; };
  const setBusy = (on) => { busy = on; zone.classList.toggle('disabled', on); zone.setAttribute('aria-busy', String(on)); zone.setAttribute('aria-disabled', String(on)); paintTitle(); };
  async function handle(file) {
    if (busy) return;                                           // one open at a time: no duplicate decodes of big files
    error.hidden = true; setBusy(true);
    try { await session.loadFile(file); }
    catch (err) { error.textContent = userMessageOf(err, 'Could not read this image.'); error.hidden = false; }   // the previous image (if any) stays loaded
    finally { setBusy(false); input.value = ''; }               // a stuck "Opening…" state is impossible
  }
  zone.addEventListener('click', () => { if (!busy) input.click(); });
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!busy) input.click(); } });
  ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); dragging = true; zone.classList.add('drag'); paintTitle(); }));
  ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); dragging = false; zone.classList.remove('drag'); paintTitle(); }));
  zone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handle(f); });
  input.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) handle(f); });

  return h('div', { class: 'stage active' }, zone, error);
}
