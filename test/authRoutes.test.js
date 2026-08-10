const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const authRoutes = require('../routes/authRoutes');
const { supabaseAnon, supabaseAdmin } = require('../lib/supabaseClient');
const { clearFailedLogins } = require('../lib/loginAttemptTracker');

// Minimal real Express app (rather than hand-rolled req/res mocks) —
// authRoutes.js uses router-level middleware (requireAuth on /logout),
// which is simplest to exercise through actual Express request handling.
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  // Match the real error contract other routes rely on (status/message).
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

async function post(app, path, body, headers = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

test('signup rejects a password shorter than the minimum', async () => {
  const app = buildApp();
  const { status, data } = await post(app, '/auth/signup', { email: 'a@example.com', password: 'short' });
  assert.strictEqual(status, 400);
  assert.match(data.error, /at least 8 characters/);
});

test('signup accepts a valid password and forwards to Supabase', async () => {
  mock.method(supabaseAnon.auth, 'signUp', async ({ email, password }) => {
    assert.strictEqual(email, 'a@example.com');
    assert.strictEqual(password, 'longenoughpassword');
    return { data: { user: { id: 'u1', email }, session: { access_token: 'tok' } }, error: null };
  });
  mock.method(supabaseAdmin, 'from', () => ({
    upsert: async () => ({ error: null })
  }));

  const app = buildApp();
  const { status, data } = await post(app, '/auth/signup', { email: 'a@example.com', password: 'longenoughpassword' });
  assert.strictEqual(status, 201);
  assert.strictEqual(data.user.id, 'u1');
  mock.restoreAll();
});

test('login locks out an account after repeated failures, independent of IP-level rate limiting', async () => {
  const email = 'locktest@example.com';
  clearFailedLogins(email);

  mock.method(supabaseAnon.auth, 'signInWithPassword', async () => ({
    data: { user: null, session: null },
    error: { message: 'Invalid login credentials' }
  }));

  const app = buildApp();

  // First 5 attempts: each fails with Supabase's own message.
  for (let i = 0; i < 5; i++) {
    const { status, data } = await post(app, '/auth/login', { email, password: 'wrong' });
    assert.strictEqual(status, 401);
    assert.strictEqual(data.error, 'Invalid login credentials');
  }

  // 6th attempt: the account-level lock kicks in BEFORE Supabase is even
  // called — even if this were a correct password now, it's rejected.
  const { status, data } = await post(app, '/auth/login', { email, password: 'wrong' });
  assert.strictEqual(status, 429);
  assert.match(data.error, /Too many failed attempts/);

  mock.restoreAll();
  clearFailedLogins(email);
});

test('a successful login clears any accumulated failure count for that account', async () => {
  const email = 'recovers@example.com';
  clearFailedLogins(email);

  let shouldSucceed = false;
  mock.method(supabaseAnon.auth, 'signInWithPassword', async () => {
    if (shouldSucceed) {
      return { data: { user: { id: 'u2', email }, session: { access_token: 'tok' } }, error: null };
    }
    return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } };
  });
  mock.method(supabaseAdmin, 'from', () => ({ upsert: async () => ({ error: null }) }));

  const app = buildApp();

  // A few failures, then the correct password.
  await post(app, '/auth/login', { email, password: 'wrong' });
  await post(app, '/auth/login', { email, password: 'wrong' });

  shouldSucceed = true;
  const ok = await post(app, '/auth/login', { email, password: 'right' });
  assert.strictEqual(ok.status, 200);

  // Failure count should be reset — this account is not still "part way locked".
  const again = await post(app, '/auth/login', { email, password: 'wrong-again' });
  assert.notStrictEqual(again.status, 429);

  mock.restoreAll();
  clearFailedLogins(email);
});

test('logout calls Supabase admin signOut with the caller\'s own token and global scope', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'u3', email: 'x@example.com' } },
    error: null
  }));

  let signOutCalledWith = null;
  mock.method(supabaseAdmin.auth.admin, 'signOut', async (jwt, scope) => {
    signOutCalledWith = { jwt, scope };
    return { error: null };
  });

  const app = buildApp();
  const { status, data } = await post(app, '/auth/logout', {}, { Authorization: 'Bearer my-own-token' });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.message, 'Logged out.');
  assert.deepStrictEqual(signOutCalledWith, { jwt: 'my-own-token', scope: 'global' });

  mock.restoreAll();
});

test('logout without a valid Authorization header is rejected (can only revoke your own session)', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: null },
    error: { message: 'invalid token' }
  }));

  const app = buildApp();
  const { status } = await post(app, '/auth/logout', {});
  assert.strictEqual(status, 401);

  mock.restoreAll();
});

test('logout still succeeds for the client even if Supabase signOut itself errors (non-fatal)', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'u4', email: 'y@example.com' } },
    error: null
  }));
  mock.method(supabaseAdmin.auth.admin, 'signOut', async () => ({ error: { message: 'token already revoked' } }));

  const app = buildApp();
  const { status, data } = await post(app, '/auth/logout', {}, { Authorization: 'Bearer some-token' });
  assert.strictEqual(status, 200);
  assert.strictEqual(data.message, 'Logged out.');

  mock.restoreAll();
});
