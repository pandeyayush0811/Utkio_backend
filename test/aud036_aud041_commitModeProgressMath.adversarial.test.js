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

function createQueryBuilder(tableHandlers = {}) {
  return function mockFrom(tableName) {
    if (tableHandlers[tableName]) {
      return tableHandlers[tableName]();
    }
    const defaultChain = {
      select: () => defaultChain,
      eq: () => defaultChain,
      gt: () => defaultChain,
      gte: () => defaultChain,
      lt: () => defaultChain,
      lte: () => defaultChain,
      is: () => defaultChain,
      order: () => defaultChain,
      limit: () => defaultChain,
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      insert: (p) => ({
        select: () => ({
          single: async () => ({ data: { id: 'sess-' + Math.random().toString(36).slice(2), ...p }, error: null })
        })
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
      upsert: async () => ({ error: null }),
      delete: () => ({ eq: async () => ({ error: null }) })
    };
    return defaultChain;
  };
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
// AUD-036 & AUD-041: 21 HARD ADVERSARIAL TESTS (Commit Mode Progress & Delta Math)
// ═════════════════════════════════════════════════════════════════════════════

// Test 1: Incomplete scenario on initial insert does NOT award scenario progress
test('AUD-036.1: Initial scenario save with is_completed: false does NOT record commit progress', async () => {
  const userId = 'user-cm-01';
  setupAuthMock(userId);
  let recorded = false;
  mock.method(supabaseAdmin, 'rpc', async (fnName) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recorded = true; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', createQueryBuilder());

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date(Date.now() - 30000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'nav',
    is_completed: false,
    messages: [{ role: 'user', content: 'Turn 1' }]
  });

  assert.strictEqual(recorded, false);
  mock.restoreAll();
});

// Test 2: Incomplete scenario on update branch does NOT award scenario progress
test('AUD-036.2: Mid-session scenario update with is_completed: false does NOT record commit progress', async () => {
  const userId = 'user-cm-02';
  setupAuthMock(userId);
  let recorded = false;
  mock.method(supabaseAdmin, 'rpc', async (fnName) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recorded = true; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const b = {
        select: () => b, eq: () => b, gt: () => b, gte: () => b, limit: () => b,
        single: async () => ({ data: { id: 's2', turn_count: 2, is_completed: false, ended_at: null }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
      return b;
    }
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: 's2',
    started_at: new Date(Date.now() - 60000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'nav',
    is_completed: false,
    messages: [{ role: 'user', content: 'Turn 2' }]
  });

  assert.strictEqual(recorded, false);
  mock.restoreAll();
});

// Test 3: Completed scenario on insert awards scenario kind progress
test('AUD-036.3: Completed scenario on insert awards kind=scenario commit progress', async () => {
  const userId = 'user-cm-03';
  setupAuthMock(userId);
  let recordedKind = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recordedKind = params.p_kind; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', createQueryBuilder());

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date(Date.now() - 180000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'nav',
    is_completed: true,
    messages: [{ role: 'user', content: 'Finished' }]
  });

  assert.strictEqual(recordedKind, 'scenario');
  mock.restoreAll();
});

// Test 4: Completed scenario on update awards scenario kind progress
test('AUD-036.4: Completed scenario on update branch awards kind=scenario commit progress', async () => {
  const userId = 'user-cm-04';
  setupAuthMock(userId);
  let recordedKind = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recordedKind = params.p_kind; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const b = {
        select: () => b, eq: () => b, gt: () => b, gte: () => b, limit: () => b,
        single: async () => ({ data: { id: 's4', turn_count: 5, is_completed: false, session_type: 'scenario' }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
      return b;
    }
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: 's4',
    started_at: new Date(Date.now() - 180000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'nav',
    is_completed: true,
    messages: [{ role: 'user', content: 'Final turn' }]
  });

  assert.strictEqual(recordedKind, 'scenario');
  mock.restoreAll();
});

// Test 5: Incomplete scenario with omitted is_completed defaults to true in legacy callers
test('AUD-036.5: Legacy caller omitting is_completed defaults is_completed to true', async () => {
  const userId = 'user-cm-05';
  setupAuthMock(userId);
  let recordedKind = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recordedKind = params.p_kind; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', createQueryBuilder());

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date(Date.now() - 180000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'nav',
    messages: [{ role: 'user', content: 'Legacy caller' }]
  });

  assert.strictEqual(recordedKind, 'scenario');
  mock.restoreAll();
});

// Test 6: AUD-041 Freeform chat 3-turn sync accumulates exact linear delta (45s not 90s)
test('AUD-041.6: Freeform 3-turn sync accumulates linear delta duration (45s total)', async () => {
  const userId = 'user-cm-06';
  setupAuthMock(userId);
  const recordedSeconds = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recordedSeconds.push(params.p_seconds); return { data: null }; }
    return { data: null };
  });

  const t0 = new Date('2026-08-31T02:00:00.000Z');
  const t1 = new Date('2026-08-31T02:00:15.000Z'); // 15s
  const t2 = new Date('2026-08-31T02:00:30.000Z'); // 30s
  const t3 = new Date('2026-08-31T02:00:45.000Z'); // 45s

  let currentEnded = null;
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const b = {
        select: () => b, eq: () => b, gt: () => b, gte: () => b, limit: () => b,
        single: async () => ({ data: { id: 's6', ended_at: currentEnded, started_at: t0.toISOString(), session_type: 'freeform' }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (p) => ({ select: () => ({ single: async () => { currentEnded = p.ended_at; return { data: { id: 's6', ...p }, error: null }; } }) }),
        update: (p) => { currentEnded = p.ended_at; return { eq: async () => ({ error: null }) }; }
      };
      return b;
    }
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', { session_id: null, started_at: t0.toISOString(), ended_at: t1.toISOString(), session_type: 'freeform', messages: [{ role: 'user', content: 'Turn 1' }] });
  await request(app, 'POST', '/chat/sessions', { session_id: 's6', started_at: t0.toISOString(), ended_at: t2.toISOString(), session_type: 'freeform', messages: [{ role: 'user', content: 'Turn 2' }] });
  await request(app, 'POST', '/chat/sessions', { session_id: 's6', started_at: t0.toISOString(), ended_at: t3.toISOString(), session_type: 'freeform', messages: [{ role: 'user', content: 'Turn 3' }] });

  const total = recordedSeconds.reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 45, `Expected 45s recorded across 3 turns, got ${total}s`);
  mock.restoreAll();
});

// Test 7: Negative time delta from clock drift / NTP adjustment clamps to 0 seconds
test('AUD-041.7: Clock skew resulting in ended_at < previous ended_at clamps delta to 0s', async () => {
  const userId = 'user-cm-07';
  setupAuthMock(userId);
  let recordedSec = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recordedSec = params.p_seconds; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const b = {
        select: () => b, eq: () => b, gt: () => b, gte: () => b, limit: () => b,
        single: async () => ({ data: { id: 's7', ended_at: '2026-08-31T02:00:30.000Z', started_at: '2026-08-31T02:00:00.000Z', session_type: 'freeform' }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
      return b;
    }
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: 's7',
    started_at: '2026-08-31T02:00:00.000Z',
    ended_at: '2026-08-31T02:00:25.000Z',
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Skew' }]
  });

  assert.strictEqual(recordedSec, 0, 'Negative delta must clamp to 0');
  mock.restoreAll();
});

// Test 8: Rapid sync spam of 5 requests within seconds handles delta without multiplier
test('AUD-041.8: Rapid sync bursts compute correct delta increments', async () => {
  const userId = 'user-cm-08';
  setupAuthMock(userId);
  const recorded = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recorded.push(params.p_seconds); return { data: null }; }
    return { data: null };
  });

  let currentEnded = '2026-08-31T02:00:00.000Z';
  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      const b = {
        select: () => b, eq: () => b, gt: () => b, gte: () => b, limit: () => b,
        single: async () => ({ data: { id: 's8', ended_at: currentEnded, started_at: '2026-08-31T02:00:00.000Z', session_type: 'freeform' }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        update: (p) => { currentEnded = p.ended_at; return { eq: async () => ({ error: null }) }; }
      };
      return b;
    }
    if (table === 'session_reports') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    if (table === 'chat_messages') return { upsert: async () => ({ error: null }) };
  });

  const app = buildApp();
  for (let i = 1; i <= 5; i++) {
    await request(app, 'POST', '/chat/sessions', {
      session_id: 's8',
      started_at: '2026-08-31T02:00:00.000Z',
      ended_at: new Date(new Date('2026-08-31T02:00:00.000Z').getTime() + i * 2000).toISOString(), // +2s each
      session_type: 'freeform',
      messages: [{ role: 'user', content: `Sync ${i}` }]
    });
  }

  const total = recorded.reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 10, 'Expected exactly 10 seconds across 5 syncs of 2s increments');
  mock.restoreAll();
});

// Test 9: Freeform initial insert computes full duration from started_at to ended_at
test('AUD-041.9: Initial freeform session insert computes correct base duration', async () => {
  const userId = 'user-cm-09';
  setupAuthMock(userId);
  let recordedSec = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recordedSec = params.p_seconds; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', createQueryBuilder());

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-31T02:00:00.000Z',
    ended_at: '2026-08-31T02:01:15.000Z', // 75 seconds
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Turn 1' }]
  });

  assert.strictEqual(recordedSec, 75);
  mock.restoreAll();
});

// Test 10: Missing ended_at in payload returns 400 Bad Request
test('AUD-041.10: Session sync with omitted ended_at strictly rejects with 400', async () => {
  const userId = 'user-cm-10';
  setupAuthMock(userId);
  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date(Date.now() - 10000).toISOString(),
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Omitted ended_at' }]
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /ended_at/i);
  mock.restoreAll();
});

// Test 11: Invalid date string in started_at returns 400 Bad Request
test('AUD-041.11: POST /chat/sessions with invalid started_at timestamp rejects with 400', async () => {
  const userId = 'user-cm-11';
  setupAuthMock(userId);
  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: 'not-a-valid-date-iso-string',
    ended_at: new Date().toISOString(),
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Corrupted date' }]
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /started_at/i);
  mock.restoreAll();
});

// Test 12: Invalid date string in ended_at returns 400 Bad Request
test('AUD-041.12: POST /chat/sessions with invalid ended_at timestamp rejects with 400', async () => {
  const userId = 'user-cm-12';
  setupAuthMock(userId);
  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: 'malformed-ended-at-time',
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Corrupted end date' }]
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /ended_at/i);
  mock.restoreAll();
});

// Test 13: Multiple freeform sessions across the day accumulate linearly
test('AUD-041.13: Multiple distinct freeform sessions on the same day accumulate sequentially', async () => {
  const userId = 'user-cm-13';
  setupAuthMock(userId);
  const recorded = [];
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recorded.push(params.p_seconds); return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', createQueryBuilder());

  const app = buildApp();
  // Session 1: 100s
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-31T01:00:00.000Z',
    ended_at: '2026-08-31T01:01:40.000Z',
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'A' }]
  });

  // Session 2: 200s
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-31T03:00:00.000Z',
    ended_at: '2026-08-31T03:03:20.000Z',
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'B' }]
  });

  const total = recorded.reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 300, 'Expected 100 + 200 = 300 seconds total');
  mock.restoreAll();
});

// Test 14: Single-second micro turn sync accurately passes 1 second delta
test('AUD-041.14: 1-second micro-turn sync accurately records 1 second delta', async () => {
  const userId = 'user-cm-14';
  setupAuthMock(userId);
  let recordedSec = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recordedSec = params.p_seconds; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', createQueryBuilder());

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-31T02:00:00.000Z',
    ended_at: '2026-08-31T02:00:01.000Z', // exactly 1 second
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Hi' }]
  });

  assert.strictEqual(recordedSec, 1);
  mock.restoreAll();
});

// Test 15: Empty messages array on POST /chat/sessions strictly returns 400
test('AUD-041.15: POST /chat/sessions with empty messages array rejects with 400', async () => {
  const userId = 'user-cm-15';
  setupAuthMock(userId);
  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-31T02:00:00.000Z',
    ended_at: '2026-08-31T02:00:00.000Z',
    session_type: 'freeform',
    messages: []
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /messages/i);
  mock.restoreAll();
});

// Test 16: DB error on session save returns structured 500
test('AUD-041.16: Database failure on session insert returns structured 500', async () => {
  const userId = 'user-cm-16';
  setupAuthMock(userId);
  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true }], error: null }));
  mock.method(supabaseAdmin, 'from', () => {
    throw new Error('Database connection reset');
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date(Date.now() - 30000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Turn 1' }]
  });

  assert.strictEqual(res.status, 500);
  mock.restoreAll();
});

// Test 17: Long session spanning 1 hour (3600 seconds) records exact duration
test('AUD-041.17: Long 1-hour session accurately computes 3600 seconds', async () => {
  const userId = 'user-cm-17';
  setupAuthMock(userId);
  let recordedSec = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recordedSec = params.p_seconds; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', createQueryBuilder());

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-31T01:00:00.000Z',
    ended_at: '2026-08-31T02:00:00.000Z',
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Marathon practice' }]
  });

  assert.strictEqual(recordedSec, 3600);
  mock.restoreAll();
});

// Test 18: Timestamp across midnight IST computes correct ist_date
test('AUD-041.18: Midnight crossing session sync passes correct IST date', async () => {
  const userId = 'user-cm-18';
  setupAuthMock(userId);
  let passedDate = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { passedDate = params.p_ist_date; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', createQueryBuilder());

  const app = buildApp();
  // 18:35 UTC = 00:05 IST on 2026-09-01
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-31T18:35:00.000Z',
    ended_at: '2026-08-31T18:40:00.000Z',
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Late night' }]
  });

  assert.strictEqual(passedDate, '2026-09-01');
  mock.restoreAll();
});

// Test 19: Scenario session sync passes kind: 'scenario' with 0 seconds
test('AUD-041.19: Completed scenario awards kind=scenario and does not add chat seconds', async () => {
  const userId = 'user-cm-19';
  setupAuthMock(userId);
  let recordedParams = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recordedParams = params; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', createQueryBuilder());

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-31T02:00:00.000Z',
    ended_at: '2026-08-31T02:03:00.000Z',
    session_type: 'scenario',
    scenario_key: 'hotel',
    is_completed: true,
    messages: [{ role: 'user', content: 'Finished' }]
  });

  assert.strictEqual(recordedParams.p_kind, 'scenario');
  assert.strictEqual(recordedParams.p_seconds, 0);
  mock.restoreAll();
});

// Test 20: Non-string scenario_key is rejected with 400 validation error
test('AUD-041.20: Non-string scenario_key object payload is rejected with 400', async () => {
  const userId = 'user-cm-20';
  setupAuthMock(userId);
  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: { injection: true },
    messages: [{ role: 'user', content: 'Object injection' }]
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /scenario_key/i);
  mock.restoreAll();
});

// Test 21: Extremely large duration (>86400s) handles safely without crash
test('AUD-041.21: Multi-day session duration handles arithmetic without overflow', async () => {
  const userId = 'user-cm-21';
  setupAuthMock(userId);
  let recordedSec = null;
  mock.method(supabaseAdmin, 'rpc', async (fnName, params) => {
    if (fnName === 'consume_access') return { data: [{ allowed: true }], error: null };
    if (fnName === 'record_commit_mode_progress') { recordedSec = params.p_seconds; return { data: null }; }
    return { data: null };
  });

  mock.method(supabaseAdmin, 'from', createQueryBuilder());

  const app = buildApp();
  await request(app, 'POST', '/chat/sessions', {
    session_id: null,
    started_at: '2026-08-20T00:00:00.000Z',
    ended_at: '2026-08-21T00:00:00.000Z', // 86400 seconds
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Long sync' }]
  });

  assert.strictEqual(recordedSec, 86400);
  mock.restoreAll();
});
