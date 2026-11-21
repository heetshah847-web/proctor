import { all } from './db.js';
import { config } from './config.js';

/**
 * Points for one item, from the AI's toughness/importance ratings (1-5 each).
 * Range: 10 (1/1) .. 30 (5/5). Learning items (videos/articles) count half.
 */
export function itemPoints(rating, kind) {
  const t = clamp(rating?.toughness ?? 3, 1, 5);
  const imp = clamp(rating?.importance ?? 3, 1, 5);
  const base = 5 + 3 * t + 2 * imp;
  return Math.round(kind === 'learning' ? base / 2 : base);
}

/** Streak multiplier: +5% per consecutive passed day, capped at 2x (20 days). */
export const streakMultiplier = (streak) => 1 + 0.05 * Math.min(Math.max(streak - 1, 0), 20);

/** Days in a row (ending on `day`) where the student passed, counting `day` itself as passed. */
export function streakIncluding(studentId, day) {
  const passed = new Set(
    all('SELECT day FROM plans WHERE student_id = ? AND best_pct >= ? AND day < ?', studentId, config.quiz.passPct, day).map((r) => r.day),
  );
  let streak = 1;
  const d = new Date(`${day}T00:00:00Z`);
  for (;;) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (!passed.has(d.toISOString().slice(0, 10))) break;
    streak++;
  }
  return streak;
}

/** Current streak for display (today counts only if already passed). */
export function currentStreak(studentId, today) {
  const rows = all('SELECT day, best_pct FROM plans WHERE student_id = ? AND best_pct >= ?', studentId, config.quiz.passPct);
  const passed = new Set(rows.map((r) => r.day));
  const d = new Date(`${today}T00:00:00Z`);
  if (!passed.has(today)) d.setUTCDate(d.getUTCDate() - 1);
  let streak = 0;
  while (passed.has(d.toISOString().slice(0, 10))) { streak++; d.setUTCDate(d.getUTCDate() - 1); }
  return streak;
}

/** Full breakdown for a plan given its best score. */
export function computeAward({ items, ratings, bestPct, streak }) {
  const byId = new Map((ratings || []).map((r) => [String(r.item_id), r]));
  const perItem = items.map((it) => ({ id: it.id, title: it.title, points: itemPoints(byId.get(String(it.id)), it.kind), rating: byId.get(String(it.id)) || null }));
  const base = perItem.reduce((a, x) => a + x.points, 0);
  const mult = streakMultiplier(streak);
  const passed = bestPct >= config.quiz.passPct;
  const total = passed ? Math.round(base * mult * (bestPct / 100)) : 0;
  return { perItem, base, streak, multiplier: Number(mult.toFixed(2)), bestPct, passed, total };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || lo));
