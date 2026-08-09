const { test, mock } = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';

const { requireAuth } = require('../middleware/authMiddleware');
const { supabaseAnon } = require('../lib/supabaseClient');

function mockRes() {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('rejects a request with no Authorization header', async () => {
  const req = { headers: {} };
  const res = mockRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(nextCalled, false);
});

test('rejects a malformed Authorization header (missing "Bearer ")', async () => {
  const req = { headers: { authorization: 'sometoken' } };
  const res = mockRes();
  await requireAuth(req, res, () => {});
  assert.strictEqual(res.statusCode, 401);
});

test('rejects when Supabase says the token is invalid', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({ data: { user: null }, error: { message: 'invalid token' } }));
  const req = { headers: { authorization: 'Bearer bad-token' } };
  const res = mockRes();
  await requireAuth(req, res, () => {});
  assert.strictEqual(res.statusCode, 401);
  mock.restoreAll();
});

test('calls next() and attaches req.user when the token is valid', async () => {
  const fakeUser = { id: 'user-123', email: 'test@example.com' };
  mock.method(supabaseAnon.auth, 'getUser', async () => ({ data: { user: fakeUser }, error: null }));

  const req = { headers: { authorization: 'Bearer good-token' } };
  const res = mockRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.deepStrictEqual(req.user, fakeUser);
  assert.strictEqual(req.accessToken, 'good-token');
  mock.restoreAll();
});
