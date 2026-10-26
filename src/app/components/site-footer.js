import { h } from '../dom.js';

export function mountFooter(el) {
  el.className = 'site-footer';
  el.append(h('div', { class: 'site-footer-in' },
    h('p', { class: 'author' }, 'Built by ', h('strong', {}, 'Himanshu Chauhan'), h('br'),
      h('a', { href: 'mailto:himanshuchauhan08072004@gmail.com' }, 'himanshuchauhan08072004@gmail.com')),
    h('a', { class: 'built-for', href: 'https://digitalheroesco.com', target: '_blank', rel: 'noopener' }, h('span', { class: 'dot' }), 'Built for Digital Heroes'),
    h('p', { class: 'foot-note' }, 'Everything runs locally in your browser with the ', h('code', {}, 'canvas'), ' API. Your images are never sent to a server and nothing about them is stored.')));
}
