// One-time importer: downloads the public Striver A2Z sheet and writes data/striver-sheet.json.
// Usage: node scripts/import-striver.mjs [path/to/saved.html]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStriverSheet, STRIVER_URL } from '../server/striver-parse.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let html;
if (process.argv[2]) html = fs.readFileSync(process.argv[2], 'utf8');
else {
  const res = await fetch(STRIVER_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  html = await res.text();
}
const { steps } = parseStriverSheet(html);
for (const s of steps) for (const t of s.topics) for (const it of t.items) delete it.status;
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'striver-sheet.json'), JSON.stringify({ source: STRIVER_URL, importedAt: new Date().toISOString(), steps }, null, 1));
const n = steps.reduce((a, s) => a + s.topics.reduce((b, t) => b + t.items.length, 0), 0);
const lc = steps.reduce((a, s) => a + s.topics.reduce((b, t) => b + t.items.filter((i) => i.leetcodeSlug).length, 0), 0);
console.log(`Imported ${steps.length} steps, ${n} items (${lc} with LeetCode links)`);
steps.forEach((s) => console.log(' -', s.title, '|', s.topics.length, 'topics'));
