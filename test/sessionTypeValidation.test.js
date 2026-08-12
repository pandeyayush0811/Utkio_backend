const { test } = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';

const { validateSessionType } = require('../routes/chatRoutes');

test('defaults to freeform when session_type is omitted', () => {
  const result = validateSessionType(undefined, undefined);
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.resolvedSessionType, 'freeform');
});

test('accepts explicit freeform', () => {
  const result = validateSessionType('freeform', undefined);
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.resolvedSessionType, 'freeform');
});

test('accepts scenario with a scenario_key', () => {
  const result = validateSessionType('scenario', 'directions_stranger');
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.resolvedSessionType, 'scenario');
});

test('rejects scenario without a scenario_key', () => {
  const result = validateSessionType('scenario', undefined);
  assert.match(result.error, /scenario_key is required/);
});

test('rejects scenario with a non-string scenario_key', () => {
  const result = validateSessionType('scenario', 12345);
  assert.match(result.error, /scenario_key is required/);
});

test('rejects an unknown session_type', () => {
  const result = validateSessionType('bogus', undefined);
  assert.match(result.error, /session_type must be one of/);
});
