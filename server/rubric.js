// The single grading rubric used for every question. The AI only decides, for each key point,
// whether the answer covers it; the score is computed here so it is consistent and explainable.

export const POINTS_PER_QUESTION = 10;
export const CREDIT = { covered: 1, partial: 0.5, missing: 0 };

// Shown to students before the quiz and to supervisors.
export const RUBRIC_TEXT = [
  `Each question is worth ${POINTS_PER_QUESTION} points.`,
  'Every question has an answer key made of 2–7 key points. The 10 points are split equally between them.',
  'Each key point is marked Covered (full share), Partly covered (half share — mentioned but vague, incomplete, or with a small mistake) or Missed (0 — absent or wrong).',
  'Your own words are fine. Exact wording is not needed, and equivalent correct reasoning counts.',
  'Your attempt score = points earned ÷ points possible.',
];

/** Instructions given to the grader model (same rubric, written for the model). */
export const GRADER_RUBRIC = `Grading rubric (apply it exactly the same way to every question):
- Each question's answer key is a numbered list of key points. For EACH key point decide one status:
  "covered"  = the answer clearly states this point (or an equivalent, correct idea) in any wording;
  "partial"  = the answer touches the point but is vague, incomplete, or has a small error;
  "missing"  = the point is absent, or the answer states something that contradicts it.
- Judge meaning, not wording. Do not require exact phrases, formulas, or complexity notation unless the point is about that.
- Do not give credit for points the answer does not address, even if the rest of the answer is good.
- If a question has NO answer key, first write the 3 most important key points a correct answer to that
  question must contain (specific to the named problem), then rate the answer against them.
- For dry-run questions on the student's own code, re-trace the code yourself. If a value in the answer key is wrong
  and the student's value matches the real behaviour of the code, mark that point "covered".
- Return the key points in the same order as given, copying their text.`;

/** score for one question from statuses: (sum of credits / number of points) * 10, one decimal. */
export function scoreQuestion(statuses) {
  if (!statuses.length) return 0;
  const earned = statuses.reduce((a, s) => a + (CREDIT[s] ?? 0), 0);
  return Math.round((earned / statuses.length) * POINTS_PER_QUESTION * 10) / 10;
}
