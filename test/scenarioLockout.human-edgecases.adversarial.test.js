const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const scenarioRoutes = require('../routes/scenarioRoutes');
const chatRoutes = require('../routes/chatRoutes');
const { supabaseAdmin, supabaseAnon } = require('../lib/supabaseClient');
const { startOfIstDay } = require('../lib/scenarioSelector');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/chat/scenario', scenarioRoutes);
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
// Suite 1: Idempotent Retries & Duplicate Turn Defense
// ─────────────────────────────────────────────────────────────────────────────

test('ADVERSARIAL HUMAN [AUD-022]: Duplicate turn sync during network retry handles upsert idempotently without crashing', async () => {
  const userId = 'user-retry-storm';
  setupAuthMock(userId);
  const existingSessionId = 'sess-retry-123';

  let upsertOptions = null;
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: existingSessionId,
                  user_id: userId,
                  turn_count: 2,
                  ended_at: '2026-08-29T10:01:00.000Z'
                },
                error: null
              })
            })
          })
        }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
    }
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    }
    if (table === 'chat_messages') {
      return {
        upsert: async (rows, options) => {
          upsertOptions = options;
          return { error: null };
        }
      };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: existingSessionId,
    started_at: '2026-08-29T10:00:00.000Z',
    ended_at: '2026-08-29T10:02:00.000Z',
    session_type: 'scenario',
    scenario_key: 'job_interview',
    messages: [
      { role: 'user', content: 'Turn 3 delta' }
    ]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.turn_count, 3);
  assert.deepStrictEqual(upsertOptions, { onConflict: 'session_id,turn_index', ignoreDuplicates: true });
  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Security & Cross-Account Session Tampering
// ─────────────────────────────────────────────────────────────────────────────

test('ADVERSARIAL HUMAN [AUD-022]: Malicious user attempting to resume another user scenario session gets 404', async () => {
  const attackerUserId = 'user-attacker-007';
  const victimSessionId = 'sess-victim-999';
  setupAuthMock(attackerUserId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: (f1, v1) => ({
            eq: (f2, v2) => ({
              single: async () => {
                // Session exists, but user_id is victim's, so Supabase eq('user_id', attackerUserId) returns no rows
                return { data: null, error: new Error('Row not found') };
              }
            })
          })
        })
      };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: victimSessionId,
    started_at: '2026-08-29T10:00:00.000Z',
    ended_at: '2026-08-29T10:02:00.000Z',
    session_type: 'scenario',
    scenario_key: 'job_interview',
    messages: [{ role: 'user', content: 'Hijack attempt' }]
  });

  assert.strictEqual(res.status, 404);
  assert.match(res.data.error, /Session to resume was not found/);
  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Unicode, Heavy Transcripts & Multilingual Input Handling
// ─────────────────────────────────────────────────────────────────────────────

test('ADVERSARIAL HUMAN [AUD-022]: Extremely long transcripts with Hindi, emojis and special quotes save cleanly', async () => {
  const userId = 'user-heavy-transcript';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'trial_ok' }], error: null }));

  let insertedRows = [];
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        gt: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (payload) => ({
          select: () => ({
            single: async () => ({ data: { id: 'heavy-sess-1', ...payload }, error: null })
          })
        })
      };
      return builder;
    }
    if (table === 'chat_messages') {
      return {
        upsert: async (rows) => {
          insertedRows = rows;
          return { error: null };
        }
      };
    }
  });

  const heavyText = 'नमस्ते Bolo! I want to order paneer butter masala with extra naan. 🙏🚀 "Quickly please!" -- test <script>';
  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date(Date.now() - 30000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'restaurant_order',
    messages: [
      { role: 'user', content: heavyText }
    ]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(insertedRows.length, 1);
  assert.strictEqual(insertedRows[0].content, heavyText);
  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: Aborted 0-Turn Session Followed By Valid Practice Session
// ─────────────────────────────────────────────────────────────────────────────

test('ADVERSARIAL HUMAN [AUD-022]: 0-turn abort at 9:00 AM + completed session at 9:05 AM correctly resolves to completed session', async () => {
  const userId = 'user-abort-then-complete';
  setupAuthMock(userId);

  const activeScenarios = [
    { key: 'interview_prep', category: 'Workplace', title: 'Interview Prep' }
  ];

  let queriedGtTurnCount = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: activeScenarios, error: null }) }) }) };
    }
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: (col, val) => {
          if (col === 'turn_count' && val === 0) queriedGtTurnCount = true;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          // Returns the completed session that had 4 turns
          data: {
            id: 'completed-905-session',
            scenario_key: 'interview_prep',
            started_at: new Date().toISOString(),
            turn_count: 4
          },
          error: null
        })
      };
      return builder;
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.already_completed_today, true);
  assert.strictEqual(res.data.completed_session_id, 'completed-905-session');
  assert.ok(queriedGtTurnCount, 'Must filter turn_count > 0 so completed session is evaluated');
  mock.restoreAll();
});
