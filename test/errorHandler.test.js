const { test } = require('node:test');
const assert = require('node:assert');

const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');

function mockRes() {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// Silence console.error noise from the handler during these tests —
// it's expected to log, we just don't want it cluttering test output.
function withSilencedConsoleError(fn) {
  const original = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = original; }
}

test('4xx errors: client message passes through unchanged (safe, intentional messages)', () => {
  const err = new Error('CORS: origin not allowed: https://evil.example');
  err.status = 403;
  const res = mockRes();

  withSilencedConsoleError(() => errorHandler(err, {}, res, () => {}));

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error, 'CORS: origin not allowed: https://evil.example');
});

test('5xx errors: internal message is hidden from the client, generic message returned instead', () => {
  const err = new Error('relation "chat_sessions_typo" does not exist — column secret_internal_id');
  err.status = 500;
  const res = mockRes();

  withSilencedConsoleError(() => errorHandler(err, {}, res, () => {}));

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.error, 'Internal server error');
  assert.ok(!res.body.error.includes('chat_sessions_typo'), 'internal DB detail must not leak to client');
});

test('errors with no explicit status default to 500 and get the generic message', () => {
  const err = new Error('ECONNREFUSED 127.0.0.1:5432');
  const res = mockRes();

  withSilencedConsoleError(() => errorHandler(err, {}, res, () => {}));

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.error, 'Internal server error');
});

test('notFoundHandler returns 404 with the requested method+path', () => {
  const req = { method: 'GET', originalUrl: '/does/not/exist' };
  const res = mockRes();

  notFoundHandler(req, res);

  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.error, 'Route not found: GET /does/not/exist');
});
