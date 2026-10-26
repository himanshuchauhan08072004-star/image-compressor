import { h } from '../dom.js';
import { createSheetPanel } from '../components/sheet-panel.js';

/** Print Layout: the sheet panel on its own (no passport crop). Add pictures, choose paper and sizes, export a PDF. */
export default {
  mount(root) {
    const panel = createSheetPanel({ mode: 'standalone' });
    root.append(h('div', { class: 'tool-area sig-root' }, h('p', { class: 'tool-hint' }, 'Nothing is uploaded: pictures are read in your browser. Open “Advanced layout” to add pictures, choose photo sizes and presets.'), panel.el));
    return () => panel.dispose();
  },
};
