import { h } from '../dom.js';
import { icon } from '../icons.js';
import { GROUPS, readyTools } from '../registry.js';
import { createDropzone } from '../components/dropzone.js';
import { createHeroDemo } from '../components/hero-demo.js';
import { toolCard } from '../components/tool-card.js';
import { setPendingGroup } from './tools-page.js';
import { MAX_FILE_BYTES } from '../../core/limits.js';

const STEPS = [
  ['01', 'upload', 'Add an image', 'Drop in a JPG, PNG, WEBP or HEIC photo. It is opened in this tab and checked against size limits first.'],
  ['02', 'wand', 'Shape it', 'Compress to a quality or an exact size, resize, crop, convert, clean metadata, cover faces, add a watermark.'],
  ['03', 'download', 'Save the result', 'Download one file, or a ZIP for a batch, or a print-ready PDF at true physical size.'],
];

/** What the privacy panel says is true of the code in this repo (see HANDOFF Phase 8: no fetch/XHR in source, connect-src 'self', one e2e network check). */
const FACTS = [
  ['lock', 'Images are processed on this device', 'Decoding, editing and encoding use your browser. No image is sent to a server.', 'The page’s Content-Security-Policy only allows requests to this site.'],
  ['shield', 'No account, no tracking pixels', 'Nothing to sign up for and no analytics scripts are loaded.', ''],
  ['zap', 'HEIC is decoded locally too', 'iPhone photos are opened with a WebAssembly decoder that ships with the app.', 'It loads only when a HEIC file is opened.'],
  ['info', 'Saved settings stay in this browser', 'Only your theme and your saved print-layout presets are remembered, and never pictures or file names.', ''],
];

const CAPS = [
  ['Exact target size', 'Compress to 50 KB, 200 KB or any size you type.'],
  ['True-size PDF', 'Print layouts are written at physical size and self-checked.'],
  ['Batch with ZIP', 'Up to 50 files per run, one verified ZIP.'],
  ['Honest limits', '100 MB per file, 100 MP in, 40 MP out. Clear messages when exceeded.'],
];

const POPULAR = ['compress', 'resize', 'convert', 'metadata', 'background', 'passport'];

/** Home page nodes + a dispose function. Upload reuses the shared session through the existing dropzone. */
export function renderHome() {
  const tools = readyTools();
  const demo = createHeroDemo();
  const mb = Math.round(MAX_FILE_BYTES / 1048576);

  const hero = h('section', { class: 'hero', 'aria-labelledby': 'home-title' },
    h('div', {},
      h('p', { class: 'eyebrow' }, 'Browser-only · no upload · no sign-up'),
      h('h1', { id: 'home-title' }, 'Every image.', h('br'), h('em', {}, 'Precisely processed.')),
      h('p', { class: 'sub' }, 'Compress, resize, convert and clean images, or lay them out for print, in one workspace that never uploads a single file.'),
      createDropzone({ label: 'Choose an image to open', limits: 'Up to ' + mb + ' MB per file' }),
      h('div', { class: 'quick' }, h('span', { class: 'quick-t' }, 'Or start with'),
        POPULAR.map((id) => tools.find((t) => t.id === id)).filter(Boolean).map((t) =>
          h('a', { class: 'quick-link', href: t.path, 'data-link': true }, icon(t.icon, { size: 16 }), t.title))),
      h('div', { class: 'hero-meta' }, h('a', { href: '/tools', 'data-link': true }, 'Browse all ' + tools.length + ' tools', icon('arrow', { size: 14 })))),
    demo.el);

  const toolsSection = h('section', { class: 'section', 'aria-labelledby': 'tools-title' },
    h('div', { class: 'section-head' },
      h('div', {}, h('h2', { id: 'tools-title' }, 'Every tool, by what you need to do'), h('p', {}, 'Each one opens a real workspace. Pick an image first or start from the tool.')),
      h('a', { class: 'link-more', href: '/tools', 'data-link': true }, 'Search the directory', icon('arrow', { size: 16 }))),
    GROUPS.map((g) => {
      const items = tools.filter((t) => t.group === g.id);
      if (!items.length) return null;
      const more = h('a', { class: 'link-more', href: '/tools', 'data-link': true, 'data-cat': g.id }, 'Filter in directory');
      more.addEventListener('click', () => setPendingGroup(g.id));
      return h('div', { class: 'group-block' },
        h('div', { class: 'group-head' }, h('div', {}, h('h3', {}, g.title), h('p', {}, g.blurb)), more),
        h('div', { class: 'task-grid' }, items.map((t) => toolCard(t, { level: 4 }))));
    }));

  const workflow = h('section', { class: 'section', 'aria-labelledby': 'flow-title' },
    h('div', { class: 'section-head' }, h('div', {}, h('h2', { id: 'flow-title' }, 'How it works'), h('p', {}, 'Three steps, no accounts. Settings update the real output as you change them.'))),
    h('div', { class: 'steps' }, STEPS.map(([n, ic, t, d]) =>
      h('div', { class: 'step' }, h('p', { class: 'step-n' }, icon(ic, { size: 18 }), n), h('h3', {}, t), h('p', {}, d)))));

  const privacy = h('section', { class: 'section', 'aria-labelledby': 'privacy-title' },
    h('div', { class: 'privacy' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Privacy'), h('h2', { id: 'privacy-title' }, 'Your pictures stay yours.'),
        h('p', {}, 'Shrinkit is a static site. There is no upload endpoint to send an image to, so there is nothing to trust, only to verify in your browser’s network panel.')),
      h('ul', { class: 'facts' }, FACTS.map(([ic, t, d, fine]) =>
        h('li', {}, h('span', { class: 'fi' }, icon(ic, { size: 16 })), h('div', {}, h('strong', {}, t), h('span', { class: 'd' }, d), fine ? h('span', { class: 'fine' }, fine) : null))))));

  const caps = h('section', { class: 'section', 'aria-labelledby': 'caps-title' },
    h('div', { class: 'section-head' }, h('div', {}, h('h2', { id: 'caps-title' }, 'Built to be precise'))),
    h('div', { class: 'caps' }, CAPS.map(([t, d]) => h('div', { class: 'cap' }, h('strong', {}, t), h('span', {}, d)))));

  return { nodes: [hero, toolsSection, workflow, privacy, caps], dispose: () => demo.dispose() };
}
