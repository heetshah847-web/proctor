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
  // Tried in the same call when the main Gemini model is overloaded (e.g. gemini-4-helium). Empty = none.
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL || '',
  // Local model through Ollama (https://ollama.com): runs on this machine, never rate-limited.
  ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen3:8b',
  // Per-call time limit for each provider (ms). A local model on a laptop is slower than a cloud API.
  aiTimeouts: {
    gemini: num('GEMINI_TIMEOUT_MS', 45000),
    claude: num('CLAUDE_TIMEOUT_MS', 60000),
    ollama: num('OLLAMA_TIMEOUT_MS', 180000),
  },
  // 'bank' (default): questions from data/question-bank.txt, AI only grades (1 AI call per attempt).
  // 'ai': the AI writes fresh questions each attempt (2 AI calls per attempt).
  questionSource: process.env.QUESTION_SOURCE === 'ai' ? 'ai' : 'bank',
  quiz: {
    questions: num('QUIZ_QUESTIONS', 3),
    minutes: num('QUIZ_MINUTES', 15),
    maxAttempts: num('QUIZ_MAX_ATTEMPTS', 0),       // attempts per day; 0 = unlimited (testing phase default)
    passPct: num('QUIZ_PASS_PCT', 50),        // below this the day is not approved (0 points)
    heartbeatTimeoutMs: num('QUIZ_HEARTBEAT_TIMEOUT_MS', 12000),
    // Strict proctoring
    requireCamera: process.env.QUIZ_REQUIRE_CAMERA !== 'false',
    // Webcam object detection (phone, book, second device, second person). PHONE_ENDS_ATTEMPT=true makes a phone end the attempt.
    objectDetection: process.env.OBJECT_DETECTION !== 'false',
    phoneEndsAttempt: process.env.PHONE_ENDS_ATTEMPT === 'true',
    // Gaze tracking: a warning when the student keeps looking to the left or right (e.g. reading a second
    // laptop or notes placed out of camera view). Angles are head turn + eye turn, measured from where the
    // student looked during the pre-quiz check. Short glances are fine.
    gazeDetection: process.env.GAZE_DETECTION !== 'false',
    gazeMaxDeg: num('GAZE_MAX_DEG', 30),              // further to the side than this counts as looking away
    gazeAwaySeconds: num('GAZE_AWAY_SECONDS', 4),     // looking away this long without a break = a warning
    gazeBudgetSeconds: num('GAZE_BUDGET_SECONDS', 15), // ...or this long in total within any 60 seconds
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
  // Plans must be approved by the supervisor before the quiz unlocks. Off unless REQUIRE_SUPERVISOR_APPROVAL=true (testing phase).
  requireSupervisorApproval: process.env.REQUIRE_SUPERVISOR_APPROVAL === 'true',
  // Every AI grading is appended here (question, key points, answer, verdict, model) as a dataset for a
  // future fine-tuned grader. Empty = off. Contains student answers: keep it private (it is git-ignored).
  gradingLog: process.env.GRADING_LOG ?? 'data/grading-log.jsonl',
};

// Providers tried in order for every AI call. AI_CHAIN=gemini,ollama overrides; otherwise the main provider
// first, then the local model (skipped instantly when Ollama isn't running). AI_PROVIDER=ollama = local only.
const PROVIDERS = ['gemini', 'claude', 'ollama'];
config.aiChain = [...new Set((process.env.AI_CHAIN || `${config.aiProvider},ollama`)
  .split(',').map((s) => s.trim().toLowerCase()).filter((s) => PROVIDERS.includes(s)))];
if (!config.aiChain.length) config.aiChain = ['ollama'];
