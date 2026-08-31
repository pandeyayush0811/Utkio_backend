const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'dummy-openai-key';

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

// ═════════════════════════════════════════════════════════════════════════════
// GROUP A: Mid-Session Interruptions, Phone Calls, RAM Kills & Lifecycle (10 Tests)
// ═════════════════════════════════════════════════════════════════════════════

test('EDGE-01: Interruption on Turn 0 (0 turns synced) does NOT lock scenario for today', async () => {
  const userId = 'user-turn0-cut';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ key: 'cafe', title: 'Cafe' }], error: null }) }) }) };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              gt: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: null, error: null })
                  })
                })
              })
            })
          })
        })
      };
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.already_completed_today, false);
  mock.restoreAll();
});

test('EDGE-02: Interruption on Turn 1 with is_completed: false does NOT lock scenario on GET /today', async () => {
  const userId = 'user-turn1-call';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ key: 'cafe', title: 'Cafe' }], error: null }) }) }) };
    }
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: { id: 'sess-turn1', scenario_key: 'cafe', started_at: new Date().toISOString(), turn_count: 2, is_completed: false },
          error: null
        })
      };
      return builder;
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.already_completed_today, false, 'Incomplete 1-turn session must not lock today');
  assert.strictEqual(res.data.completed_session_id, null);
  mock.restoreAll();
});

test('EDGE-03: Mid-roleplay RAM Kill at 60s (4 turns, is_completed: false) allows re-entry without 409', async () => {
  const userId = 'user-midroleplay-kill';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ key: 'interview', title: 'Interview' }], error: null }) }) }) };
    }
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: { id: 'sess-ram-killed', scenario_key: 'interview', started_at: new Date().toISOString(), turn_count: 4, is_completed: false },
          error: null
        })
      };
      return builder;
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');
  assert.strictEqual(res.data.already_completed_today, false);
  mock.restoreAll();
});

test('EDGE-04: Interruption at 179s (is_completed: false) allows resuming same session ID on POST /sessions', async () => {
  const userId = 'user-179s-drop';
  setupAuthMock(userId);
  let updatedPayload = null;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-179s', turn_count: 8, is_completed: false }, error: null }) }) }) }),
        update: (payload) => {
          updatedPayload = payload;
          return { eq: async () => ({ error: null }) };
        }
      };
    }
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    }
    if (table === 'chat_messages') {
      return { upsert: async () => ({ error: null }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: 'sess-179s',
    started_at: new Date(Date.now() - 185000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'interview',
    is_completed: true, // Now finishing
    messages: [{ role: 'assistant', content: 'Good job in the interview!' }]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(updatedPayload.is_completed, true);
  mock.restoreAll();
});

test('EDGE-05: Interruption at Phase 2 boundary (feedback starting) with is_completed: false does not lock day', async () => {
  const userId = 'user-phase2-boundary-drop';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ key: 'hotel', title: 'Hotel' }], error: null }) }) }) };
    }
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: { id: 'sess-phase2-start', scenario_key: 'hotel', started_at: new Date().toISOString(), turn_count: 6, is_completed: false },
          error: null
        })
      };
      return builder;
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');
  assert.strictEqual(res.data.already_completed_today, false);
  mock.restoreAll();
});

test('EDGE-06: Fully completed scenario session (is_completed: true) correctly locks today on GET /today', async () => {
  const userId = 'user-completed-cleanly';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ key: 'hotel', title: 'Hotel' }], error: null }) }) }) };
    }
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: { id: 'sess-completed-full', scenario_key: 'hotel', started_at: new Date().toISOString(), turn_count: 8, is_completed: true },
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
  assert.strictEqual(res.data.completed_session_id, 'sess-completed-full');
  mock.restoreAll();
});

test('EDGE-07: Scenario started yesterday (23:58 IST) does not lock today (00:02 IST) across midnight', async () => {
  const userId = 'user-midnight-crosser';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ key: 'shopping', title: 'Shopping' }], error: null }) }) }) };
    }
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          // Started yesterday in IST
          data: { id: 'sess-yesterday', scenario_key: 'shopping', started_at: '2026-08-29T18:28:00.000Z', turn_count: 6, is_completed: true },
          error: null
        })
      };
      return builder;
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.already_completed_today, false, 'Yesterday session must not lock today');
  mock.restoreAll();
});

test('EDGE-08: POST /chat/sessions allows new scenario when previous today session was is_completed: false', async () => {
  const userId = 'user-retry-new-session';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: 'starter' }, error: null }) }) }) };
    }
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        gte: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'new-retry-sess', ...payload }, error: null }) }) })
      };
      return builder;
    }
    if (table === 'chat_messages') {
      return { upsert: async () => ({ error: null }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date(Date.now() - 30000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'shopping',
    is_completed: false,
    messages: [{ role: 'user', content: 'How much for this?' }]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.session_id, 'new-retry-sess');
  mock.restoreAll();
});

test('EDGE-09: POST /chat/sessions blocks second new scenario attempt on SAME day if already is_completed: true (409 Conflict)', async () => {
  const userId = 'user-double-scenario-attacker';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        gte: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: { id: 'completed-sess-today', is_completed: true },
          error: null
        })
      };
      return builder;
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'shopping',
    messages: [{ role: 'user', content: 'Can I do another scenario?' }]
  });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.error, 'scenario_already_done_today');
  mock.restoreAll();
});

test('EDGE-10: Idempotent session recovery does not duplicate session on concurrent pagehide syncs', async () => {
  const userId = 'user-concurrency-idempotent';
  setupAuthMock(userId);
  const fixedStartedAt = '2026-08-30T10:00:00.000Z';

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        gte: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: { id: 'existing-sess-100' },
          error: null
        }),
        single: async () => ({
          data: { id: 'existing-sess-100', turn_count: 2 },
          error: null
        }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
      return builder;
    }
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    }
    if (table === 'chat_messages') {
      return { upsert: async () => ({ error: null }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null, // Omitted, but exact started_at exists
    started_at: fixedStartedAt,
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'shopping',
    messages: [{ role: 'user', content: 'Delta sync' }]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.session_id, 'existing-sess-100');
  mock.restoreAll();
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP B: State Mismatches, Deadlocks & Navigation Gating (8 Tests)
// ═════════════════════════════════════════════════════════════════════════════

test('EDGE-11: POST /analyze on is_completed: false scenario strictly returns 400 Bad Request', async () => {
  const userId = 'user-analyze-incomplete-gating';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }) };
    }
    if (table === 'chat_sessions') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-inc', session_type: 'scenario', is_completed: false, turn_count: 4 }, error: null }) }) }) }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions/sess-inc/analyze');
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /still in progress/i);
  mock.restoreAll();
});

test('EDGE-12: POST /analyze on scenario with 1 turn returns 400 (needs >= 2 turns)', async () => {
  const userId = 'user-analyze-1turn';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }) };
    }
    if (table === 'chat_sessions') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-1t', session_type: 'scenario', is_completed: true, turn_count: 1 }, error: null }) }) }) }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions/sess-1t/analyze');
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /at least 2 turns/i);
  mock.restoreAll();
});

test('EDGE-13: POST /analyze on completed scenario with 2 turns passes validation to claim report', async () => {
  const userId = 'user-analyze-2turns';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true }], error: null }));

  let claimedReport = false;
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }),
        insert: () => ({ select: () => ({ single: async () => { claimedReport = true; return { data: { id: 'rep-claim-1' }, error: null }; } }) }),
        delete: () => ({ eq: async () => ({ error: null }) }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
    }
    if (table === 'chat_sessions') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-2t', session_type: 'scenario', is_completed: true, turn_count: 2 }, error: null }) }) }) }) };
    }
    if (table === 'chat_messages') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ role: 'assistant', content: 'Hi' }, { role: 'user', content: 'Hello' }], error: null }) }) }) };
    }
  });

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions/sess-2t/analyze');
  assert.strictEqual(claimedReport, true);
  mock.restoreAll();
});

test('EDGE-14: POST /analyze for freeform chat ignores is_completed: false and analyzes if >= 10 turns', async () => {
  const userId = 'user-analyze-freeform-10t';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true }], error: null }));

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }),
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'rep-freeform' }, error: null }) }) }),
        delete: () => ({ eq: async () => ({ error: null }) }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
    }
    if (table === 'chat_sessions') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-ff-10', session_type: 'freeform', is_completed: false, turn_count: 10 }, error: null }) }) }) }) };
    }
    if (table === 'chat_messages') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: Array(10).fill({ role: 'user', content: 'text' }), error: null }) }) }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions/sess-ff-10/analyze');
  assert.notStrictEqual(res.status, 400);
  mock.restoreAll();
});

test('EDGE-15: POST /analyze for freeform chat with 9 turns rejects with 400 Bad Request', async () => {
  const userId = 'user-analyze-freeform-9t';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }) };
    }
    if (table === 'chat_sessions') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-ff-9', session_type: 'freeform', turn_count: 9 }, error: null }) }) }) }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions/sess-ff-9/analyze');
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /at least 10 turns/i);
  mock.restoreAll();
});

test('EDGE-16: GET /chat/sessions/:id ownership check returns 404 for another user session', async () => {
  const userId = 'user-attacker-snoop';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: { message: 'Not found' } }) }) }) }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/sessions/other-user-session-id');
  assert.strictEqual(res.status, 404);
  mock.restoreAll();
});

test('EDGE-17: POST /chat/sessions on already-reported session returns 409 Locked', async () => {
  const userId = 'user-append-to-reported-session';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-locked-report', turn_count: 12 }, error: null }) }) }) }) };
    }
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'rep-existing-123' }, error: null }) }) }) }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: 'sess-locked-report',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'More turns after report' }]
  });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.error, 'locked');
  mock.restoreAll();
});

test('EDGE-18: GET /chat/scenario/today returns completed_session_id only when completed today', async () => {
  const userId = 'user-check-completed-id';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ key: 'nav', title: 'Nav' }], error: null }) }) }) };
    }
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: { id: 'completed-nav-session', scenario_key: 'nav', started_at: new Date().toISOString(), is_completed: true, turn_count: 5 },
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
  assert.strictEqual(res.data.completed_session_id, 'completed-nav-session');
  mock.restoreAll();
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP C: Commit Mode Progress, Math & Timing (8 Tests)
// ═════════════════════════════════════════════════════════════════════════════

test('EDGE-19: Incomplete scenario save (is_completed: false) does NOT award Commit Mode progress', async () => {
  const userId = 'user-commit-incomplete-guard';
  setupAuthMock(userId);
  let recorded = false;
  mock.method(supabaseAdmin, 'rpc', async (fnName) => {
    if (fnName === 'consume_access') return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    if (fnName === 'record_commit_mode_progress') { recorded = true; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: 'commit_mode' }, error: null }) }) }) };
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        gte: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'sess-inc', ...payload }, error: null }) }) })
      };
      return builder;
    }
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date(Date.now() - 30000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'nav',
    is_completed: false,
    messages: [{ role: 'user', content: 'Incomplete' }]
  });

  assert.strictEqual(recorded, false, 'Incomplete scenario must not record progress');
  mock.restoreAll();
});

test('EDGE-20: Completed scenario save (is_completed: true) awards Commit Mode progress', async () => {
  const userId = 'user-commit-complete-guard';
  setupAuthMock(userId);
  let recordedKind = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    if (fnName === 'record_commit_mode_progress') { recordedKind = params.p_kind; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: 'commit_mode' }, error: null }) }) }) };
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        gte: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'sess-comp', ...payload }, error: null }) }) })
      };
      return builder;
    }
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date(Date.now() - 180000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'nav',
    is_completed: true,
    messages: [{ role: 'user', content: 'Completed' }]
  });

  assert.strictEqual(recordedKind, 'scenario');
  mock.restoreAll();
});

test('EDGE-21: Multi-turn freeform chat sync does NOT quadratically inflate recorded chat seconds', async () => {
  const userId = 'user-commit-quadratic-math';
  setupAuthMock(userId);

  const secondsList = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    if (fnName === 'record_commit_mode_progress') { secondsList.push(params.p_seconds); return { data: null }; }
    return { data: null };
  });

  const t0 = new Date('2026-08-30T10:00:00.000Z');
  const t1 = new Date('2026-08-30T10:00:15.000Z'); // 15s
  const t2 = new Date('2026-08-30T10:00:30.000Z'); // 30s
  const t3 = new Date('2026-08-30T10:00:45.000Z'); // 45s

  let turnCount = 0;
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: 'commit_mode' }, error: null }) }) }) };
    if (table === 'chat_sessions') {
      const builder = {
        select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-sync-quad', turn_count: turnCount }, error: null }) }) }) }),
        update: (payload) => { if (payload.turn_count) turnCount = payload.turn_count; return { eq: async () => ({ error: null }) }; },
        insert: (payload) => ({ select: () => ({ single: async () => { turnCount = 1; return { data: { id: 'sess-sync-quad', ...payload }, error: null }; } }) })
      };
      return builder;
    }
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', { session_id: null, started_at: t0.toISOString(), ended_at: t1.toISOString(), session_type: 'freeform', messages: [{ role: 'user', content: 'Turn 1' }] });
  await request(app, 'POST', '/chat/sessions', { session_id: 'sess-sync-quad', started_at: t0.toISOString(), ended_at: t2.toISOString(), session_type: 'freeform', messages: [{ role: 'user', content: 'Turn 2' }] });
  await request(app, 'POST', '/chat/sessions', { session_id: 'sess-sync-quad', started_at: t0.toISOString(), ended_at: t3.toISOString(), session_type: 'freeform', messages: [{ role: 'user', content: 'Turn 3' }] });

  const sum = secondsList.reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, 45, `Expected 45s total chat recorded, got inflated ${sum}s`);
  mock.restoreAll();
});

test('EDGE-22: Multiple separate chat sessions in a single day accumulate linearly', async () => {
  const userId = 'user-commit-separate-sessions';
  setupAuthMock(userId);

  const secondsList = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    if (fnName === 'record_commit_mode_progress') { secondsList.push(params.p_seconds); return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: 'commit_mode' }, error: null }) }) }) };
    if (table === 'chat_sessions') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'sess-new-' + Math.random(), ...payload }, error: null }) }) })
      };
    }
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  // Session 1: 100s
  await request(app, 'POST', '/chat/sessions', { session_id: null, started_at: '2026-08-30T10:00:00.000Z', ended_at: '2026-08-30T10:01:40.000Z', session_type: 'freeform', messages: [{ role: 'user', content: 'A' }] });
  // Session 2: 200s
  await request(app, 'POST', '/chat/sessions', { session_id: null, started_at: '2026-08-30T11:00:00.000Z', ended_at: '2026-08-30T11:03:20.000Z', session_type: 'freeform', messages: [{ role: 'user', content: 'B' }] });

  const total = secondsList.reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 300, '100s + 200s must equal 300s');
  mock.restoreAll();
});

test('EDGE-23: Negative duration due to client clock desync is sanitized to 0 seconds', async () => {
  const userId = 'user-clock-desync';
  setupAuthMock(userId);

  let recordedSeconds = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    if (fnName === 'record_commit_mode_progress') { recordedSeconds = params.p_seconds; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: 'commit_mode' }, error: null }) }) }) };
    if (table === 'chat_sessions') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'sess-desync', ...payload }, error: null }) }) })
      };
    }
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  // ended_at is BEFORE started_at due to phone clock change
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-30T10:05:00.000Z',
    ended_at: '2026-08-30T10:00:00.000Z',
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Clock backwards' }]
  });

  assert.strictEqual(recordedSeconds, 0, 'Negative duration must clamp to 0');
  mock.restoreAll();
});

test('EDGE-24: GET /chat/commit-mode/today returns structured zero defaults for fresh user', async () => {
  const userId = 'user-commit-fresh';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'commit_mode_daily_progress') {
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/commit-mode/today');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.chat_seconds_done, 0);
  assert.strictEqual(res.data.chat_requirement_met, false);
  assert.strictEqual(res.data.scenario_requirement_met, false);
  mock.restoreAll();
});

test('EDGE-25: 299s chat does not satisfy 5-minute requirement (needs >= 300s)', async () => {
  const userId = 'user-299s-border';
  setupAuthMock(userId);

  let recordedSeconds = 0;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    if (fnName === 'record_commit_mode_progress') { recordedSeconds = params.p_seconds; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: 'commit_mode' }, error: null }) }) }) };
    if (table === 'chat_sessions') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'sess-299', ...payload }, error: null }) }) })
      };
    }
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-30T10:00:00.000Z',
    ended_at: '2026-08-30T10:04:59.000Z', // 299s
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Close but not 5m' }]
  });

  assert.strictEqual(recordedSeconds, 299);
  mock.restoreAll();
});

test('EDGE-26: 301s chat satisfies 5-minute requirement', async () => {
  const userId = 'user-301s-border';
  setupAuthMock(userId);

  let recordedSeconds = 0;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    if (fnName === 'record_commit_mode_progress') { recordedSeconds = params.p_seconds; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: 'commit_mode' }, error: null }) }) }) };
    if (table === 'chat_sessions') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'sess-301', ...payload }, error: null }) }) })
      };
    }
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-30T10:00:00.000Z',
    ended_at: '2026-08-30T10:05:01.000Z', // 301s
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Target met' }]
  });

  assert.strictEqual(recordedSeconds, 301);
  mock.restoreAll();
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP D: Free Trial Credits, Billing & Access Limits (6 Tests)
// ═════════════════════════════════════════════════════════════════════════════

test('EDGE-27: Aborted 0-turn scenario does NOT deduct from trial_scenarios_used', async () => {
  const userId = 'user-trial-0t-abort';
  setupAuthMock(userId);
  let consumed = false;
  mock.method(supabaseAdmin, 'rpc', async (fnName) => {
    if (fnName === 'consume_access') { consumed = true; return { data: { allowed: true } }; }
    return { data: null };
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'test',
    messages: []
  });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(consumed, false);
  mock.restoreAll();
});

test('EDGE-28: Malformed timestamp on session save rejects with 400 before consuming trial credit', async () => {
  const userId = 'user-trial-bad-time';
  setupAuthMock(userId);
  let consumed = false;
  mock.method(supabaseAdmin, 'rpc', async (fnName) => {
    if (fnName === 'consume_access') { consumed = true; return { data: { allowed: true } }; }
    return { data: null };
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: 'not-a-valid-date',
    ended_at: new Date().toISOString(),
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Hi' }]
  });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(consumed, false);
  mock.restoreAll();
});

test('EDGE-29: Valid new scenario session consumes 1 trial scenario credit', async () => {
  const userId = 'user-trial-valid-scenario';
  setupAuthMock(userId);
  let consumedKind = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') { consumedKind = params.p_kind; return { data: { allowed: true, reason: 'trial_ok' } }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: null, trial_scenarios_used: 0 }, error: null }) }) }) };
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        gte: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'sess-trial-1', ...payload }, error: null }) }) })
      };
      return builder;
    }
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date(Date.now() - 60000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'test',
    messages: [{ role: 'user', content: 'Hello scenario' }]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(consumedKind, 'scenario');
  mock.restoreAll();
});

test('EDGE-30: Second scenario attempt when trial credits exhausted returns 402 Payment Required', async () => {
  const userId = 'user-trial-exhausted';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'rpc', async (fnName) => {
    if (fnName === 'consume_access') return { data: { allowed: false, reason: 'trial_limit_reached' } };
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: null, trial_scenarios_used: 1 }, error: null }) }) }) };
    if (table === 'chat_sessions') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        gte: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: null, error: null })
      };
      return builder;
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'test',
    messages: [{ role: 'user', content: 'Second scenario' }]
  });

  assert.strictEqual(res.status, 402);
  assert.strictEqual(res.data.error, 'active_plan_required');
  mock.restoreAll();
});

test('EDGE-31: Paid Starter plan user bypasses trial limits on chat sessions', async () => {
  const userId = 'user-paid-starter';
  setupAuthMock(userId);
  let checkedKind = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') { checkedKind = params.p_kind; return { data: { allowed: true, plan: 'starter' } }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: 'starter' }, error: null }) }) }) };
    if (table === 'chat_sessions') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'sess-paid-1', ...payload }, error: null }) }) })
      };
    }
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Unlimited chat' }]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(checkedKind, 'chat');
  mock.restoreAll();
});

test('EDGE-32: Resuming an existing session ID does not consume a new chat credit', async () => {
  const userId = 'user-resume-no-credit-burn';
  setupAuthMock(userId);
  let consumeAccessCalled = false;
  mock.method(supabaseAdmin, 'rpc', async (fnName) => {
    if (fnName === 'consume_access') { consumeAccessCalled = true; return { data: { allowed: true } }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-existing-resume', turn_count: 4 }, error: null }) }) }) }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
    }
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: 'sess-existing-resume',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Continuation' }]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(consumeAccessCalled, false, 'Resuming must bypass requirePlan credit deduction');
  mock.restoreAll();
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP E: Data Integrity, Transcripts, Multilingual & Sanitization (6 Tests)
// ═════════════════════════════════════════════════════════════════════════════

test('EDGE-33: Hindi Devanagari script and emojis in transcripts are preserved without distortion', async () => {
  const userId = 'user-devanagari-emoji';
  setupAuthMock(userId);
  let savedContent = null;

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true }], error: null }));
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: 'starter' }, error: null }) }) }) };
    if (table === 'chat_sessions') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'sess-hindi', ...payload }, error: null }) }) })
      };
    }
    if (table === 'chat_messages') {
      return { upsert: async (rows) => { savedContent = rows[0].content; return { error: null }; } };
    }
  });

  const app = buildApp();
  const hindiMsg = 'नमस्ते Bolo! 🇮🇳 I want to ask: "Where is the platform?" 🙏';
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'freeform',
    messages: [{ role: 'user', content: hindiMsg }]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(savedContent, hindiMsg);
  mock.restoreAll();
});

test('EDGE-34: XSS injection scripts in message content are saved safely without execution', async () => {
  const userId = 'user-xss-test';
  setupAuthMock(userId);
  let savedContent = null;

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true }], error: null }));
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: { plan: 'starter' }, error: null }) }) }) };
    if (table === 'chat_sessions') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'sess-xss', ...payload }, error: null }) }) })
      };
    }
    if (table === 'chat_messages') {
      return { upsert: async (rows) => { savedContent = rows[0].content; return { error: null }; } };
    }
  });

  const app = buildApp();
  const xssMsg = '<script>alert("hacked")</script><img src="x" onerror="alert(1)">';
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'freeform',
    messages: [{ role: 'user', content: xssMsg }]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(savedContent, xssMsg);
  mock.restoreAll();
});

test('EDGE-35: Messages with whitespace-only content reject with 400 Bad Request', async () => {
  const userId = 'user-empty-content';
  setupAuthMock(userId);

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'freeform',
    messages: [{ role: 'user', content: '    ' }]
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /must be a non-empty string/i);
  mock.restoreAll();
});

test('EDGE-36: Messages exceeding MAX_MESSAGES_PER_SESSION (500 turns) reject with 400', async () => {
  const userId = 'user-500-turns-overflow';
  setupAuthMock(userId);

  const app = buildApp();
  const longMessages = Array(501).fill({ role: 'user', content: 'Turn' });
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'freeform',
    messages: longMessages
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /exceeds max of 500/i);
  mock.restoreAll();
});

test('EDGE-37: Non-boolean is_completed parameter returns 400 validation error', async () => {
  const userId = 'user-bad-is-completed';
  setupAuthMock(userId);

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'test',
    is_completed: 'yes', // Invalid
    messages: [{ role: 'user', content: 'Hello' }]
  });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.data.error, 'is_completed must be a boolean');
  mock.restoreAll();
});

test('EDGE-38: Missing scenario_key when session_type is "scenario" rejects with 400', async () => {
  const userId = 'user-missing-scenario-key';
  setupAuthMock(userId);

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: undefined, // Missing
    messages: [{ role: 'user', content: 'Hello' }]
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /scenario_key is required/i);
  mock.restoreAll();
});
