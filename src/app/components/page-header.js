import { h } from '../dom.js';
import { icon } from '../icons.js';

/** Breadcrumb + title block. `title` may be a string or nodes (the landing hero uses <br>/<em>). Exactly one h1 per page. */
export function pageHead({ crumbs = [], eyebrow = '', title, sub = '', hero = false }) {
  const trail = crumbs.length ? h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
    crumbs.flatMap((c, i) => {
      const last = i === crumbs.length - 1;
      const node = c.href && !last ? h('a', { href: c.href, 'data-link': true }, c.label) : h('span', last ? { 'aria-current': 'page' } : {}, c.label);
      return i ? [icon('chevron', { size: 14 }), node] : [node];
    })) : null;
  return h('header', { class: 'page-head' + (hero ? ' hero-head' : '') },
    trail,
    eyebrow ? h('p', { class: 'eyebrow' }, eyebrow) : null,
    h('h1', {}, ...[].concat(title)),
    sub ? h('p', { class: 'sub' }, sub) : null);
}
