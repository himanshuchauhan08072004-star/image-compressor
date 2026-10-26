import { h } from './dom.js';
import { session } from './session.js';
import { startProcessor } from './processor.js';
import { createRouter } from './router.js';
import { readyTools, toolByPath, DEFAULT_TOOL_PATH, GROUPS } from './registry.js';
import { createDropzone } from './components/dropzone.js';
import { mountHeader } from './components/site-header.js';
import { mountFooter } from './components/site-footer.js';
import { pageHead } from './components/page-header.js';
import { renderHome } from './pages/home.js';
import { renderToolsPage } from './pages/tools-page.js';
import { startTheme } from './theme.js';
import { mountResult } from './components/result-view.js';
import { mountOutputPanel } from './components/output-panel.js';
import { mountEditsBar } from './components/edits-bar.js';

const SITE = 'Shrinkit';
const HOME_TITLE = 'Shrinkit — precise image tools that run in your browser';

export function startApp({ view, nav, navStrip, header, footer }) {
  startProcessor(session);
  let chrome = null;
  const theme = startTheme((t) => chrome && chrome.onThemeChange(t));
  // A file dropped slightly outside the dropzone would make the browser open it and discard the user's work.
  const guard = (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); };
  addEventListener('dragover', guard);
  addEventListener('drop', guard);
  let path = '/', disposers = [], token = 0, lastDecoded = null;

  const router = createRouter((p) => show(p));

  chrome = mountHeader({ header, navStrip, nav, tools: readyTools(), groups: GROUPS, go: (p) => router.go(p), theme });
  mountFooter(footer);

  const heroHead = (tool) => pageHead({
    crumbs: [{ label: 'Tools', href: '/tools' }, { label: tool.title }], hero: true,
    title: [tool.hero.a, h('br'), tool.hero.b, h('em', {}, tool.hero.em)], sub: tool.blurb });
  const compactHead = (tool) => pageHead({ crumbs: [{ label: 'Tools', href: '/tools' }, { label: tool.title }], title: tool.title, sub: tool.blurb });

  /** Tool landing (no image yet): hero + the shared upload. The home page is its own module. */
  function landing(tool) {
    view.append(heroHead(tool), h('section', { class: 'lighttable' }, createDropzone({ label: 'Choose an image' })));
  }

  /** A tool chunk can fail to load (offline, or an old tab after a new deploy changed the file names). Show a way out instead of a blank page. */
  const loadFailed = (tool) => h('section', { class: 'lighttable workbench' }, h('div', { class: 'tool-area', role: 'alert' },
    h('p', { class: 'dz-error' }, 'Could not load ' + tool.title + '. Check your connection, then reload the page. Your images never left this device.'),
    h('button', { type: 'button', class: 'btn btn-primary', id: 'reload-tool', onClick: () => location.reload() }, 'Reload')));
  async function loadTool(tool, my) {
    let mod;
    try { mod = await tool.load(); } catch (e) { if (my === token) view.replaceChildren(loadFailed(tool)); return null; }
    return my === token ? mod : null;
  }
  const safeMount = (mod, el, tool) => {
    try { return mod.default.mount(el, { session }); }
    catch (e) { el.replaceChildren(loadFailed(tool)); return null; }   // a tool that throws while mounting must not break the shell
  };

  async function workbench(tool) {
    const my = token;
    const mod = await loadTool(tool, my);
    if (!mod) return;
    if (tool.ownView) {
      const area = h('div', { class: 'tool-area sig-root' });
      view.append(compactHead(tool), h('section', { class: 'lighttable workbench own-view' }, area));
      disposers.push(safeMount(mod, area, tool));
      return;
    }
    const [edits, toolArea, stage, out] = [h('div'), h('div', { class: 'tool-area' }), h('div', { class: 'stage active' }), h('div')];
    const panel = h('div', { class: 'panel' });
    view.append(compactHead(tool), h('section', { class: 'lighttable workbench' }, edits, toolArea, stage, out), panel);
    disposers.push(mountEditsBar(edits, session), safeMount(mod, toolArea, tool),
      mountResult(stage, panel, session), mountOutputPanel(out, session));
  }

  /** Tools that bring their own images (Batch): no single-image session needed. */
  async function standalone(tool) {
    const my = token;
    const mod = await loadTool(tool, my);
    if (!mod) return;
    const root = h('section', { class: 'lighttable workbench batch' });
    view.append(heroHead(tool), root);
    disposers.push(safeMount(mod, root, tool));
  }

  const PAGES = { '/tools': { title: 'All tools', render: renderToolsPage } };

  function show(p) {
    token++;
    disposers.forEach((d) => typeof d === 'function' && d());
    disposers = [];
    view.replaceChildren();
    const moved = p !== path;
    path = p;
    const tool = toolByPath(p), page = PAGES[p];
    if (p !== '/' && !tool && !page) { router.go('/', { replace: true }); return; }
    session.setSuspended(!!(tool && tool.ownView));   // before any await: the processor must not start a run for a tool that has its own preview
    document.body.dataset.page = page ? 'tools' : tool ? 'tool' : 'home';
    chrome.sync(p);
    document.title = tool ? tool.title + ' — ' + SITE : page ? page.title + ' — ' + SITE : HOME_TITLE;
    if (page) { const r = page.render(); view.append(...r.nodes); disposers.push(r.dispose); }
    else if (tool && tool.standalone) standalone(tool);
    else if (!session.getState().decoded) {
      if (tool) landing(tool);
      else { const r = renderHome(); view.append(...r.nodes); disposers.push(r.dispose); }
    }
    else if (!tool) router.go(DEFAULT_TOOL_PATH, { replace: true });
    else workbench(tool);
    if (moved) { scrollTo(0, 0); view.focus({ preventScroll: true }); }   // new page: start at the top, and screen readers land on the content
  }

  session.subscribe((s) => {
    if (s.decoded === lastDecoded) return;
    lastDecoded = s.decoded;
    show(path);
  });
  router.start();
}
