import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { db, one, all, run } from './db.js';
import { hashPassword, verifyPassword, newInviteCode, createSession, destroySession, loadUser, requireRole, publicUser, purgeExpiredSessions } from './auth.js';
import { sheet, sheetItems, leetcodeRecentAccepted, leetcodeUserExists, leetcodeQuestion, tufCompletedItems } from './sources.js';
import { generateQuiz, gradeAnswers } from './ai.js';
import { computeAward, streakIncluding, currentStreak } from './points.js';
import { RUBRIC_TEXT } from './rubric.js';
import { encrypt, decrypt } from './vault.js';
import { loginLimit, signupLimit, aiLimit, externalLimit, apiLimit } from './ratelimit.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

// Security headers. MediaPipe needs 'wasm-unsafe-eval' (WebAssembly) and blob: workers; the page uses inline style attributes.
const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'", "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (config.secureCookies) res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});

// Snapshots get their own, larger body limit (a 200 KB JPEG is ~270 KB as base64).
const jsonBody = express.json({ limit: '200kb' });
app.use((req, res, next) => (/^\/api\/attempts\/\d+\/snapshot$/.test(req.path) ? next() : jsonBody(req, res, next)));
app.use(loadUser);
app.use('/api', apiLimit);
app.use(express.static(path.join(ROOT, 'public')));
// Face detection runs in the browser from a locally served copy of MediaPipe (no CDN needed during a quiz).
app.use('/vendor/mediapipe', express.static(path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision')));

const student = requireRole('student');
const supervisor = requireRole('supervisor');
const anyone = requireRole();

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
// AI provider errors are logged in full on the server; the browser only gets a short, safe reason.
const aiErrorMessage = (e) => (/rate limit|429|overloaded|529/i.test(e?.message || '')
  ? 'the AI service is busy right now — try again in a few minutes'
  : 'the AI service is unavailable right now — try again later');
const fail = (status, msg) => { throw new HttpError(status, msg); };
const now = () => Date.now();
const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

// ======================= Auth =======================
app.post('/api/auth/signup', signupLimit, async (req, res) => {
  const { role, name, email, password, inviteCode } = req.body || {};
  if (!['student', 'supervisor'].includes(role)) fail(400, 'Role must be student or supervisor');
  if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') fail(400, 'Name, email and password are required');
  if (!name.trim() || name.length > 100 || !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email.trim())) fail(400, 'A name and a valid email are required');
  if (password.length < 8 || password.length > 200) fail(400, 'Password must be 8-200 characters');
  if (one('SELECT id FROM users WHERE email = ?', email.trim().toLowerCase())) fail(409, 'An account with this email already exists');
  let supervisorId = null;
  if (role === 'student' && inviteCode?.trim()) {
    const sup = one("SELECT id FROM users WHERE role='supervisor' AND invite_code = ?", inviteCode.trim().toUpperCase());
    if (!sup) fail(400, 'Supervisor invite code not found');
    supervisorId = sup.id;
  }
  const passwordHash = await hashPassword(password);
  const r = run(
    'INSERT INTO users (role, name, email, password_hash, invite_code, supervisor_id, created_at) VALUES (?,?,?,?,?,?,?)',
    role, name.trim(), email.trim().toLowerCase(), passwordHash, role === 'supervisor' ? newInviteCode() : null, supervisorId, now(),
  );
  createSession(res, Number(r.lastInsertRowid));
  res.json({ user: publicUser(one('SELECT * FROM users WHERE id = ?', r.lastInsertRowid)) });
});

app.post('/api/auth/login', loginLimit, async (req, res) => {
  const { email, password } = req.body || {};
  const u = one('SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
  if (!(await verifyPassword(String(password || '').slice(0, 200), u?.password_hash))) fail(401, 'Wrong email or password');
  createSession(res, u.id);
  res.json({ user: publicUser(u) });
});

app.post('/api/auth/logout', (req, res) => { destroySession(req, res); res.json({ ok: true }); });

app.get('/api/me', (req, res) => {
  const sup = req.user?.supervisor_id ? one('SELECT name, email FROM users WHERE id = ?', req.user.supervisor_id) : null;
  res.json({
    user: publicUser(req.user),
    supervisor: sup,
    settings: { aiMode: config.aiMode, quiz: config.quiz, requireSupervisorApproval: config.requireSupervisorApproval, rubric: RUBRIC_TEXT },
  });
});

app.put('/api/me/profile', student, externalLimit, async (req, res) => {
  const { leetcodeUsername, tufCookie, inviteCode, name } = req.body || {};
  if (name !== undefined && name.trim()) run('UPDATE users SET name = ? WHERE id = ?', name.trim(), req.user.id);
  if (leetcodeUsername !== undefined) {
    const u = String(leetcodeUsername || '').trim();
    if (u && !(await leetcodeUserExists(u))) fail(400, `LeetCode user "${u}" not found`);
    run('UPDATE users SET leetcode_username = ? WHERE id = ?', u || null, req.user.id);
  }
  if (tufCookie !== undefined) run('UPDATE users SET tuf_cookie = ? WHERE id = ?', encrypt(String(tufCookie || '').trim().slice(0, 8000)), req.user.id);
  if (inviteCode !== undefined && String(inviteCode).trim()) {
    const sup = one("SELECT id FROM users WHERE role='supervisor' AND invite_code = ?", String(inviteCode).trim().toUpperCase());
    if (!sup) fail(400, 'Supervisor invite code not found');
    run('UPDATE users SET supervisor_id = ? WHERE id = ?', sup.id, req.user.id);
  }
  res.json({ user: publicUser(one('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

// ======================= Sheet =======================
app.get('/api/sheet', anyone, (_req, res) => res.json(sheet));

// ======================= Plans (student) =======================
function planDetail(plan, { forSupervisor = false } = {}) {
  const items = all('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY id', plan.id);
  const attempts = all('SELECT * FROM quiz_attempts WHERE plan_id = ? ORDER BY attempt_no', plan.id).map((a) => {
    const qs = JSON.parse(a.questions_json);
    const grading = a.grading_json ? JSON.parse(a.grading_json) : null;
    const base = {
      id: a.id, attemptNo: a.attempt_no, status: a.status, scorePct: a.score_pct, endReason: a.end_reason,
      startedAt: a.started_at, finishedAt: a.finished_at,
      questions: qs.map((q, i) => ({
        question: q.question,
        itemTitle: items.find((it) => String(it.id) === String(q.item_id))?.title ?? q.item_title,
        code: q.code ?? null,
        codeLang: q.code_lang ?? null,
        answer: a.answers_json ? JSON.parse(a.answers_json)[i] ?? '' : null,
        score: grading?.results?.[i]?.score ?? null,
        feedback: grading?.results?.[i]?.feedback ?? null,
        keyPoints: grading?.results?.[i]?.key_points ?? null,
      })),
    };
    if (forSupervisor) {
      base.summary = grading?.summary ?? null;
      base.suspicion = grading?.suspicion ?? null;
      base.events = all('SELECT type, detail, at FROM proctor_events WHERE attempt_id = ? ORDER BY at', a.id);
      base.strikes = a.strikes ?? 0;
      base.snapshots = all('SELECT id, at, faces, reason FROM proctor_snapshots WHERE attempt_id = ? ORDER BY at', a.id);
    }
    return base;
  });
  const ratings = plan.ratings_json ? JSON.parse(plan.ratings_json) : null;
  const award = computeAward({ items, ratings, bestPct: plan.best_pct ?? 0, streak: plan.streak ?? 1 });
  const allVerified = items.length > 0 && items.every((i) => i.verified_at);
  const needsCode = (i) => config.quiz.requireCode === 'practice' && i.kind !== 'learning' && !i.code?.trim();
  const missingCode = items.filter(needsCode).map((i) => i.title);
  const used = attempts.length;
  const approvedOk = !config.requireSupervisorApproval || plan.status === 'approved';
  return {
    id: plan.id, day: plan.day, status: plan.status, studentNote: plan.student_note, supervisorNote: plan.supervisor_note,
    bestPct: plan.best_pct, pointsAwarded: plan.points_awarded, streak: plan.streak,
    items: items.map((i) => ({
      id: i.id, sheetItemId: i.sheet_item_id, title: i.title, step: i.step, topic: i.topic, kind: i.kind,
      difficulty: i.difficulty, leetcodeSlug: i.leetcode_slug, verifiedVia: i.verified_via, verifiedAt: i.verified_at,
      tufPreDone: Boolean(i.tuf_pre_done),
      code: i.code ?? null, codeLang: i.code_lang ?? null, codeRequired: config.quiz.requireCode === 'practice' && i.kind !== 'learning',
    })),
    codeLocked: attempts.length > 0,
    attempts,
    ratingsKnown: Boolean(ratings),
    award: ratings ? award : null,
    quiz: {
      attemptsUsed: used,
      maxAttempts: config.quiz.maxAttempts,
      unlocked: approvedOk && allVerified && !missingCode.length && used < config.quiz.maxAttempts && (plan.best_pct ?? 0) < 100,
      reason: !items.length ? 'Add items to your plan'
        : !approvedOk ? 'Waiting for supervisor approval'
        : !allVerified ? 'Complete and verify every item first'
        : missingCode.length ? `Add your code for: ${missingCode.join(', ')}`
        : used >= config.quiz.maxAttempts ? 'No attempts left today'
        : (plan.best_pct ?? 0) >= 100 ? 'Perfect score already' : null,
    },
  };
}

function ownPlan(req, id) {
  const p = one('SELECT * FROM plans WHERE id = ? AND student_id = ?', Number(id), req.user.id);
  if (!p) fail(404, 'Plan not found');
  return p;
}
const editable = (p) => ['draft', 'changes_requested', 'proposed'].includes(p.status) || fail(409, 'This plan is locked after approval');

app.post('/api/plans', student, (req, res) => {
  const { day, dayStart } = req.body || {};
  if (!isDay(day) || !Number.isFinite(dayStart)) fail(400, 'day and dayStart are required');
  let p = one('SELECT * FROM plans WHERE student_id = ? AND day = ?', req.user.id, day);
  if (!p) {
    // The client sends its local date and local midnight. Accept them only if they are consistent with each
    // other (UTC-12..UTC+14) and with the real current time, so plans can't be made for other days
    // and the LeetCode verification window can't be moved back to old submissions.
    const H = 3600_000;
    const utcMidnight = Date.parse(`${day}T00:00:00Z`);
    const offset = utcMidnight - dayStart; // = the client's UTC offset
    if (!Number.isFinite(utcMidnight) || offset < -12 * H || offset > 14 * H || offset % (15 * 60_000) !== 0) fail(400, 'Invalid day');
    if (now() < dayStart || now() >= dayStart + 25 * H) fail(400, "You can only create today's plan — check your computer's date and time");
    run('INSERT INTO plans (student_id, day, day_start, created_at) VALUES (?,?,?,?)', req.user.id, day, dayStart, now());
    p = one('SELECT * FROM plans WHERE student_id = ? AND day = ?', req.user.id, day);
  }
  res.json({ plan: planDetail(p) });
});

app.post('/api/plans/:id/items', student, externalLimit, async (req, res) => {
  const p = ownPlan(req, req.params.id);
  editable(p);
  const { sheetItemId, leetcodeSlug } = req.body || {};
  if (sheetItemId) {
    const it = sheetItems.get(String(sheetItemId)) || fail(404, 'Sheet item not found');
    run(`INSERT OR IGNORE INTO plan_items (plan_id, sheet_item_id, title, step, topic, kind, difficulty, leetcode_slug) VALUES (?,?,?,?,?,?,?,?)`,
      p.id, it.id, it.title, it.step, it.topic, it.kind, it.difficulty, it.leetcodeSlug);
  } else if (leetcodeSlug) {
    const slug = String(leetcodeSlug).trim().toLowerCase().replace(/^.*leetcode\.com\/problems\//, '').replace(/\/.*$/, '');
    const q = (await leetcodeQuestion(slug)) || fail(404, `LeetCode problem "${slug}" not found`);
    if (one('SELECT id FROM plan_items WHERE plan_id = ? AND leetcode_slug = ?', p.id, q.titleSlug)) fail(409, 'Already in plan');
    run(`INSERT INTO plan_items (plan_id, sheet_item_id, title, step, topic, kind, difficulty, leetcode_slug) VALUES (?,?,?,?,?,?,?,?)`,
      p.id, null, q.title, 'LeetCode', q.topicTags?.map((t) => t.name).slice(0, 3).join(', ') || null, 'practice', q.difficulty?.toLowerCase(), q.titleSlug);
  } else fail(400, 'sheetItemId or leetcodeSlug required');
  if (p.status === 'proposed' || p.status === 'changes_requested') run("UPDATE plans SET status='draft' WHERE id = ?", p.id);
  res.json({ plan: planDetail(one('SELECT * FROM plans WHERE id = ?', p.id)) });
});

app.delete('/api/plans/:id/items/:itemId', student, (req, res) => {
  const p = ownPlan(req, req.params.id);
  editable(p);
  run('DELETE FROM plan_items WHERE id = ? AND plan_id = ?', Number(req.params.itemId), p.id);
  if (p.status === 'proposed') run("UPDATE plans SET status='draft' WHERE id = ?", p.id);
  res.json({ plan: planDetail(one('SELECT * FROM plans WHERE id = ?', p.id)) });
});

app.post('/api/plans/:id/propose', student, externalLimit, async (req, res) => {
  const p = ownPlan(req, req.params.id);
  editable(p);
  const items = all('SELECT * FROM plan_items WHERE plan_id = ?', p.id);
  if (!items.length) fail(400, 'Add at least one item first');
  // Snapshot TUF: items already marked done before today can't be verified through TUF later.
  if (req.user.tuf_cookie) {
    try {
      const done = await tufCompletedItems(decrypt(req.user.tuf_cookie));
      for (const it of items) run('UPDATE plan_items SET tuf_pre_done = ? WHERE id = ?', it.sheet_item_id && done.has(it.sheet_item_id) ? 1 : 0, it.id);
    } catch (e) { console.warn('TUF snapshot failed:', e.message); }
  }
  const next = config.requireSupervisorApproval ? 'proposed' : 'approved';
  run('UPDATE plans SET status = ?, student_note = ? WHERE id = ?', next, String(req.body?.note || '').slice(0, 1000) || null, p.id);
  res.json({ plan: planDetail(one('SELECT * FROM plans WHERE id = ?', p.id)) });
});

app.post('/api/plans/:id/verify', student, externalLimit, async (req, res) => {
  const p = ownPlan(req, req.params.id);
  const items = all('SELECT * FROM plan_items WHERE plan_id = ? AND verified_at IS NULL', p.id);
  const report = { leetcode: null, tuf: null, newlyVerified: [] };
  const dayEnd = p.day_start + 864e5 * 2; // allow finishing up to the end of the next day (late-night work)

  if (req.user.leetcode_username && items.some((i) => i.leetcode_slug)) {
    try {
      const subs = await leetcodeRecentAccepted(req.user.leetcode_username);
      report.leetcode = { ok: true, recent: subs.length };
      for (const it of items) {
        const hit = it.leetcode_slug && subs.find((s) => s.slug === it.leetcode_slug && s.at >= p.day_start && s.at < dayEnd);
        if (hit) {
          run("UPDATE plan_items SET verified_via='leetcode', verified_at=? WHERE id=?", hit.at, it.id);
          report.newlyVerified.push(it.title);
          it.verified_at = hit.at;
        }
      }
    } catch (e) { report.leetcode = { ok: false, error: e.message }; }
  } else if (!req.user.leetcode_username) report.leetcode = { ok: false, error: 'Add your LeetCode username in Profile' };

  const remaining = items.filter((i) => !i.verified_at && i.sheet_item_id);
  if (req.user.tuf_cookie && remaining.length) {
    try {
      const done = await tufCompletedItems(decrypt(req.user.tuf_cookie));
      report.tuf = { ok: true, doneOnSheet: done.size };
      for (const it of remaining) {
        if (done.has(it.sheet_item_id) && !it.tuf_pre_done) {
          run("UPDATE plan_items SET verified_via='tuf', verified_at=? WHERE id=?", now(), it.id);
          report.newlyVerified.push(it.title);
        }
      }
      if (done.size === 0) report.tuf.warning = 'No items show as done on takeuforward — if you have marked some, your cookie has probably expired.';
    } catch (e) { report.tuf = { ok: false, error: e.message }; }
  }
  res.json({ report, plan: planDetail(one('SELECT * FROM plans WHERE id = ?', p.id)) });
});

// Items with no LeetCode link (videos/articles/GFG-only) can be self-attested when TUF isn't connected.
// The proctored quiz is the real check; the supervisor sees these as "self".
// The student's own solution code. Locked once the first quiz attempt starts.
app.put('/api/plans/:id/items/:itemId/code', student, (req, res) => {
  const p = ownPlan(req, req.params.id);
  const it = one('SELECT * FROM plan_items WHERE id = ? AND plan_id = ?', Number(req.params.itemId), p.id) || fail(404, 'Item not found');
  if (one('SELECT id FROM quiz_attempts WHERE plan_id = ?', p.id)) fail(409, 'Code is locked once you have started the quiz');
  const code = String(req.body?.code ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (code.length > 10000 || code.split('\n').length > 250) fail(400, 'Code is too long (max 250 lines)');
  const lang = ['cpp', 'java', 'python', 'javascript', 'other'].includes(req.body?.lang) ? req.body.lang : 'other';
  run('UPDATE plan_items SET code = ?, code_lang = ? WHERE id = ?', code || null, code ? lang : null, it.id);
  res.json({ plan: planDetail(one('SELECT * FROM plans WHERE id = ?', p.id)) });
});

app.post('/api/plans/:id/items/:itemId/attest', student, (req, res) => {
  const p = ownPlan(req, req.params.id);
  const it = one('SELECT * FROM plan_items WHERE id = ? AND plan_id = ?', Number(req.params.itemId), p.id) || fail(404, 'Item not found');
  if (it.leetcode_slug) fail(400, 'LeetCode problems must be verified through LeetCode');
  if (req.user.tuf_cookie && !it.tuf_pre_done) fail(400, 'Your takeuforward account is connected — mark it done there and press Check progress');
  run("UPDATE plan_items SET verified_via='self', verified_at=? WHERE id=?", now(), it.id);
  res.json({ plan: planDetail(one('SELECT * FROM plans WHERE id = ?', p.id)) });
});

app.get('/api/student/summary', student, (req, res) => {
  const today = isDay(req.query.today) ? req.query.today : new Date().toISOString().slice(0, 10);
  const total = one('SELECT COALESCE(SUM(points_awarded),0) AS t FROM plans WHERE student_id = ?', req.user.id).t;
  const history = all('SELECT id, day, status, best_pct, points_awarded, streak, (SELECT COUNT(*) FROM plan_items WHERE plan_id = plans.id) AS items FROM plans WHERE student_id = ? ORDER BY day DESC LIMIT 60', req.user.id);
  res.json({ totalPoints: total, streak: currentStreak(req.user.id, today), history });
});

app.get('/api/student/plans/:day', student, (req, res) => {
  const p = one('SELECT * FROM plans WHERE student_id = ? AND day = ?', req.user.id, req.params.day);
  res.json({ plan: p ? planDetail(p) : null });
});

// ======================= Proctored quiz =======================
// Hard violations end the attempt immediately (0%, attempt used).
const HARD = new Set([
  'visibility_hidden', 'window_blur', 'fullscreen_exit', 'page_unload', 'heartbeat_lost', 'second_session',
  'multiple_faces', 'camera_off', 'camera_missing', 'window_resized', 'extra_monitor', 'text_injected',
]);
// Soft violations are warnings ("strikes"); QUIZ_MAX_STRIKES of them end the attempt.
const SOFT = new Set([
  'no_face', 'camera_blocked', 'paste_blocked', 'copy_blocked', 'cut_blocked', 'drop_blocked', 'contextmenu_blocked', 'blocked_key',
  'mouse_left_window', 'bulk_insert', 'superhuman_typing', 'page_modified',
]);

function ownAttempt(req, id) {
  const a = one(`SELECT a.*, p.student_id, p.id AS pid FROM quiz_attempts a JOIN plans p ON p.id = a.plan_id WHERE a.id = ?`, Number(id));
  if (!a || a.student_id !== req.user.id) fail(404, 'Attempt not found');
  return a;
}
const logEvent = (attemptId, type, detail = '') =>
  run('INSERT INTO proctor_events (attempt_id, type, detail, at) VALUES (?,?,?,?)', attemptId, type, String(detail).slice(0, 300), now());

/** The attempt secret proves requests come from the tab that started the attempt. A mismatch ends it. */
function attemptFromTab(req) {
  const a = ownAttempt(req, req.params.id);
  const token = req.get('x-attempt-token') || req.body?.token;
  if (a.status === 'in_progress' && token !== a.token) {
    logEvent(a.id, 'second_session', `request from another tab/device (${req.ip})`);
    endAttempt(a.id, 'terminated', 'second_session');
    fail(409, 'This attempt was opened somewhere else and has been ended');
  }
  if (a.status !== 'in_progress' && token !== a.token) fail(409, 'This attempt has ended');
  return a;
}

// After an attempt ends, the tab may still deliver its last snapshot/event (they race the end).
// Accept those for a short grace period only, and cap the totals so nobody can fill the disk.
const EVIDENCE_GRACE_MS = 15_000;
const recentlyEnded = (a) => a.status === 'in_progress' || (a.finished_at && now() - a.finished_at < EVIDENCE_GRACE_MS);
const maxSnapshots = () => Math.ceil((config.quiz.minutes * 60_000) / config.quiz.snapshotEveryMs) + 60;
const MAX_EVENTS = 500;
function endAttempt(id, status, reason) {
  run("UPDATE quiz_attempts SET status=?, end_reason=?, finished_at=?, score_pct=COALESCE(score_pct,0) WHERE id=? AND status='in_progress'", status, reason, now(), id);
}
function checkAlive(a) {
  if (a.status !== 'in_progress') return false;
  const t = now();
  if (t - a.last_seen > config.quiz.heartbeatTimeoutMs) { endAttempt(a.id, 'terminated', 'heartbeat_lost'); return false; }
  if (t > a.deadline + 30000) { endAttempt(a.id, 'terminated', 'timeout'); return false; }
  // Camera is enforced server-side too: webcam snapshots must keep arriving.
  if (config.quiz.requireCamera && t - (a.last_snapshot || a.started_at) > config.quiz.maxSnapshotGapMs) {
    logEvent(a.id, 'camera_missing', 'no webcam snapshot received in time');
    endAttempt(a.id, 'terminated', 'camera_missing'); return false;
  }
  return true;
}
const attemptStatus = (id) => one('SELECT status, end_reason, strikes FROM quiz_attempts WHERE id=?', id);

app.post('/api/plans/:id/quiz/start', student, aiLimit, async (req, res) => {
  const p = ownPlan(req, req.params.id);
  const pre = req.body?.preflight || {};
  if (config.quiz.requireCamera && !pre.camera) fail(400, 'Your webcam must be on to start the quiz');
  if (pre.extendedDisplay) fail(400, 'Disconnect extra monitors before starting the quiz');
  // Any attempt left open (refresh, crash, closed tab) is forfeited.
  for (const a of all("SELECT id FROM quiz_attempts WHERE plan_id = ? AND status = 'in_progress'", p.id)) endAttempt(a.id, 'terminated', 'abandoned');
  const detail = planDetail(p);
  if (!detail.quiz.unlocked) fail(409, detail.quiz.reason || 'Quiz is locked');

  const items = all('SELECT * FROM plan_items WHERE plan_id = ?', p.id);
  const previous = all('SELECT questions_json FROM quiz_attempts WHERE plan_id = ?', p.id).flatMap((r) => JSON.parse(r.questions_json));
  let quiz;
  try { quiz = await generateQuiz(items, previous); }
  catch (e) { console.error('Quiz generation failed:', e); fail(502, `Could not generate questions: ${aiErrorMessage(e)}`); }

  if (!p.ratings_json) run('UPDATE plans SET ratings_json = ? WHERE id = ?', JSON.stringify(quiz.ratings), p.id);
  const t = now();
  const token = crypto.randomBytes(24).toString('hex');
  const r = run(
    `INSERT INTO quiz_attempts (plan_id, attempt_no, status, questions_json, started_at, deadline, last_seen, token, ip, user_agent, strikes)
     VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
    p.id, detail.quiz.attemptsUsed + 1, 'in_progress', JSON.stringify(quiz.questions), t, t + config.quiz.minutes * 60000, t,
    token, req.ip, String(req.get('user-agent') || '').slice(0, 300),
  );
  const attemptId = Number(r.lastInsertRowid);
  logEvent(attemptId, 'preflight', `camera=${Boolean(pre.camera)} faces=${pre.faces ?? '?'} faceDetection=${pre.faceDetection ?? '?'} screens=${pre.extendedDisplay === false ? 'single' : 'unknown'} ${String(pre.browser || '').slice(0, 80)}`);
  res.json({
    attemptId,
    token,
    attemptNo: detail.quiz.attemptsUsed + 1,
    deadline: t + config.quiz.minutes * 60000,
    proctor: { maxStrikes: config.quiz.maxStrikes, requireCamera: config.quiz.requireCamera, snapshotEveryMs: config.quiz.snapshotEveryMs },
    questions: quiz.questions.map((q) => ({ question: q.question, itemTitle: items.find((i) => String(i.id) === q.item_id)?.title, code: q.code ?? null, codeLang: q.code_lang ?? null })),
  });
});

app.post('/api/attempts/:id/heartbeat', student, (req, res) => {
  const a = attemptFromTab(req);
  if (!checkAlive(a)) return res.json({ alive: false, status: attemptStatus(a.id) });
  if (a.ip && req.ip !== a.ip) logEvent(a.id, 'ip_changed', `${a.ip} -> ${req.ip}`);
  run('UPDATE quiz_attempts SET last_seen = ? WHERE id = ?', now(), a.id);
  res.json({ alive: true });
});

app.post('/api/attempts/:id/event', student, (req, res) => {
  const a = attemptFromTab(req);
  const type = String(req.body?.type || '').slice(0, 40);
  const logged = one('SELECT COUNT(*) AS n FROM proctor_events WHERE attempt_id = ?', a.id).n;
  if (recentlyEnded(a) && logged < MAX_EVENTS) logEvent(a.id, type, req.body?.detail || '');
  if (a.status === 'in_progress') {
    if (HARD.has(type)) endAttempt(a.id, 'terminated', type);
    else if (SOFT.has(type)) {
      run('UPDATE quiz_attempts SET strikes = strikes + 1 WHERE id = ?', a.id);
      if (attemptStatus(a.id).strikes >= config.quiz.maxStrikes) endAttempt(a.id, 'terminated', 'too_many_warnings');
    }
  }
  res.json({ status: attemptStatus(a.id), maxStrikes: config.quiz.maxStrikes });
});

// Webcam snapshot (small JPEG). Stored for the supervisor; also proves the camera stayed on.
app.post('/api/attempts/:id/snapshot', student, express.json({ limit: '300kb' }), (req, res) => {
  const a = attemptFromTab(req);
  if (!recentlyEnded(a)) fail(409, 'This attempt has ended');
  if (one('SELECT COUNT(*) AS n FROM proctor_snapshots WHERE attempt_id = ?', a.id).n >= maxSnapshots()) fail(429, 'Too many snapshots for this attempt');
  const m = String(req.body?.image || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) fail(400, 'Invalid snapshot');
  const jpeg = Buffer.from(m[1], 'base64');
  if (jpeg.length > 200_000) fail(400, 'Snapshot too large');
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) fail(400, 'Invalid snapshot'); // JPEG magic bytes
  const faces = Number.isInteger(req.body?.faces) ? req.body.faces : null;
  run('INSERT INTO proctor_snapshots (attempt_id, at, faces, reason, jpeg) VALUES (?,?,?,?,?)', a.id, now(), faces, String(req.body?.reason || 'periodic').slice(0, 40), jpeg);
  if (a.status === 'in_progress') run('UPDATE quiz_attempts SET last_snapshot = ? WHERE id = ?', now(), a.id);
  res.json({ ok: true });
});

app.post('/api/attempts/:id/exit', student, (req, res) => {
  const a = attemptFromTab(req);
  endAttempt(a.id, 'exited', 'student_exit');
  res.json({ ok: true });
});

async function gradeAndAward(attemptId) {
  const a = one('SELECT * FROM quiz_attempts WHERE id = ?', attemptId);
  const p = one('SELECT * FROM plans WHERE id = ?', a.plan_id);
  const grading = await gradeAnswers(JSON.parse(a.questions_json), JSON.parse(a.answers_json));
  run("UPDATE quiz_attempts SET status='graded', grading_json=?, score_pct=?, finished_at=? WHERE id=?", JSON.stringify(grading), grading.pct, now(), a.id);
  const best = Math.max(p.best_pct ?? 0, grading.pct);
  const items = all('SELECT * FROM plan_items WHERE plan_id = ?', p.id);
  const streak = streakIncluding(p.student_id, p.day);
  const award = computeAward({ items, ratings: JSON.parse(p.ratings_json || '[]'), bestPct: best, streak });
  run('UPDATE plans SET best_pct = ?, points_awarded = ?, streak = ? WHERE id = ?', best, award.total, streak, p.id);
  return { grading, award };
}

app.post('/api/attempts/:id/submit', student, async (req, res) => {
  const a = attemptFromTab(req);
  if (!checkAlive(a)) fail(409, `This attempt has ended (${one('SELECT end_reason FROM quiz_attempts WHERE id=?', a.id).end_reason})`);
  const answers = Array.isArray(req.body?.answers) ? req.body.answers.slice(0, 50).map((x) => String(x ?? '').slice(0, 4000)) : fail(400, 'answers[] required');
  run("UPDATE quiz_attempts SET status='submitted', answers_json=? WHERE id=?", JSON.stringify(answers), a.id);
  try {
    const { grading, award } = await gradeAndAward(a.id);
    res.json({ grading: { pct: grading.pct, results: grading.results }, award, plan: planDetail(one('SELECT * FROM plans WHERE id = ?', a.plan_id)) });
  } catch (e) {
    console.error('Grading failed:', e);
    fail(502, `Your answers are saved but grading failed: ${aiErrorMessage(e)}. Use "Retry grading".`);
  }
});

const regrading = new Set(); // attempt ids being regraded right now (stops parallel paid AI calls)
app.post('/api/attempts/:id/regrade', student, aiLimit, async (req, res) => {
  const a = ownAttempt(req, req.params.id);
  if (a.status !== 'submitted') fail(409, 'Nothing to regrade');
  if (regrading.has(a.id)) fail(409, 'Grading is already in progress');
  regrading.add(a.id);
  try {
    const { grading, award } = await gradeAndAward(a.id);
    res.json({ grading: { pct: grading.pct, results: grading.results }, award, plan: planDetail(one('SELECT * FROM plans WHERE id = ?', a.plan_id)) });
  } catch (e) {
    console.error('Regrading failed:', e);
    fail(502, `Your answers are saved but grading failed: ${aiErrorMessage(e)}. Use "Retry grading".`);
  } finally { regrading.delete(a.id); }
});

// ======================= Supervisor =======================
app.get('/api/supervisor/students', supervisor, (req, res) => {
  const today = isDay(req.query.today) ? req.query.today : new Date().toISOString().slice(0, 10);
  const students = all('SELECT * FROM users WHERE supervisor_id = ? ORDER BY name', req.user.id).map((s) => {
    const todayPlan = one('SELECT * FROM plans WHERE student_id = ? AND day = ?', s.id, today);
    const pending = all("SELECT id, day FROM plans WHERE student_id = ? AND status = 'proposed' ORDER BY day DESC", s.id);
    const agg = one(`SELECT COALESCE(SUM(points_awarded),0) AS points, COUNT(*) AS days,
      SUM(CASE WHEN best_pct >= ? THEN 1 ELSE 0 END) AS passed FROM plans WHERE student_id = ?`, config.quiz.passPct, s.id);
    const violations = one(`SELECT COUNT(*) AS n FROM quiz_attempts a JOIN plans p ON p.id = a.plan_id
      WHERE p.student_id = ? AND a.status = 'terminated'`, s.id).n;
    return {
      ...publicUser(s), totalPoints: agg.points, daysPlanned: agg.days, daysPassed: agg.passed ?? 0,
      streak: currentStreak(s.id, today), terminatedAttempts: violations, pendingPlans: pending,
      today: todayPlan ? { status: todayPlan.status, bestPct: todayPlan.best_pct, points: todayPlan.points_awarded,
        items: one('SELECT COUNT(*) AS n FROM plan_items WHERE plan_id = ?', todayPlan.id).n,
        verified: one('SELECT COUNT(*) AS n FROM plan_items WHERE plan_id = ? AND verified_at IS NOT NULL', todayPlan.id).n } : null,
    };
  });
  res.json({ students });
});

app.get('/api/supervisor/snapshots/:id', supervisor, (req, res) => {
  const s = one(`SELECT ps.jpeg FROM proctor_snapshots ps JOIN quiz_attempts a ON a.id = ps.attempt_id JOIN plans p ON p.id = a.plan_id
    JOIN users u ON u.id = p.student_id WHERE ps.id = ? AND u.supervisor_id = ?`, Number(req.params.id), req.user.id) || fail(404, 'Not found');
  res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=86400').send(Buffer.from(s.jpeg));
});

app.get('/api/supervisor/students/:id', supervisor, (req, res) => {
  const s = one('SELECT * FROM users WHERE id = ? AND supervisor_id = ?', Number(req.params.id), req.user.id) || fail(404, 'Student not found');
  const plans = all('SELECT * FROM plans WHERE student_id = ? ORDER BY day DESC LIMIT 60', s.id).map((p) => planDetail(p, { forSupervisor: true }));
  res.json({ student: publicUser(s), plans });
});

app.post('/api/supervisor/plans/:id/review', supervisor, (req, res) => {
  const p = one('SELECT p.* FROM plans p JOIN users u ON u.id = p.student_id WHERE p.id = ? AND u.supervisor_id = ?', Number(req.params.id), req.user.id) || fail(404, 'Plan not found');
  const { action, note, removeItemIds } = req.body || {};
  if (!['approve', 'request_changes'].includes(action)) fail(400, 'action must be approve or request_changes');
  if (!['proposed', 'draft', 'changes_requested'].includes(p.status)) fail(409, `Plan is already ${p.status}`);
  for (const id of Array.isArray(removeItemIds) ? removeItemIds : []) run('DELETE FROM plan_items WHERE id = ? AND plan_id = ?', Number(id), p.id);
  if (action === 'approve' && !one('SELECT id FROM plan_items WHERE plan_id = ?', p.id)) fail(400, 'Cannot approve an empty plan');
  run('UPDATE plans SET status = ?, supervisor_note = ? WHERE id = ?', action === 'approve' ? 'approved' : 'changes_requested', String(note || '').slice(0, 1000) || null, p.id);
  res.json({ plan: planDetail(one('SELECT * FROM plans WHERE id = ?', p.id), { forSupervisor: true }) });
});

// ======================= Errors =======================
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  // Body-parser errors (bad JSON, too large) carry a safe 4xx status.
  if (err.status >= 400 && err.status < 500 && err.expose) return res.status(err.status).json({ error: err.message });
  const ref = crypto.randomBytes(4).toString('hex');
  console.error(`[error ${ref}]`, err);
  res.status(500).json({ error: `Server error (ref ${ref})` });
});

// Housekeeping: expired sessions and old webcam snapshots (privacy: don't keep biometric images forever).
function purgeOldData() {
  purgeExpiredSessions();
  const days = config.quiz.snapshotRetentionDays;
  if (days > 0) {
    const n = run('DELETE FROM proctor_snapshots WHERE at < ?', now() - days * 864e5).changes;
    if (n) console.log(`Deleted ${n} webcam snapshot(s) older than ${days} days`);
  }
}
purgeOldData();
setInterval(purgeOldData, 3600_000).unref();

app.listen(config.port, () => {
  const ai = config.aiMode === 'demo' ? 'demo' : config.aiProvider === 'gemini' ? `gemini (${config.geminiModel})` : `claude (${config.model})`;
  console.log(`Proctor running on http://localhost:${config.port}  (AI: ${ai})`);
  if (config.aiMode !== 'demo') {
    if (config.aiProvider === 'gemini' && !config.geminiApiKey) console.warn('AI_PROVIDER=gemini but GEMINI_API_KEY is not set — quiz generation will fail.');
    if (config.aiProvider === 'claude' && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      console.warn('No AI key set — quiz generation will fail. Put GEMINI_API_KEY or ANTHROPIC_API_KEY in .env, or run `npm run demo`.');
    }
  }
});
