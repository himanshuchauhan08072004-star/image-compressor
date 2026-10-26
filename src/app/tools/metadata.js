import { h } from '../dom.js';
import { readFileBytes } from '../../core/filebytes.js';
import { inspectMetadata, LABELS } from '../../core/metadata.js';

const NAME = { jpeg: 'JPG', png: 'PNG', webp: 'WEBP', heic: 'HEIC' };
const LIMITS = [
  'Only file metadata is removed, not picture content. Faces, number plates, street signs and visible text stay in the picture.',
  'The original file name is kept in the download name, so rename the file if the name itself is private.',
  'PNG and WEBP files that carry a rotation flag cannot use lossless removal, because the flag would be lost. Use “Rebuild image” for those.',
];

export default {
  mount(el, { session }) {
    session.setSuffix('clean');
    const { file, decoded } = session.getState();
    const type = decoded.kind.type;
    let alive = true, want = 'lossless', keepIcc = true;
    let found = null, orientation = 1, inspectError = '';   // found === null means "still reading"

    const foundTitle = h('p', { class: 'tool-title' }, 'Found in this file');
    const foundList = h('ul', { class: 'meta-list', 'aria-label': 'Metadata found in this file' });
    const foundNote = h('p', { class: 'tool-hint', role: 'status' }, 'Reading the file…');

    const bLossless = h('button', { type: 'button', 'aria-pressed': 'true', 'data-m': 'lossless', onClick: () => { want = 'lossless'; apply(); } }, 'Lossless');
    const bRebuild = h('button', { type: 'button', 'aria-pressed': 'false', 'data-m': 'reencode', onClick: () => { want = 'reencode'; apply(); } }, 'Rebuild image');
    const methodHint = h('p', { class: 'tool-hint' });
    const reason = h('p', { class: 'tool-hint meta-reason hidden', role: 'status' });
    const icc = h('input', { type: 'checkbox', id: 'keepicc', checked: true });
    icc.addEventListener('change', () => { keepIcc = icc.checked; apply(); });
    const iccRow = h('div', { class: 'ctrl-group' }, icc, h('label', { for: 'keepicc' }, 'Keep colour profile'));
    const limits = h('div', { class: 'meta-limits' }, h('p', { class: 'tool-title' }, 'What this does not do'), h('ul', {}, LIMITS.map((t) => h('li', {}, t))));

    el.append(foundTitle, foundList, foundNote,
      h('div', { class: 'tool-row' }, h('div', { class: 'ctrl-group' }, h('label', {}, 'Method'),
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Removal method' }, bLossless, bRebuild)), iccRow),
      methodHint, reason, limits);

    const cur = () => session.getState();
    /** Why lossless cannot be used right now, or '' when it can. */
    function blockReason(s) {
      const r = s.recipe;
      if (r.crop || r.resize || r.regions.length) return 'Lossless is off because Crop, Resize or blur regions are applied. They need the picture to be redrawn.';
      if (type === 'heic') return 'Lossless is off: HEIC cannot be rewritten here. Rebuild saves a JPG, PNG or WEBP from the pixels, so the HEIC file’s metadata blocks are not copied.';
      if (inspectError) return 'Lossless is off because this file’s metadata could not be read safely.';
      if (type !== 'jpeg' && orientation > 1) return 'Lossless is off: this ' + NAME[type] + ' has a rotation flag that would be lost.';
      return '';
    }

    /** Make recipe.strip match the controls. Only writes when something actually changed (no update loops). */
    function apply() {
      if (!alive) return;
      const s = cur();
      const method = want === 'lossless' && !blockReason(s) ? 'lossless' : 'reencode';
      const strip = s.recipe.strip;
      if (!strip || strip.method !== method || strip.keepIcc !== keepIcc) session.setRecipe({ strip: { method, keepIcc } });
      else render(s);
    }

    function render(s) {
      if (!alive || !s.decoded) return;
      const why = blockReason(s);
      const lossless = !!s.recipe.strip && s.recipe.strip.method === 'lossless';
      bLossless.setAttribute('aria-pressed', String(lossless));
      bRebuild.setAttribute('aria-pressed', String(!lossless));
      bLossless.disabled = !!why;
      reason.textContent = why; reason.classList.toggle('hidden', !why);
      iccRow.classList.toggle('hidden', !lossless);
      methodHint.textContent = lossless
        ? 'Lossless copies the picture data untouched and drops the metadata. Same quality, usually a smaller file.'
        : 'Rebuild redraws the picture and saves it again. Metadata blocks are not copied, but the picture is re-compressed (you can pick format and quality below).';
      if (found) {
        foundList.replaceChildren(...found.map((k) => h('li', { class: k === 'gps' ? 'meta-gps' : null, 'data-k': k }, LABELS[k] + (k === 'gps' ? ' — shows where the photo was taken' : ''))));
        foundNote.textContent = found.length ? '' : 'None of the metadata types Shrinkit looks for were found. Cleaning is still safe, but there may be little to remove.';
        foundNote.classList.toggle('hidden', found.length > 0);
      }
    }

    // Always start in the safest, best method, then let the file's real facts decide.
    if (type === 'heic') {   // HEIC metadata is not parsed by Shrinkit; the rebuilt output is what gets checked
      found = []; foundNote.textContent = 'Shrinkit does not list the metadata inside HEIC files. The rebuilt JPG/PNG/WEBP is re-read and checked for the categories Shrinkit knows.'; foundNote.classList.remove('hidden'); apply();
    } else readFileBytes(file).then((bytes) => {
      if (!alive) return;
      const r = inspectMetadata(bytes, type);
      found = r.found; orientation = r.orientation;
      apply(); render(cur());
    }).catch((e) => {
      if (!alive) return;
      inspectError = e.userMessage || 'Could not read this file’s metadata.';
      found = [];
      foundNote.textContent = inspectError; foundNote.classList.remove('hidden');
      apply();
    });

    apply();                                    // sets recipe.strip right away; processor then runs
    const off = session.subscribe(() => apply());   // idempotent: only writes the recipe when the method or option really changed
    return () => {
      alive = false; off(); session.setSuffix('');
      if (cur().recipe.strip) session.setRecipe({ strip: null });
    };
  },
};
