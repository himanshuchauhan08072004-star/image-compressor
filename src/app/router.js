export function normalizePath(p) {
  const clean = (p || '/').split(/[?#]/)[0].replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

/** Minimal History-API router. Links opt in with data-link. */
export function createRouter(onRoute) {
  const here = () => normalizePath(location.pathname);
  const go = (path, { replace = false } = {}) => {
    const target = normalizePath(path);
    if (target !== here()) history[replace ? 'replaceState' : 'pushState'](null, '', target);
    onRoute(target);
  };
  addEventListener('popstate', () => onRoute(here()));
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-link]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(a.getAttribute('href'));
  });
  return { go, start: () => onRoute(here()) };
}
