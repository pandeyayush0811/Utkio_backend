const { test } = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';

const { validateMessages } = require('../routes/chatRoutes');

test('accepts a valid messages array', () => {
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' }
  ];
  assert.strictEqual(validateMessages(messages), null);
});

test('rejects an empty array', () => {
  assert.match(validateMessages([]), /non-empty array/);
});

test('rejects a non-array', () => {
  assert.match(validateMessages('not an array'), /non-empty array/);
});

test('rejects an invalid role', () => {
  const messages = [{ role: 'system', content: 'oops' }];
  assert.match(validateMessages(messages), /role must be/);
});

test('rejects empty content', () => {
  const messages = [{ role: 'user', content: '   ' }];
  assert.match(validateMessages(messages), /non-empty string/);
});

test('rejects non-string content', () => {
  const messages = [{ role: 'user', content: 12345 }];
  assert.match(validateMessages(messages), /non-empty string/);
});

test('rejects more than the max allowed messages', () => {
  const messages = Array.from({ length: 501 }, (_, i) => ({ role: 'user', content: 'msg ' + i }));
  assert.match(validateMessages(messages), /exceeds max/);
});

test('accepts exactly the max allowed messages', () => {
  const messages = Array.from({ length: 500 }, (_, i) => ({ role: 'user', content: 'msg ' + i }));
  assert.strictEqual(validateMessages(messages), null);
});
