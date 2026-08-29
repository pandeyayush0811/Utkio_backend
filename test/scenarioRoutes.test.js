const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const scenarioRoutes = require('../routes/scenarioRoutes');
const { supabaseAnon, supabaseAdmin } = require('../lib/supabaseClient');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/chat/scenario', scenarioRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function setupAuthMock(userId = 'user-scenario-1') {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: userId, email: `${userId}@example.com` } },
    error: null
  }));
}

async function get(app, path, headers = { Authorization: 'Bearer test-token' }) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

test('scenarioRoutes: GET /today returns 503 if no active scenarios exist', async () => {
  setupAuthMock('user-scenario-1');
  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'scenario_configs');
    return {
      select: () => ({
        eq: () => ({
          order: async () => ({ data: [], error: null })
        })
      })
    };
  });

  const app = buildApp();
  const res = await get(app, '/chat/scenario/today');
  assert.strictEqual(res.status, 503);
  assert.match(res.data.error, /No scenarios are configured/);
  mock.restoreAll();
});

test('scenarioRoutes: GET /today returns already_completed_today: false when user has no prior sessions', async () => {
  setupAuthMock('user-scenario-2');
  const activeScenarios = [
    { key: 'restaurant_order', category: 'Daily', title: 'Ordering Food', character_brief: 'Waiter', opening_situation: 'At restaurant' }
  ];

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
        gt: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: null, error: null })
      };
      return builder;
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const app = buildApp();
  const res = await get(app, '/chat/scenario/today');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.already_completed_today, false);
  assert.strictEqual(res.data.completed_session_id, null);
  assert.strictEqual(res.data.scenario.key, 'restaurant_order');
  mock.restoreAll();
});

test('scenarioRoutes: GET /today returns already_completed_today: true when user completed a session today with turns > 0', async () => {
  setupAuthMock('user-scenario-3');
  const activeScenarios = [
    { key: 'job_interview', category: 'Workplace', title: 'Job Interview', character_brief: 'HR', opening_situation: 'Interview room' }
  ];

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
        gt: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: {
            id: 'session-done-today',
            scenario_key: 'job_interview',
            started_at: new Date().toISOString()
          },
          error: null
        })
      };
      return builder;
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const app = buildApp();
  const res = await get(app, '/chat/scenario/today');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.already_completed_today, true);
  assert.strictEqual(res.data.completed_session_id, 'session-done-today');
  mock.restoreAll();
});
