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
// Suite 1: Adversarial GET /chat/scenario/today — 0-Turn Lockout Elimination
// ─────────────────────────────────────────────────────────────────────────────

test('ADVERSARIAL [AUD-022]: GET /chat/scenario/today ignores 0-turn aborted session and returns already_completed_today: false', async () => {
  const userId = 'user-aborted-today';
  setupAuthMock(userId);

  const activeScenarios = [
    { key: 'directions_stranger', category: 'Daily', title: 'Directions', character_brief: 'Stranger', opening_situation: 'Street corner' },
    { key: 'restaurant_order', category: 'Daily', title: 'Order Food', character_brief: 'Waiter', opening_situation: 'Restaurant' }
  ];

  let queriedGtTurnCount = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: activeScenarios, error: null })
          })
        })
      };
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
        maybeSingle: async () => {
          // If the query correctly filters for turn_count > 0, it finds NO completed session
          if (queriedGtTurnCount) {
            return { data: null, error: null };
          }
          // If buggy (no turn_count > 0 filter), it returns the 0-turn session
          return {
            data: {
              id: 'aborted-0-turn-session',
              scenario_key: 'directions_stranger',
              started_at: new Date().toISOString(),
              turn_count: 0
            },
            error: null
          };
        }
      };
      return builder;
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(
    res.data.already_completed_today,
    false,
    'CRITICAL: 0-turn aborted session must NOT mark already_completed_today as true!'
  );
  assert.strictEqual(
    res.data.completed_session_id,
    null,
    'completed_session_id must be null for uncompleted scenario'
  );
  assert.ok(queriedGtTurnCount, 'Database query in scenarioRoutes.js MUST filter for turn_count > 0 (.gt("turn_count", 0))');
  mock.restoreAll();
});

test('ADVERSARIAL [AUD-022]: Anti-repeat ignores today 0-turn aborted session and uses yesterday completed session', async () => {
  const userId = 'user-anti-repeat';
  setupAuthMock(userId);

  const activeScenarios = [
    { key: 'scenario_a', category: 'Work', title: 'Scenario A' },
    { key: 'scenario_b', category: 'Work', title: 'Scenario B' }
  ];

  const now = new Date();
  const yesterdayIst = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: activeScenarios, error: null })
          })
        })
      };
    }
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: (col, val) => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          // Only yesterday's session has turn_count > 0
          data: {
            id: 'session-yesterday',
            scenario_key: 'scenario_a',
            started_at: yesterdayIst.toISOString(),
            turn_count: 6
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
  assert.strictEqual(res.data.already_completed_today, false);
  // Anti-repeat should consider yesterday's 'scenario_a' and avoid it if possible
  assert.ok(res.data.scenario, 'Scenario should be returned');
  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Adversarial POST /chat/sessions — Creation vs Conflict vs Resumption
// ─────────────────────────────────────────────────────────────────────────────

test('ADVERSARIAL [AUD-022]: POST /chat/sessions allows new scenario when existing session today has turn_count === 0', async () => {
  const userId = 'user-retry-scenario';
  setupAuthMock(userId);

  let createdSession = null;
  let queriedGtTurnCount = false;

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'trial_ok' }], error: null }));

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        gt: (col, val) => {
          if (col === 'turn_count' && val === 0) queriedGtTurnCount = true;
          return builder;
        },
        limit: () => builder,
        maybeSingle: async () => {
          // If query checks turn_count > 0, returns null (no completed session today)
          if (queriedGtTurnCount) return { data: null, error: null };
          // If buggy, returns 0-turn session
          return { data: { id: 'aborted-0-turn' }, error: null };
        },
        insert: (payload) => {
          createdSession = { id: 'new-scenario-sess-456', ...payload };
          return {
            select: () => ({
              single: async () => ({ data: createdSession, error: null })
            })
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
    throw new Error(`Unexpected table in test: ${table}`);
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date(Date.now() - 60000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'restaurant_order',
    messages: [
      { role: 'user', content: 'I would like to order a pasta.' },
      { role: 'assistant', content: 'Sure, which pasta would you like?' }
    ]
  });

  assert.strictEqual(
    res.status,
    200,
    'CRITICAL: Starting a new scenario session after a 0-turn abort must return 200, NOT 409 Conflict!'
  );
  assert.strictEqual(res.data.session_id, 'new-scenario-sess-456');
  assert.strictEqual(res.data.turn_count, 2);
  assert.ok(queriedGtTurnCount, 'Database query in chatRoutes.js MUST filter for turn_count > 0 (.gt("turn_count", 0))');
  mock.restoreAll();
});

test('ADVERSARIAL [AUD-022]: POST /chat/sessions rejects new session with 409 if user ALREADY completed a scenario today (turn_count > 0)', async () => {
  const userId = 'user-already-completed';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'trial_ok' }], error: null }));

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        gt: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: { id: 'completed-scenario-today', turn_count: 5 },
          error: null
        })
      };
      return builder;
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date(Date.now() - 30000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'restaurant_order',
    messages: [
      { role: 'user', content: 'Another session attempt' }
    ]
  });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.error, 'scenario_already_done_today');
  assert.strictEqual(res.data.session_id, 'completed-scenario-today');
  mock.restoreAll();
});

test('ADVERSARIAL [AUD-022]: POST /chat/sessions safely RESUMES existing scenario session and appends delta turns without 409', async () => {
  const userId = 'user-resume-scenario';
  setupAuthMock(userId);

  const existingSessionId = 'active-scenario-sess-789';
  let upsertedMessageRows = [];
  let updatedSessionPayload = null;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: (f1, v1) => ({
            eq: (f2, v2) => ({
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
        update: (payload) => {
          updatedSessionPayload = payload;
          return {
            eq: async (col, val) => ({ error: null })
          };
        }
      };
    }
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }) // No report locked yet
            })
          })
        })
      };
    }
    if (table === 'chat_messages') {
      return {
        upsert: async (rows) => {
          upsertedMessageRows = rows;
          return { error: null };
        }
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: existingSessionId,
    started_at: '2026-08-29T10:00:00.000Z',
    ended_at: '2026-08-29T10:03:00.000Z',
    session_type: 'scenario',
    scenario_key: 'job_interview',
    messages: [
      { role: 'user', content: 'Delta turn 3' },
      { role: 'assistant', content: 'Delta turn 4' }
    ]
  });

  assert.strictEqual(res.status, 200, 'Resume mode must return 200 OK');
  assert.strictEqual(res.data.session_id, existingSessionId);
  assert.strictEqual(res.data.turn_count, 4, 'Total turn count must increment from 2 + 2 = 4');

  // Verify startIndex mapping
  assert.strictEqual(upsertedMessageRows.length, 2);
  assert.strictEqual(upsertedMessageRows[0].turn_index, 2, 'First delta turn index must start at existing.turn_count (2)');
  assert.strictEqual(upsertedMessageRows[1].turn_index, 3, 'Second delta turn index must be 3');
  assert.strictEqual(updatedSessionPayload.turn_count, 4);

  mock.restoreAll();
});

test('ADVERSARIAL [AUD-022]: POST /chat/sessions rejects resume with 409 if session report already generated (Snapshotted)', async () => {
  const userId = 'user-locked-sess';
  setupAuthMock(userId);

  const existingSessionId = 'locked-scenario-sess-999';

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
                  turn_count: 8,
                  ended_at: '2026-08-29T10:04:00.000Z'
                },
                error: null
              })
            })
          })
        })
      };
    }
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'report-uuid-1', session_id: existingSessionId },
                error: null
              })
            })
          })
        })
      };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: existingSessionId,
    started_at: '2026-08-29T10:00:00.000Z',
    ended_at: '2026-08-29T10:06:00.000Z',
    session_type: 'scenario',
    scenario_key: 'job_interview',
    messages: [{ role: 'user', content: 'Late message' }]
  });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.error, 'locked');
  mock.restoreAll();
});
