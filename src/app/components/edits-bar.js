import { h } from '../dom.js';

/** Shows active crop/resize/region edits (shared across tools) with a remove button each. */
export function mountEditsBar(el, session) {
  el.className = 'edits';
  function render(s) {
    if (!s.decoded) return;
    const { crop, resize, regions } = s.recipe;
    const chips = [];
    if (crop) chips.push(['Crop ' + crop.w + ' × ' + crop.h, () => session.setRecipe({ crop: null })]);
    if (resize) chips.push(['Resize ' + resize.width + ' × ' + resize.height, () => session.setRecipe({ resize: null })]);
    if (regions.length) chips.push([regions.length + ' protected ' + (regions.length === 1 ? 'region' : 'regions'), () => session.setRecipe({ regions: [] })]);
    el.replaceChildren(...chips.map(([label, remove]) =>
      h('span', { class: 'edit-chip' }, label,
        h('button', { type: 'button', 'aria-label': 'Remove ' + label, onClick: remove }, '×'))));
    el.classList.toggle('hidden', chips.length === 0);
  }
  render(session.getState());
  return session.subscribe(render);
}
