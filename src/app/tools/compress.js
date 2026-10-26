import { h } from '../dom.js';

/** Compress has no geometry controls of its own: the shared output panel does the work. */
export default {
  mount(el) {
    el.append(h('p', { class: 'tool-hint' },
      'Pick a quality, or switch to “Target size” and Shrinkit finds the best quality that fits your limit.'));
    return () => {};
  },
};
