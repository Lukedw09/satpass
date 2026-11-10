// Regenerate data/fallback-tle.js from CelesTrak (Node 18+, no dependencies).
//   node tools/update-fallback.mjs
// The site only uses this snapshot when the live CelesTrak request fails.
import { writeFileSync } from 'node:fs';
const groups = ['stations', 'visual'];
const seen = new Set(), out = [];
for (const g of groups) {
  const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`);
  if (!r.ok) throw new Error(`${g}: HTTP ${r.status}`);
  const L = (await r.text()).split(/\r?\n/).map(s => s.trim());
  for (let i = 0; i + 2 < L.length; i++) {
    if (L[i + 1].startsWith('1 ') && L[i + 2].startsWith('2 ')) {
      const n = L[i + 1].slice(2, 7);
      if (!seen.has(n)) { seen.add(n); out.push(L[i], L[i + 1], L[i + 2]); }
      i += 2;
    }
  }
}
const obj = { fetchedUtc: new Date().toISOString(), source: 'CelesTrak gp.php GROUP=stations + GROUP=visual (FORMAT=tle)', count: seen.size, tle: out.join('\n') };
writeFileSync(new URL('../data/fallback-tle.js', import.meta.url),
  '/* Bundled TLE snapshot used only when the live CelesTrak fetch fails. Regenerate: node tools/update-fallback.mjs */\nwindow.SATPASS_FALLBACK = ' + JSON.stringify(obj) + ';\n');
console.log(`wrote ${seen.size} objects`);
