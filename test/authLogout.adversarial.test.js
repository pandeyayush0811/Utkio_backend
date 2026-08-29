const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const authRoutes = require('../routes/authRoutes');
const { supabaseAnon, supabaseAdmin } = require('../lib/supabaseClient');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

async function request(app, method, path, body = {}, headers = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method !== 'GET' ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKEND ADVERSARIAL SUITE — POST /auth/logout (AUD-004 Verification)
// ═══════════════════════════════════════════════════════════════════════════

test('backend adversarial: valid Bearer token invokes admin.signOut with global scope and returns 200', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async (token) => {
    assert.strictEqual(token, 'valid-token-alpha');
    return { data: { user: { id: 'u-100', email: 'user@example.in' } }, error: null };
  });

  let signOutCall = null;
  mock.method(supabaseAdmin.auth.admin, 'signOut', async (jwt, scope) => {
    signOutCall = { jwt, scope };
    return { error: null };
  });

  const app = buildApp();
  const { status, data } = await request(app, 'POST', '/auth/logout', {}, { Authorization: 'Bearer valid-token-alpha' });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.message, 'Logged out.');
  assert.deepStrictEqual(signOutCall, { jwt: 'valid-token-alpha', scope: 'global' });

  mock.restoreAll();
});

test('backend adversarial: missing Authorization header is rejected with 401', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: null },
    error: { message: 'Missing auth header' }
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'POST', '/auth/logout', {});

  assert.strictEqual(status, 401);
  assert.match(data.error, /authorization/i);

  mock.restoreAll();
});

test('backend adversarial: malformed or empty Bearer token is rejected with 401', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: null },
    error: { message: 'invalid token' }
  }));

  const app = buildApp();

  // Test various malformed headers
  const badHeaders = [
    { Authorization: 'Bearer ' },
    { Authorization: 'Bearer' },
    { Authorization: 'Basic dXNlcjpwYXNz' },
    { Authorization: 'InvalidFormat xyz' }
  ];

  for (const h of badHeaders) {
    const { status } = await request(app, 'POST', '/auth/logout', {}, h);
    assert.strictEqual(status, 401);
  }

  mock.restoreAll();
});

test('backend adversarial: admin.signOut returning an error (e.g. token already expired/revoked) is non-fatal and returns 200', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'u-200', email: 'user2@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin.auth.admin, 'signOut', async () => ({
    error: { message: 'User session not found or already terminated' }
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'POST', '/auth/logout', {}, { Authorization: 'Bearer already-revoked-token' });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.message, 'Logged out.');

  mock.restoreAll();
});

test('backend adversarial: concurrent logout requests with identical token both resolve safely with 200', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'u-300', email: 'user3@example.in' } },
    error: null
  }));

  let signOutCount = 0;
  mock.method(supabaseAdmin.auth.admin, 'signOut', async () => {
    signOutCount++;
    return { error: null };
  });

  const app = buildApp();
  const results = await Promise.all([
    request(app, 'POST', '/auth/logout', {}, { Authorization: 'Bearer concurrent-token' }),
    request(app, 'POST', '/auth/logout', {}, { Authorization: 'Bearer concurrent-token' }),
    request(app, 'POST', '/auth/logout', {}, { Authorization: 'Bearer concurrent-token' })
  ]);

  for (const res of results) {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.message, 'Logged out.');
  }
  assert.strictEqual(signOutCount, 3);

  mock.restoreAll();
});

test('backend adversarial: GET request on /auth/logout is rejected with 404', async () => {
  const app = buildApp();
  const { status } = await request(app, 'GET', '/auth/logout');
  assert.strictEqual(status, 404);
});
