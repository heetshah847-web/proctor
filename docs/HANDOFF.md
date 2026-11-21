# DSA Proctor — Handoff Guide

This document is for an engineer or AI assistant (e.g. another Claude session) picking up this codebase.
It explains what the app does, how every part works, why it was built that way, and what is known to be untested or limited.
Read it top to bottom once; afterwards use the section headings as a reference.

> Branch `v1` contains everything described here. Code is the source of truth — if this document and the code disagree,
> trust the code and update this document.

---

## 1. What the product is

A daily accountability tool for students working through **Striver's A2Z DSA sheet** (takeuforward.org) and **LeetCode**.

Two roles:

| Role | Can do |
|---|---|
| **Student** | Picks the day's problems, solves them on LeetCode / TUF, pastes their own solution code, takes a proctored AI quiz, earns points. |
| **Supervisor** | Shares an invite code; approves or edits each student's daily plan; sees every item, how it was verified, every quiz answer with its key-point grading, webcam photos and the full proctoring log. |

### The daily loop

1. **Plan.** The student picks items from the 495-item A2Z sheet (or any LeetCode problem by URL/slug) and sends the plan to their supervisor.
2. **Coordinate.** The supervisor approves it, removes items, or requests changes. An approved plan is locked for the day.
3. **Verify.** The student solves the items and presses *Check progress*. The server checks LeetCode accepted submissions (timestamp must fall in the plan's day) and, optionally, the student's takeuforward sheet ticks. Items without a LeetCode link can be self-marked.
4. **Code.** For each practice item the student pastes their own solution (locks when the quiz starts).
5. **Proctored quiz.** Unlocks when the plan is approved, every item is verified, and every practice item has code. 3 questions, 15 minutes, full screen, webcam on. One question is a dry run of the student's own code; the rest come from a hand-written question bank.
6. **Grade.** The AI marks each key point of each answer as covered / partly covered / missed; the server computes the score with one fixed rubric.
7. **Points.** Best attempt score × the day's base points × streak multiplier. Below 50% the day earns nothing. Up to 3 attempts per day, each with new questions.

The quiz exists because LeetCode "accepted" and TUF "done" can be faked (pasting AI code, ticking boxes). The quiz checks understanding.

---

## 2. Stack and how to run

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite`; tested on Node 24). No build step.
- **Express 5** server, **SQLite** file DB (`data/proctor.db`, WAL mode).
- **Vanilla JS** single-page frontend in `public/` (ES modules, no framework).
- **AI:** Google **Gemini** (REST `generateContent`) or **Anthropic Claude** (`@anthropic-ai/sdk`), chosen by env vars.
- **Face detection:** `@mediapipe/tasks-vision@0.10.14` (BlazeFace), served locally from `node_modules`, model file in `public/models/`.

```bash
npm install
cp .env.example .env     # put GEMINI_API_KEY (free tier works) or ANTHROPIC_API_KEY in it
npm start                # http://localhost:3000
npm run demo             # no AI key needed: templated grading by word overlap, clearly labelled in the UI
npm run dev              # node --watch
npm run import-sheet     # re-download the Striver sheet into data/striver-sheet.json
```

The webcam only works on `localhost` or HTTPS (browser rule). Use Chrome or Edge for the quiz.

---

## 3. Repository map

```
server/
  index.js           Express app: security headers, all API routes, quiz/proctoring state machine
  config.js          Env loading (tiny .env parser, no dotenv) and the `config` object
  db.js              SQLite schema + idempotent ALTER TABLE migrations; helpers one/all/run
  auth.js            scrypt passwords, session cookies, role guards, publicUser()
  ratelimit.js       In-memory fixed-window rate limiters (login, signup, AI, external, general)
  sources.js         Loads the sheet catalogue; LeetCode GraphQL; takeuforward progress via student cookie
  striver-parse.js   Parses the TUF sheet page (Next.js flight payload) into steps/topics/items
  question-bank.js   Parses data/question-bank.txt; picks questions per attempt; generic fallbacks
  rubric.js          THE grading rubric (text for students + instructions for the grader + scoring math)
  ai.js              Gemini/Claude calls, structured output, dry-run code questions, grading
  points.js          Item points, streaks, day award
public/
  index.html         Shell
  app.js             Whole SPA: auth, student views, supervisor views, quiz + client proctoring
  proctor.js         Webcam, face detection, snapshots, brightness, monitor check helpers
  styles.css         Light/dark theme via CSS variables
  models/blaze_face_short_range.tflite   Face model (≈230 KB)
data/
  striver-sheet.json   495 items in 20 steps (imported once; committed)
  question-bank.txt    Hand-written interview questions + answer keys for every sheet item (committed)
  proctor.db           Runtime DB (git-ignored)
scripts/import-striver.mjs   One-off importer for the sheet
docs/HANDOFF.md      This file
```

---

## 4. Configuration (`.env`)

`server/config.js` reads `.env` itself (real environment variables win). `.env` is git-ignored; `.env.example` documents every key.

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | — | If it is the only key set, Gemini is used automatically. |
| `GEMINI_MODEL` / `GEMINI_THINKING_LEVEL` | `gemini-4-hydrogen` / `medium` | Free-tier model; thinking level `low`–`xhigh`. |
| `ANTHROPIC_API_KEY` / `CLAUDE_MODEL` | — / `claude-opus-5-5` | Use Claude instead. |
| `AI_PROVIDER` | auto | Force `gemini` or `claude`. |
| `AI_MODE` (or `--demo`) | `claude` | `demo` = no AI calls at all. |
| `QUESTION_SOURCE` | `bank` | `ai` = AI writes every question (extra call per attempt). |
| `CODE_QUESTIONS` | `1` | Dry-run questions on the student's own code per attempt (each = 1 AI call). `0` = off. |
| `REQUIRE_CODE` | `practice` | `none` = pasting code is optional. |
| `QUIZ_QUESTIONS` / `QUIZ_MINUTES` / `QUIZ_MAX_ATTEMPTS` / `QUIZ_PASS_PCT` | 3 / 15 / 3 / 50 | |
| `QUIZ_REQUIRE_CAMERA` | `true` | Webcam proctoring on/off. |
| `QUIZ_MAX_STRIKES` | `3` | Warnings before an attempt ends. |
| `QUIZ_HEARTBEAT_TIMEOUT_MS` | `12000` | Silence that ends an attempt. |
| `QUIZ_SNAPSHOT_EVERY_MS` / `QUIZ_MAX_SNAPSHOT_GAP_MS` | 20000 / 60000 | Webcam photo cadence / max gap before the server ends the attempt. |
| `REQUIRE_SUPERVISOR_APPROVAL` | `true` | `false` = quiz unlocks without approval. |
| `NODE_ENV=production` / `COOKIE_SECURE` | — | Secure cookies + HSTS (needs HTTPS). |
| `TRUST_PROXY` | `false` | Set behind a reverse proxy so `req.ip` (rate limits, IP logging) is the real client. |
| `PORT`, `DB_PATH` | 3000, `data/proctor.db` | |

---

## 5. Data sources and progress verification

### 5.1 The Striver A2Z sheet catalogue

- takeuforward has **no public API**. The sheet page (`https://takeuforward.org/prep-hub/strivers-a2z-dsa-sheet`) is a Next.js app whose data
  is embedded in `self.__next_f.push([...])` script chunks (the React "flight" payload).
- `server/striver-parse.js` concatenates those chunks, finds the `"sheet_syllabus":` object by bracket matching (string/escape aware),
  and decodes its compact row format: `fields` is a list of field-name arrays; each row is `[fieldsIndex, ...values]`.
  Rows are either `category` (with `children` row indices) or `item`. `roots` are the 20 steps.
- Important fields per item: `id`, `slug`, `label` (title), `layoutType` (`practice` | `learning`), `difficulty` (`basic` | `core` | `pro`),
  `leetcode_link` (289 of 495 items have one), and `status` (per-user progress; `"unsolved"` on the anonymous page).
  Values starting with `$` are flight references, not real values — the parser ignores them for `difficulty`.
- `scripts/import-striver.mjs` runs the parser once and writes `data/striver-sheet.json` (statuses stripped). It is committed, so the app
  does not depend on takeuforward at runtime except for the optional per-student progress check.
- If takeuforward changes its page format the importer and TUF verification break; the catalogue JSON keeps working.
- Slugs are the stable key used everywhere else (question bank, etc.). Note two slugs contain commas: `pow(x,n)` and
  `pre,-post,-inorder-in-one-traversal`. The slug `basic-hashing` appears twice in the sheet (step 1 and step 4).

### 5.2 LeetCode verification (`server/sources.js`)

- Public GraphQL at `https://leetcode.com/graphql`, no login:
  - `recentAcSubmissionList(username, limit: 20)` → `{ titleSlug, timestamp }` (LeetCode caps this list at ~20).
  - `matchedUser(username)` to validate the username in Profile (a GraphQL error "That user does not exist" is mapped to "not found").
  - `question(titleSlug)` to add a custom LeetCode problem (title, difficulty, tags).
- A plan item is verified via LeetCode when its `leetcode_slug` is in the recent accepted list with a timestamp in
  `[plan.day_start, plan.day_start + 48h)` (the extra day allows late-night work). Solves from before the plan's day never count.
- The student's recent submissions must be public. Because only ~20 are returned, students should press *Check progress* the same day.

### 5.3 takeuforward verification (optional)

- The per-user `status` on the sheet page is only present when the page is fetched **as the logged-in user**. The student pastes their
  TUF `Cookie` header in Profile (`users.tuf_cookie`); the server fetches the page with it and treats statuses matching
  `/^(solved|completed|done|complete)$/i` as done (`tufCompletedItems`). Those status values are an assumption — nobody has verified them
  against a real account. If TUF uses another word, change `DONE` in `server/sources.js`.
- Zero done items usually means the cookie was rejected (anonymous page); the verify report shows a warning.
- **Anti-replay:** when a plan is proposed, the server snapshots which of its items are already done on TUF (`plan_items.tuf_pre_done`).
  Those items cannot later be verified through TUF (TUF statuses have no timestamps, so old ticks would otherwise count).
- Why a cookie and not "paste the login redirect URL"? The user asked for a CodeTantra-style flow (log in, paste the redirect URL with
  `?code=`). That only works for apps registered as OAuth clients with the identity provider; LeetCode and takeuforward offer no OAuth to
  third parties, and their sessions live in HttpOnly cookies, never in the URL. A suggested improvement (not built): LeetCode ownership proof
  by putting a one-time code in the LeetCode profile "About me", and accepting a pasted "Copy as cURL" for TUF.

### 5.4 Self-attested items

- Items with no LeetCode link (videos, articles, GFG-only problems) can be marked done by the student (`verified_via = 'self'`) when TUF
  is not connected (or the item was already done on TUF before the plan). The supervisor sees these labelled `self`. The quiz is the real check.

### 5.5 Plan days and time zones

- The client sends its local date (`day`, `YYYY-MM-DD`) and local midnight (`dayStart`, epoch ms). `POST /api/plans` accepts them only if
  they are self-consistent (implied UTC offset between −12h and +14h, multiple of 15 min) **and** the real current time is inside
  `[dayStart, dayStart + 25h)`. So plans can only be created for *today*, and the LeetCode window cannot be moved back to old submissions.
- One plan per student per day (`UNIQUE (student_id, day)`).

---

## 6. Data model (`server/db.js`)

SQLite via `node:sqlite` (`DatabaseSync`, synchronous). `PRAGMA foreign_keys = ON`, WAL journal.
Schema is created with `CREATE TABLE IF NOT EXISTS`; columns added later are applied with `ALTER TABLE ... ADD COLUMN` inside
`try/catch` at startup (idempotent migrations). **When you add a column: add it to the CREATE statement and to the migration list.**

| Table | Purpose / notable columns |
|---|---|
| `users` | `role` (`student`/`supervisor`), `email` unique, `password_hash` (`salt:hash`, scrypt), `invite_code` (supervisors), `supervisor_id` (students), `leetcode_username`, `tuf_cookie` (secret; never returned by the API — `publicUser()` exposes only `tufConnected`). |
| `sessions` | `token` (random 32 bytes hex, the `sid` cookie), `user_id`, `expires_at` (14 days). Expired rows purged at startup and hourly. |
| `plans` | One per student per day. `status`: `draft` → `proposed` → `approved`, or `changes_requested`. `day_start` (local midnight, ms). `ratings_json` (per-item toughness/importance, frozen at the first quiz). `best_pct`, `points_awarded`, `streak`. |
| `plan_items` | `sheet_item_id` (null for custom LeetCode problems), `title/step/topic/kind/difficulty`, `leetcode_slug`, `verified_via` (`leetcode`/`tuf`/`self`), `verified_at`, `tuf_pre_done`, `code`, `code_lang`. |
| `quiz_attempts` | `status`: `in_progress` → `submitted` → `graded`, or `terminated` / `exited`. `questions_json` holds the questions **with their key points** (never sent to the browser before grading). `answers_json`, `grading_json`, `score_pct`, `end_reason`, `deadline`, `last_seen` (heartbeat), `token` (attempt secret), `ip`, `user_agent`, `strikes`, `last_snapshot`. |
| `proctor_events` | Every proctoring signal: `type`, `detail`, `at`. |
| `proctor_snapshots` | Webcam JPEGs (`jpeg` BLOB, ≤200 KB each), `faces` detected client-side, `reason` (`periodic`, `start`, `submit`, or the violation type). |

Note: the comment on `quiz_attempts.questions_json` in `db.js` still says "includes rubric"; it now stores `key_points` arrays
(older rows may have a `rubric` string — `ai.js` handles both via `keysOf()`).

---

## 7. HTTP API (`server/index.js`)

All JSON. Auth is the `sid` HttpOnly cookie. Guards: `student`, `supervisor`, `anyone` (= signed in). Errors are `{ error }`;
`HttpError`/`fail(status, msg)` produce expected errors, anything else becomes `500 Server error (ref xxxx)` with the details only in the server log.

| Method & path | Who | Notes |
|---|---|---|
| `POST /api/auth/signup` | public | `role, name, email, password (8–200), inviteCode?`. Rate-limited. |
| `POST /api/auth/login` / `logout` | public | Login is rate-limited per IP and per email; constant-time for unknown emails. |
| `GET /api/me` | any | `{ user, supervisor, settings }` — `settings` carries quiz config and the rubric text for the UI. |
| `PUT /api/me/profile` | student | `name`, `leetcodeUsername` (validated against LeetCode), `tufCookie` (`''` disconnects), `inviteCode` (link/switch supervisor). |
| `GET /api/sheet` | any | The whole catalogue. |
| `POST /api/plans` | student | Get-or-create today's plan (see 5.5). |
| `POST /api/plans/:id/items` | student | `{ sheetItemId }` or `{ leetcodeSlug }` (URL accepted). Editing a proposed plan sends it back to `draft`. |
| `DELETE /api/plans/:id/items/:itemId` | student | Not allowed once approved. |
| `PUT /api/plans/:id/items/:itemId/code` | student | `{ code, lang }` (`cpp/java/python/javascript/other`), ≤250 lines. Locked once any attempt exists. |
| `POST /api/plans/:id/propose` | student | Snapshots TUF pre-done items; status → `proposed` (or straight to `approved` if approval is disabled). |
| `POST /api/plans/:id/verify` | student | Runs LeetCode then TUF checks; returns a report + plan. |
| `POST /api/plans/:id/items/:itemId/attest` | student | Self-mark an item that has no LeetCode link. |
| `GET /api/student/summary`, `GET /api/student/plans/:day` | student | Totals, streak, history; one plan's detail. |
| `POST /api/plans/:id/quiz/start` | student | Body `{ preflight }`. Returns `{ attemptId, token, attemptNo, deadline, proctor, questions }`. AI rate-limited. |
| `POST /api/attempts/:id/heartbeat` | student | Requires `X-Attempt-Token`. |
| `POST /api/attempts/:id/event` | student | `{ type, detail }`; hard/soft handling (section 10). Token also accepted in the body (for `sendBeacon`). |
| `POST /api/attempts/:id/snapshot` | student | `{ image: data:image/jpeg;base64,..., faces, reason }`. |
| `POST /api/attempts/:id/exit` / `submit` / `regrade` | student | `submit` grades immediately; `regrade` retries a failed grading. |
| `GET /api/supervisor/students` | supervisor | Dashboard rows: today's status, verified count, best %, streak, total points, terminated attempts, pending plans. |
| `GET /api/supervisor/students/:id` | supervisor | Last 60 plans with items, code, attempts, answers, key-point grading, AI summary/suspicion, events, strikes, snapshot list. |
| `GET /api/supervisor/snapshots/:id` | supervisor | The JPEG (only for the supervisor's own students). |
| `POST /api/supervisor/plans/:id/review` | supervisor | `{ action: approve | request_changes, note, removeItemIds }`. |

`planDetail(plan, { forSupervisor })` is the single serializer for plans; it also computes `quiz.unlocked` and the human-readable
`quiz.reason` (empty plan → waiting for approval → unverified items → missing code → no attempts left → perfect score).

