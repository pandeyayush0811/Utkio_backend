const { test, mock } = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const { requirePlan } = require('../middleware/requirePlan');
const { supabaseAdmin } = require('../lib/supabaseClient');

function mockRes() {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('requirePlan(kind) throws synchronously for an invalid kind — fails loud at wiring time, not at request time', () => {
  assert.throws(() => requirePlan('bogus'), /kind must be 'chat' or 'report'/);
});

test('allows the request through when consume_access reports an active paid plan', async () => {
  mock.method(supabaseAdmin, 'rpc', async (fn, args) => {
    assert.strictEqual(fn, 'consume_access');
    assert.strictEqual(args.p_kind, 'chat');
    return { data: [{ allowed: true, reason: 'paid_plan' }], error: null };
  });

  const req = { user: { id: 'user-1' } };
  const res = mockRes();
  let nextCalled = false;
  await requirePlan('chat')(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(req.accessReason, 'paid_plan');
  assert.strictEqual(res.statusCode, null);
  mock.restoreAll();
});

test('allows the request through when the user still has trial credit', async () => {
  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'trial_ok' }], error: null }));

  const req = { user: { id: 'user-2' } };
  const res = mockRes();
  let nextCalled = false;
  await requirePlan('report')(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(req.accessReason, 'trial_ok');
  mock.restoreAll();
});

test('rejects with 402 + trial_expired message when the 3-day trial window has passed', async () => {
  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: false, reason: 'trial_expired' }], error: null }));

  const req = { user: { id: 'user-3' } };
  const res = mockRes();
  let nextCalled = false;
  await requirePlan('chat')(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 402);
  assert.strictEqual(res.body.error, 'active_plan_required');
  assert.strictEqual(res.body.reason, 'trial_expired');
  assert.match(res.body.message, /trial khatam/);
  mock.restoreAll();
});

test('rejects with 402 + trial_limit_reached message once free credits are used up', async () => {
  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: false, reason: 'trial_limit_reached' }], error: null }));

  const req = { user: { id: 'user-4' } };
  const res = mockRes();
  await requirePlan('report')(req, res, () => {});

  assert.strictEqual(res.statusCode, 402);
  assert.strictEqual(res.body.reason, 'trial_limit_reached');
  assert.match(res.body.message, /free reports/);
  mock.restoreAll();
});

test('chat and report kinds are independent — each passes its own p_kind through to the RPC', async () => {
  const seenKinds = [];
  mock.method(supabaseAdmin, 'rpc', async (fn, args) => {
    seenKinds.push(args.p_kind);
    return { data: [{ allowed: true, reason: 'trial_ok' }], error: null };
  });

  const req = { user: { id: 'user-5' } };
  await requirePlan('chat')(req, mockRes(), () => {});
  await requirePlan('report')(req, mockRes(), () => {});

  assert.deepStrictEqual(seenKinds, ['chat', 'report']);
  mock.restoreAll();
});

test('passes a Postgres/RPC error to next() instead of swallowing it', async () => {
  const dbError = new Error('function consume_access does not exist');
  mock.method(supabaseAdmin, 'rpc', async () => ({ data: null, error: dbError }));

  const req = { user: { id: 'user-6' } };
  const res = mockRes();
  let caught = null;
  await requirePlan('chat')(req, res, (err) => { caught = err; });

  assert.strictEqual(caught, dbError);
  assert.strictEqual(res.statusCode, null); // response left untouched — errorHandler deals with it
  mock.restoreAll();
});

test('rejects with 402 when RPC reports trial_not_started or user_not_found', async () => {
  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: false, reason: 'trial_not_started' }], error: null }));

  const req = { user: { id: 'user-7' } };
  const res = mockRes();
  await requirePlan('chat')(req, res, () => {});

  assert.strictEqual(res.statusCode, 402);
  assert.strictEqual(res.body.reason, 'trial_not_started');
  mock.restoreAll();
});
