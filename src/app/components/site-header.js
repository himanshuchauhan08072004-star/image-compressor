import { h } from '../dom.js';
import { icon, logoMark } from '../icons.js';
import { searchTools } from '../tool-search.js';

/**
 * Header (brand, search, theme, menu) + the ONE tool-nav element. Desktop: tab strip under the header.
 * Mobile: the same element becomes the drawer opened by the menu button. Search is a native <dialog> palette over the real registry.
 */
export function mountHeader({ header, navStrip, nav, tools, groups, go, theme }) {
  // ---- tool nav (one markup for every viewport) ----
  nav.replaceChildren(...groups.map((g) => {
    const items = tools.filter((t) => t.group === g.id);
    if (!items.length) return null;
    return h('div', { class: 'nav-group', role: 'group', 'aria-label': g.title },
      h('span', { class: 'nav-group-t', 'aria-hidden': 'true' }, g.title),
      items.map((t) => h('a', { href: t.path, 'data-link': true }, icon(t.icon, { size: 16 }), t.title)));
  }));

  // ---- header ----
  const themeBtn = h('button', { type: 'button', class: 'icon-btn theme-btn' });
  const paintTheme = (t) => {
    themeBtn.replaceChildren(icon(t === 'dark' ? 'sun' : 'moon', { size: 18 }));
    themeBtn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    themeBtn.setAttribute('title', t === 'dark' ? 'Light theme' : 'Dark theme');
  };
  const searchBtn = h('button', { type: 'button', class: 'search-btn', 'aria-haspopup': 'dialog', 'aria-label': 'Search tools' },
    icon('search', { size: 18 }), h('span', { class: 'search-label' }, 'Search tools'), h('span', { class: 'kbd', 'aria-hidden': 'true' }, '/'));
  const menuBtn = h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-label': 'Open menu', 'aria-expanded': 'false', 'aria-controls': 'toolNav' }, icon('menu', { size: 20 }));
  header.className = 'site-header';
  header.append(h('div', { class: 'site-header-in' },
    h('a', { class: 'brandmark', href: '/', 'data-link': true, 'aria-label': 'Shrinkit home' }, logoMark(28, 'lg-h'), h('span', {}, 'Shrinkit')),
    h('div', { class: 'header-actions' }, searchBtn,
      h('a', { class: 'btn btn-primary btn-sm header-cta', href: '/tools', 'data-link': true }, 'All tools'),
      themeBtn, menuBtn)));

  // ---- menu (mobile drawer) ----
  const setMenu = (open) => {
    document.body.classList.toggle('menu-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    menuBtn.replaceChildren(icon(open ? 'close' : 'menu', { size: 20 }));
    if (open) document.documentElement.style.setProperty('--hdr-h', header.offsetHeight + 'px');
  };
  menuBtn.addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
  navStrip.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  const onKey = (e) => { if (e.key === 'Escape' && document.body.classList.contains('menu-open')) { setMenu(false); menuBtn.focus(); } };
  addEventListener('keydown', onKey);
  const mqWide = matchMedia('(min-width: 900px)');
  mqWide.addEventListener('change', () => { if (mqWide.matches) setMenu(false); });

  // ---- search palette ----
  const input = h('input', { type: 'text', id: 'palette-input', placeholder: 'Search tools: compress, passport, blur…', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list', 'aria-label': 'Search tools' });
  const list = h('ul', { class: 'pal-list', id: 'palette-list', role: 'listbox', 'aria-label': 'Matching tools' });
  const status = h('p', { class: 'sr-only', role: 'status' });
  const dlg = h('dialog', { class: 'palette', 'aria-label': 'Search tools' },
    h('div', { class: 'pal-field' }, icon('search', { size: 20 }), input),
    list, status,
    h('div', { class: 'pal-foot' }, h('span', {}, '↑ ↓ to move'), h('span', {}, 'Enter to open'), h('span', {}, 'Esc to close')));
  document.body.append(dlg);

  let results = [], active = 0;
  const paint = () => {
    results = searchTools(tools, input.value).slice(0, 8);
    active = Math.min(active, Math.max(0, results.length - 1));
    if (!results.length) {
      list.replaceChildren(h('li', { class: 'pal-empty', role: 'presentation' }, 'No tool matches “' + input.value.trim() + '”. Try “resize”, “metadata” or “pdf”.'));
      status.textContent = 'No tools found';
      input.removeAttribute('aria-activedescendant'); return;
    }
    list.replaceChildren(...results.map((t, i) => h('li', { class: 'pal-item', role: 'presentation' },
      h('a', { href: t.path, 'data-link': true, role: 'option', id: 'pal-' + t.id, 'aria-selected': String(i === active), tabindex: '-1' },
        h('span', { class: 'pal-icon' }, icon(t.icon, { size: 18 })),
        h('span', { class: 'pal-text' }, h('span', { class: 'pal-t' }, t.title), h('span', { class: 'pal-d' }, t.blurb))))));
    input.setAttribute('aria-activedescendant', 'pal-' + results[active].id);
    status.textContent = results.length + (results.length === 1 ? ' tool' : ' tools');
  };
  const close = () => { if (dlg.open) dlg.close(); };
  const open = () => { if (dlg.open) return; setMenu(false); input.value = ''; active = 0; paint(); dlg.showModal(); input.focus(); };
  input.addEventListener('input', () => { active = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (results.length) { active = (active + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length; paint(); list.children[active].scrollIntoView({ block: 'nearest' }); } }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); const p = results[active].path; close(); go(p); }
  });
  list.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });   // the router's own link handler does the navigation
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });         // click on the backdrop
  searchBtn.addEventListener('click', open);
  const onSlash = (e) => {
    const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if ((e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); open(); }
  };
  addEventListener('keydown', onSlash);

  // ---- theme ----
  paintTheme(theme.current());
  themeBtn.addEventListener('click', () => paintTheme(theme.toggle()));

  return {
    sync(path) {
      nav.querySelectorAll('a').forEach((a) => (a.getAttribute('href') === path ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
      setMenu(false); close();
    },
    onThemeChange: paintTheme,
  };
}
