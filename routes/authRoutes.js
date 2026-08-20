const express = require('express');
const router = express.Router();
const { supabaseAnon, supabaseAdmin } = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/authMiddleware');
const { checkLoginLock, recordFailedLogin, clearFailedLogins } = require('../lib/loginAttemptTracker');
const { normalizeIndianPhone } = require('../lib/phoneUtil');
const { canSendOtp, recordOtpSent, canVerifyOtp, recordFailedVerify, clearOtpState } = require('../lib/otpThrottle');

const OTP_REGEX = /^\d{6}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── WHY EMAIL OTP, NOT PHONE OTP ────────────────────────────────────────
// Phone OTP needs a paid SMS provider (Twilio Verify etc.) wired up before
// a single OTP can go out. Supabase's own email OTP needs zero extra
// signup/billing to get started (free tier is generous) and works today.
// Phone number is still COLLECTED at signup and stored on `profiles` for
// product use (contact, WhatsApp reminders, etc.) — it is just never
// verified via Supabase's phone-auth. auth.users.phone stays untouched;
// don't rely on it anywhere for identity, only profiles.phone.
//
// Migration path later: swap signInWithOtp({email,...}) below for
// signInWithOtp({phone,...}) with type:'sms' once an SMS provider is
// configured — the throttle/lock/route shape here doesn't need to change,
// only the identifier used.

function normalizeEmail(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return EMAIL_REGEX.test(email) ? email : null;
}

// Defense-in-depth: Supabase's own project-level password policy
// (Dashboard -> Auth -> Policies) is the primary enforcement point, but
// its default minimum is only 6 characters and that setting lives
// outside this codebase — nothing here would catch it if it were ever
// left at the weak default. This is a second, independent floor that
// doesn't depend on a dashboard setting being configured correctly.
const MIN_PASSWORD_LENGTH = 8;

function passwordError(password) {
  if (!password || typeof password !== 'string') return 'password is required';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

// Idempotent — makes sure a row exists in `profiles` for this user, and
// fills in phone the first time it becomes known (signup collects it;
// Google login never has one).
async function ensureUserRow(user, extra = {}) {
  if (!supabaseAdmin || !user) return;
  const row = { id: user.id, email: user.email || null };
  if (extra.phone) row.phone = extra.phone;
  const { error } = await supabaseAdmin
    .from('profiles')
    .upsert(row, { onConflict: 'id', ignoreDuplicates: false });
  if (error) console.error('ensureUserRow error:', error.message);
}

// Given whatever the user typed in a single "email or phone" field,
// resolves it to the ACCOUNT'S EMAIL — since Supabase auth (and every
// verification flow here) is keyed on email, not phone. Looks up
// profiles.phone via the admin client when a phone was given.
// Returns null if it can't be resolved (unknown phone, or admin client
// unavailable) — callers must treat that as "credentials invalid",
// never surface *why* (user enumeration).
async function resolveToEmail(identifier) {
  const asEmail = normalizeEmail(identifier);
  if (asEmail) return asEmail;

  const phone = normalizeIndianPhone(identifier);
  if (!phone || !supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('email')
    .eq('phone', phone)
    .maybeSingle();
  if (error) {
    console.error('resolveToEmail: profiles lookup failed:', error.message);
    return null;
  }
  return data?.email || null;
}

// ── Signup, step 1: send OTP to email ───────────────────────────────────
// POST /auth/signup/otp { email, phone }
// Phone is validated and carried through to step 2, but not verified —
// it just needs to look like a real 10-digit Indian mobile number.
// Does NOT create the account yet — Supabase creates the auth.users row
// only once the OTP is actually verified in /signup/verify below, so an
// abandoned/never-verified email leaves no phantom account behind.
router.post('/signup/otp', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.status(400).json({ error: 'Enter a valid email address' });
    const phone = normalizeIndianPhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number' });

    const throttle = canSendOtp(email);
    if (!throttle.allowed) {
      return res.status(429).json({
        error: `Please wait ${throttle.retryAfterSeconds}s before requesting another OTP.`
      });
    }

    const { error } = await supabaseAnon.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true }
    });
    if (error) return res.status(400).json({ error: error.message });

    recordOtpSent(email);
    res.json({ message: 'OTP sent to your email.', email });
  } catch (err) { next(err); }
});

// ── Signup, step 2: verify OTP + set password ───────────────────────────
// POST /auth/signup/verify { email, phone, token, password }
router.post('/signup/verify', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const phone = normalizeIndianPhone(req.body.phone);
    const { token, password } = req.body;
    if (!email) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number' });
    if (!token || !OTP_REGEX.test(token)) return res.status(400).json({ error: 'Enter the 6-digit OTP' });
    const pwError = passwordError(password);
    if (pwError) return res.status(400).json({ error: pwError });

    const verifyLock = canVerifyOtp(email);
    if (!verifyLock.allowed) {
      return res.status(429).json({
        error: `Too many wrong OTP attempts. Try again in ${Math.ceil(verifyLock.retryAfterSeconds / 60)} minute(s).`
      });
    }

    const { data, error } = await supabaseAnon.auth.verifyOtp({ email, token, type: 'email' });
    if (error || !data.user) {
      recordFailedVerify(email);
      return res.status(400).json({ error: error ? error.message : 'OTP verification failed' });
    }

    // verifyOtp succeeded — the account exists but has no password yet
    // (email-OTP accounts start password-less). Set it via the admin API.
    // Needs SUPABASE_SERVICE_ROLE_KEY; without it we cannot safely set a
    // password server-side, so fail loudly rather than leaving the
    // account password-less (which would silently break login below).
    if (!supabaseAdmin) {
      console.error('signup/verify: SUPABASE_SERVICE_ROLE_KEY not set — cannot set password.');
      return res.status(500).json({ error: 'Signup is temporarily unavailable. Please try again later.' });
    }
    const { error: pwSetError } = await supabaseAdmin.auth.admin.updateUserById(data.user.id, { password });
    if (pwSetError) {
      console.error('signup/verify: failed to set password:', pwSetError.message);
      return res.status(500).json({ error: 'Could not complete signup. Please try again.' });
    }

    // Enforce phone uniqueness ourselves (profiles.phone has a unique
    // index, but that only fires at the DB level after we've already
    // created the auth user above — check first so we can give a clean
    // 409 instead of a raw constraint-violation 500).
    const { data: existingPhone } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('phone', phone)
      .neq('id', data.user.id)
      .maybeSingle();
    if (existingPhone) {
      return res.status(409).json({ error: 'This mobile number is already registered with another account.' });
    }

    clearOtpState(email);
    await ensureUserRow(data.user, { phone });

    res.status(201).json({ user: data.user, session: data.session, message: 'Signed up successfully.' });
  } catch (err) { next(err); }
});

// ── Login with EITHER email or phone + password ────────────────────────
// POST /auth/login { identifier, password }
// If `identifier` looks like a phone number, it's resolved to the
// account's email server-side (profiles.phone -> email) since phone is
// never verified in Supabase auth itself — see resolveToEmail() above.
router.post('/login', async (req, res, next) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ error: 'identifier and password are required' });
    }

    // Lock key is the raw normalized identifier (email or phone) as
    // typed — locking on the input itself, before resolution, means a
    // wrong/unregistered phone number still gets throttled the same way
    // a wrong password does, instead of skipping the lock entirely.
    const lockKeyCandidate = normalizeEmail(identifier) || normalizeIndianPhone(identifier) || identifier;
    const lock = checkLoginLock(lockKeyCandidate);
    if (lock.locked) {
      return res.status(429).json({
        error: `Too many failed attempts for this account. Try again in ${Math.ceil(lock.retryAfterSeconds / 60)} minute(s).`
      });
    }

    const email = await resolveToEmail(identifier);
    if (!email) {
      recordFailedLogin(lockKeyCandidate);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
    if (error) {
      recordFailedLogin(lockKeyCandidate);
      // Deliberately generic — do not reveal whether the account exists
      // vs. the password was wrong (user enumeration).
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    clearFailedLogins(lockKeyCandidate);

    await ensureUserRow(data.user);

    res.json({ user: data.user, session: data.session });
  } catch (err) { next(err); }
});

// ── Forgot password, step 1: send OTP to the account's email ───────────
// POST /auth/forgot-password/otp { identifier }
// `identifier` can be email or phone — either way the OTP goes to the
// account's email (phone isn't a verified channel here). Response is
// intentionally identical regardless of whether the identifier matches
// an account, to avoid leaking which emails/phones are registered.
router.post('/forgot-password/otp', async (req, res, next) => {
  try {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ error: 'Enter your email or mobile number' });

    const email = await resolveToEmail(identifier);
    if (email) {
      const throttle = canSendOtp(email);
      if (!throttle.allowed) {
        // Still generic to the client — a real attacker probing this
        // endpoint shouldn't learn "this identifier resolves to a real
        // account" just from getting a 429 instead of a 200.
        return res.json({ message: 'If this account exists, an OTP has been sent to its registered email.' });
      }
      const { error } = await supabaseAnon.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
      if (error) console.warn('forgot-password/otp:', error.message);
      else recordOtpSent(email);
    }

    res.json({ message: 'If this account exists, an OTP has been sent to its registered email.' });
  } catch (err) { next(err); }
});

// ── Forgot password, step 2: verify OTP + set new password ─────────────
// POST /auth/forgot-password/verify { identifier, token, newPassword }
router.post('/forgot-password/verify', async (req, res, next) => {
  try {
    const { identifier, token, newPassword } = req.body;
    if (!identifier) return res.status(400).json({ error: 'Enter your email or mobile number' });
    if (!token || !OTP_REGEX.test(token)) return res.status(400).json({ error: 'Enter the 6-digit OTP' });
    const pwError = passwordError(newPassword);
    if (pwError) return res.status(400).json({ error: pwError });

    const email = await resolveToEmail(identifier);
    if (!email) return res.status(400).json({ error: 'Invalid or expired OTP.' });

    const verifyLock = canVerifyOtp(email);
    if (!verifyLock.allowed) {
      return res.status(429).json({
        error: `Too many wrong OTP attempts. Try again in ${Math.ceil(verifyLock.retryAfterSeconds / 60)} minute(s).`
      });
    }

    const { data, error } = await supabaseAnon.auth.verifyOtp({ email, token, type: 'email' });
    if (error || !data.user) {
      recordFailedVerify(email);
      return res.status(400).json({ error: 'Invalid or expired OTP.' });
    }

    if (!supabaseAdmin) {
      console.error('forgot-password/verify: SUPABASE_SERVICE_ROLE_KEY not set — cannot set password.');
      return res.status(500).json({ error: 'Password reset is temporarily unavailable. Please try again later.' });
    }
    const { error: pwSetError } = await supabaseAdmin.auth.admin.updateUserById(data.user.id, { password: newPassword });
    if (pwSetError) {
      console.error('forgot-password/verify: failed to set password:', pwSetError.message);
      return res.status(500).json({ error: 'Could not reset password. Please try again.' });
    }

    // Revoke every other existing session for this account (other
    // devices, a possibly-compromised session that triggered the reset in
    // the first place) — only the session created just now by this OTP
    // verify survives. Non-fatal if it errors; the password change itself
    // already succeeded.
    const { error: signOutError } = await supabaseAdmin.auth.admin.signOut(data.session.access_token, 'others');
    if (signOutError) console.error('forgot-password/verify: signOut(others) failed (non-fatal):', signOutError.message);

    clearOtpState(email);
    clearFailedLogins(email);

    res.json({ user: data.user, session: data.session, message: 'Password reset successfully.' });
  } catch (err) { next(err); }
});

// Frontend gets a Google idToken from the native Google Sign-In plugin
// (@codetrix-studio/capacitor-google-auth), sends it here, we exchange
// it for a real Supabase session.
router.post('/google', async (req, res, next) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });

    const { data, error } = await supabaseAnon.auth.signInWithIdToken({
      provider: 'google',
      token: idToken
    });
    if (error) return res.status(401).json({ error: error.message });

    await ensureUserRow(data.user);

    res.json({ user: data.user, session: data.session });
  } catch (err) { next(err); }
});

// Actually revokes the session server-side (not just a client-side
// localStorage wipe). requireAuth is now applied so we know exactly
// whose session to revoke — a device can only revoke its OWN session,
// never someone else's. scope: 'global' revokes the refresh token too
// (not just the current access token), so a lost/stolen device can be
// fully signed out remotely, not just locally.
//
// If SUPABASE_SERVICE_ROLE_KEY isn't configured (local dev without it),
// this falls back to the old purely-cosmetic behavior instead of
// hard-failing a route that used to always succeed — the client still
// clears its own local session either way.
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    if (supabaseAdmin) {
      const { error } = await supabaseAdmin.auth.admin.signOut(req.accessToken, 'global');
      // Not fatal if this fails (e.g. token already expired/revoked) —
      // the end state the client cares about (no longer logged in) is
      // the same either way, so log and proceed rather than blocking
      // the user from completing logout.
      if (error) console.error('logout: signOut error (non-fatal):', error.message);
    }
    res.json({ message: 'Logged out.' });
  } catch (err) { next(err); }
});

// Called by the frontend when the access token is close to expiring (or
// already has). Exchanges the long-lived refresh_token for a brand new
// access_token + refresh_token pair — this is what keeps a user logged
// in for weeks/months instead of getting silently logged out every hour
// (Supabase access tokens expire after 1 hour by default).
router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required' });

    const { data, error } = await supabaseAnon.auth.refreshSession({ refresh_token });
    if (error || !data.session) {
      return res.status(401).json({ error: error ? error.message : 'Refresh failed' });
    }

    res.json({ session: data.session });
  } catch (err) { next(err); }
});

module.exports = router;