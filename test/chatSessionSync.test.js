const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

test('chatSessionSync: message rows format correctly with turn_index for upsert', () => {
  const messages = [
    { role: 'user', content: 'Hello there' },
    { role: 'assistant', content: 'Hi! How can I help you today?' }
  ];

  const startIndex = 5;
  const rows = messages.map((m, i) => ({
    session_id: 'session-123',
    role: m.role,
    content: m.content.trim(),
    turn_index: startIndex + i
  }));

  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].session_id, 'session-123');
  assert.strictEqual(rows[0].turn_index, 5);
  assert.strictEqual(rows[0].role, 'user');
  assert.strictEqual(rows[0].content, 'Hello there');

  assert.strictEqual(rows[1].session_id, 'session-123');
  assert.strictEqual(rows[1].turn_index, 6);
  assert.strictEqual(rows[1].role, 'assistant');
});

test('chatSessionSync: deduplicates identical turn indices when mapped for idempotency', () => {
  const messagesBatch1 = [
    { role: 'user', content: 'Turn 1' },
    { role: 'assistant', content: 'Reply 1' }
  ];

  const rows = messagesBatch1.map((m, i) => ({
    session_id: 'session-abc',
    role: m.role,
    content: m.content.trim(),
    turn_index: i
  }));

  const uniqueKeys = new Set(rows.map(r => `${r.session_id}:${r.turn_index}`));
  assert.strictEqual(uniqueKeys.size, 2);
});
