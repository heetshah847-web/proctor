import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency). Real environment variables win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const num = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);

export const config = {
  port: num('PORT', 3000),
  // Secure cookies + HSTS: on by default in production (HTTPS). Set COOKIE_SECURE=false to test production mode over plain http.
  secureCookies: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production',
  // Set TRUST_PROXY=true when running behind a reverse proxy / load balancer, so req.ip is the real client IP.
  trustProxy: process.env.TRUST_PROXY === 'true',
  // 'claude' (default) uses the Anthropic API; 'demo' uses canned questions + heuristic grading for local trials.
  aiMode: process.env.AI_MODE === 'demo' || process.argv.includes('--demo') ? 'demo' : 'claude',
  // 'gemini' or 'claude'. Defaults to gemini when only GEMINI_API_KEY is set.
  aiProvider: (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY ? 'gemini' : 'claude')).toLowerCase(),
  model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-4-hydrogen',
  geminiThinkingLevel: process.env.GEMINI_THINKING_LEVEL ?? 'medium',
  // 'bank' (default): questions from data/question-bank.txt, AI only grades (1 AI call per attempt).
  // 'ai': the AI writes fresh questions each attempt (2 AI calls per attempt).
  questionSource: process.env.QUESTION_SOURCE === 'ai' ? 'ai' : 'bank',
  quiz: {
    questions: num('QUIZ_QUESTIONS', 3),
    minutes: num('QUIZ_MINUTES', 15),
    maxAttempts: num('QUIZ_MAX_ATTEMPTS', 3),
    passPct: num('QUIZ_PASS_PCT', 50),        // below this the day is not approved (0 points)
    heartbeatTimeoutMs: num('QUIZ_HEARTBEAT_TIMEOUT_MS', 12000),
    // Strict proctoring
    requireCamera: process.env.QUIZ_REQUIRE_CAMERA !== 'false',
    maxStrikes: num('QUIZ_MAX_STRIKES', 3),          // warnings (no face, blocked keys, ...) before the attempt ends
    snapshotEveryMs: num('QUIZ_SNAPSHOT_EVERY_MS', 20000),
    // Webcam snapshots are deleted after this many days (0 = keep forever).
    snapshotRetentionDays: num('SNAPSHOT_RETENTION_DAYS', 90),
    maxSnapshotGapMs: num('QUIZ_MAX_SNAPSHOT_GAP_MS', 60000),
    // Dry-run questions on the student's own code (1 extra AI call per attempt when > 0).
    codeQuestions: num('CODE_QUESTIONS', 1),
    // 'practice' = practice problems need the student's code before the quiz unlocks; 'none' = code is optional.
    requireCode: process.env.REQUIRE_CODE === 'none' ? 'none' : 'practice',
  },
  // Plans must be approved by the supervisor before the quiz unlocks.
  requireSupervisorApproval: process.env.REQUIRE_SUPERVISOR_APPROVAL !== 'false',
};
