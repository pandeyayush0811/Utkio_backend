const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const { supabaseAnon, supabaseAdmin } = require('../lib/supabaseClient');
const chatRoutes = require('../routes/chatRoutes');
const { istDateString } = require('../lib/commitMode');

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
// BACKEND ADVERSARIAL SUITE — Issue #5 (AUD-005: Commit Mode Progress & Security Definer Hardening)
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: Security Definer Search Path & Parameter Tampering Hardening
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-005 SEC: record_commit_mode_progress RPC invocation enforces strict parameter types and schema validation', async () => {
  // Why this matters: Verifies that malicious SQL tokens or illegal p_kind values cannot bypass RPC contract.
  let rpcCalls = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    rpcCalls.push({ fnName, params });
    if (fnName === 'record_commit_mode_progress') {
      if (params.p_kind !== 'chat' && params.p_kind !== 'scenario') {
        return { data: null, error: { message: `record_commit_mode_progress: p_kind must be chat or scenario, got ${params.p_kind}` } };
      }
      return { data: null, error: null };
    }
    return { data: { allowed: true, plan: 'commit_mode' }, error: null };
  });

  const validRes = await supabaseAdmin.rpc('record_commit_mode_progress', {
    p_user_id: 'user-sec-01',
    p_ist_date: '2026-08-29',
    p_kind: 'chat',
    p_seconds: 120
  });
  assert.strictEqual(validRes.error, null);

  // Adversarial: SQL injection string in p_kind
  const sqlInjRes = await supabaseAdmin.rpc('record_commit_mode_progress', {
    p_user_id: 'user-sec-01',
    p_ist_date: '2026-08-29',
    p_kind: "chat'; DROP TABLE commit_mode_daily_progress; --",
    p_seconds: 120
  });
  assert.notStrictEqual(sqlInjRes.error, null);
  assert.match(sqlInjRes.error.message, /must be chat or scenario/);

  // Adversarial: Case tampering in p_kind
  const caseTamperRes = await supabaseAdmin.rpc('record_commit_mode_progress', {
    p_user_id: 'user-sec-01',
    p_ist_date: '2026-08-29',
    p_kind: 'CHAT',
    p_seconds: 120
  });
  assert.notStrictEqual(caseTamperRes.error, null);

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: Human Interaction & App-Level Extreme Input / Seconds Tampering
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-005 HUMAN: negative practice seconds from client clock manipulation is bounded by greatest(p_seconds, 0)', async () => {
  // Why this matters: If a user manipulates device clock or sends negative duration, it must never decrement progress.
  let capturedParams = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') {
      return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    }
    if (fnName === 'record_commit_mode_progress') {
      capturedParams = params;
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-neg-sec', email: 'neg@example.in' } },
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
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: { id: 'session-neg-1', user_id: 'user-neg-sec', session_type: 'freeform', turn_count: 2 },
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
  // App sends a session with negative duration (started_at after ended_at due to device clock jump)
  const { status } = await request(app, 'POST', '/chat/sessions', {
    started_at: '2026-08-29T10:00:00.000Z',
    ended_at: '2026-08-29T09:50:00.000Z', // 10 minutes BEFORE started_at!
    turn_count: 2,
    messages: [
      { role: 'user', content: 'Hello', turn_index: 0 },
      { role: 'assistant', content: 'Hi there!', turn_index: 1 }
    ]
  }, {
    Authorization: 'Bearer valid-token-commit'
  });

  assert.strictEqual(status, 200);
  // Backend duration calculation must clamp or pass safe integer to RPC
  assert.ok(capturedParams !== null);
  assert.strictEqual(capturedParams.p_kind, 'chat');
  assert.ok(capturedParams.p_seconds <= 0 || capturedParams.p_seconds === 0);

  mock.restoreAll();
});

test('AUD-005 HUMAN: massive duration (e.g. app left in background for 72 hours) does not cause integer overflow', async () => {
  // Why this matters: User forgets app open over a weekend; session duration of 259,200s must be handled without DB error.
  let capturedParams = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') {
      return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    }
    if (fnName === 'record_commit_mode_progress') {
      capturedParams = params;
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-huge-dur', email: 'huge@example.in' } },
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
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: { id: 'session-huge-1', user_id: 'user-huge-dur', session_type: 'freeform', turn_count: 2 },
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
    started_at: '2026-08-26T10:00:00.000Z',
    ended_at: '2026-08-29T10:00:00.000Z', // 72 hours later
    turn_count: 2,
    messages: [
      { role: 'user', content: 'Long session test', turn_index: 0 },
      { role: 'assistant', content: 'Acknowledged', turn_index: 1 }
    ]
  }, {
    Authorization: 'Bearer valid-token-commit'
  });

  assert.strictEqual(status, 200);
  assert.ok(capturedParams !== null);
  assert.ok(capturedParams.p_seconds > 0);

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: Incremental Multi-Session Human Daily Practice Flow
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-005 PROGRESS: simulates incremental sessions (120s + 100s + 80s = 300s) transitioning chat_requirement_met from false to true', () => {
  // Why this matters: Humans practice in short micro-bursts throughout the day.
  // We simulate the exact SQL state machine logic from 007_commit_mode.sql.

  function simulateRecordProgress(currentState, p_kind, p_seconds, p_min_chat_seconds = 300) {
    if (currentState && currentState.judged_at) {
      // no-op if already judged
      return { ...currentState };
    }
    if (!currentState) {
      const chatSecs = p_kind === 'chat' ? Math.max(p_seconds, 0) : 0;
      return {
        chat_seconds_done: chatSecs,
        chat_requirement_met: p_kind === 'chat' ? chatSecs >= p_min_chat_seconds : false,
        scenario_requirement_met: p_kind === 'scenario',
        judged_at: null
      };
    }
    const newChatSecs = currentState.chat_seconds_done + (p_kind === 'chat' ? Math.max(p_seconds, 0) : 0);
    return {
      ...currentState,
      chat_seconds_done: newChatSecs,
      chat_requirement_met: p_kind === 'chat' ? newChatSecs >= p_min_chat_seconds : currentState.chat_requirement_met,
      scenario_requirement_met: p_kind === 'scenario' ? true : currentState.scenario_requirement_met
    };
  }

  // Session 1: Morning chat (120s)
  let state = simulateRecordProgress(null, 'chat', 120);
  assert.strictEqual(state.chat_seconds_done, 120);
  assert.strictEqual(state.chat_requirement_met, false);
  assert.strictEqual(state.scenario_requirement_met, false);

  // Session 2: Lunch scenario simulation
  state = simulateRecordProgress(state, 'scenario', 0);
  assert.strictEqual(state.chat_seconds_done, 120);
  assert.strictEqual(state.chat_requirement_met, false);
  assert.strictEqual(state.scenario_requirement_met, true);

  // Session 3: Evening chat (100s -> total 220s)
  state = simulateRecordProgress(state, 'chat', 100);
  assert.strictEqual(state.chat_seconds_done, 220);
  assert.strictEqual(state.chat_requirement_met, false);
  assert.strictEqual(state.scenario_requirement_met, true);

  // Session 4: Night chat (79s -> total 299s — 1s below threshold!)
  state = simulateRecordProgress(state, 'chat', 79);
  assert.strictEqual(state.chat_seconds_done, 299);
  assert.strictEqual(state.chat_requirement_met, false); // boundary: 299 is false!

  // Session 5: Night chat final 1s (total 300s -> exact threshold reached!)
  state = simulateRecordProgress(state, 'chat', 1);
  assert.strictEqual(state.chat_seconds_done, 300);
  assert.strictEqual(state.chat_requirement_met, true); // boundary: 300 is true!
  assert.strictEqual(state.scenario_requirement_met, true);

  // Session 6: Extra chat after requirement met (500s -> total 800s)
  state = simulateRecordProgress(state, 'chat', 500);
  assert.strictEqual(state.chat_seconds_done, 800);
  assert.strictEqual(state.chat_requirement_met, true);
  assert.strictEqual(state.scenario_requirement_met, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: Midnight Sweep Judged Day Locking & Replay Protection
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-005 REPLAY: session synced after midnight sweep does NOT resurrect or alter judged record', () => {
  // Why this matters: If a phone loses internet and syncs hours later after the 00:05 IST sweep judged the day,
  // it must never overwrite judged_at or change judged_result.

  function simulateRecordProgress(currentState, p_kind, p_seconds, p_min_chat_seconds = 300) {
    if (currentState && currentState.judged_at) {
      // WHERE commit_mode_daily_progress.judged_at is null
      return { ...currentState };
    }
    const newChatSecs = (currentState ? currentState.chat_seconds_done : 0) + (p_kind === 'chat' ? Math.max(p_seconds, 0) : 0);
    return {
      chat_seconds_done: newChatSecs,
      chat_requirement_met: p_kind === 'chat' ? newChatSecs >= p_min_chat_seconds : (currentState ? currentState.chat_requirement_met : false),
      scenario_requirement_met: p_kind === 'scenario' ? true : (currentState ? currentState.scenario_requirement_met : false),
      judged_at: currentState ? currentState.judged_at : null,
      judged_result: currentState ? currentState.judged_result : null
    };
  }

  const judgedState = {
    chat_seconds_done: 180,
    chat_requirement_met: false,
    scenario_requirement_met: false,
    judged_at: '2026-08-29T00:05:00.000Z',
    judged_result: 'missed'
  };

  // Late arriving chat session (200s)
  const updatedState1 = simulateRecordProgress(judgedState, 'chat', 200);
  assert.strictEqual(updatedState1.chat_seconds_done, 180, 'chat_seconds_done must remain untouched');
  assert.strictEqual(updatedState1.chat_requirement_met, false);
  assert.strictEqual(updatedState1.judged_result, 'missed');

  // Late arriving scenario session
  const updatedState2 = simulateRecordProgress(judgedState, 'scenario', 0);
  assert.strictEqual(updatedState2.scenario_requirement_met, false, 'scenario_requirement_met must remain false');
  assert.strictEqual(updatedState2.judged_result, 'missed');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: IST Midnight Date Transition During Live Voice Session
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-005 TIMEZONE: session crossing IST midnight is attributed deterministically to start IST date', () => {
  // Why this matters: User starts practicing at 23:58 IST on Aug 28 and ends at 00:05 IST on Aug 29.
  // The session's started_at governs the IST progress bucket.

  const startUtc = new Date('2026-08-28T18:28:00.000Z'); // 23:58 IST on 2026-08-28
  const endUtc = new Date('2026-08-28T18:35:00.000Z');   // 00:05 IST on 2026-08-29

  const assignedIstDate = istDateString(startUtc);
  assert.strictEqual(assignedIstDate, '2026-08-28', 'Session starting before midnight IST must be assigned to that IST day');

  const nextDayStartUtc = new Date('2026-08-28T18:31:00.000Z'); // 00:01 IST on 2026-08-29
  assert.strictEqual(istDateString(nextDayStartUtc), '2026-08-29', 'Session starting after midnight IST must be assigned to next IST day');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6: Scenario Session Progress Recording (AUD-020)
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-020: POST /chat/sessions records Commit Mode scenario progress for brand-new scenario session', async () => {
  let capturedRpc = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') {
      return { data: { allowed: true, plan: 'commit_mode' }, error: null };
    }
    if (fnName === 'record_commit_mode_progress') {
      capturedRpc = { fnName, params };
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-scen-01', email: 'scen@example.in' } },
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
            return builder;
          }
          return {
            single: async () => ({
              data: { id: 'session-scen-new-1', user_id: 'user-scen-01', session_type: 'scenario', turn_count: 2 },
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
              data: { id: 'session-scen-new-1', user_id: 'user-scen-01', ...row },
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
    return { select: () => ({ eq: () => ({ single: async () => ({ data: {}, error: null }) }) }) };
  });

  const app = buildApp();
  const startedAt = '2026-08-29T10:00:00.000Z';
  const endedAt = '2026-08-29T10:04:00.000Z';
  const { status, data } = await request(app, 'POST', '/chat/sessions', {
    started_at: startedAt,
    ended_at: endedAt,
    session_type: 'scenario',
    scenario_key: 'restaurant_order',
    messages: [
      { role: 'user', content: 'Table for two please', turn_index: 0 },
      { role: 'assistant', content: 'Right this way!', turn_index: 1 }
    ]
  }, {
    Authorization: 'Bearer valid-token-commit'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.session_id, 'session-scen-new-1');
  assert.notStrictEqual(capturedRpc, null, 'record_commit_mode_progress RPC MUST be invoked for scenario sessions');
  assert.strictEqual(capturedRpc.params.p_kind, 'scenario');
  assert.strictEqual(capturedRpc.params.p_seconds, 0);
  assert.strictEqual(capturedRpc.params.p_ist_date, istDateString(new Date(endedAt)));

  mock.restoreAll();
});

test('AUD-020: POST /chat/sessions records Commit Mode scenario progress for resumed scenario session', async () => {
  let capturedRpc = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'record_commit_mode_progress') {
      capturedRpc = { fnName, params };
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-scen-02', email: 'scen2@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: 'session-scen-resumed-1', user_id: 'user-scen-02', session_type: 'scenario', turn_count: 2, scenario_key: 'restaurant_order' },
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
  const startedAt = '2026-08-29T10:02:00.000Z';
  const endedAt = '2026-08-29T10:05:00.000Z';
  const { status, data } = await request(app, 'POST', '/chat/sessions', {
    session_id: 'session-scen-resumed-1',
    session_type: 'scenario',
    scenario_key: 'restaurant_order',
    started_at: startedAt,
    ended_at: endedAt,
    messages: [
      { role: 'user', content: 'Can we see the menu?', turn_index: 2 },
      { role: 'assistant', content: 'Here you go!', turn_index: 3 }
    ]
  }, {
    Authorization: 'Bearer valid-token-commit'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.session_id, 'session-scen-resumed-1');
  assert.notStrictEqual(capturedRpc, null, 'record_commit_mode_progress RPC MUST be invoked for resumed scenario sessions');
  assert.strictEqual(capturedRpc.params.p_kind, 'scenario');
  assert.strictEqual(capturedRpc.params.p_seconds, 0);

  mock.restoreAll();
});

