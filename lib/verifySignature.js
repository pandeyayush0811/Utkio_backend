const crypto = require('crypto');

// Timing-safe HMAC-SHA256 signature check — used everywhere we verify a
// Razorpay signature (payment /verify, webhook, browser-checkout /verify).
//
// Why not `expectedSignature !== providedSignature`: a plain string
// comparison short-circuits at the first mismatched character, so the
// time it takes to return leaks (in theory) how many leading characters
// of an attacker's guess were correct — a classic timing side-channel.
// crypto.timingSafeEqual() always takes the same amount of time
// regardless of where the mismatch is, closing that channel.
//
// Two things it needs that a naive `===`/`!==` doesn't:
//   1. Both buffers must be the same length, or timingSafeEqual throws
//      instead of returning false — so we check lengths first.
//   2. Inputs must be Buffers, not strings — we hex-decode both sides.
function verifyHmacSignature({ secret, payload, providedSignature }) {
  if (!providedSignature || typeof providedSignature !== 'string') return false;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const expectedBuf = Buffer.from(expectedSignature, 'hex');
  const providedBuf = Buffer.from(providedSignature, 'hex');

  // Different length (e.g. malformed/truncated header, or just a wrong
  // guess) — reject before timingSafeEqual, which would otherwise throw.
  if (expectedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

module.exports = { verifyHmacSignature };
