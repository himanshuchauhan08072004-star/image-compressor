/** Pure tool search + filter (unit-tested). Scores title > keywords > blurb; every word of the query must match somewhere. */
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

export function searchTools(tools, query = '', group = 'all') {
  const words = norm(query).split(/[^a-z0-9:]+/).filter(Boolean);
  const pool = group && group !== 'all' ? tools.filter((t) => t.group === group) : tools;
  if (!words.length) return pool.slice();
  const scored = [];
  for (const t of pool) {
    const title = norm(t.title), kw = norm(t.keywords), blurb = norm(t.blurb + ' ' + (t.short || ''));
    let total = 0, ok = true;
    for (const w of words) {
      const s = title.startsWith(w) ? 6 : title.includes(w) ? 4 : kw.split(/\s+/).some((k) => k.startsWith(w)) ? 3 : kw.includes(w) ? 2 : blurb.includes(w) ? 1 : 0;
      if (!s) { ok = false; break; }
      total += s;
    }
    if (ok) scored.push({ t, total });
  }
  return scored.sort((a, b) => b.total - a.total).map((x) => x.t);
}
