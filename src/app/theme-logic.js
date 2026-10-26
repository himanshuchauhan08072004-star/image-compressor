/** Pure theme rules (unit-tested). public/theme-init.js repeats resolveTheme before first paint. */
export const THEME_KEY = 'shrinkit.theme';
export function resolveTheme(stored, systemPrefersLight) {
  if (stored === 'light' || stored === 'dark') return stored;
  return systemPrefersLight ? 'light' : 'dark';
}
export const nextTheme = (current) => (current === 'dark' ? 'light' : 'dark');
