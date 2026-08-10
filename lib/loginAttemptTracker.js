// Per-ACCOUNT failed-login throttling, on top of the existing per-IP
// authLimiter (middleware/rateLimiter.js).
//
// WHY THIS EXISTS: authLimiter caps requests per IP (20 / 15 min). An
// attacker who rotates IPs (cheap at scale — residential proxies,
// botnets) faces no throttling at all on repeatedly guessing passwords
// for ONE specific target email, since each guess can come from a
// different IP. This tracker closes that gap by keying on the email
// being attempted, regardless of which IP it comes from.
//
// Deliberately does NOT touch the account's actual Supabase auth state
// — this is a temporary, self-expiring soft-lock in front of Supabase,
// not an account-lockout flag in the database. A correct password
// during the lock window still gets rejected (fails closed) until the
// window naturally elapses; there's no separate "unlock" action needed
// and no permanent state to clean up.
//
// In-memory by default — same caveat as rateLimiter.js: with 2+ server
// instances behind a load balancer, each instance tracks independently,
// so effective attempts-before-lock becomes (limit × instance count).
// Fine for the documented single-instance deployment target; if you
// scale to multiple instances, mirror rateLimiter.js's REDIS_URL
// pattern here too (swap the Map below for Redis INCR + EXPIRE).

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// email (lowercased) -> { count: number, firstFailureAt: number }
const failuresByEmail = new Map();

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Periodic cleanup so this Map doesn't grow unbounded from one-off
// typos/attempts that never come back. Cheap — runs off the hot path.
setInterval(() => {
  const now = Date.now();
  for (const [email, entry] of failuresByEmail) {
    if (now - entry.firstFailureAt > LOCK_WINDOW_MS) failuresByEmail.delete(email);
  }
}, LOCK_WINDOW_MS).unref();

/**
 * @returns {{ locked: boolean, retryAfterSeconds?: number }}
 */
function checkLoginLock(email) {
  const key = normalizeEmail(email);
  if (!key) return { locked: false };

  const entry = failuresByEmail.get(key);
  if (!entry) return { locked: false };

  const elapsed = Date.now() - entry.firstFailureAt;
  if (elapsed > LOCK_WINDOW_MS) {
    failuresByEmail.delete(key);
    return { locked: false };
  }

  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    return { locked: true, retryAfterSeconds: Math.ceil((LOCK_WINDOW_MS - elapsed) / 1000) };
  }
  return { locked: false };
}

function recordFailedLogin(email) {
  const key = normalizeEmail(email);
  if (!key) return;

  const now = Date.now();
  const entry = failuresByEmail.get(key);
  if (!entry || now - entry.firstFailureAt > LOCK_WINDOW_MS) {
    failuresByEmail.set(key, { count: 1, firstFailureAt: now });
  } else {
    entry.count += 1;
  }
}

function clearFailedLogins(email) {
  const key = normalizeEmail(email);
  if (key) failuresByEmail.delete(key);
}

module.exports = { checkLoginLock, recordFailedLogin, clearFailedLogins, MAX_FAILED_ATTEMPTS, LOCK_WINDOW_MS };
