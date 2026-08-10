const express = require('express');
const router = express.Router();
const { supabaseAnon, supabaseAdmin } = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/authMiddleware');
const { checkLoginLock, recordFailedLogin, clearFailedLogins } = require('../lib/loginAttemptTracker');

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

// Idempotent — makes sure a row exists in `profiles` for this user.
async function ensureUserRow(user) {
  if (!supabaseAdmin || !user) return;
  const { error } = await supabaseAdmin
    .from('profiles')
    .upsert({ id: user.id, email: user.email }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) console.error('ensureUserRow error:', error.message);
}

router.post('/signup', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    const pwError = passwordError(password);
    if (pwError) return res.status(400).json({ error: pwError });

    const { data, error } = await supabaseAnon.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });

    if (data.user) await ensureUserRow(data.user);

    res.status(201).json({
      user: data.user,
      session: data.session, // null if your Supabase project requires email confirmation
      message: data.session
        ? 'Signed up and logged in.'
        : 'Signup successful — check email to confirm before logging in.'
    });
  } catch (err) { next(err); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const lock = checkLoginLock(email);
    if (lock.locked) {
      return res.status(429).json({
        error: `Too many failed attempts for this account. Try again in ${Math.ceil(lock.retryAfterSeconds / 60)} minute(s).`
      });
    }

    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
    if (error) {
      recordFailedLogin(email);
      return res.status(401).json({ error: error.message });
    }
    clearFailedLogins(email);

    await ensureUserRow(data.user);

    res.json({ user: data.user, session: data.session });
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