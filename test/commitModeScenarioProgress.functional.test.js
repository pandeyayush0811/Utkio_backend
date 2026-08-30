const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const { supabaseAnon, supabaseAdmin } = require('../lib/supabaseClient');
const chatRoutes = require('../routes/chatRoutes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/chat', chatRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

async function request(app, method, path, body = null, headers = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNCTIONAL SANITY TEST — AUD-020 (Issue 1): Commit Mode Scenario Progress
// Role: 10_FunctionalSanityTester
// Plain everyday scenario: A normal user on Commit Mode completes their daily
// scenario simulation. Does the app record their scenario requirement as completed?
// ═══════════════════════════════════════════════════════════════════════════

test('FUNCTIONAL SANITY: Normal user on Commit Mode completes a daily scenario — checks if scenario progress is recorded', async () => {
  const rpcCalls = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    rpcCalls.push({ fnName, params });
    if (fnName === 'consume_access') {
      return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    }
    if (fnName === 'record_commit_mode_progress') {
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-commit-mode-01', email: 'learner@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 86400000).toISOString() },
              error: null
            })
          })
        })
      };
    }
    if (table === 'chat_sessions') {
      const builder = {
        select: (cols) => {
          if (cols === 'id') {
            // Check for today's existing session
            return builder;
          }
          return {
            single: async () => ({
              data: { id: 'session-scenario-101', user_id: 'user-commit-mode-01', session_type: 'scenario', turn_count: 4 },
              error: null
            })
          };
        },
        eq: () => builder,
        gt: () => builder,
        gte: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (row) => ({
          select: () => ({
            single: async () => ({
              data: { id: 'session-scenario-101', user_id: 'user-commit-mode-01', ...row },
              error: null
            })
          })
        })
      };
      return builder;
    }
    if (table === 'chat_messages') {
      return {
        upsert: async () => ({ error: null }),
        insert: async () => ({ error: null })
      };
    }
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
            single: async () => ({ data: {}, error: null })
          })
        })
      })
    };
  });

  const app = buildApp();

  // Plain everyday action: User finishes daily scenario simulation and client sends session save
  const { status, data } = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-30T02:40:00.000Z',
    ended_at: '2026-08-30T02:43:00.000Z',
    session_type: 'scenario',
    scenario_key: 'restaurant_order',
    messages: [
      { role: 'assistant', content: 'Welcome to the bistro! What can I get for you today?' },
      { role: 'user', content: 'Hi, I would like to order a cappuccino and a croissant please.' },
      { role: 'assistant', content: 'Sure, would you like that hot or iced?' },
      { role: 'user', content: 'Hot cappuccino please, with oat milk if possible.' }
    ]
  }, {
    Authorization: 'Bearer valid-commit-token'
  });

  assert.strictEqual(status, 200, 'Session save request should return HTTP 200');
  assert.strictEqual(data.session_id, 'session-scenario-101');

  // Verify whether record_commit_mode_progress was called for kind: 'scenario'
  const scenarioProgressCall = rpcCalls.find(call => 
    call.fnName === 'record_commit_mode_progress' && call.params.p_kind === 'scenario'
  );

  const didRecordScenarioProgress = !!scenarioProgressCall;
  console.log(`[OBSERVED ACTUAL BEHAVIOR] record_commit_mode_progress called for scenario: ${didRecordScenarioProgress}`);

  // We assert that scenario progress was recorded:
  assert.strictEqual(
    didRecordScenarioProgress,
    true,
    'CRITICAL BUG OBSERVED: POST /chat/sessions succeeded with HTTP 200, but NEVER recorded Commit Mode progress for the scenario session. As a result, scenario_requirement_met stays false!'
  );

  mock.restoreAll();
});

test('FUNCTIONAL SANITY: Comparison check — freeform chat session DOES record chat progress', async () => {
  const rpcCalls = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    rpcCalls.push({ fnName, params });
    if (fnName === 'consume_access') {
      return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    }
    if (fnName === 'record_commit_mode_progress') {
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-commit-mode-02', email: 'learner2@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 86400000).toISOString() },
              error: null
            })
          })
        })
      };
    }
    if (table === 'chat_sessions') {
      return {
        insert: (row) => ({
          select: () => ({
            single: async () => ({
              data: { id: 'session-chat-202', user_id: 'user-commit-mode-02', ...row },
              error: null
            })
          })
        })
      };
    }
    if (table === 'chat_messages') {
      return {
        upsert: async () => ({ error: null }),
        insert: async () => ({ error: null })
      };
    }
    return { select: () => ({ eq: () => ({ single: async () => ({ data: {}, error: null }) }) }) };
  });

  const app = buildApp();

  const { status } = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-30T02:30:00.000Z',
    ended_at: '2026-08-30T02:36:00.000Z',
    session_type: 'freeform',
    messages: [
      { role: 'assistant', content: 'Namaste! Aaj kis topic par baat karein?' },
      { role: 'user', content: 'Let us talk about my upcoming job interview.' }
    ]
  }, {
    Authorization: 'Bearer valid-commit-token'
  });

  assert.strictEqual(status, 200);

  const chatProgressCall = rpcCalls.find(call => 
    call.fnName === 'record_commit_mode_progress' && call.params.p_kind === 'chat'
  );

  assert.ok(chatProgressCall, 'Freeform chat session correctly calls record_commit_mode_progress for kind=chat');
  assert.strictEqual(chatProgressCall.params.p_seconds, 360);

  mock.restoreAll();
});

test('FUNCTIONAL SANITY: Resumed / reconnect scenario session in Commit Mode — checks if scenario progress is recorded', async () => {
  const rpcCalls = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    rpcCalls.push({ fnName, params });
    if (fnName === 'record_commit_mode_progress') {
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-commit-mode-03', email: 'learner3@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'session-resumed-303',
                  user_id: 'user-commit-mode-03',
                  started_at: '2026-08-30T02:40:00.000Z',
                  ended_at: '2026-08-30T02:41:00.000Z',
                  turn_count: 2,
                  session_type: 'scenario',
                  scenario_key: 'job_interview'
                },
                error: null
              })
            })
          })
        }),
        update: () => ({
          eq: async () => ({ error: null })
        })
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
    if (table === 'chat_messages') {
      return {
        upsert: async () => ({ error: null })
      };
    }
    return { select: () => ({ eq: () => ({ single: async () => ({ data: {}, error: null }) }) }) };
  });

  const app = buildApp();

  const { status } = await request(app, 'POST', '/chat/sessions', {
    session_id: 'session-resumed-303',
    started_at: '2026-08-30T02:41:30.000Z',
    ended_at: '2026-08-30T02:44:30.000Z',
    session_type: 'scenario',
    scenario_key: 'job_interview',
    messages: [
      { role: 'user', content: 'I have experience in leading small engineering teams.' },
      { role: 'assistant', content: 'That sounds impressive. How do you resolve conflicts?' }
    ]
  }, {
    Authorization: 'Bearer valid-commit-token'
  });

  assert.strictEqual(status, 200);

  const scenarioProgressCall = rpcCalls.find(call => 
    call.fnName === 'record_commit_mode_progress' && call.params.p_kind === 'scenario'
  );

  const didRecordScenarioProgress = !!scenarioProgressCall;
  console.log(`[OBSERVED ACTUAL BEHAVIOR] Resumed scenario: record_commit_mode_progress called: ${didRecordScenarioProgress}`);

  assert.strictEqual(
    didRecordScenarioProgress,
    true,
    'CRITICAL BUG OBSERVED: Resumed scenario session did not record scenario progress!'
  );

  mock.restoreAll();
});
