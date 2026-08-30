const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const { supabaseAnon, supabaseAdmin } = require('../lib/supabaseClient');
const chatRoutes = require('../routes/chatRoutes');
const { istDateString } = require('../lib/commitMode');
const { runCommitModeMidnightSweep } = require('../lib/commitModeEnforcer');

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

function createSupabaseQueryMock(handlers = {}) {
  const defaultHandler = () => Promise.resolve({ data: null, error: null });
  const builder = {
    select: () => builder,
    eq: () => builder,
    gt: () => builder,
    gte: () => builder,
    lt: () => builder,
    lte: () => builder,
    is: () => builder,
    order: () => builder,
    limit: () => builder,
    single: handlers.single || defaultHandler,
    maybeSingle: handlers.maybeSingle || defaultHandler,
    insert: (row) => ({
      select: () => ({
        single: handlers.insertSingle ? () => handlers.insertSingle(row) : () => Promise.resolve({ data: { id: 'mock-id', ...row }, error: null }),
        maybeSingle: handlers.insertMaybeSingle ? () => handlers.insertMaybeSingle(row) : () => Promise.resolve({ data: { id: 'mock-id', ...row }, error: null })
      }),
      then: (resolve) => resolve({ data: row, error: null })
    }),
    update: (fields) => ({
      eq: () => ({
        eq: handlers.updateEqEq ? (col, val) => handlers.updateEqEq(fields, col, val) : () => Promise.resolve({ error: null }),
        is: handlers.updateEqIs ? () => handlers.updateEqIs(fields) : () => Promise.resolve({ error: null }),
        then: (resolve) => resolve({ error: null })
      }),
      then: (resolve) => resolve({ error: null })
    }),
    upsert: handlers.upsert || (() => Promise.resolve({ error: null })),
    delete: () => ({
      eq: handlers.deleteEq || (() => Promise.resolve({ error: null }))
    })
  };
  return builder;
}

// ═══════════════════════════════════════════════════════════════════════════
// ADVERSARIAL TEST SUITE — AUD-020 (Issue #1): Commit Mode Scenario Progress
// Role: 06_TestWriter (Senior Frontend/Backend Adversarial QA)
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: Route-Level New & Resumed Scenario Sessions (AUD-020 Core Fix)
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-020 ADVERSARIAL: POST /chat/sessions for brand new scenario session records kind=scenario with 0 seconds and correct IST date', async () => {
  // Why this matters: Verifies that saving a completed scenario immediately triggers record_commit_mode_progress RPC with kind=scenario, preventing premature midnight sweep lockout.
  let rpcCalls = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    rpcCalls.push({ fnName, params });
    if (fnName === 'consume_access') return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    if (fnName === 'record_commit_mode_progress') return { data: null, error: null };
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-adv-scen-01', email: 'scen01@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') {
      return createSupabaseQueryMock({
        single: () => Promise.resolve({ data: { plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 86400000).toISOString() }, error: null })
      });
    }
    if (table === 'chat_sessions') {
      return createSupabaseQueryMock({
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insertSingle: (row) => Promise.resolve({ data: { id: 'session-new-scen-01', user_id: 'user-adv-scen-01', ...row }, error: null })
      });
    }
    if (table === 'chat_messages') {
      return createSupabaseQueryMock({
        upsert: () => Promise.resolve({ error: null })
      });
    }
    return createSupabaseQueryMock();
  });

  const app = buildApp();
  const startedAt = '2026-08-30T10:00:00.000Z';
  const endedAt = '2026-08-30T10:03:30.000Z';

  const { status, data } = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: startedAt,
    ended_at: endedAt,
    session_type: 'scenario',
    scenario_key: 'restaurant_order',
    messages: [
      { role: 'assistant', content: 'Welcome to our restaurant. Table for one?' },
      { role: 'user', content: 'Table for two please, near the window.' },
      { role: 'assistant', content: 'Right away. Here is the menu.' },
      { role: 'user', content: 'Thank you! What is the special today?' }
    ]
  }, {
    Authorization: 'Bearer valid-commit-mode-jwt'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.session_id, 'session-new-scen-01');

  const progressCall = rpcCalls.find(call => call.fnName === 'record_commit_mode_progress');
  assert.ok(progressCall, 'record_commit_mode_progress MUST be called');
  assert.strictEqual(progressCall.params.p_kind, 'scenario');
  assert.strictEqual(progressCall.params.p_seconds, 0);
  assert.strictEqual(progressCall.params.p_user_id, 'user-adv-scen-01');
  assert.strictEqual(progressCall.params.p_ist_date, istDateString(new Date(endedAt)));

  mock.restoreAll();
});

test('AUD-020 ADVERSARIAL: POST /chat/sessions for resumed scenario session records kind=scenario with 0 seconds', async () => {
  // Why this matters: If a learner disconnects mid-scenario, reconnects, and finishes the session, the resume handler MUST record scenario progress.
  let rpcCalls = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    rpcCalls.push({ fnName, params });
    if (fnName === 'record_commit_mode_progress') return { data: null, error: null };
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-adv-scen-02', email: 'scen02@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return createSupabaseQueryMock({
        single: () => Promise.resolve({
          data: {
            id: 'session-resumed-scen-02',
            user_id: 'user-adv-scen-02',
            started_at: '2026-08-30T10:00:00.000Z',
            ended_at: '2026-08-30T10:01:00.000Z',
            turn_count: 2,
            session_type: 'scenario',
            scenario_key: 'job_interview'
          },
          error: null
        })
      });
    }
    if (table === 'session_reports') {
      return createSupabaseQueryMock({
        maybeSingle: () => Promise.resolve({ data: null, error: null })
      });
    }
    if (table === 'chat_messages') {
      return createSupabaseQueryMock({
        upsert: () => Promise.resolve({ error: null })
      });
    }
    return createSupabaseQueryMock();
  });

  const app = buildApp();
  const resumedStartedAt = '2026-08-30T10:01:30.000Z';
  const resumedEndedAt = '2026-08-30T10:04:30.000Z';

  const { status, data } = await request(app, 'POST', '/chat/sessions', {
    session_id: 'session-resumed-scen-02',
    started_at: resumedStartedAt,
    ended_at: resumedEndedAt,
    session_type: 'scenario',
    scenario_key: 'job_interview',
    messages: [
      { role: 'user', content: 'I have 3 years of experience as a software tester.' },
      { role: 'assistant', content: 'Tell me about a challenging bug you uncovered.' }
    ]
  }, {
    Authorization: 'Bearer valid-commit-mode-jwt'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.session_id, 'session-resumed-scen-02');

  const progressCall = rpcCalls.find(call => call.fnName === 'record_commit_mode_progress');
  assert.ok(progressCall, 'Resumed scenario session MUST record commit mode progress');
  assert.strictEqual(progressCall.params.p_kind, 'scenario');
  assert.strictEqual(progressCall.params.p_seconds, 0);
  assert.strictEqual(progressCall.params.p_user_id, 'user-adv-scen-02');

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: Adversarial Type Tampering & Sibling Path Contrast
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-020 ADVERSARIAL: Malicious / unrecognized session_type returns 400 Bad Request and does NOT grant scenario progress', async () => {
  // Why this matters: Strict schema contract — invalid session_type values are rejected before touching DB or progress RPC.
  let rpcCalls = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    rpcCalls.push({ fnName, params });
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-tamper-01', email: 'tamper@example.in' } },
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-30T11:00:00.000Z',
    ended_at: '2026-08-30T11:02:00.000Z',
    session_type: 'custom_hack', // Malicious invalid string
    messages: [
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Hi' }
    ]
  }, {
    Authorization: 'Bearer valid-commit-mode-jwt'
  });

  assert.strictEqual(status, 400);
  assert.match(data.error, /session_type must be/);
  assert.strictEqual(rpcCalls.length, 0, 'No RPCs should be called on validation rejection');

  mock.restoreAll();
});

test('AUD-020 ADVERSARIAL: Standard freeform chat session records chat progress and NEVER scenario progress', async () => {
  // Why this matters: Strict sibling path separation — normal chat must not satisfy the scenario commitment.
  let rpcCalls = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    rpcCalls.push({ fnName, params });
    if (fnName === 'consume_access') return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    if (fnName === 'record_commit_mode_progress') return { data: null, error: null };
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-chat-only', email: 'chatonly@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') {
      return createSupabaseQueryMock({
        single: () => Promise.resolve({ data: { plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 86400000).toISOString() }, error: null })
      });
    }
    if (table === 'chat_sessions') {
      return createSupabaseQueryMock({
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insertSingle: (row) => Promise.resolve({ data: { id: 'session-chat-only-1', user_id: 'user-chat-only', ...row }, error: null })
      });
    }
    if (table === 'chat_messages') {
      return createSupabaseQueryMock({
        upsert: () => Promise.resolve({ error: null })
      });
    }
    return createSupabaseQueryMock();
  });

  const app = buildApp();
  const { status } = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-30T12:00:00.000Z',
    ended_at: '2026-08-30T12:05:00.000Z', // 300s
    session_type: 'freeform',
    messages: [
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Hello' }
    ]
  }, {
    Authorization: 'Bearer valid-commit-mode-jwt'
  });

  assert.strictEqual(status, 200);

  const scenarioCall = rpcCalls.find(call => call.fnName === 'record_commit_mode_progress' && call.params.p_kind === 'scenario');
  assert.strictEqual(scenarioCall, undefined, 'Freeform chat MUST NOT trigger scenario progress');

  const chatCall = rpcCalls.find(call => call.fnName === 'record_commit_mode_progress' && call.params.p_kind === 'chat');
  assert.ok(chatCall, 'Freeform chat MUST trigger chat progress');
  assert.strictEqual(chatCall.params.p_seconds, 300);

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: IST Date Midnight Boundary Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-020 ADVERSARIAL: Scenario finishing at 23:59:59 IST is attributed to current IST date', async () => {
  // Why this matters: Date boundary precision — 18:29:59 UTC is 23:59:59 IST. Must attribute to that day, satisfying yesterday before midnight sweep at 00:05.
  let rpcCalls = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    rpcCalls.push({ fnName, params });
    if (fnName === 'consume_access') return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    if (fnName === 'record_commit_mode_progress') return { data: null, error: null };
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-boundary-01', email: 'boundary01@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') {
      return createSupabaseQueryMock({
        single: () => Promise.resolve({ data: { plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 86400000).toISOString() }, error: null })
      });
    }
    if (table === 'chat_sessions') {
      return createSupabaseQueryMock({
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insertSingle: (row) => Promise.resolve({ data: { id: 'session-boundary-1', user_id: 'user-boundary-01', ...row }, error: null })
      });
    }
    if (table === 'chat_messages') {
      return createSupabaseQueryMock({
        upsert: () => Promise.resolve({ error: null })
      });
    }
    return createSupabaseQueryMock();
  });

  const app = buildApp();
  // 18:29:59 UTC on Aug 28 = 23:59:59 IST on Aug 28
  const endedAt = '2026-08-28T18:29:59.000Z';

  const { status } = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-28T18:26:00.000Z',
    ended_at: endedAt,
    session_type: 'scenario',
    scenario_key: 'restaurant_order',
    messages: [
      { role: 'assistant', content: 'Welcome' },
      { role: 'user', content: 'Hi' }
    ]
  }, {
    Authorization: 'Bearer valid-commit-mode-jwt'
  });

  assert.strictEqual(status, 200);

  const progressCall = rpcCalls.find(call => call.fnName === 'record_commit_mode_progress');
  assert.ok(progressCall);
  assert.strictEqual(progressCall.params.p_ist_date, '2026-08-28');

  mock.restoreAll();
});

test('AUD-020 ADVERSARIAL: Scenario finishing at 00:00:01 IST is attributed to the new IST date', async () => {
  // Why this matters: 18:30:01 UTC on Aug 28 = 00:00:01 IST on Aug 29. Attributed to Aug 29.
  let rpcCalls = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    rpcCalls.push({ fnName, params });
    if (fnName === 'consume_access') return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    if (fnName === 'record_commit_mode_progress') return { data: null, error: null };
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-boundary-02', email: 'boundary02@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') {
      return createSupabaseQueryMock({
        single: () => Promise.resolve({ data: { plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 86400000).toISOString() }, error: null })
      });
    }
    if (table === 'chat_sessions') {
      return createSupabaseQueryMock({
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insertSingle: (row) => Promise.resolve({ data: { id: 'session-boundary-2', user_id: 'user-boundary-02', ...row }, error: null })
      });
    }
    if (table === 'chat_messages') {
      return createSupabaseQueryMock({
        upsert: () => Promise.resolve({ error: null })
      });
    }
    return createSupabaseQueryMock();
  });

  const app = buildApp();
  // 18:30:01 UTC on Aug 28 = 00:00:01 IST on Aug 29
  const endedAt = '2026-08-28T18:30:01.000Z';

  const { status } = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-28T18:27:00.000Z',
    ended_at: endedAt,
    session_type: 'scenario',
    scenario_key: 'restaurant_order',
    messages: [
      { role: 'assistant', content: 'Welcome' },
      { role: 'user', content: 'Hi' }
    ]
  }, {
    Authorization: 'Bearer valid-commit-mode-jwt'
  });

  assert.strictEqual(status, 200);

  const progressCall = rpcCalls.find(call => call.fnName === 'record_commit_mode_progress');
  assert.ok(progressCall);
  assert.strictEqual(progressCall.params.p_ist_date, '2026-08-29');

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: Failure & Rollback Isolation (No Phantom Scenario Progress)
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-020 ADVERSARIAL: If message insertion fails, session is rolled back and scenario progress is NOT recorded', async () => {
  // Why this matters: If a DB write fails mid-flight, an aborted session must never falsely mark the scenario requirement as complete.
  let rpcCalls = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    rpcCalls.push({ fnName, params });
    if (fnName === 'consume_access') return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-fail-01', email: 'fail01@example.in' } },
    error: null
  }));

  let sessionDeleted = false;
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') {
      return createSupabaseQueryMock({
        single: () => Promise.resolve({ data: { plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 86400000).toISOString() }, error: null })
      });
    }
    if (table === 'chat_sessions') {
      return createSupabaseQueryMock({
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insertSingle: (row) => Promise.resolve({ data: { id: 'session-fail-1', user_id: 'user-fail-01', ...row }, error: null }),
        deleteEq: () => {
          sessionDeleted = true;
          return Promise.resolve({ error: null });
        }
      });
    }
    if (table === 'chat_messages') {
      return createSupabaseQueryMock({
        upsert: () => Promise.resolve({ error: new Error('Disk I/O error or constraint failure') })
      });
    }
    return createSupabaseQueryMock();
  });

  const app = buildApp();
  const { status } = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-30T10:00:00.000Z',
    ended_at: '2026-08-30T10:03:00.000Z',
    session_type: 'scenario',
    scenario_key: 'restaurant_order',
    messages: [
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Hi' }
    ]
  }, {
    Authorization: 'Bearer valid-commit-mode-jwt'
  });

  assert.strictEqual(status, 500);
  assert.strictEqual(sessionDeleted, true, 'Orphaned session row must be cleaned up on failure');

  const scenarioCall = rpcCalls.find(call => call.fnName === 'record_commit_mode_progress');
  assert.strictEqual(scenarioCall, undefined, 'record_commit_mode_progress MUST NOT be called if session save failed');

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: Midnight Sweep & Overall Commitment Evaluation (Full Lifecycle)
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-020 LIFECYCLE: Midnight sweep keeps subscription alive when user meets both Chat and Scenario commitments', async () => {
  // Why this matters: The ultimate end-to-end impact test. Proves that with scenario progress recorded, midnight sweep evaluates met=true and keeps subscription.
  const users = [
    { id: 'user-keep-1', plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 86400000).toISOString() }
  ];

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: users, error: null }),
        update: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: null })
          })
        })
      };
      return builder;
    }
    if (table === 'commit_mode_daily_progress') {
      return {
        insert: () => ({
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null })
          })
        }),
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () => Promise.resolve({
                data: {
                  id: 'progress-keep-1',
                  chat_requirement_met: true,
                  scenario_requirement_met: true, // AUD-020: True because scenario was recorded!
                  judged_at: null
                },
                error: null
              })
            })
          })
        }),
        update: () => ({
          eq: () => ({
            is: () => Promise.resolve({ error: null })
          })
        })
      };
    }
  });

  const result = await runCommitModeMidnightSweep();

  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.kept, 1, 'User who completed both chat and scenario must be kept');
  assert.strictEqual(result.terminated, 0, 'No termination should occur');

  mock.restoreAll();
});

test('AUD-020 LIFECYCLE: Midnight sweep terminates subscription when Scenario requirement is missed despite 300s chat', async () => {
  // Why this matters: Proves that scenario requirement is strictly enforced — omitting scenario legitimately terminates subscription.
  const users = [
    { id: 'user-term-1', plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 86400000).toISOString() }
  ];

  let terminatedProfileId = null;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: users, error: null }),
        update: (fields) => ({
          eq: (col1, val1) => ({
            eq: (col2, val2) => {
              if (val1 === 'user-term-1') terminatedProfileId = val1;
              return Promise.resolve({ error: null });
            }
          })
        })
      };
      return builder;
    }
    if (table === 'commit_mode_daily_progress') {
      return {
        insert: () => ({
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null })
          })
        }),
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () => Promise.resolve({
                data: {
                  id: 'progress-term-1',
                  chat_requirement_met: true,
                  scenario_requirement_met: false, // Scenario NOT done!
                  judged_at: null
                },
                error: null
              })
            })
          })
        }),
        update: () => ({
          eq: () => ({
            is: () => Promise.resolve({ error: null })
          })
        })
      };
    }
  });

  const result = await runCommitModeMidnightSweep();

  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.kept, 0);
  assert.strictEqual(result.terminated, 1, 'Missing scenario must trigger termination');
  assert.strictEqual(terminatedProfileId, 'user-term-1');

  mock.restoreAll();
});
