import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
export const db = new DatabaseSync(process.env.DB_PATH || path.join(ROOT, 'data', 'proctor.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('student','supervisor')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  invite_code TEXT UNIQUE,              -- supervisors share this with students
  supervisor_id INTEGER REFERENCES users(id),
  leetcode_username TEXT,
  tuf_cookie TEXT,                      -- optional; lets the server read the student's TUF sheet progress
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- One plan per student per day.
-- status: draft -> proposed -> approved (or changes_requested -> proposed ...)
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                    -- YYYY-MM-DD in the student's local time
  day_start INTEGER NOT NULL,           -- epoch ms of local midnight (for LeetCode timestamp checks)
  status TEXT NOT NULL DEFAULT 'draft',
  student_note TEXT,
  supervisor_note TEXT,
  ratings_json TEXT,                    -- AI toughness/importance ratings, fixed at first quiz
  best_pct REAL,                        -- best quiz score so far
  points_awarded INTEGER NOT NULL DEFAULT 0,
  streak INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (student_id, day)
);

CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  sheet_item_id TEXT,                   -- Striver sheet id (null for custom LeetCode problems)
  title TEXT NOT NULL,
  step TEXT,
  topic TEXT,
  kind TEXT,
  difficulty TEXT,
  leetcode_slug TEXT,
  verified_via TEXT,                    -- 'leetcode' | 'tuf' | 'self'
  verified_at INTEGER,
  tuf_pre_done INTEGER NOT NULL DEFAULT 0, -- already done on TUF before the plan was proposed
  code TEXT,                            -- the student's own solution, used for dry-run questions
  code_lang TEXT,
  UNIQUE (plan_id, sheet_item_id)
);

-- status: in_progress | graded | terminated | exited
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  questions_json TEXT NOT NULL,         -- includes rubric; rubric is never sent to the browser
  answers_json TEXT,
  grading_json TEXT,
  score_pct REAL,
  end_reason TEXT,
  started_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS proctor_snapshots (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  faces INTEGER,                        -- faces detected in the browser when taken (null if detection unavailable)
  reason TEXT,
  jpeg BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS proctor_events (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
`);

// Migrations for databases created before these columns existed.
for (const col of ['code TEXT', 'code_lang TEXT']) {
  try { db.exec(`ALTER TABLE plan_items ADD COLUMN ${col}`); } catch { /* already exists */ }
}
for (const col of ['token TEXT', 'ip TEXT', 'user_agent TEXT', 'strikes INTEGER NOT NULL DEFAULT 0', 'last_snapshot INTEGER']) {
  try { db.exec(`ALTER TABLE quiz_attempts ADD COLUMN ${col}`); } catch { /* already exists */ }
}

export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
