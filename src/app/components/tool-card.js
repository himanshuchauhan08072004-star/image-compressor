import { h } from '../dom.js';
import { icon } from '../icons.js';
import { GROUPS } from '../registry.js';

const groupTitle = (id) => (GROUPS.find((g) => g.id === id) || {}).title || '';

/** One tool entry, used by the home page and the /tools directory. A real link to a real route. */
export function toolCard(tool, { showGroup = false, level = 3 } = {}) {
  return h('a', { class: 'task-card', href: tool.path, 'data-link': true },
    h('div', { class: 'tc-top' }, h('span', { class: 'tc-icon' }, icon(tool.icon, { size: 20 })), h('span', { class: 'tc-arrow' }, icon('arrow', { size: 18 }))),
    h('h' + level, {}, tool.title),
    h('p', {}, tool.short || tool.blurb),
    showGroup ? h('span', { class: 'tc-tag' }, groupTitle(tool.group)) : null);
}
