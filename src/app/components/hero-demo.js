import { h } from '../dom.js';
import { formatBytes } from '../../core/format.js';

const W = 960, H = 600, HI = 0.95, LO = 0.25;

/** Procedural sample (not a photo): sky, sun, hills, fine texture so JPEG quality visibly matters. Deterministic. */
function drawSample() {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#1a1448'); sky.addColorStop(.55, '#6a47f5'); sky.addColorStop(1, '#ff9e7a');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const sun = g.createRadialGradient(660, 330, 10, 660, 330, 170); sun.addColorStop(0, '#fff4d6'); sun.addColorStop(.35, 'rgba(255,214,160,.9)'); sun.addColorStop(1, 'rgba(255,158,122,0)');
  g.fillStyle = sun; g.beginPath(); g.arc(660, 330, 170, 0, Math.PI * 2); g.fill();
  const hills = [['#2b2a63', 360, 70, 0.006, 0], ['#1f2054', 430, 55, 0.009, 2], ['#141640', 505, 40, 0.013, 5]];
  for (const [col, base, amp, f, ph] of hills) {
    g.fillStyle = col; g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, base + Math.sin(x * f + ph) * amp + Math.sin(x * f * 2.7 + ph) * amp * .35);
    g.lineTo(W, H); g.closePath(); g.fill();
  }
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1;                       // fine lines: costly to compress
  for (let i = 0; i < 90; i++) { const x = (i * 97) % W, y = 40 + ((i * 53) % 260); g.beginPath(); g.moveTo(x, y); g.lineTo(x + 18 + (i % 7) * 6, y + ((i % 5) - 2) * 3); g.stroke(); }
  const img = g.getImageData(0, 0, W, H), d = img.data; let s = 1234567;           // seeded grain
  for (let i = 0; i < d.length; i += 4) { s = (s * 1664525 + 1013904223) >>> 0; const n = ((s >>> 24) - 128) * 0.14; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  return c;
}
const toBlob = (c, q) => new Promise((res) => c.toBlob(res, 'image/jpeg', q));

/**
 * Real, small demonstration: the sample is encoded twice by this browser (JPG q95 and q25) and the byte sizes shown are the real
 * blob sizes. Drag the handle or use the arrow keys. Returns { el, dispose }. If encoding is unavailable the demo stays hidden.
 */
export function createHeroDemo() {
  let dead = false; const urls = [];
  const wrap = h('figure', { class: 'hero-demo' });
  const frame = h('div', { class: 'demo', role: 'group', 'aria-label': 'Sample image compared at two JPG qualities' }, h('div', { class: 'demo-skel' }));
  const cap = h('figcaption', { class: 'demo-cap' }, 'Preparing a live sample…');
  wrap.append(frame, cap);

  const start = async () => {
    try {
      const c = drawSample();
      const [a, b] = [await toBlob(c, HI), await toBlob(c, LO)];
      c.width = c.height = 0;
      if (dead) return;
      if (!a || !b || a.type !== 'image/jpeg' || b.type !== 'image/jpeg') throw new Error('no jpeg');
      const ua = URL.createObjectURL(a), ub = URL.createObjectURL(b); urls.push(ua, ub);
      const range = h('input', { type: 'range', class: 'demo-range', min: '0', max: '100', value: '50', 'aria-label': 'Compare quality 95 with quality 25. Move to reveal more of either side.' });
      range.addEventListener('input', () => frame.style.setProperty('--pos', range.value + '%'));
      frame.replaceChildren(
        h('img', { src: ub, alt: 'Sample saved at JPG quality 25', draggable: 'false' }),
        h('img', { class: 'demo-top', src: ua, alt: 'Sample saved at JPG quality 95', draggable: 'false' }),
        h('span', { class: 'demo-tag l' }, 'Q95 · ' + formatBytes(a.size)), h('span', { class: 'demo-tag r' }, 'Q25 · ' + formatBytes(b.size)),
        h('span', { class: 'demo-handle', 'aria-hidden': 'true' }), range, h('span', { class: 'demo-focus', 'aria-hidden': 'true' }));
      const pct = Math.round((1 - b.size / a.size) * 100);
      cap.textContent = 'Live sample, drawn and encoded by your browser just now: Q25 is ' + pct + '% smaller than Q95 here. Results on real photos vary.';
    } catch { if (!dead) wrap.classList.add('hidden'); }   // no demo is better than a fake one
  };
  (window.requestIdleCallback || ((f) => setTimeout(f, 60)))(start);
  return { el: wrap, dispose() { dead = true; urls.forEach((u) => URL.revokeObjectURL(u)); urls.length = 0; } };
}
