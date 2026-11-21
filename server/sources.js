// Progress sources: LeetCode (public GraphQL) and takeuforward (needs the student's own session cookie).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { parseStriverSheet, STRIVER_URL } from './striver-parse.js';

// ---------- Striver sheet catalogue (imported once by scripts/import-striver.mjs) ----------
const sheetPath = path.join(ROOT, 'data', 'striver-sheet.json');
export const sheet = JSON.parse(fs.readFileSync(sheetPath, 'utf8'));
export const sheetItems = new Map();
for (const s of sheet.steps) for (const t of s.topics) for (const it of t.items) sheetItems.set(it.id, { ...it, step: s.title, topic: t.title });

// ---------- LeetCode ----------
const LC_GRAPHQL = 'https://leetcode.com/graphql';

async function lcQuery(query, variables) {
  const res = await fetch(LC_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`LeetCode responded ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

/** Recent accepted submissions (LeetCode caps this list at ~20). Returns [{slug, title, at}] */
export async function leetcodeRecentAccepted(username) {
  const data = await lcQuery(
    `query r($u: String!, $l: Int!) { recentAcSubmissionList(username: $u, limit: $l) { title titleSlug timestamp } }`,
    { u: username, l: 20 },
  );
  return (data.recentAcSubmissionList || []).map((s) => ({ slug: s.titleSlug, title: s.title, at: Number(s.timestamp) * 1000 }));
}

export async function leetcodeUserExists(username) {
  try {
    const data = await lcQuery(`query u($u: String!) { matchedUser(username: $u) { username } }`, { u: username });
    return Boolean(data.matchedUser);
  } catch (e) {
    if (/does not exist/i.test(e.message)) return false;
    throw e;
  }
}

export async function leetcodeQuestion(slug) {
  const data = await lcQuery(
    `query q($s: String!) { question(titleSlug: $s) { title titleSlug difficulty topicTags { name } } }`,
    { s: slug },
  );
  return data.question;
}

// ---------- takeuforward ----------
// TUF has no public API. The sheet page embeds a per-item `status` that reflects the logged-in
// user's progress, so when a student provides their TUF cookie we fetch the page as them.
const DONE = /^(solved|completed|done|complete)$/i;

/** Returns Map<sheetItemId, status> for items marked done on the student's TUF account. */
export async function tufCompletedItems(cookie) {
  if (!cookie) throw new Error('takeuforward cookie is missing or could not be decrypted — reconnect it in Profile');
  const res = await fetch(STRIVER_URL, { headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`takeuforward responded ${res.status}`);
  const { items } = parseStriverSheet(await res.text());
  const done = new Map();
  for (const [id, it] of items) if (it.status && DONE.test(it.status)) done.set(id, it.status);
  // Zero done items usually means the cookie was not accepted and we got the anonymous page.
  return done;
}
