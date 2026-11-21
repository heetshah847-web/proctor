# DSA Proctor

Daily accountability for Striver's A2Z DSA sheet and LeetCode. A student plans the day's topics with their supervisor, the app verifies completion on LeetCode and takeuforward, and then a proctored AI quiz checks that the student actually understood the problems before any points are awarded.

## Run it

Requires Node 22.5+ (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env        # then put GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in .env
npm start                   # http://localhost:3000
```

Get a free Gemini key at https://aistudio.google.com/apikey. On Gemini's free tier, Google may use what the app sends (questions and student answers) to improve its products, and daily request limits apply. A paid Gemini key or an Anthropic key avoids both.

No API key yet? Run `npm run demo` to try the whole flow. In demo mode the questions are templates and grading is by answer length, and the UI shows an "AI demo mode" badge.

To refresh the Striver sheet catalogue (`data/striver-sheet.json`): `npm run import-sheet`.

## How it works

**Roles**
- **Supervisor**: gets an invite code, approves or edits each student's daily plan, and sees every item, how each one was verified, every quiz answer, the AI's grades and suspicion notes, and every proctoring event.
- **Student**: signs up with the supervisor's invite code and sets their LeetCode username. Connecting a takeuforward session cookie is optional.

**Daily loop**
1. The student picks items from the 495-item A2Z sheet (or any LeetCode problem) and sends the plan to the supervisor.
2. The supervisor approves it, can remove items, or requests changes. The plan then locks for the day.
3. The student solves the items and presses **Check progress**:
   - **LeetCode**: the problem must appear in the student's recent *accepted* submissions with a timestamp on or after the plan's day (public GraphQL, no login needed). 289 of the sheet's items link to LeetCode.
   - **takeuforward**: TUF has no public API. If the student pastes their TUF cookie, the server loads the sheet as them and reads the per-item status. Items already ticked on TUF *before* the plan was proposed are flagged and cannot be verified through TUF.
   - **Self-marked**: items with no LeetCode link (videos, GFG-only problems) can be marked done when TUF isn't connected. The supervisor sees these as `self`.
4. For each practice problem the student pastes **their own solution code** (it locks when the quiz starts). Once every item is verified and has code, the **proctored quiz** unlocks.
   - **One question per attempt is a dry run of the student's own code.** The AI picks a small input and asks for exact variable values at a specific iteration plus the final output. It also asks *why* a specific line (by line number) is there, e.g. what breaks without it. The code is shown with line numbers in the quiz. If the AI call fails, the quiz uses bank questions instead.
   - The other questions come from the bank: Questions come from `data/question-bank.txt`, a hand-written bank covering all 495 sheet items with answer keys and toughness/importance scores. Each retry gets questions not asked before. Items not in the bank (custom LeetCode problems), or items whose bank questions are used up, get generic problem-specific questions (walk-through, complexity, edge cases).
5. The AI (Gemini or Claude) grades with **one fixed rubric** (`server/rubric.js`). Per attempt that is 1 AI call for the dry-run question plus 1 for grading (set `CODE_QUESTIONS=0` for grading only):
   - Each question is worth 10 points, split equally between the key points in its answer key (2–7 points).
   - Each key point is marked **covered** (full share), **partly covered** (half: vague, incomplete or a small mistake) or **missed** (0: absent or wrong).
   - The AI only marks the points; the server computes the score. Example: 4 key points with 2 covered, 1 partly covered and 1 missed gives (2 + 0.5) / 4 × 10 = 6.25/10.
   - After grading, the student and supervisor see every key point with its mark. The attempt score is points earned ÷ points possible, and the day's points use the student's **best** attempt.

**Points**
- Each item is worth `5 + 3×toughness + 2×importance` (10–30 points). Videos and articles count half.
- `day points = sum(items) × streak multiplier × best% / 100`.
- Streak multiplier: +5% per consecutive approved day, capped at ×2.
- Below `QUIZ_PASS_PCT` (default 50%) the day is not approved and earns 0. The student can retry (default 3 attempts) to raise their best score.

**Proctoring (strict)**

Use Chrome or Edge on a laptop or desktop.

Before the quiz, a system check must pass:
- full screen is supported;
- only one monitor is connected;
- the webcam is on, with exactly one face visible;
- no phone, book or other screen is visible, and eye tracking has calibrated where the student looks straight ahead;
- the student ticks a consent box.

The quiz then runs full screen. Where supported, Keyboard Lock routes Alt+Tab, the Windows key and Esc to the page, so they can be blocked.

| Ends the attempt immediately (0%) | Warning (`QUIZ_MAX_STRIKES`, default 3, ends it) |
|---|---|
| leaving full screen; switching tab or window; alt-tab; minimising | face not visible for 2 s; camera covered or dark |
| refresh or close; resizing the window or opening dev tools | copy, paste, print, dev-tools or new-tab shortcuts; right-click |
| a second monitor connected; the quiz opened in another tab or device | mouse leaving the window |
| text pasted, dropped or autofilled into an answer | text appearing faster than a person types (>100 chars in 5 s) |
| camera turned off; two or more faces on camera | a browser extension injecting into the page |
| no heartbeat for 12 s; webcam photos stop reaching the server for 60 s | a phone, book/notes, another screen or another person on camera |
| | looking to the left or right for 4 s at a time, or 15 s in total within a minute |

- Webcam photos are taken every 20 s and at every warning. The supervisor sees them per attempt, with face counts, plus the full event log and warning count.
- Face detection (MediaPipe BlazeFace) runs **in the browser**; video never leaves the computer, only the small photos do. The library and model are served from this server, not a CDN.
- Object detection (EfficientDet-Lite0 float16) and eye tracking (MediaPipe Face Landmarker) also run in the browser, on the CPU. All three models are open source (Apache 2.0) and live in `public/models/`.
- Eye tracking adds the head turn and the eye turn into one angle, measured from where the student looked during the system check (so a webcam mounted slightly to one side still works). This catches reading from a second laptop, tablet or notes placed **out of camera view**, which object detection cannot see. A live "Looking to your left/right" alert shows on the camera box before it becomes a warning.
- Each attempt gets a secret token, and requests without it (another tab or device) end the attempt. The camera and heartbeat rules are also enforced on the server, so turning off the page's JavaScript doesn't get around them.
- Each retry gets new questions, the answer keys never reach the browser before grading, and student answers are treated as untrusted input by the grader.

### Limits to know about
- A web page cannot fully lock the computer. The webcam catches a second person and long looks to the side, but not a phone held below the camera while looking at the screen, or someone whispering. Full lockdown would need a desktop kiosk app (e.g. Electron) or a second camera.
- Ctrl+Alt+Del and OS-level overlays can't be blocked by a browser, though leaving the quiz window is still detected.
- LeetCode's public API returns only the ~20 most recent accepted submissions, so press **Check progress** the same day.
- The LeetCode profile's recent submissions must be public.
- TUF verification depends on TUF's page format and on the student's cookie staying valid (it expires when they log out of TUF). The `status` values counted as done are `solved`/`completed`/`done`. Adjust `DONE` in `server/sources.js` if TUF uses something else.

## Editing the question bank

`data/question-bank.txt` is plain text. Supervisors can add or reword questions, and changes apply on the next server start:

```
@two-sum 1 5                      <- sheet slug(s), toughness 1-5, importance 1-5
Q Explain the hash map solution and its complexity.
A For each x check target-x in map...; O(n) time, O(n) space.
```

The `A` line is the answer key: key points separated by `;`, each scored separately. Several slugs separated by spaces can share one block. A custom LeetCode problem can be added under its LeetCode slug.

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `GEMINI_API_KEY` | — | free key; used automatically if it's the only key set |
| `GEMINI_MODEL` / `GEMINI_THINKING_LEVEL` | `gemini-4-hydrogen` / `medium` | |
| `ANTHROPIC_API_KEY` | — | use Claude instead |
| `AI_PROVIDER` | auto | force `gemini` or `claude` |
| `CODE_QUESTIONS` | `1` | dry-run questions on the student's own code per attempt (0 = off) |
| `REQUIRE_CODE` | `practice` | `none` = pasting code is optional |
| `QUESTION_SOURCE` | `bank` | `ai` = the AI writes new questions each attempt (2 calls instead of 1) |
| `AI_MODE` | `claude` | `demo` = templates + length grading |
| `CLAUDE_MODEL` | `claude-opus-5-5` | |
| `QUIZ_QUESTIONS` / `QUIZ_MINUTES` / `QUIZ_MAX_ATTEMPTS` / `QUIZ_PASS_PCT` | 3 / 15 / 3 / 50 | |
| `QUIZ_REQUIRE_CAMERA` | `true` | `false` turns off webcam proctoring |
| `QUIZ_MAX_STRIKES` | `3` | warnings before an attempt ends |
| `OBJECT_DETECTION` / `PHONE_ENDS_ATTEMPT` | `true` / `false` | phone, book, screen and second-person detection; `true` makes a phone end the attempt |
| `GAZE_DETECTION` | `true` | warn when the student keeps looking to the side |
| `GAZE_MAX_DEG` / `GAZE_AWAY_SECONDS` / `GAZE_BUDGET_SECONDS` | 30 / 4 / 15 | how far is "away", how long at once, how long in total per minute |
| `REQUIRE_SUPERVISOR_APPROVAL` | `true` | `false` = quiz unlocks without approval |

## Layout

```
server/index.js         Express API (auth, plans, verification, quiz, supervisor)
server/ai.js            Gemini or Claude: question generation + ratings, grading (structured outputs)
server/sources.js       LeetCode GraphQL + takeuforward progress
server/striver-parse.js parses the TUF sheet page
server/question-bank.js loads data/question-bank.txt and picks questions
server/points.js        points + streak
server/db.js            SQLite schema (data/proctor.db)
public/                 single-page UI (no build step)
scripts/import-striver.mjs
```
