// Runs before first paint (blocking, external so the CSP script-src 'self' allows it). Keep in sync with src/app/theme-logic.js.
(function () {
  var t = null;
  try { t = localStorage.getItem('shrinkit.theme'); } catch (e) { /* storage blocked: follow the system */ }
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();
