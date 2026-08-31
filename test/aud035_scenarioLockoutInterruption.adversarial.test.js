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
// AUD-035 / AUD-038: 21 HARD ADVERSARIAL TESTS (Scenario Lockout & Interruptions)
// ═════════════════════════════════════════════════════════════════════════════

// Test 1: Turn 0 abort must never lock scenario on GET /today
test('AUD-035.1: 0-turn abort before speech starts leaves today unlocked', async () => {
  const userId = 'user-adv-01';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ key: 'cafe', title: 'Cafe' }], error: null }) }) }) };
    if (table === 'chat_sessions') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ gt: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }) })
      };
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.already_completed_today, false);
  mock.restoreAll();
});

// Test 2: Turn 1 incoming phone call (is_completed: false) leaves today unlocked
test('AUD-035.2: Turn 1 phone call interruption (is_completed: false) leaves today unlocked', async () => {
  const userId = 'user-adv-02';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ key: 'cafe', title: 'Cafe' }], error: null }) }) }) };
    if (table === 'chat_sessions') {
      const b = { select: () => b, eq: () => b, gt: () => b, order: () => b, limit: () => b, maybeSingle: async () => ({ data: { id: 's1', is_completed: false, turn_count: 1, started_at: new Date().toISOString() }, error: null }) };
      return b;
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.already_completed_today, false);
  assert.strictEqual(res.data.completed_session_id, null);
  mock.restoreAll();
});

// Test 3: Mid-session RAM kill at 4 turns allows re-entry on POST /sessions without 409
test('AUD-035.3: Mid-session RAM kill at 4 turns allows new session initiation without 409', async () => {
  const userId = 'user-adv-03';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const b = {
        select: () => b, eq: () => b, gt: () => b, gte: () => b, limit: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'new-sess-after-kill', ...payload }, error: null }) }) })
      };
      return b;
    }
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'hotel',
    is_completed: false,
    messages: [{ role: 'user', content: 'Checking in' }]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.session_id, 'new-sess-after-kill');
  mock.restoreAll();
});

// Test 4: Phase 2 feedback boundary drop (179s, is_completed: false) keeps day open
test('AUD-035.4: Phase 2 boundary network drop keeps today unlocked', async () => {
  const userId = 'user-adv-04';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ key: 'hotel', title: 'Hotel' }], error: null }) }) }) };
    if (table === 'chat_sessions') {
      const b = { select: () => b, eq: () => b, gt: () => b, order: () => b, limit: () => b, maybeSingle: async () => ({ data: { id: 's-ph2', is_completed: false, turn_count: 6, started_at: new Date().toISOString() }, error: null }) };
      return b;
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.already_completed_today, false);
  mock.restoreAll();
});

// Test 5: Fully completed session (is_completed: true) strictly locks today
test('AUD-035.5: Completed session (is_completed: true) locks GET /today with session ID', async () => {
  const userId = 'user-adv-05';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ key: 'interview', title: 'Interview' }], error: null }) }) }) };
    if (table === 'chat_sessions') {
      const b = { select: () => b, eq: () => b, gt: () => b, order: () => b, limit: () => b, maybeSingle: async () => ({ data: { id: 's-completed', is_completed: true, turn_count: 8, started_at: new Date().toISOString() }, error: null }) };
      return b;
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.already_completed_today, true);
  assert.strictEqual(res.data.completed_session_id, 's-completed');
  mock.restoreAll();
});

// Test 6: Second new scenario attempt after full completion rejects with 409
test('AUD-035.6: Attempting a new scenario after completing today returns 409 Conflict', async () => {
  const userId = 'user-adv-06';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const b = {
        select: () => b, eq: () => b, gt: () => b, gte: () => b, limit: () => b,
        maybeSingle: async () => ({ data: { id: 's-done', is_completed: true }, error: null })
      };
      return b;
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'interview',
    messages: [{ role: 'user', content: 'Second attempt' }]
  });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.error, 'scenario_already_done_today');
  mock.restoreAll();
});

// Test 7: Resuming an existing incomplete session with session_id succeeds without 409
test('AUD-035.7: Resuming existing incomplete session by ID succeeds without 409', async () => {
  const userId = 'user-adv-07';
  setupAuthMock(userId);
  let updated = false;
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-resume-ok', turn_count: 3, is_completed: false }, error: null }) }) }) }),
        update: () => { updated = true; return { eq: async () => ({ error: null }) }; }
      };
    }
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: 'sess-resume-ok',
    started_at: new Date(Date.now() - 60000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'hotel',
    is_completed: false,
    messages: [{ role: 'user', content: 'Next sentence' }]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(updated, true);
  mock.restoreAll();
});

// Test 8: Concurrent pagehide / visibilitychange syncs resolve idempotently without 409
test('AUD-035.8: Concurrent pagehide sync matches started_at idempotently', async () => {
  const userId = 'user-adv-08';
  setupAuthMock(userId);
  const fixedStart = '2026-08-31T01:00:00.000Z';

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const b = {
        select: () => b, eq: () => b, gt: () => b, gte: () => b, limit: () => b,
        maybeSingle: async () => ({ data: { id: 'in-flight-session' }, error: null }),
        single: async () => ({ data: { id: 'in-flight-session', turn_count: 2 }, error: null }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
      return b;
    }
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: fixedStart,
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'hotel',
    messages: [{ role: 'user', content: 'Concurrent sync' }]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.session_id, 'in-flight-session');
  mock.restoreAll();
});

// Test 9: Malicious user attempting to resume another user's session gets 404
test('AUD-035.9: Cross-user session resumption attempt returns 404 Not Found', async () => {
  const userId = 'user-attacker-09';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: { message: 'Not found' } }) }) }) }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: 'victim-session-id',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'hotel',
    messages: [{ role: 'user', content: 'Hijack attempt' }]
  });

  assert.strictEqual(res.status, 404);
  mock.restoreAll();
});

// Test 10: Resuming a session whose report is already generated returns 409 locked
test('AUD-035.10: Resuming a session with generated report returns 409 locked', async () => {
  const userId = 'user-adv-10';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-locked', turn_count: 5 }, error: null }) }) }) }) };
    }
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'rep-done' }, error: null }) }) }) }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: 'sess-locked',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'hotel',
    messages: [{ role: 'user', content: 'Append to finalized report' }]
  });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.error, 'locked');
  mock.restoreAll();
});

// Test 11: Attempting to POST /analyze on incomplete scenario strictly returns 400
test('AUD-035.11: POST /analyze on incomplete scenario session strictly returns 400', async () => {
  const userId = 'user-adv-11';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }) };
    if (table === 'chat_sessions') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-inc', session_type: 'scenario', is_completed: false, turn_count: 5 }, error: null }) }) }) }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions/sess-inc/analyze');
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /still in progress/i);
  mock.restoreAll();
});

// Test 12: Scenario with 1 turn on POST /analyze rejects with 400 (needs >= 2 turns)
test('AUD-035.12: POST /analyze on completed scenario with 1 turn rejects (min 2 turns needed)', async () => {
  const userId = 'user-adv-12';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }) };
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

// Test 13: Freeform chat ignores is_completed: false and analyzes with 10 turns
test('AUD-035.13: POST /analyze for freeform chat ignores is_completed: false and analyzes >=10 turns', async () => {
  const userId = 'user-adv-13';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true }], error: null }));
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }),
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'rep-ff-13' }, error: null }) }) }),
        delete: () => ({ eq: async () => ({ error: null }) }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
    }
    if (table === 'chat_sessions') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sess-ff-13', session_type: 'freeform', is_completed: false, turn_count: 10 }, error: null }) }) }) }) };
    }
    if (table === 'chat_messages') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: Array(10).fill({ role: 'user', content: 'test' }), error: null }) }) }) };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions/sess-ff-13/analyze');
  assert.notStrictEqual(res.status, 400);
  mock.restoreAll();
});

// Test 14: Non-boolean is_completed payload type rejects with 400 validation error
test('AUD-035.14: POST /chat/sessions rejects non-boolean is_completed with 400', async () => {
  const userId = 'user-adv-14';
  setupAuthMock(userId);
  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'hotel',
    is_completed: 'truthy-string-injection',
    messages: [{ role: 'user', content: 'Hack' }]
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /is_completed/i);
  mock.restoreAll();
});

// Test 15: Midnight crossing: scenario started at 23:58 IST yesterday does not lock 00:02 IST today
test('AUD-035.15: Yesterday scenario near midnight does not lock today across IST boundary', async () => {
  const userId = 'user-adv-15';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ key: 'cafe', title: 'Cafe' }], error: null }) }) }) };
    if (table === 'chat_sessions') {
      const b = { select: () => b, eq: () => b, gt: () => b, order: () => b, limit: () => b, maybeSingle: async () => ({ data: null, error: null }) };
      return b;
    }
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.already_completed_today, false);
  mock.restoreAll();
});

// Test 16: Zero active scenarios in database returns 503 Service Unavailable
test('AUD-035.16: GET /chat/scenario/today returns 503 when scenario list is empty', async () => {
  const userId = 'user-adv-16';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'scenario_configs') return { select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) };
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');
  assert.strictEqual(res.status, 503);
  mock.restoreAll();
});

// Test 17: Extreme special characters, emojis and Hindi script in messages save cleanly
test('AUD-035.17: Unicode, Hindi and emojis in transcript payload handle cleanly', async () => {
  const userId = 'user-adv-17';
  setupAuthMock(userId);
  let savedMessages = null;
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const b = {
        select: () => b, eq: () => b, gt: () => b, gte: () => b, limit: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'sess-unicode', ...payload }, error: null }) }) })
      };
      return b;
    }
    if (table === 'chat_messages') {
      return { upsert: async (msgs) => { savedMessages = msgs; return { error: null }; } };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'hotel',
    is_completed: false,
    messages: [
      { role: 'user', content: 'नमस्ते! क्या मुझे एक कमरा मिल सकता है? 🏨 ✨' },
      { role: 'assistant', content: 'Sure! "Welcome to Grand Hotel." How can I help?' }
    ]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(savedMessages.length, 2);
  mock.restoreAll();
});

// Test 18: Unauthenticated request to GET /chat/scenario/today strictly rejects with 401
test('AUD-035.18: GET /chat/scenario/today without Bearer token rejects with 401 Unauthorized', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({ data: { user: null }, error: { message: 'Invalid token' } }));
  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today', null, {});
  assert.strictEqual(res.status, 401);
  mock.restoreAll();
});

// Test 19: Unauthenticated request to POST /chat/sessions strictly rejects with 401
test('AUD-035.19: POST /chat/sessions without Bearer token rejects with 401 Unauthorized', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({ data: { user: null }, error: { message: 'Invalid token' } }));
  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', { started_at: new Date().toISOString(), ended_at: new Date().toISOString() }, {});
  assert.strictEqual(res.status, 401);
  mock.restoreAll();
});

// Test 20: Missing scenario_key for session_type: scenario rejects with 400 validation error
test('AUD-035.20: POST /chat/sessions with scenario session type but missing key rejects with 400', async () => {
  const userId = 'user-adv-20';
  setupAuthMock(userId);
  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: null,
    messages: [{ role: 'user', content: 'No scenario key' }]
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /scenario_key/i);
  mock.restoreAll();
});

// Test 21: Database connection failure in GET /chat/scenario/today returns 500 error gracefully
test('AUD-035.21: Database connection exception in GET /today returns structured 500', async () => {
  const userId = 'user-adv-21';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'from', () => {
    throw new Error('Supabase connection pool exhausted');
  });

  const app = buildApp();
  const res = await request(app, 'GET', '/chat/scenario/today');
  assert.strictEqual(res.status, 500);
  assert.match(res.data.error, /pool exhausted/i);
  mock.restoreAll();
});
