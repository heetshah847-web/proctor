// Parses the takeuforward A2Z sheet page (Next.js flight payload) into a tree.
// Used both by the one-time importer and by the per-student TUF progress check
// (when a student supplies their TUF session cookie, the same page comes back
// with their per-item `status`).

function extractFlight(html) {
  const re = /self\.__next_f\.push\((\[.*?\])\)<\/script>/gs;
  let flight = '';
  for (const m of html.matchAll(re)) {
    try {
      const a = JSON.parse(m[1]);
      if (typeof a[1] === 'string') flight += a[1];
    } catch { /* ignore non-JSON chunks */ }
  }
  return flight;
}

function sliceBalanced(text, start) {
  let depth = 0, inStr = false, esc = false, i = start;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('Unbalanced JSON in sheet payload');
}

function leetcodeSlug(url) {
  const m = typeof url === 'string' && url.match(/leetcode\.com\/problems\/([a-z0-9-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Returns { steps: [{ id, title, topics: [{ id, title, items: [...] }] }], items: Map } */
export function parseStriverSheet(html) {
  const flight = extractFlight(html);
  const key = '"sheet_syllabus":';
  const idx = flight.indexOf(key);
  if (idx < 0) throw new Error('sheet_syllabus not found — page format may have changed');
  const syl = JSON.parse(sliceBalanced(flight, idx + key.length));

  const rows = syl.rows.map((r) => {
    const fields = syl.fields[r[0]];
    const o = {};
    fields.forEach((f, k) => { o[f] = r[k + 1]; });
    return o;
  });

  const toItem = (o) => ({
    id: String(o.id),
    slug: o.slug,
    title: o.label,
    kind: o.layoutType, // "practice" | "learning" | "contest"
    duration: typeof o.duration === 'string' ? o.duration : null,
    difficulty: typeof o.difficulty === 'string' && !o.difficulty.startsWith('$') ? o.difficulty : null,
    leetcodeSlug: leetcodeSlug(o.leetcode_link),
    url: typeof o.leetcode_link === 'string' && o.leetcode_link.startsWith('http') ? o.leetcode_link : null,
    status: o.status ?? null,
  });

  const collect = (rowIdx, out) => {
    const o = rows[rowIdx];
    if (!o) return;
    if (o.type === 'category') (o.children || []).forEach((c) => collect(c, out));
    else if (o.type === 'item') out.push(toItem(o));
  };

  const roots = Array.isArray(syl.roots) ? syl.roots : [];
  const steps = roots.map((ri) => {
    const step = rows[ri];
    const topics = [];
    const direct = [];
    for (const c of step.children || []) {
      const child = rows[c];
      if (child?.type === 'category') {
        const items = [];
        collect(c, items);
        topics.push({ id: String(child.id), title: child.label, items });
      } else if (child?.type === 'item') {
        direct.push(toItem(child));
      }
    }
    if (direct.length) topics.unshift({ id: `${step.id}-direct`, title: step.label, items: direct });
    return { id: String(step.id), title: step.label, topics };
  });

  const items = new Map();
  for (const s of steps) for (const t of s.topics) for (const it of t.items) items.set(it.id, { ...it, step: s.title, topic: t.title });
  return { steps, items };
}

export const STRIVER_URL = 'https://takeuforward.org/prep-hub/strivers-a2z-dsa-sheet';
