// Pre-written interview questions (data/question-bank.txt) so the AI is only needed for grading.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { sheetItems } from './sources.js';

const BANK_PATH = path.join(ROOT, 'data', 'question-bank.txt');

/** Map slug -> { toughness, importance, questions: [{ q, a }] } */
export function loadBank(file = BANK_PATH) {
  const bank = new Map();
  if (!fs.existsSync(file)) return bank;
  let cur = null;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, n) => {
    if (!line.trim() || line.startsWith('#')) return;
    const head = line.match(/^@(.+?)\s+([1-5])\s+([1-5])\s*$/);
    if (head) {
      cur = { toughness: Number(head[2]), importance: Number(head[3]), questions: [] };
      for (const slug of head[1].trim().split(/\s+/)) bank.set(slug.toLowerCase(), cur);
    } else if (line.startsWith('Q ') && cur) cur.questions.push({ q: line.slice(2).trim(), a: '' });
    else if (line.startsWith('A ') && cur?.questions.length) cur.questions.at(-1).a = line.slice(2).trim();
    else console.warn(`question-bank.txt line ${n + 1} ignored: ${line.slice(0, 60)}`);
  });
  return bank;
}

export const bank = loadBank();

const slugOf = (item) => (item.sheet_item_id && sheetItems.get(item.sheet_item_id)?.slug) || null;

/** Bank entry for a plan item: by sheet slug first, then by LeetCode slug. */
export function bankEntry(item) {
  const s = slugOf(item);
  return (s && bank.get(s)) || (item.leetcode_slug && bank.get(item.leetcode_slug)) || null;
}

const DIFF_TOUGHNESS = { basic: 2, easy: 2, core: 3, medium: 3, pro: 4, hard: 4 };

/** An answer key is a list of key points separated by ";" — each is scored separately (see rubric.js). */
export const keyPointsOf = (answerKey) => String(answerKey || '').split(';').map((s) => s.trim().replace(/\.$/, '')).filter(Boolean);

// Used when an item isn't in the bank (e.g. a custom LeetCode problem) or its bank questions are used up.
// These have no answer key: the grader writes the key points itself, then scores them with the same rubric.
const TEMPLATES = [
  (t) => `Explain the core idea of your solution to "${t}" in your own words. Why does it work?`,
  (t) => `Walk through your solution to "${t}" on a small example of your choice, step by step.`,
  (t) => `What was the key observation in "${t}" that let you avoid a brute-force solution?`,
  (t) => `Give one input that would break a careless solution to "${t}", and explain how your solution handles it.`,
];

/**
 * Picks `count` questions for the day's items, avoiding any question text in `alreadyAsked`.
 * Spreads questions across items, favouring tougher/more important ones.
 * @returns {{ ratings, questions: [{ item_id, item_title, question, rubric }] }}
 */
export function pickQuestions(items, alreadyAsked, count) {
  const asked = new Set(alreadyAsked);
  const ratings = [];
  const pools = items.map((it) => {
    const e = bankEntry(it);
    const toughness = e?.toughness ?? DIFF_TOUGHNESS[it.difficulty] ?? 3;
    const importance = e?.importance ?? 3;
    ratings.push({ item_id: String(it.id), toughness, importance });
    const fromBank = (e?.questions || []).map((x) => ({ question: x.q, key_points: keyPointsOf(x.a) }));
    const generic = TEMPLATES.map((f) => ({ question: f(it.title), key_points: [] }));
    // Bank questions first (shuffled), generic ones only as a fallback. Once every question for an item has been
    // asked in earlier attempts, repeat old ones (shuffled) rather than fail — an item has only 1 bank + 4 generic.
    const all = [...shuffle(fromBank), ...generic];
    return {
      item: it,
      weight: toughness + importance,
      queue: [...all.filter((q) => !asked.has(q.question)), ...shuffle(all.filter((q) => asked.has(q.question)))],
    };
  });

  pools.sort((a, b) => b.weight - a.weight || Math.random() - 0.5);
  const picked = [];
  while (picked.length < count && pools.some((p) => p.queue.length)) {
    for (const p of pools) {
      if (picked.length >= count) break;
      const q = p.queue.shift();
      if (q) picked.push({ item_id: String(p.item.id), item_title: p.item.title, ...q });
    }
  }
  return { ratings, questions: picked };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
