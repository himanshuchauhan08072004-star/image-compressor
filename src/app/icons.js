/** One consistent 24px stroke icon set, drawn here (no icon dependency). Paths are static strings, never user input. */
const P = {
  compress: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  resize: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  crop: '<path d="M6 2v14a2 2 0 002 2h14M2 6h14a2 2 0 012 2v14"/>',
  convert: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
  blur: '<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5" opacity=".55"/>',
  stack: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5M3 17.5l9 5 9-5" opacity=".6"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16c.5-2 5.5-2 6 0M14 10h4M14 14h3"/>',
  pen: '<path d="M4 20l1-4L17 4l3 3L8 19l-4 1zM14 7l3 3"/>',
  stamp: '<path d="M9 14V9a3 3 0 116 0v5l3 3v2H6v-2l3-3zM5 22h14"/>',
  wand: '<path d="M5 19L16 8l2 2L7 21l-2-2zM15 3v3M13.5 4.5h3M20 11v2M19 12h2"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  print: '<path d="M7 9V3h10v6M7 17H5a2 2 0 01-2-2v-4a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2h-2"/><rect x="7" y="14" width="10" height="7" rx="1"/>',
  flow: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="18" r="2"/><path d="M7 6h5a3 3 0 013 3v1M7 18h5a3 3 0 003-3v-1"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  moon: '<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 118 0v3"/>',
  zap: '<path d="M13 2L5 13h6l-1 9 8-11h-6l1-9z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18l5-5 4 4 3-3 4 4"/>',
  alert: '<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 19h16"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
};

export const hasIcon = (name) => Object.prototype.hasOwnProperty.call(P, name);

/** Returns an <svg> element. Decorative by default (aria-hidden); pass {label} to make it an image. */
export function icon(name, { size = 20, label = '' } = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', String(size)); el.setAttribute('height', String(size));
  el.setAttribute('fill', 'none'); el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.7'); el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('class', 'ico');
  if (label) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', label); } else el.setAttribute('aria-hidden', 'true');
  el.innerHTML = P[name] || P.image;
  return el;
}

/** Shrinkit mark: four corner brackets closing in on a centre square. */
export function logoMark(size = 26, id = 'lg') {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 32 32'); el.setAttribute('width', String(size)); el.setAttribute('height', String(size)); el.setAttribute('aria-hidden', 'true'); el.setAttribute('class', 'logo-mark');
  el.innerHTML = '<defs><linearGradient id="' + id + '" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop class="s1"/><stop offset="1" class="s2"/></linearGradient></defs>' +
    '<path d="M4 11V6a2 2 0 012-2h5M21 4h5a2 2 0 012 2v5M28 21v5a2 2 0 01-2 2h-5M11 28H6a2 2 0 01-2-2v-5" stroke="url(#' + id + ')" stroke-width="2.6" stroke-linecap="round" fill="none"/>' +
    '<rect x="11.5" y="11.5" width="9" height="9" rx="2.2" fill="url(#' + id + ')"/>';
  return el;
}
