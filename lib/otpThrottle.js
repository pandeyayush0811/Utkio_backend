// Per-PHONE throttling for OTP send + verify, on top of the existing
// per-IP authLimiter (middleware/rateLimiter.js).
//
// WHY THIS EXISTS, SEPARATE FROM authLimiter:
// 1. SMS COST/ABUSE: every "send OTP" call costs money (SMS provider) and
//    can be used to spam a stranger's phone. authLimiter alone (20 req /
//    15 min / IP) still lets a script send a real person 20 OTP texts in
//    15 minutes just by rotating nothing — same IP is enough. This adds a
//    hard per-phone cooldown independent of who's asking.
// 2. OTP BRUTE-FORCE: a 6-digit OTP has 1,000,000 combinations. Without a
//    per-phone verify-attempt cap, an attacker with a valid session to
//    someone's phone number (or just guessing) could brute-force it well
//    within authLimiter's 20/15min IP budget by using multiple IPs.
//
// Same in-memory caveat as loginAttemptTracker.js / rateLimiter.js: fine
// for a single-instance deploy; swap the Maps for Redis if you scale out.

const SEND_COOLDOWN_MS = 60 * 1000;          // min gap between two sends to the same phone
const SEND_MAX_PER_WINDOW = 5;                // max sends per phone per window
const SEND_WINDOW_MS = 60 * 60 * 1000;        // 1 hour
const VERIFY_MAX_ATTEMPTS = 5;                // wrong-OTP guesses allowed
const VERIFY_LOCK_MS = 15 * 60 * 1000;        // lock this phone's OTP after too many wrong guesses

// phone -> { lastSentAt, sentTimestamps: number[] }
const sendState = new Map();
// phone -> { count, firstFailureAt }
const verifyState = new Map();

function canSendOtp(phone) {
  const entry = sendState.get(phone);
  const now = Date.now();
  if (!entry) return { allowed: true };

  if (now - entry.lastSentAt < SEND_COOLDOWN_MS) {
    return { allowed: false, retryAfterSeconds: Math.ceil((SEND_COOLDOWN_MS - (now - entry.lastSentAt)) / 1000) };
  }

  const recent = entry.sentTimestamps.filter((t) => now - t < SEND_WINDOW_MS);
  if (recent.length >= SEND_MAX_PER_WINDOW) {
    const retryAfterSeconds = Math.ceil((SEND_WINDOW_MS - (now - recent[0])) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true };
}

function recordOtpSent(phone) {
  const now = Date.now();
  const entry = sendState.get(phone) || { lastSentAt: 0, sentTimestamps: [] };
  entry.lastSentAt = now;
  entry.sentTimestamps = entry.sentTimestamps.filter((t) => now - t < SEND_WINDOW_MS);
  entry.sentTimestamps.push(now);
  sendState.set(phone, entry);
}

function canVerifyOtp(phone) {
  const entry = verifyState.get(phone);
  if (!entry) return { allowed: true };

  const elapsed = Date.now() - entry.firstFailureAt;
  if (elapsed > VERIFY_LOCK_MS) {
    verifyState.delete(phone);
    return { allowed: true };
  }
  if (entry.count >= VERIFY_MAX_ATTEMPTS) {
    return { allowed: false, retryAfterSeconds: Math.ceil((VERIFY_LOCK_MS - elapsed) / 1000) };
  }
  return { allowed: true };
}

function recordFailedVerify(phone) {
  const now = Date.now();
  const entry = verifyState.get(phone);
  if (!entry || now - entry.firstFailureAt > VERIFY_LOCK_MS) {
    verifyState.set(phone, { count: 1, firstFailureAt: now });
  } else {
    entry.count += 1;
  }
}

function clearOtpState(phone) {
  sendState.delete(phone);
  verifyState.delete(phone);
}

// Cleanup so the Maps don't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of sendState) {
    if (now - entry.lastSentAt > SEND_WINDOW_MS) sendState.delete(phone);
  }
  for (const [phone, entry] of verifyState) {
    if (now - entry.firstFailureAt > VERIFY_LOCK_MS) verifyState.delete(phone);
  }
}, SEND_WINDOW_MS).unref();

module.exports = { canSendOtp, recordOtpSent, canVerifyOtp, recordFailedVerify, clearOtpState };
