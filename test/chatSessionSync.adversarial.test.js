const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const chatRoutes = require('../routes/chatRoutes');
const { supabaseAdmin, supabaseAnon } = require('../lib/supabaseClient');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/chat', chatRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function setupAuthMock(userId) {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: userId, email: `${userId}@example.com` } },
    error: null
  }));
}

async function request(app, method, path, body = null, headers = { Authorization: 'Bearer test-token' }) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUD-024 ADVERSARIAL SUITE: POST /chat/sessions Idempotency & Concurrency
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-024 ADVERSARIAL 1: sequential retry of POST /chat/sessions with same started_at does NOT insert duplicate session or consume extra credit', async () => {
  const userId = 'user-retry-idempotency';
  setupAuthMock(userId);

  let consumeAccessCalls = 0;
  mock.method(supabaseAdmin, 'rpc', async (rpcName) => {
    if (rpcName === 'consume_access') {
      consumeAccessCalls++;
      return { data: [{ allowed: true, reason: 'trial_ok' }], error: null };
    }
    return { data: null, error: null };
  });

  const sessionStore = new Map();
  let insertCount = 0;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      let filterUserId = null;
      let filterStartedAt = null;
      let filterId = null;

      const builder = {
        select: () => builder,
        eq: (col, val) => {
          if (col === 'user_id') filterUserId = val;
          if (col === 'started_at') filterStartedAt = val;
          if (col === 'id') filterId = val;
          return builder;
        },
        maybeSingle: async () => {
          if (filterUserId && filterStartedAt) {
            for (const sess of sessionStore.values()) {
              if (sess.user_id === filterUserId && sess.started_at === filterStartedAt) {
                return { data: { id: sess.id, turn_count: sess.turn_count, ended_at: sess.ended_at }, error: null };
              }
            }
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (filterId && sessionStore.has(filterId)) {
            const sess = sessionStore.get(filterId);
            return { data: { id: sess.id, turn_count: sess.turn_count, ended_at: sess.ended_at }, error: null };
          }
          return { data: null, error: new Error('Not found') };
        },
        insert: (payload) => {
          insertCount++;
          const newId = `session-uuid-${insertCount}`;
          const newRow = { id: newId, ...payload };
          sessionStore.set(newId, newRow);
          return {
            select: () => ({
              single: async () => ({ data: newRow, error: null })
            })
          };
        },
        update: (payload) => {
          if (filterId && sessionStore.has(filterId)) {
            const existing = sessionStore.get(filterId);
            sessionStore.set(filterId, { ...existing, ...payload });
          }
          return {
            eq: (col, val) => {
              if (sessionStore.has(val)) {
                sessionStore.set(val, { ...sessionStore.get(val), ...payload });
              }
              return Promise.resolve({ error: null });
            }
          };
        }
      };
      return builder;
    }
    if (table === 'chat_messages') {
      return {
        upsert: async () => ({ error: null })
      };
    }
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null })
            })
          })
        })
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const app = buildApp();
  const payload = {
    session_id: null,
    started_at: '2026-08-30T08:00:00.000Z',
    ended_at: '2026-08-30T08:02:00.000Z',
    session_type: 'freeform',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' }
    ]
  };

  const res1 = await request(app, 'POST', '/chat/sessions', payload);
  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res1.data.session_id, 'session-uuid-1');
  assert.strictEqual(insertCount, 1);
  assert.strictEqual(consumeAccessCalls, 1);

  const res2 = await request(app, 'POST', '/chat/sessions', payload);
  assert.strictEqual(res2.status, 200);
  assert.strictEqual(res2.data.session_id, 'session-uuid-1', 'Duplicate request must resolve to existing session_id');
  assert.strictEqual(insertCount, 1, 'Duplicate request must NOT insert a second row in chat_sessions');
  assert.strictEqual(consumeAccessCalls, 1, 'Duplicate request must NOT consume a second trial credit');

  mock.restoreAll();
});

test('AUD-024 ADVERSARIAL 2: concurrent duplicate POST /chat/sessions requests resolve to identical session_id and single credit consumption', async () => {
  const userId = 'user-concurrent-idempotency';
  setupAuthMock(userId);

  let consumeAccessCalls = 0;
  mock.method(supabaseAdmin, 'rpc', async (rpcName) => {
    if (rpcName === 'consume_access') {
      consumeAccessCalls++;
      return { data: [{ allowed: true, reason: 'trial_ok' }], error: null };
    }
    return { data: null, error: null };
  });

  const sessionStore = new Map();
  let insertCount = 0;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      let filterUserId = null;
      let filterStartedAt = null;
      let filterId = null;

      const builder = {
        select: () => builder,
        eq: (col, val) => {
          if (col === 'user_id') filterUserId = val;
          if (col === 'started_at') filterStartedAt = val;
          if (col === 'id') filterId = val;
          return builder;
        },
        maybeSingle: async () => {
          if (filterUserId && filterStartedAt) {
            for (const sess of sessionStore.values()) {
              if (sess.user_id === filterUserId && sess.started_at === filterStartedAt) {
                return { data: { id: sess.id, turn_count: sess.turn_count, ended_at: sess.ended_at }, error: null };
              }
            }
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (filterId && sessionStore.has(filterId)) {
            const sess = sessionStore.get(filterId);
            return { data: { id: sess.id, turn_count: sess.turn_count, ended_at: sess.ended_at }, error: null };
          }
          return { data: null, error: new Error('Not found') };
        },
        insert: (payload) => {
          insertCount++;
          const newId = `session-concurrent-${insertCount}`;
          const newRow = { id: newId, ...payload };
          sessionStore.set(newId, newRow);
          return {
            select: () => ({
              single: async () => ({ data: newRow, error: null })
            })
          };
        },
        update: (payload) => {
          if (filterId && sessionStore.has(filterId)) {
            const existing = sessionStore.get(filterId);
            sessionStore.set(filterId, { ...existing, ...payload });
          }
          return {
            eq: (col, val) => {
              if (sessionStore.has(val)) {
                sessionStore.set(val, { ...sessionStore.get(val), ...payload });
              }
              return Promise.resolve({ error: null });
            }
          };
        }
      };
      return builder;
    }
    if (table === 'chat_messages') {
      return {
        upsert: async () => ({ error: null })
      };
    }
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null })
            })
          })
        })
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const app = buildApp();
  const payload = {
    session_id: null,
    started_at: '2026-08-30T08:15:00.000Z',
    ended_at: '2026-08-30T08:18:00.000Z',
    session_type: 'freeform',
    messages: [
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'Turn 2' }
    ]
  };

  const res1 = await request(app, 'POST', '/chat/sessions', payload);
  const res2 = await request(app, 'POST', '/chat/sessions', payload);

  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res2.status, 200);
  assert.strictEqual(res1.data.session_id, 'session-concurrent-1');
  assert.strictEqual(res2.data.session_id, 'session-concurrent-1');
  assert.strictEqual(insertCount, 1);
  assert.strictEqual(consumeAccessCalls, 1);

  mock.restoreAll();
});

test('AUD-024 ADVERSARIAL 3: distinct sessions with different started_at create separate records and consume separate credits', async () => {
  const userId = 'user-distinct-sessions';
  setupAuthMock(userId);

  let consumeAccessCalls = 0;
  mock.method(supabaseAdmin, 'rpc', async (rpcName) => {
    if (rpcName === 'consume_access') {
      consumeAccessCalls++;
      return { data: [{ allowed: true, reason: 'trial_ok' }], error: null };
    }
    return { data: null, error: null };
  });

  const sessionStore = new Map();
  let insertCount = 0;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      let filterUserId = null;
      let filterStartedAt = null;

      const builder = {
        select: () => builder,
        eq: (col, val) => {
          if (col === 'user_id') filterUserId = val;
          if (col === 'started_at') filterStartedAt = val;
          return builder;
        },
        maybeSingle: async () => {
          if (filterUserId && filterStartedAt) {
            for (const sess of sessionStore.values()) {
              if (sess.user_id === filterUserId && sess.started_at === filterStartedAt) {
                return { data: { id: sess.id, turn_count: sess.turn_count, ended_at: sess.ended_at }, error: null };
              }
            }
          }
          return { data: null, error: null };
        },
        insert: (payload) => {
          insertCount++;
          const newId = `session-distinct-${insertCount}`;
          const newRow = { id: newId, ...payload };
          sessionStore.set(newId, newRow);
          return {
            select: () => ({
              single: async () => ({ data: newRow, error: null })
            })
          };
        }
      };
      return builder;
    }
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
    throw new Error(`Unexpected table: ${table}`);
  });

  const app = buildApp();
  const res1 = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-30T08:00:00.000Z',
    ended_at: '2026-08-30T08:02:00.000Z',
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Turn 1' }]
  });

  const res2 = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-30T09:00:00.000Z',
    ended_at: '2026-08-30T09:02:00.000Z',
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Turn 2' }]
  });

  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res2.status, 200);
  assert.notStrictEqual(res1.data.session_id, res2.data.session_id);
  assert.strictEqual(insertCount, 2, 'Distinct timestamps must create 2 distinct session rows');
  assert.strictEqual(consumeAccessCalls, 2, 'Distinct sessions must consume 2 credits');

  mock.restoreAll();
});

test('AUD-024 ADVERSARIAL 4: locked session with existing report rejects delayed/duplicate sync with 409', async () => {
  const userId = 'user-locked-sync';
  setupAuthMock(userId);

  const sessionId = 'sess-locked-snapshot';
  const startedAt = '2026-08-30T08:00:00.000Z';

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: { id: sessionId, turn_count: 4, ended_at: '2026-08-30T08:05:00.000Z' }, error: null }),
        single: async () => ({ data: { id: sessionId, turn_count: 4, ended_at: '2026-08-30T08:05:00.000Z' }, error: null })
      };
      return builder;
    }
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: 'rep-uuid-1' }, error: null })
            })
          })
        })
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: startedAt,
    ended_at: '2026-08-30T08:06:00.000Z',
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Late turn' }]
  });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.error, 'locked');

  mock.restoreAll();
});

test('AUD-024 ADVERSARIAL 5: scenario session duplicate sync resolves cleanly without false positive 409 scenario_already_done_today', async () => {
  const userId = 'user-scenario-sync';
  setupAuthMock(userId);

  let consumeAccessCalls = 0;
  mock.method(supabaseAdmin, 'rpc', async (rpcName) => {
    if (rpcName === 'consume_access') {
      consumeAccessCalls++;
      return { data: [{ allowed: true, reason: 'trial_ok' }], error: null };
    }
    return { data: null, error: null };
  });

  const sessionStore = new Map();
  let insertCount = 0;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      let filterUserId = null;
      let filterStartedAt = null;
      let filterId = null;

      const builder = {
        select: () => builder,
        eq: (col, val) => {
          if (col === 'user_id') filterUserId = val;
          if (col === 'started_at') filterStartedAt = val;
          if (col === 'id') filterId = val;
          return builder;
        },
        gt: () => builder,
        gte: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          if (filterUserId && filterStartedAt) {
            for (const sess of sessionStore.values()) {
              if (sess.user_id === filterUserId && sess.started_at === filterStartedAt) {
                return { data: { id: sess.id, turn_count: sess.turn_count, ended_at: sess.ended_at }, error: null };
              }
            }
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (filterId && sessionStore.has(filterId)) {
            const sess = sessionStore.get(filterId);
            return { data: { id: sess.id, turn_count: sess.turn_count, ended_at: sess.ended_at }, error: null };
          }
          return { data: null, error: new Error('Not found') };
        },
        insert: (payload) => {
          insertCount++;
          const newId = `session-scenario-${insertCount}`;
          const newRow = { id: newId, ...payload };
          sessionStore.set(newId, newRow);
          return {
            select: () => ({
              single: async () => ({ data: newRow, error: null })
            })
          };
        },
        update: (payload) => {
          if (filterId && sessionStore.has(filterId)) {
            const existing = sessionStore.get(filterId);
            sessionStore.set(filterId, { ...existing, ...payload });
          }
          return {
            eq: () => Promise.resolve({ error: null })
          };
        }
      };
      return builder;
    }
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
    throw new Error(`Unexpected table: ${table}`);
  });

  const app = buildApp();
  const payload = {
    session_id: null,
    started_at: '2026-08-30T08:30:00.000Z',
    ended_at: '2026-08-30T08:33:00.000Z',
    session_type: 'scenario',
    scenario_key: 'interview_prep',
    messages: [
      { role: 'assistant', content: 'Tell me about yourself' },
      { role: 'user', content: 'I am a software engineer' }
    ]
  };

  const res1 = await request(app, 'POST', '/chat/sessions', payload);
  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res1.data.session_id, 'session-scenario-1');

  const res2 = await request(app, 'POST', '/chat/sessions', payload);
  assert.strictEqual(res2.status, 200);
  assert.strictEqual(res2.data.session_id, 'session-scenario-1');
  assert.strictEqual(insertCount, 1);
  assert.strictEqual(consumeAccessCalls, 1);

  mock.restoreAll();
});
