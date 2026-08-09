const express = require('express');
const router = express.Router();
const { supabaseAnon, supabaseAdmin } = require('../lib/supabaseClient');

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

    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });

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

// Token invalidation actually happens client-side (the app deletes its
// stored session). This endpoint exists mainly for a clean client contract
// and a place to hook in server-side revocation later if you ever need it.
router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out.' });
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
