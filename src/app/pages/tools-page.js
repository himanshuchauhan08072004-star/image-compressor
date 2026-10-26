import { h } from '../dom.js';
import { icon } from '../icons.js';
import { GROUPS, readyTools } from '../registry.js';
import { searchTools } from '../tool-search.js';
import { toolCard } from '../components/tool-card.js';
import { pageHead } from '../components/page-header.js';

let pending = null;
/** Home page category links ask the directory to open with a group already selected. */
export const setPendingGroup = (id) => { pending = id; };

export function renderToolsPage() {
  const tools = readyTools();
  let q = '', group = pending && GROUPS.some((g) => g.id === pending) ? pending : 'all';
  pending = null;

  const input = h('input', { type: 'search', id: 'tools-q', placeholder: 'Search: compress, passport, blur, pdf…', autocomplete: 'off', 'aria-label': 'Search tools' });
  const meta = h('p', { class: 'results-meta', role: 'status' });
  const grid = h('div', { class: 'task-grid' });
  const holder = h('div', {});
  const filters = h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter by category' });

  const chip = (id, label) => {
    const b = h('button', { type: 'button', class: 'chip', 'data-group': id, 'aria-pressed': 'false' }, label);
    b.addEventListener('click', () => { group = id; paint(); });
    return b;
  };
  const chips = [chip('all', 'All'), ...GROUPS.map((g) => chip(g.id, g.title))];
  filters.append(...chips);

  function paint() {
    const list = searchTools(tools, q, group);
    chips.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === group)));
    const gTitle = (GROUPS.find((g) => g.id === group) || {}).title;
    meta.textContent = q.trim()
      ? list.length + (list.length === 1 ? ' tool matches “' : ' tools match “') + q.trim() + '”' + (gTitle ? ' in ' + gTitle : '')
      : (gTitle ? list.length + ' ' + gTitle + ' tools' : tools.length + ' tools');
    if (!list.length) {
      const clear = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { q = ''; input.value = ''; paint(); input.focus(); } }, 'Clear search');
      const all = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { group = 'all'; paint(); } }, 'Show every category');
      holder.replaceChildren(h('div', { class: 'empty' },
        h('span', { class: 'eico' }, icon('search', { size: 24 })),
        h('h2', {}, 'No tools match “' + q.trim() + '”'),
        h('p', {}, group === 'all' ? 'Try a task word like “resize”, “metadata” or “print”, or a format like “heic”.' : 'Nothing in ' + gTitle + ' matches. Other categories might.'),
        h('div', { class: 'tool-row' }, clear, group === 'all' ? null : all)));
      return;
    }
    grid.replaceChildren(...list.map((t) => toolCard(t, { showGroup: true, level: 2 })));
    holder.replaceChildren(grid);
  }
  input.addEventListener('input', () => { q = input.value; paint(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); q = ''; input.value = ''; paint(); } });
  paint();

  const search = h('div', { class: 'tools-search' }, icon('search', { size: 20 }), input);
  const node = h('div', {},
    pageHead({ crumbs: [{ label: 'Home', href: '/' }, { label: 'Tools' }], title: 'All tools', sub: 'Find the right one by task or format. Every tool runs in your browser.' }),
    h('div', { class: 'tools-bar' }, search, filters), meta, holder);
  return { nodes: [node], dispose() {} };
}
