import { THEME_KEY, resolveTheme, nextTheme } from './theme-logic.js';

const read = () => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } };
const write = (v) => { try { localStorage.setItem(THEME_KEY, v); } catch { /* blocked: the choice lasts for this tab only */ } };
const mq = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null);

export const currentTheme = () => document.documentElement.getAttribute('data-theme') || resolveTheme(read(), !!(mq() && mq().matches));

export function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#F6F6F9' : '#0B0C10');
}

/** Toggle persists the choice. Until the person chooses, a change of system preference is followed live. */
export function startTheme(onChange = () => {}) {
  applyTheme(currentTheme());
  const m = mq();
  if (m && m.addEventListener) m.addEventListener('change', () => {
    if (read() === 'light' || read() === 'dark') return;
    applyTheme(resolveTheme(null, m.matches)); onChange(currentTheme());
  });
  return {
    current: currentTheme,
    toggle() { const t = nextTheme(currentTheme()); write(t); applyTheme(t); onChange(t); return t; },
  };
}
