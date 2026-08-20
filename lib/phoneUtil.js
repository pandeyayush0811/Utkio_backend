// Minimal E.164 phone validation/normalization. Deliberately NOT using a
// heavy library (libphonenumber etc.) since the product is India-only for
// now (see app_intro: "Abhi bss hindi audience ke liye") — if/when the
// audience expands beyond India, swap this for libphonenumber-js rather
// than growing this regex.
//
// Accepts:
//   9876543210        -> +919876543210
//   09876543210       -> +919876543210
//   +919876543210     -> +919876543210 (unchanged)
// Rejects anything else (too short/long, letters, missing digits).

const INDIA_MOBILE_REGEX = /^[6-9]\d{9}$/; // Indian mobile numbers start 6-9, 10 digits total

function normalizeIndianPhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let digits = raw.trim().replace(/[\s-]/g, '');

  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);

  if (!INDIA_MOBILE_REGEX.test(digits)) return null;
  return `+91${digits}`;
}

module.exports = { normalizeIndianPhone };
