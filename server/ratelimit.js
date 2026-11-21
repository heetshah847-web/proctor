// Small in-memory fixed-window rate limiter. Fine for a single server process;
// if you run several instances, move the counters to a shared store (e.g. Redis) or a WAF rule.

/**
 * @param {object} o
 * @param {string} o.name    label used in the key
 * @param {number} o.max     requests allowed per window
 * @param {number} o.windowMs window length
 * @param {(req) => string|string[]} o.key  what to count per (IP, user id, email ...). Each key is limited separately.
 */
export function rateLimit({ name, max, windowMs, key }) {
  const hits = new Map(); // key -> { count, reset }
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset <= t) hits.delete(k); }, windowMs).unref();

  return (req, res, next) => {
    const t = Date.now();
    for (const k of [].concat(key(req)).filter(Boolean)) {
      const id = `${name}:${k}`;
      let h = hits.get(id);
      if (!h || h.reset <= t) hits.set(id, (h = { count: 0, reset: t + windowMs }));
      if (++h.count > max) {
        res.set('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
        return res.status(429).json({ error: 'Too many requests — please wait a bit and try again.' });
      }
    }
    next();
  };
}

const MIN = 60_000;
const ip = (req) => `ip:${req.ip}`;
const user = (req) => (req.user ? `u:${req.user.id}` : ip(req));

// Password guessing: per IP and per target email.
export const loginLimit = rateLimit({
  name: 'login', max: 10, windowMs: 15 * MIN,
  key: (req) => [ip(req), `email:${String(req.body?.email || '').trim().toLowerCase().slice(0, 200)}`],
});
export const signupLimit = rateLimit({ name: 'signup', max: 5, windowMs: 60 * MIN, key: ip });
// Paid AI calls and calls to LeetCode / takeuforward.
export const aiLimit = rateLimit({ name: 'ai', max: 10, windowMs: 60 * MIN, key: user });
export const externalLimit = rateLimit({ name: 'ext', max: 30, windowMs: 10 * MIN, key: user });
// Everything else under /api: generous, just stops floods.
export const apiLimit = rateLimit({ name: 'api', max: 600, windowMs: MIN, key: user });
