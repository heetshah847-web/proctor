// DSA Proctor — single-page frontend (no build step).
import { loadFaceDetector, loadObjectDetector, openCamera, countFaces, detectObjects, snapshot, brightness, extendedDisplay, browserName } from './proctor.js';
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $who = document.getElementById('who');
const $topbar = document.getElementById('topbar');
const $quiz = document.getElementById('quiz');

const S = { me: null, supervisor: null, settings: null, view: null, sheet: null, plan: null, summary: null, sheetQuery: '' };

// ---------------- utils ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const fmtTime = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast${bad ? ' bad' : ''}`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4500);
}
async function act(fn, btn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}

const STATUS = {
  draft: ['Draft — not sent yet', ''], proposed: ['Waiting for supervisor approval', 'warn'],
  changes_requested: ['Supervisor requested changes', 'bad'], approved: ['Approved', 'ok'],
};
const statusChip = (s) => `<span class="chip ${STATUS[s]?.[1] || ''}">${esc(s.replace('_', ' '))}</span>`;
const diffChip = (d) => (d ? `<span class="chip">${esc(d)}</span>` : '');
const viaChip = (it) => it.verifiedAt
  ? `<span class="chip ${it.verifiedVia === 'self' ? 'warn' : 'ok'}" title="${esc(fmtTime(it.verifiedAt))}">✓ ${esc(it.verifiedVia)}</span>`
  : '<span class="chip">not verified</span>';
const KP = { covered: ['✓', 'ok', 'covered'], partial: ['◐', 'warn', 'partly covered'], missing: ['✗', 'bad', 'missed'] };
const keyPointsHtml = (points) => (points?.length ? `<ul class="kp">${points.map((p) => {
  const [icon, cls, label] = KP[p.status] || KP.missing;
  return `<li class="${cls}" title="${label}"><span class="kpi">${icon}</span>${esc(p.point)}</li>`;
}).join('')}</ul>` : '');
const LANGS = { cpp: 'C++', java: 'Java', python: 'Python', javascript: 'JavaScript', other: 'Other' };
const codeBlock = (code, lang) => `<div class="code" data-lang="${esc(LANGS[lang] || '')}">${String(code).split('\n')
  .map((l, i) => `<div class="cl"><span class="ln">${i + 1}</span><span class="lc">${esc(l) || ' '}</span></div>`).join('')}</div>`;
function codeEditorHtml(it, locked) {
  if (locked) return `<li class="code-edit"><div class="grow">${it.code ? codeBlock(it.code, it.codeLang) : '<p class="muted small">No code saved.</p>'}
    <p class="small muted">Code is locked once the quiz has started.</p></div></li>`;
  return `<li class="code-edit"><div class="grow stack">
    <div class="small muted">Paste <b>your own</b> accepted solution for “${esc(it.title)}”. In the quiz you’ll be asked to dry run it on an example and explain why particular lines are there. It locks when you start the quiz.</div>
    <select id="codelang" style="max-width:180px">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${it.codeLang === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <textarea id="codetext" class="mono" rows="12" spellcheck="false" placeholder="// your solution">${esc(it.code || '')}</textarea>
    <div class="row"><button class="btn primary sm" data-savecode="${it.id}">Save code</button><button class="btn sm" data-closecode>Close</button></div>
  </div></li>`;
}
const fmtScore = (s) => (s == null ? '' : `${Number.isInteger(s) ? s : s.toFixed(1)}/10`);
const rubricHtml = () => `<ul class="small">${S.settings.rubric.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
const pctChip = (p) => (p == null ? '<span class="muted">—</span>' : `<span class="chip ${p >= (S.settings?.quiz.passPct ?? 50) ? 'ok' : 'bad'}">${Math.round(p)}%</span>`);

// ---------------- boot / nav ----------------
async function boot() {
  const r = await api('/api/me');
  S.me = r.user; S.supervisor = r.supervisor; S.settings = r.settings;
  if (!S.me) return renderAuth();
  $topbar.hidden = false;
  const views = S.me.role === 'student' ? [['today', 'Today'], ['history', 'History'], ['profile', 'Profile']] : [['students', 'Students']];
  $nav.innerHTML = views.map(([k, l]) => `<button data-view="${k}">${l}</button>`).join('');
  $nav.onclick = (e) => { const v = e.target.dataset.view; if (v) go(v); };
  $who.innerHTML = `${S.settings.aiMode === 'demo' ? '<span class="chip warn" title="Questions are templates and grading is by length">AI demo mode</span>' : ''}
    <span>${esc(S.me.name)} <span class="muted">· ${S.me.role}</span></span><button class="btn sm" id="logout">Log out</button>`;
  document.getElementById('logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); };
  go(views[0][0]);
}

function go(view, arg) {
  S.view = view;
  [...$nav.children].forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  ({ today: renderToday, history: renderHistory, profile: renderProfile, students: renderStudents, student: renderStudentDetail }[view])(arg);
}

// ---------------- auth ----------------
function renderAuth(mode = 'login') {
  $topbar.hidden = true;
  $app.innerHTML = `
  <div class="auth card">
    <h1>DSA <span style="color:var(--accent)">Proctor</span></h1>
    <p class="muted">Daily Striver A2Z + LeetCode accountability, with a proctored AI check.</p>
    <div class="tabs"><button class="btn ${mode === 'login' ? 'active' : ''}" data-m="login">Log in</button><button class="btn ${mode === 'signup' ? 'active' : ''}" data-m="signup">Sign up</button></div>
    <form id="authf">
      ${mode === 'signup' ? `
        <div class="field"><label>I am a</label><select name="role"><option value="student">Student</option><option value="supervisor">Supervisor</option></select></div>
        <div class="field"><label>Name</label><input type="text" name="name" required></div>` : ''}
      <div class="field"><label>Email</label><input type="email" name="email" required></div>
      <div class="field"><label>Password</label><input type="password" name="password" required minlength="8" maxlength="200"></div>
      ${mode === 'signup' ? `<div class="field" id="invf"><label>Supervisor invite code (students, optional — can add later)</label><input type="text" name="inviteCode"></div>` : ''}
      <div class="field"><button class="btn primary" style="width:100%">${mode === 'login' ? 'Log in' : 'Create account'}</button></div>
    </form>
  </div>`;
  $app.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => renderAuth(b.dataset.m)));
  const f = document.getElementById('authf');
  f.role?.addEventListener('change', () => (document.getElementById('invf').hidden = f.role.value !== 'student'));
  f.onsubmit = (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    act(async () => { await api(`/api/auth/${mode}`, { method: 'POST', body }); location.reload(); }, f.querySelector('button.primary'));
  };
}

// ======================= STUDENT =======================
async function loadToday() {
  const [p, s] = await Promise.all([
    api('/api/plans', { method: 'POST', body: { day: localDay(), dayStart: dayStart() } }),
    api(`/api/student/summary?today=${localDay()}`),
  ]);
  S.plan = p.plan; S.summary = s;
}

async function renderToday() {
  $app.innerHTML = '<p class="muted">Loading…</p>';
  await act(loadToday);
  if (!S.sheet) S.sheet = await api('/api/sheet');
  drawToday();
}

function setupWarnings() {
  const w = [];
  if (!S.me.leetcodeUsername) w.push('Add your <b>LeetCode username</b> in Profile so problems can be auto-verified.');
  if (S.settings.requireSupervisorApproval && !S.me.supervisorId) w.push('You are not linked to a supervisor yet — add their invite code in Profile.');
  return w.map((x) => `<div class="banner warn small">${x}</div>`).join('');
}

function drawToday() {
  const p = S.plan;
  const locked = p.status === 'approved';
  const needApproval = S.settings.requireSupervisorApproval;
  const st = !needApproval && p.status === 'approved' ? ['Plan locked in for today', 'ok'] : STATUS[p.status];
  const inPlan = new Set(p.items.map((i) => i.sheetItemId).filter(Boolean));
  $app.innerHTML = `
  <div class="grid cols-3" style="margin-bottom:16px">
    <div class="card stat"><span class="muted small">Total points</span><b>${S.summary.totalPoints}</b></div>
    <div class="card stat"><span class="muted small">Streak</span><b>${S.summary.streak} 🔥</b></div>
    <div class="card stat"><span class="muted small">Today</span><b>${p.pointsAwarded} pts</b><span class="small muted">${p.bestPct != null ? `best quiz ${Math.round(p.bestPct)}%` : 'quiz not taken'}</span></div>
  </div>
  <div class="stack" style="margin-bottom:16px">${setupWarnings()}</div>
  <div class="grid cols-2">
    <div class="stack">
      <div class="card">
        <div class="row spread"><h2>Today's plan · ${esc(p.day)}</h2>${statusChip(p.status)}</div>
        <div class="banner ${st[1]} small">${st[0]}${p.supervisorNote ? ` — <i>“${esc(p.supervisorNote)}”</i>` : ''}</div>
        ${p.items.length ? `<ul class="items" style="margin-top:8px">${p.items.map((it) => `
          <li>
            <div class="grow"><div class="title">${esc(it.title)}</div>
              <div class="small muted">${esc(it.step || '')}${it.topic ? ` › ${esc(it.topic)}` : ''} ${diffChip(it.difficulty)}
              ${it.leetcodeSlug ? `<a href="https://leetcode.com/problems/${esc(it.leetcodeSlug)}/" target="_blank" rel="noopener">LeetCode ↗</a>` : '<span class="chip">no LeetCode link</span>'}
              ${it.tufPreDone ? '<span class="chip warn" title="Already ticked on TUF before today">done before today</span>' : ''}</div></div>
            ${viaChip(it)}
            ${!it.verifiedAt && !it.leetcodeSlug && (!S.me.tufConnected || it.tufPreDone) ? `<button class="btn sm" data-attest="${it.id}" title="No LeetCode link — mark as done yourself; the AI quiz will check it">Mark done</button>` : ''}
            ${it.codeRequired || it.code ? `<button class="btn sm" data-code="${it.id}" title="Your own solution — the quiz asks you to dry run it">${it.code ? 'Code ✓' : '<span style="color:var(--warn)">Add code</span>'}</button>` : ''}
            ${!locked ? `<button class="btn sm danger" data-del="${it.id}" title="Remove">✕</button>` : ''}
          </li>${S.codeOpen === it.id ? codeEditorHtml(it, p.codeLocked) : ''}`).join('')}</ul>` : '<p class="muted">No items yet — pick today’s topics from the Striver sheet on the right.</p>'}
        <div class="row" style="margin-top:12px">
          ${!locked ? `${needApproval ? `<input type="text" id="pnote" placeholder="Note for your supervisor (optional)" value="${esc(p.studentNote || '')}" style="flex:1;min-width:200px">` : ''}
            <button class="btn primary" id="propose" ${p.items.length ? '' : 'disabled'}>${!needApproval ? 'Lock in plan' : p.status === 'proposed' ? 'Re-send' : 'Send to supervisor'}</button>` : ''}
          <button class="btn" id="verify" ${p.items.length ? '' : 'disabled'}>Check progress</button>
        </div>
        <div id="vreport" class="small muted" style="margin-top:8px"></div>
      </div>
      ${quizCard(p)}
    </div>
    <div class="card">
      <h2>Add from Striver A2Z</h2>
      ${locked ? '<p class="muted small">Plan is approved and locked for today.</p>' : `
      <input type="text" id="sq" placeholder="Search 495 sheet items…" value="${esc(S.sheetQuery)}">
      <div class="sheet" id="sheet" style="margin-top:8px">${sheetHtml(inPlan)}</div>
      <h3 style="margin-top:16px">Or a LeetCode problem</h3>
      <div class="row"><input type="text" id="lcslug" placeholder="two-sum or https://leetcode.com/problems/two-sum/" style="flex:1"><button class="btn" id="addlc">Add</button></div>`}
    </div>
  </div>`;
  bindToday();
}

function sheetHtml(inPlan) {
  const q = S.sheetQuery.trim().toLowerCase();
  const row = (it) => `<div class="sitem"><span class="grow">${esc(it.title)}</span>${diffChip(it.difficulty)}${it.leetcodeSlug ? '<span class="chip accent">LC</span>' : ''}
    ${inPlan.has(it.id) ? '<span class="chip ok">added</span>' : `<button class="btn sm" data-add="${it.id}">Add</button>`}</div>`;
  if (q) {
    const hits = [];
    for (const s of S.sheet.steps) for (const t of s.topics) for (const it of t.items) if (it.title.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)) hits.push(it);
    return hits.length ? hits.slice(0, 120).map(row).join('') : '<p class="muted small" style="padding:8px">No matches</p>';
  }
  return S.sheet.steps.map((s, i) => `<details><summary>Step ${i + 1}: ${esc(s.title)}</summary>
    ${s.topics.map((t) => `<details><summary>${esc(t.title)} <span class="muted small">(${t.items.length})</span></summary>${t.items.map(row).join('')}</details>`).join('')}</details>`).join('');
}

function quizCard(p) {
  const q = p.quiz;
  const pass = S.settings.quiz.passPct;
  const award = p.award;
  return `<div class="card">
    <div class="row spread"><h2>AI check (proctored)</h2><span class="muted small">attempts ${q.attemptsUsed}/${q.maxAttempts}</span></div>
    <p class="small muted">Once every item is verified, answer ${S.settings.quiz.questions} questions about today’s problems in a locked, full-screen session
      (${S.settings.quiz.minutes} min). Score ≥ ${pass}% approves the day. You can retry to raise your best score — points use your <b>best</b> attempt.</p>
    ${p.attempts.length ? `<table><tr><th>#</th><th>Result</th><th class="num">Score</th></tr>${p.attempts.map((a) => `<tr><td>${a.attemptNo}</td>
      <td>${a.status === 'graded' ? 'graded' : `<span class="chip bad">${esc(a.status)}</span> <span class="small muted">${esc(a.endReason || '')}</span>`}</td>
      <td class="num">${pctChip(a.scorePct)}</td></tr>`).join('')}</table>` : ''}
    ${award ? `<p class="small">Base ${award.base} pts × streak ${award.multiplier} × best ${Math.round(award.bestPct)}% = <b>${award.total} pts</b>${award.passed ? '' : ` <span class="chip bad">below ${pass}% — not approved</span>`}</p>` : ''}
    <div class="row" style="margin-top:8px">
      <button class="btn primary" id="startquiz" ${q.unlocked ? '' : 'disabled'}>${p.attempts.length ? 'Try again' : 'Start proctored quiz'}</button>
      ${q.reason ? `<span class="small muted">${esc(q.reason)}</span>` : ''}
    </div>
  </div>`;
}

function bindToday() {
  const p = S.plan;
  const refresh = (r) => { S.plan = r.plan; drawToday(); };
  $app.querySelectorAll('[data-code]').forEach((b) => (b.onclick = () => {
    S.codeOpen = S.codeOpen === Number(b.dataset.code) ? null : Number(b.dataset.code); drawToday();
  }));
  $app.querySelector('[data-closecode]')?.addEventListener('click', () => { S.codeOpen = null; drawToday(); });
  const sc = $app.querySelector('[data-savecode]');
  if (sc) sc.onclick = () => act(async () => {
    const r = await api(`/api/plans/${p.id}/items/${sc.dataset.savecode}/code`, { method: 'PUT',
      body: { code: document.getElementById('codetext').value, lang: document.getElementById('codelang').value } });
    S.codeOpen = null; refresh(r); toast('Code saved');
  }, sc);
  $app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => act(async () => refresh(await api(`/api/plans/${p.id}/items/${b.dataset.del}`, { method: 'DELETE' })), b)));
  $app.querySelectorAll('[data-attest]').forEach((b) => (b.onclick = () => act(async () => refresh(await api(`/api/plans/${p.id}/items/${b.dataset.attest}/attest`, { method: 'POST' })), b)));
  const sheetEl = document.getElementById('sheet');
  if (sheetEl) sheetEl.onclick = (e) => {
    const id = e.target.dataset.add;
    if (id) act(async () => { const st = sheetEl.scrollTop; const open = [...sheetEl.querySelectorAll('details[open]')].map((d) => d.querySelector('summary').textContent);
      refresh(await api(`/api/plans/${p.id}/items`, { method: 'POST', body: { sheetItemId: id } }));
      const el = document.getElementById('sheet'); el.querySelectorAll('details').forEach((d) => { if (open.includes(d.querySelector('summary').textContent)) d.open = true; }); el.scrollTop = st; }, e.target);
  };
  const sq = document.getElementById('sq');
  if (sq) sq.oninput = () => { S.sheetQuery = sq.value; document.getElementById('sheet').innerHTML = sheetHtml(new Set(p.items.map((i) => i.sheetItemId))); };
  const addlc = document.getElementById('addlc');
  if (addlc) addlc.onclick = () => act(async () => refresh(await api(`/api/plans/${p.id}/items`, { method: 'POST', body: { leetcodeSlug: document.getElementById('lcslug').value } })), addlc);
  const prop = document.getElementById('propose');
  if (prop) prop.onclick = () => act(async () => { refresh(await api(`/api/plans/${p.id}/propose`, { method: 'POST', body: { note: document.getElementById('pnote')?.value || '' } })); toast(S.settings.requireSupervisorApproval ? 'Sent to your supervisor' : 'Plan locked in'); }, prop);
  const ver = document.getElementById('verify');
  ver.onclick = () => act(async () => {
    const r = await api(`/api/plans/${p.id}/verify`, { method: 'POST' });
    refresh(r);
    const parts = [];
    if (r.report.leetcode) parts.push(r.report.leetcode.ok ? `LeetCode: checked ${r.report.leetcode.recent} recent accepted submissions.` : `LeetCode: ${r.report.leetcode.error}`);
    if (r.report.tuf) parts.push(r.report.tuf.ok ? `takeuforward: ${r.report.tuf.doneOnSheet} items done on your sheet. ${r.report.tuf.warning || ''}` : `takeuforward: ${r.report.tuf.error}`);
    parts.push(r.report.newlyVerified.length ? `Newly verified: ${r.report.newlyVerified.join(', ')}` : 'Nothing new verified.');
    document.getElementById('vreport').textContent = parts.join(' ');
  }, ver);
  const sq2 = document.getElementById('startquiz');
  if (sq2) sq2.onclick = () => openQuizIntro(p);
}

// ---------------- Proctored quiz ----------------
const Q = { attempt: null, answers: [], timers: [], listeners: [], ended: false, blurTimer: null, stream: null, video: null, detector: null, objDetector: null, lastSoft: {}, observer: null };

const HARD_REASONS = {
  visibility_hidden: 'you switched tab or minimised the window',
  window_blur: 'the quiz window lost focus (another app or window was used)',
  fullscreen_exit: 'you left full screen',
  page_unload: 'the page was refreshed or closed',
  heartbeat_lost: 'the connection to the server was lost',
  timeout: 'time ran out',
  second_session: 'the quiz was opened in another tab or device',
  multiple_faces: 'more than one person was seen on camera',
  phone_detected: 'a phone was seen on camera',
  camera_off: 'your webcam was turned off',
  camera_missing: 'webcam images stopped reaching the server',
  window_resized: 'the window was resized or developer tools were opened',
  extra_monitor: 'a second monitor was connected',
  text_injected: 'text was inserted into an answer without typing it (paste, drag-and-drop or autofill)',
  too_many_warnings: 'you reached the maximum number of warnings',
};
const SOFT_REASONS = {
  no_face: 'your face is not visible on camera',
  camera_blocked: 'your camera looks covered or too dark',
  paste_blocked: 'pasting is not allowed', copy_blocked: 'copying is not allowed', cut_blocked: 'cutting is not allowed',
  drop_blocked: 'drag-and-drop is not allowed', contextmenu_blocked: 'right-click is not allowed',
  blocked_key: 'that keyboard shortcut is not allowed',
  mouse_left_window: 'the mouse left the quiz window',
  bulk_insert: 'a large block of text appeared at once',
  superhuman_typing: 'typing speed was unrealistically fast',
  page_modified: 'something (likely a browser extension) changed the quiz page',
  phone_detected: 'a phone is visible on camera — put it away',
  book_detected: 'a book or notes are visible on camera',
  device_detected: 'another laptop or screen is visible on camera',
  extra_person: 'another person is visible on camera',
};

function stopCamera() {
  Q.stream?.getTracks().forEach((t) => t.stop());
  Q.stream = null;
}

// ---- Pre-flight: camera, face, monitors, full screen ----
function openQuizIntro(plan) {
  const needCam = S.settings.quiz.requireCamera;
  const objects = needCam && S.settings.quiz.objectDetection;
  const phoneEnds = objects && S.settings.quiz.phoneEndsAttempt;
  $quiz.hidden = false;
  $quiz.innerHTML = `<div class="inner"><div class="card">
    <h1>Proctored AI check</h1>
    <p>Attempt ${plan.quiz.attemptsUsed + 1} of ${plan.quiz.maxAttempts}. ${S.settings.quiz.questions} questions, ${S.settings.quiz.minutes} minutes.</p>
    <div class="grid cols-2">
      <div>
        <h3>Strict rules</h3>
        <ul class="rules small">
          <li><b>Ends the attempt immediately (0%):</b> leaving full screen (Esc), switching tab or window, alt-tab, minimising, refreshing,
            resizing the window or opening developer tools, connecting a second monitor, opening the quiz in another tab/device,
            pasting or dropping text into an answer${needCam ? ', turning the camera off, or a second person on camera' : ''}${phoneEnds ? ', a phone seen on camera' : ''}.</li>
          <li><b>Warnings</b> (${S.settings.quiz.maxStrikes} warnings end the attempt): ${needCam ? 'face not visible for 5 s, camera covered, ' : ''}
            ${objects ? `${phoneEnds ? '' : 'a phone, '}a book or notes, another laptop or screen, or another person visible on camera, ` : ''}
            blocked shortcuts (copy, paste, print, dev tools), right-click, mouse leaving the window, browser extensions changing the page,
            text appearing faster than a person can type.</li>
          ${needCam ? `<li>Your webcam stays on. A photo is saved every ${Math.round(S.settings.quiz.snapshotEveryMs / 1000)} s and at every warning; your supervisor sees them.</li>` : ''}
          <li>Type every answer yourself. You may leave with <b>Exit quiz</b>, which uses the attempt.</li>
        </ul>
      </div>
      <div>
        <h3>System check</h3>
        <ul class="checks small" id="checks"></ul>
        ${needCam ? '<div id="pfcam" class="pfcam"></div>' : ''}
      </div>
    </div>
    <details class="small"><summary>How each answer is graded</summary>${rubricHtml()}</details>
    <label class="small" style="margin-top:10px"><input type="checkbox" id="qagree"> I understand the rules${needCam ? ' and agree to webcam monitoring' : ''}.</label>
    <div class="row" style="margin-top:8px"><button class="btn primary" id="qgo" disabled>Enter full screen &amp; start</button><button class="btn" id="qcancel">Not now</button></div>
    <p class="small muted" id="qmsg"></p>
  </div></div>`;

  const st = { fullscreen: Boolean(document.documentElement.requestFullscreen), extended: extendedDisplay(), camera: !needCam, faceModel: null, faces: null, objModel: objects ? null : false, seen: [] };
  const drawChecks = () => {
    const row = (ok, text) => `<li class="${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'}"><span class="kpi">${ok === true ? '✓' : ok === false ? '✗' : '!'}</span>${text}</li>`;
    document.getElementById('checks').innerHTML = [
      row(st.fullscreen, st.fullscreen ? 'Full screen supported' : 'This browser cannot go full screen'),
      row(st.extended === false ? true : st.extended ? false : null, st.extended === false ? 'Single monitor' : st.extended ? 'Disconnect extra monitors' : 'Monitor check unavailable — use Chrome or Edge'),
      needCam ? row(st.camera === true ? true : st.camera === false ? false : null, st.camera === true ? 'Webcam on' : st.camera === false ? `Webcam unavailable: ${esc(st.cameraError || '')}` : 'Starting webcam…') : '',
      needCam ? row(st.faceModel === false ? null : st.faces === 1, st.faceModel === false ? 'Face detection unavailable in this browser (photos only)'
        : st.faceModel == null ? 'Loading face detection…' : st.faces === 1 ? 'One face visible' : st.faces === 0 ? 'No face visible — sit in front of the camera' : `${st.faces} faces visible — only you may be on camera`) : '',
      objects ? row(st.objModel === false ? null : st.objModel == null ? null : !st.seen.length,
        st.objModel === false ? 'Object detection unavailable in this browser (photos only)'
        : st.objModel == null ? 'Loading object detection…'
        : !st.seen.length ? 'No phone, book or other device visible'
        : `Remove from camera view: ${esc([...new Set(st.seen.map((o) => o.label))].join(', '))}`) : '',
    ].join('');
    // Phones, books, devices and other people must be out of view before starting (cups/bottles are fine).
    const ready = st.fullscreen && st.extended !== true && st.camera === true && (!needCam || st.faceModel === false || st.faces === 1) && !st.seen.length;
    document.getElementById('qgo').disabled = !(ready && document.getElementById('qagree').checked);
  };
  drawChecks();
  document.getElementById('qagree').onchange = drawChecks;
  document.getElementById('qcancel').onclick = () => { clearInterval(Q.pfTimer); stopCamera(); closeQuiz(); };

  if (needCam) {
    Q.video = document.createElement('video');
    document.getElementById('pfcam').append(Q.video);
    openCamera(Q.video).then((stream) => { Q.stream = stream; st.camera = true; drawChecks(); })
      .catch((e) => { st.camera = false; st.cameraError = e.name === 'NotAllowedError' ? 'permission denied — allow camera access in the address bar' : e.message; drawChecks(); });
    loadFaceDetector().then((d) => { Q.detector = d; st.faceModel = true; drawChecks(); })
      .catch((e) => { console.warn('Face detection unavailable', e); Q.detector = null; st.faceModel = false; drawChecks(); });
    if (objects) {
      loadObjectDetector().then((d) => { Q.objDetector = d; st.objModel = true; drawChecks(); })
        .catch((e) => { console.warn('Object detection unavailable', e); Q.objDetector = null; st.objModel = false; drawChecks(); });
    }
    clearInterval(Q.pfTimer);
    Q.pfTimer = setInterval(() => {
      if (!document.getElementById('checks')) return clearInterval(Q.pfTimer);
      st.extended = extendedDisplay();
      if (Q.detector && Q.video) st.faces = countFaces(Q.detector, Q.video);
      if (Q.objDetector && Q.video) st.seen = (detectObjects(Q.objDetector, Q.video) || []).filter((o) => o.event !== 'object_seen');
      drawChecks();
    }, 600);
  }

  document.getElementById('qgo').onclick = async (e) => {
    const btn = e.target; btn.disabled = true;
    clearInterval(Q.pfTimer);
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      // Keyboard Lock (Chrome/Edge, full screen only): captures Alt+Tab, the Windows key, Esc etc. so they reach the page.
      try { await navigator.keyboard?.lock?.(); } catch { /* not supported */ }
      document.getElementById('qmsg').textContent = 'Preparing your questions…';
      const r = await api(`/api/plans/${plan.id}/quiz/start`, { method: 'POST', body: { preflight: {
        camera: st.camera === true && needCam, faces: st.faces, faceDetection: st.faceModel === true,
        objectDetection: st.objModel === true, phoneVisible: st.seen.some((o) => o.event === 'phone_detected'),
        extendedDisplay: st.extended, browser: `${browserName()} ${navigator.userAgent.slice(0, 60)}`,
      } } });
      startQuiz(r);
    } catch (err) {
      navigator.keyboard?.unlock?.();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      document.getElementById('qmsg').textContent = err.message; btn.disabled = false;
    }
  };
}

function on(target, ev, fn, opts) { target.addEventListener(ev, fn, opts); Q.listeners.push([target, ev, fn, opts]); }
function cleanupQuiz() {
  Q.listeners.forEach(([t, ev, fn, o]) => t.removeEventListener(ev, fn, o)); Q.listeners = [];
  Q.timers.forEach(clearInterval); Q.timers = []; clearTimeout(Q.blurTimer);
  Q.observer?.disconnect(); Q.observer = null;
  navigator.keyboard?.unlock?.();
}
function closeQuiz() {
  cleanupQuiz(); stopCamera(); clearInterval(Q.pfTimer);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $quiz.hidden = true; $quiz.innerHTML = '';
  if (S.view === 'today') renderToday();
}

// Every quiz request carries the attempt secret; requests from another tab/device end the attempt.
const qapi = (path, body) => api(`/api/attempts/${Q.attempt.attemptId}/${path}`, { method: 'POST', body, headers: { 'X-Attempt-Token': Q.attempt.token } });

function sendSnapshot(reason) {
  if (!Q.stream || !Q.video || Q.video.readyState < 2) return;
  const faces = Q.detector ? countFaces(Q.detector, Q.video) : null;
  qapi('snapshot', { image: snapshot(Q.video), faces, reason }).catch(() => {});
}

/** Hard violation: the attempt ends now. */
function violation(type, detail) {
  if (Q.ended) return;
  Q.ended = true;
  cleanupQuiz();
  sendSnapshot(type);
  qapi('event', { type, detail }).catch(() => {});
  showEnded(type);
}
function showEnded(type) {
  Q.ended = true; cleanupQuiz(); stopCamera();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $quiz.innerHTML = `<div class="inner"><div class="card"><h1 style="color:var(--bad)">Attempt ended</h1>
    <p>This attempt was terminated because ${esc(HARD_REASONS[type] || type)}. It counts as 0% and uses one attempt.</p>
    <p class="small muted">Your supervisor can see the proctoring log${S.settings.quiz.requireCamera ? ' and webcam photos' : ''} for this attempt.</p>
    <button class="btn primary" id="qclose">Back to dashboard</button></div></div>`;
  document.getElementById('qclose').onclick = closeQuiz;
}

/** Soft violation: a warning. The server counts them and ends the attempt at the limit. */
async function warn(type, detail) {
  if (Q.ended) return;
  const t = Date.now();
  if (t - (Q.lastSoft[type] || 0) < 3000) return; // one warning per kind every 3 s (e.g. a held key)
  Q.lastSoft[type] = t;
  sendSnapshot(type);
  try {
    const r = await qapi('event', { type, detail });
    if (r.status.status !== 'in_progress') return showEnded(r.status.end_reason || 'too_many_warnings');
    const left = r.maxStrikes - r.status.strikes;
    const el = document.getElementById('qwarn');
    el.hidden = false;
    el.innerHTML = `⚠ Warning ${r.status.strikes} of ${r.maxStrikes}: ${esc(SOFT_REASONS[type] || type)}. ${left === 1 ? '<b>One more warning ends this attempt.</b>' : ''}`;
    document.getElementById('qstrikes').textContent = `Warnings ${r.status.strikes}/${r.maxStrikes}`;
  } catch { /* the heartbeat will catch real problems */ }
}

function startQuiz(r) {
  Q.attempt = r; Q.answers = r.questions.map(() => ''); Q.ended = false; Q.lastSoft = {};
  $quiz.innerHTML = `
    <div class="bar"><b>Attempt ${r.attemptNo}</b>
      <span class="row"><span class="chip" id="qstrikes">Warnings 0/${r.proctor.maxStrikes}</span><span class="timer" id="qtimer"></span></span>
      <button class="btn danger" id="qexit">Exit quiz</button></div>
    <div class="banner bad small" id="qwarn" hidden style="margin:8px 16px"></div>
    <div class="inner">
      ${r.questions.map((q, i) => `<div class="card" style="margin-bottom:12px">
        <div class="small muted">Question ${i + 1} · ${esc(q.itemTitle || '')}</div>
        ${q.code ? `<div class="small muted">Your code:</div>${codeBlock(q.code, q.codeLang)}` : ''}
        <p style="font-weight:600">${esc(q.question)}</p>
        <textarea data-i="${i}" placeholder="Type your answer in your own words…" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-gramm="false" data-enable-grammarly="false"></textarea></div>`).join('')}
      <div class="row"><button class="btn primary" id="qsubmit">Submit answers</button><span class="small muted" id="qmsg"></span></div>
    </div>
    ${Q.stream ? '<div class="cam" id="qcam"><span class="camdot" id="qcamdot"></span></div>' : ''}`;
  if (Q.stream) document.getElementById('qcam').prepend(Q.video);

  // ---- answer boxes: only real typing is allowed ----
  const typed = []; // [time, chars]
  const ALLOWED_INPUT = /^(insertText|insertLineBreak|insertParagraph|insertCompositionText|deleteContent|deleteWord|deleteSoftLine|deleteHardLine|historyUndo|historyRedo)/;
  $quiz.querySelectorAll('textarea').forEach((t) => {
    t.addEventListener('beforeinput', (e) => {
      if (!ALLOWED_INPUT.test(e.inputType)) { e.preventDefault(); violation('text_injected', e.inputType); }
    });
    t.addEventListener('input', (e) => {
      Q.answers[t.dataset.i] = t.value;
      if (e.inputType === 'insertText' && (e.data || '').length > 3) warn('bulk_insert', `${e.data.length} chars at once`);
      const now = Date.now();
      typed.push([now, (e.data || '').length]);
      while (typed.length && now - typed[0][0] > 5000) typed.shift();
      if (typed.reduce((a, x) => a + x[1], 0) > 100) warn('superhuman_typing', '>100 chars in 5 s');
    });
  });
  $quiz.querySelector('textarea')?.focus();

  // ---- focus, full screen, tabs ----
  on(document, 'visibilitychange', () => { if (document.hidden) violation('visibility_hidden'); });
  on(document, 'fullscreenchange', () => { if (!document.fullscreenElement) violation('fullscreen_exit'); });
  on(window, 'blur', () => { clearTimeout(Q.blurTimer); Q.blurTimer = setTimeout(() => violation('window_blur'), 300); });
  on(window, 'focus', () => clearTimeout(Q.blurTimer));
  const unload = () => navigator.sendBeacon(`/api/attempts/${r.attemptId}/event`, new Blob([JSON.stringify({ type: 'page_unload', token: r.token })], { type: 'application/json' }));
  on(window, 'beforeunload', unload);
  on(window, 'pagehide', unload);
  on(document.documentElement, 'mouseleave', () => warn('mouse_left_window'));

  // ---- clipboard, mouse, keyboard ----
  for (const ev of ['copy', 'cut', 'paste', 'drop', 'contextmenu']) on(document, ev, (e) => { e.preventDefault(); warn(`${ev}_blocked`); }, true);
  on(document, 'dragstart', (e) => e.preventDefault(), true);
  on(document, 'wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { capture: true, passive: false }); // no ctrl+wheel zoom
  const EDIT_OK = new Set(['z', 'y', 'a', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'backspace', 'delete', 'home', 'end', 'control', 'shift']);
  on(document, 'keydown', (e) => {
    if (e.getModifierState?.('AltGraph')) return; // AltGr is needed to type @, € etc. on many keyboards
    const k = e.key.toLowerCase();
    if (e.key === 'Escape' || e.key === 'Meta' || e.key === 'OS' || e.key === 'ContextMenu') { e.preventDefault(); return; }
    if (/^F\d{1,2}$/.test(e.key)) { e.preventDefault(); if (['F12', 'F5', 'F11'].includes(e.key)) warn('blocked_key', e.key); return; }
    if (e.altKey || e.metaKey) { e.preventDefault(); if (e.key === 'Tab') warn('blocked_key', 'Alt+Tab'); return; }
    if (e.ctrlKey && !EDIT_OK.has(k)) {
      e.preventDefault();
      if (['c', 'v', 'x', 'p', 's', 'u', 'i', 'j', 't', 'n', 'w', 'r', 'f', 'tab'].includes(k) || e.shiftKey) warn('blocked_key', `Ctrl+${e.shiftKey ? 'Shift+' : ''}${e.key}`);
    }
  }, true);
  on(document, 'keyup', (e) => { if (e.key === 'PrintScreen') { e.preventDefault(); warn('blocked_key', 'PrintScreen'); } }, true);

  // ---- extensions injecting into the page ----
  const seenTags = new Set();
  Q.observer = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (!seenTags.has(tag)) { seenTags.add(tag); warn('page_modified', tag); }
    }
  });
  Q.observer.observe(document.body, { childList: true });
  Q.observer.observe(document.documentElement, { childList: true });

  // ---- window size (dev tools), monitors ----
  let base = null;
  setTimeout(() => { base = { w: innerWidth, h: innerHeight }; }, 1500);
  Q.timers.push(setInterval(() => {
    if (base && (innerWidth < base.w - 80 || innerHeight < base.h - 80)) violation('window_resized', `${innerWidth}x${innerHeight} (was ${base.w}x${base.h})`);
    if (extendedDisplay() === true) violation('extra_monitor');
  }, 1000));

  // ---- webcam: face presence, covered lens, camera off, photos ----
  if (Q.stream) {
    const track = Q.stream.getVideoTracks()[0];
    track.addEventListener('ended', () => violation('camera_off'));
    let noFaceSince = null, darkSince = null, multi = 0;
    Q.timers.push(setInterval(() => {
      if (track.readyState === 'ended') return violation('camera_off');
      const now = Date.now();
      const b = brightness(Q.video);
      if (b != null && b < 18) { darkSince ??= now; if (now - darkSince > 5000) { darkSince = now; warn('camera_blocked', `brightness ${Math.round(b)}`); } }
      else darkSince = null;
      const faces = Q.detector ? countFaces(Q.detector, Q.video) : null;
      const dot = document.getElementById('qcamdot');
      if (dot) dot.className = `camdot ${faces == null ? '' : faces === 1 ? 'ok' : 'bad'}`;
      if (faces == null) return;
      if (faces === 0) { noFaceSince ??= now; if (now - noFaceSince > 5000) { noFaceSince = now; warn('no_face'); } }
      else noFaceSince = null;
      multi = faces >= 2 ? multi + 1 : 0;
      if (multi >= 2) violation('multiple_faces', `${faces} faces`);
    }, 1000));
    // ---- object detection: phone, book, other device, extra person ----
    // An object must be seen in 3 of the last 5 checks (one per second) before it counts, so a single
    // misdetection never costs a warning. After a warning the same kind waits 10 s before it can warn again.
    if (Q.objDetector) {
      const history = {}, lastWarned = {}, logged = new Set();
      setTimeout(() => !Q.ended && Q.timers.push(setInterval(() => {
        if (Q.ended) return;
        const found = detectObjects(Q.objDetector, Q.video);
        if (!found) return;
        for (const o of found.filter((x) => x.event === 'object_seen')) {
          if (!logged.has(o.label)) { logged.add(o.label); qapi('event', { type: 'object_seen', detail: `${o.label} ${o.score}` }).catch(() => {}); }
        }
        const now = Date.now();
        for (const ev of ['phone_detected', 'book_detected', 'device_detected', 'extra_person']) {
          const hits = found.filter((x) => x.event === ev);
          const h = (history[ev] = [...(history[ev] || []), hits.length > 0].slice(-5));
          if (h.filter(Boolean).length < 3 || now - (lastWarned[ev] || 0) < 10_000) continue;
          lastWarned[ev] = now; history[ev] = [];
          const detail = hits.length ? hits.map((x) => `${x.label} ${x.score}`).join(', ') : 'seen in 3 of the last 5 checks';
          if (ev === 'phone_detected' && S.settings.quiz.phoneEndsAttempt) return violation(ev, detail);
          warn(ev, detail);
        }
      }, 1000)), 500); // offset from the face check so both don't run in the same frame
    }

    sendSnapshot('start');
    Q.timers.push(setInterval(() => sendSnapshot('periodic'), r.proctor.snapshotEveryMs));
  }

  // ---- timer + heartbeat ----
  const tick = () => {
    const left = Math.max(0, r.deadline - Date.now());
    const el = document.getElementById('qtimer');
    if (el) { el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`; el.classList.toggle('low', left < 60000); }
    if (left <= 0) submit(true);
  };
  tick();
  Q.timers.push(setInterval(tick, 500));
  Q.timers.push(setInterval(async () => {
    try { const h = await qapi('heartbeat'); if (!h.alive) showEnded(h.status?.end_reason || 'heartbeat_lost'); }
    catch (e) { if (/another tab|ended/.test(e.message)) showEnded('second_session'); }
  }, 4000));

  document.getElementById('qexit').onclick = () => {
    const bar = document.getElementById('qmsg');
    bar.innerHTML = 'Exit and forfeit this attempt? <button class="btn sm danger" id="qyes">Yes, exit</button> <button class="btn sm" id="qno">Keep going</button>';
    document.getElementById('qno').onclick = () => (bar.textContent = '');
    document.getElementById('qyes').onclick = async () => {
      Q.ended = true; cleanupQuiz();
      await qapi('exit').catch(() => {});
      closeQuiz();
    };
  };
  document.getElementById('qsubmit').onclick = () => submit(false);
}

async function submit(auto) {
  if (Q.ended) return;
  const empty = Q.answers.filter((a) => !a.trim()).length;
  const msg = document.getElementById('qmsg');
  if (!auto && empty && !msg.dataset.confirmed) { msg.dataset.confirmed = '1'; msg.textContent = `${empty} answer(s) are empty. Press Submit again to submit anyway.`; return; }
  sendSnapshot('submit');
  Q.ended = true; cleanupQuiz();
  const r = Q.attempt;
  const answers = Q.answers;
  $quiz.innerHTML = '<div class="inner"><div class="card"><h2>Grading your answers…</h2><p class="muted">The AI is reviewing your answers. This can take up to a minute.</p></div></div>';
  try {
    const res = await qapi('submit', { answers });
    stopCamera();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    showResult(res);
  } catch (e) {
    stopCamera();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $quiz.innerHTML = `<div class="inner"><div class="card"><h2>Grading problem</h2><p>${esc(e.message)}</p>
      <div class="row">${/saved/.test(e.message) ? '<button class="btn primary" id="qre">Retry grading</button>' : ''}<button class="btn" id="qclose">Back</button></div></div></div>`;
    document.getElementById('qclose').onclick = closeQuiz;
    const re = document.getElementById('qre');
    if (re) re.onclick = () => act(async () => showResult(await api(`/api/attempts/${r.attemptId}/regrade`, { method: 'POST' })), re);
  }
}

function showResult({ grading, award, plan }) {
  const qs = Q.attempt.questions;
  const pass = S.settings.quiz.passPct;
  $quiz.innerHTML = `<div class="inner"><div class="card">
    <div class="row spread"><div><div class="muted small">This attempt</div><div class="score-big" style="color:var(${grading.pct >= pass ? '--ok' : '--bad'})">${grading.pct}%</div></div>
      <div style="text-align:right"><div class="muted small">Best today</div><div class="score-big">${Math.round(award.bestPct)}%</div></div></div>
    <p>${award.passed ? `Day approved. <b>${award.total} points</b> (base ${award.base} × streak ${award.multiplier} × ${Math.round(award.bestPct)}%).` : `Below ${pass}% — the day is not approved yet.`}
      ${plan.quiz.unlocked ? `You have ${plan.quiz.maxAttempts - plan.quiz.attemptsUsed} attempt(s) left to improve your best score.` : ''}</p>
    ${qs.map((q, i) => `<div class="qa">${q.code ? `<details class="small"><summary>Your code</summary>${codeBlock(q.code, q.codeLang)}</details>` : ''}<div class="q">${esc(q.question)}</div><div class="a">${esc(Q.answers[i] || '(empty)')}</div>
      <div class="small"><b>${fmtScore(grading.results[i]?.score ?? 0)}</b> — ${esc(grading.results[i]?.feedback || '')}</div>
      ${keyPointsHtml(grading.results[i]?.key_points)}</div>`).join('')}
    <details class="small" style="margin-top:10px"><summary>Grading rubric</summary>${rubricHtml()}</details>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="qclose">Back to dashboard</button></div>
  </div></div>`;
  document.getElementById('qclose').onclick = closeQuiz;
}

// ---------------- History / plan detail ----------------
// Supervisor chips for objects the webcam detector flagged during an attempt (see the events table and photos for evidence).
const OBJECT_CHIPS = { phone_detected: 'phone on camera', book_detected: 'book/notes on camera', device_detected: 'other device on camera', extra_person: 'other person on camera' };
const objectChips = (events) => Object.entries(OBJECT_CHIPS)
  .map(([type, label]) => [label, (events || []).filter((e) => e.type === type).length])
  .filter(([, n]) => n).map(([label, n]) => `<span class="chip bad">${label}${n > 1 ? ` ×${n}` : ''}</span>`).join('');

function attemptsHtml(plan, forSupervisor) {
  if (!plan.attempts.length) return '<p class="muted small">No quiz attempts.</p>';
  return plan.attempts.map((a) => `<details class="qa"><summary><b>Attempt ${a.attemptNo}</b> · ${pctChip(a.scorePct)}
      ${a.status !== 'graded' ? `<span class="chip bad">${esc(a.status)}: ${esc(a.endReason || '')}</span>` : ''}
      <span class="small muted">${fmtTime(a.startedAt)}</span>
      ${forSupervisor && a.suspicion ? '<span class="chip warn">AI flagged</span>' : ''}
      ${forSupervisor && a.events?.length ? `<span class="chip">${a.events.length} proctor events</span>` : ''}
      ${forSupervisor && a.strikes ? `<span class="chip warn">${a.strikes} warning(s)</span>` : ''}
      ${forSupervisor && a.snapshots?.some((x) => x.faces != null && x.faces !== 1) ? '<span class="chip bad">face issue on camera</span>' : ''}
      ${forSupervisor ? objectChips(a.events) : ''}</summary>
    ${forSupervisor && a.summary ? `<p class="small"><b>AI summary:</b> ${esc(a.summary)}</p>` : ''}
    ${forSupervisor && a.suspicion ? `<p class="small" style="color:var(--warn)"><b>AI suspicion:</b> ${esc(a.suspicion)}</p>` : ''}
    ${forSupervisor && a.snapshots?.length ? `<div class="snaps">${a.snapshots.map((x) => `<figure class="${x.faces != null && x.faces !== 1 ? 'flag' : ''}"><img src="/api/supervisor/snapshots/${x.id}" loading="lazy" alt="webcam"><figcaption>${new Date(x.at).toLocaleTimeString()} · ${esc(x.reason || '')}${x.faces != null ? ` · ${x.faces} face${x.faces === 1 ? '' : 's'}` : ''}</figcaption></figure>`).join('')}</div>` : ''}
    ${a.questions.map((q) => `<div style="margin:8px 0"><div class="small muted">${esc(q.itemTitle || '')}${q.code ? ' · dry-run of own code' : ''}</div>
      ${q.code ? `<details class="small"><summary>Student's code</summary>${codeBlock(q.code, q.codeLang)}</details>` : ''}<div class="q">${esc(q.question)}</div>
      ${q.answer != null ? `<div class="a">${esc(q.answer || '(empty)')}</div>` : '<div class="small muted">(not answered)</div>'}
      ${q.score != null ? `<div class="small"><b>${fmtScore(q.score)}</b> — ${esc(q.feedback)}</div>${keyPointsHtml(q.keyPoints)}` : ''}</div>`).join('')}
    ${forSupervisor && a.events?.length ? `<table class="small"><tr><th>Proctor event</th><th>Detail</th><th>Time</th></tr>${a.events.map((e) => `<tr><td>${esc(e.type)}</td><td>${esc(e.detail || '')}</td><td>${new Date(e.at).toLocaleTimeString()}</td></tr>`).join('')}</table>` : ''}
  </details>`).join('');
}

function planCard(plan, forSupervisor) {
  return `<div class="card" data-plan="${plan.id}">
    <div class="row spread"><h3>${esc(plan.day)}</h3><div class="row">${statusChip(plan.status)} ${pctChip(plan.bestPct)} <span class="chip accent">${plan.pointsAwarded} pts</span></div></div>
    ${plan.studentNote ? `<p class="small"><b>Student note:</b> ${esc(plan.studentNote)}</p>` : ''}
    ${plan.supervisorNote ? `<p class="small"><b>Supervisor note:</b> ${esc(plan.supervisorNote)}</p>` : ''}
    <ul class="items">${plan.items.map((it) => `<li>
      ${forSupervisor && plan.status === 'proposed' ? `<input type="checkbox" data-rm="${it.id}" title="Remove from plan">` : ''}
      <div class="grow"><div class="title">${esc(it.title)}</div><div class="small muted">${esc(it.step || '')}${it.topic ? ` › ${esc(it.topic)}` : ''} ${diffChip(it.difficulty)}
      ${it.tufPreDone ? '<span class="chip warn">done on TUF before this day</span>' : ''}</div></div>${viaChip(it)}</li>`).join('')}</ul>
    ${plan.award ? `<p class="small muted">Points: base ${plan.award.base} (${plan.award.perItem.map((x) => `${esc(x.title)} ${x.points}`).join(', ')}) × streak ${plan.award.multiplier} × best ${Math.round(plan.award.bestPct)}%</p>` : ''}
    ${forSupervisor && plan.status === 'proposed' ? `<div class="stack" style="margin:10px 0">
      <input type="text" data-note placeholder="Note to student (optional)">
      <div class="row"><button class="btn primary" data-review="approve">Approve${''}</button><button class="btn" data-review="request_changes">Request changes</button>
      <span class="small muted">Tick items to remove them before approving.</span></div></div>` : ''}
    <h3 style="margin-top:12px">Quiz attempts</h3>${attemptsHtml(plan, forSupervisor)}
  </div>`;
}

async function renderHistory() {
  $app.innerHTML = '<p class="muted">Loading…</p>';
  const s = await api(`/api/student/summary?today=${localDay()}`);
  $app.innerHTML = `<div class="card"><h2>History</h2>
    <p class="muted small">Total ${s.totalPoints} points · current streak ${s.streak}</p>
    <table><tr><th>Day</th><th>Status</th><th class="num">Items</th><th class="num">Best</th><th class="num">Streak</th><th class="num">Points</th></tr>
    ${s.history.map((h) => `<tr class="clickable" data-day="${h.day}"><td>${h.day}</td><td>${statusChip(h.status)}</td><td class="num">${h.items}</td>
      <td class="num">${pctChip(h.best_pct)}</td><td class="num">${h.streak ?? '—'}</td><td class="num">${h.points_awarded}</td></tr>`).join('')}</table></div>
    <div id="hdetail" style="margin-top:16px"></div>`;
  $app.querySelectorAll('[data-day]').forEach((tr) => (tr.onclick = () => act(async () => {
    const { plan } = await api(`/api/student/plans/${tr.dataset.day}`);
    document.getElementById('hdetail').innerHTML = plan ? planCard(plan, false) : '';
  })));
}

function renderProfile() {
  const u = S.me;
  $app.innerHTML = `<div class="grid cols-2"><div class="card"><h2>Profile</h2><form id="pf">
    <div class="field"><label>Name</label><input type="text" name="name" value="${esc(u.name)}"></div>
    <div class="field"><label>LeetCode username</label><input type="text" name="leetcodeUsername" value="${esc(u.leetcodeUsername || '')}" placeholder="e.g. neal_wu">
      <div class="small muted">Used to read your recent <i>accepted</i> submissions (public data). Your profile’s recent submissions must be visible.</div></div>
    <div class="field"><label>takeuforward session cookie ${u.tufConnected ? '<span class="chip ok">connected</span>' : '<span class="chip">not connected</span>'}</label>
      <input type="password" name="tufCookie" placeholder="${u.tufConnected ? 'Leave blank to keep the current cookie' : 'Paste the Cookie header value'}">
      <div class="small muted">Optional. takeuforward has no public API, so to read your sheet ticks the server loads the sheet as you.
      In takeuforward (logged in) open DevTools → Network, reload, click the page request and copy the <span class="mono">cookie</span> request header.
      It expires when you log out of TUF. Without it, sheet items that have no LeetCode link are self-marked and checked by the AI quiz.</div>
      ${u.tufConnected ? '<label style="margin-top:6px"><input type="checkbox" name="tufClear"> Disconnect takeuforward</label>' : ''}</div>
    <div class="field"><label>Supervisor invite code</label><input type="text" name="inviteCode" placeholder="${S.supervisor ? 'Enter a new code to switch supervisor' : 'Ask your supervisor for their code'}"></div>
    <div class="field"><button class="btn primary">Save</button></div></form></div>
    <div class="card"><h2>Supervisor</h2>${S.supervisor ? `<p>${esc(S.supervisor.name)}<br><span class="muted small">${esc(S.supervisor.email)}</span></p>` : '<p class="muted">Not linked yet.</p>'}
    <h3>How points work</h3><ul class="small">
      <li>The AI rates each item for toughness and importance (1–5); an item is worth 5 + 3×toughness + 2×importance (10–30 pts; videos/articles half).</li>
      <li>Your streak multiplies the day: +5% per consecutive approved day, up to ×2.</li>
      <li>The day’s points are scaled by your best quiz score; under ${S.settings.quiz.passPct}% earns nothing.</li></ul>
    <h3>How answers are graded</h3>${rubricHtml()}</div></div>`;
  const f = document.getElementById('pf');
  f.onsubmit = (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const body = { name: d.name, leetcodeUsername: d.leetcodeUsername, inviteCode: d.inviteCode };
    if (d.tufCookie) body.tufCookie = d.tufCookie;
    if (d.tufClear) body.tufCookie = '';
    act(async () => { await api('/api/me/profile', { method: 'PUT', body }); toast('Saved'); await boot(); go('profile'); }, f.querySelector('button'));
  };
}

// ======================= SUPERVISOR =======================
async function renderStudents() {
  $app.innerHTML = '<p class="muted">Loading…</p>';
  const { students } = await api(`/api/supervisor/students?today=${localDay()}`);
  const pending = students.reduce((a, s) => a + s.pendingPlans.length, 0);
  $app.innerHTML = `
  <div class="grid cols-3" style="margin-bottom:16px">
    <div class="card stat"><span class="muted small">Your invite code</span><b class="mono">${esc(S.me.inviteCode)}</b><span class="small muted">Students enter this at sign-up or in Profile</span></div>
    <div class="card stat"><span class="muted small">Students</span><b>${students.length}</b></div>
    <div class="card stat"><span class="muted small">Plans waiting for you</span><b style="color:var(${pending ? '--warn' : '--ink'})">${pending}</b></div>
  </div>
  <div class="card"><h2>Students</h2>
    ${students.length ? `<table><tr><th>Student</th><th>Today</th><th class="num">Verified</th><th class="num">Best</th><th class="num">Streak</th><th class="num">Total pts</th><th class="num">Ended attempts</th></tr>
    ${students.map((s) => `<tr class="clickable" data-sid="${s.id}">
      <td><b>${esc(s.name)}</b>${s.pendingPlans.length ? ' <span class="chip warn">needs review</span>' : ''}<div class="small muted">${s.leetcodeUsername ? `LC: ${esc(s.leetcodeUsername)}` : 'no LeetCode'} · ${s.tufConnected ? 'TUF connected' : 'TUF not connected'}</div></td>
      <td>${s.today ? statusChip(s.today.status) : '<span class="muted small">no plan</span>'}</td>
      <td class="num">${s.today ? `${s.today.verified}/${s.today.items}` : '—'}</td>
      <td class="num">${pctChip(s.today?.bestPct)}</td><td class="num">${s.streak}</td><td class="num"><b>${s.totalPoints}</b></td>
      <td class="num">${s.terminatedAttempts ? `<span class="chip bad">${s.terminatedAttempts}</span>` : '0'}</td></tr>`).join('')}</table>`
    : '<p class="muted">No students yet. Share your invite code.</p>'}
  </div>`;
  $app.querySelectorAll('[data-sid]').forEach((tr) => (tr.onclick = () => go('student', tr.dataset.sid)));
}

async function renderStudentDetail(id) {
  $app.innerHTML = '<p class="muted">Loading…</p>';
  const { student, plans } = await api(`/api/supervisor/students/${id}`);
  const total = plans.reduce((a, p) => a + p.pointsAwarded, 0);
  $app.innerHTML = `<p><button class="btn sm" id="back">← All students</button></p>
    <div class="card" style="margin-bottom:16px"><h1>${esc(student.name)}</h1>
      <p class="muted">${esc(student.email)} · LeetCode: ${student.leetcodeUsername ? `<a href="https://leetcode.com/u/${esc(student.leetcodeUsername)}/" target="_blank" rel="noopener">${esc(student.leetcodeUsername)}</a>` : 'not set'} · TUF ${student.tufConnected ? 'connected' : 'not connected'} · ${total} points (last 60 days shown)</p></div>
    <div class="stack">${plans.map((p) => planCard(p, true)).join('') || '<p class="muted">No plans yet.</p>'}</div>`;
  document.getElementById('back').onclick = () => go('students');
  $app.querySelectorAll('[data-review]').forEach((b) => (b.onclick = () => act(async () => {
    const card = b.closest('[data-plan]');
    await api(`/api/supervisor/plans/${card.dataset.plan}/review`, { method: 'POST', body: {
      action: b.dataset.review, note: card.querySelector('[data-note]').value,
      removeItemIds: [...card.querySelectorAll('[data-rm]:checked')].map((c) => c.dataset.rm) } });
    toast(b.dataset.review === 'approve' ? 'Plan approved' : 'Changes requested');
    renderStudentDetail(id);
  }, b)));
}

boot().catch((e) => { $app.innerHTML = `<div class="card"><h2>Could not load</h2><p>${esc(e.message)}</p></div>`; });
