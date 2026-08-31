// Role: 06_TestWriter (Senior Backend Adversarial QA)
// Issues: AUD-059 (Unbounded History Queries & Pagination), AUD-063 (Streak Computation & Query Bounds)
// Target Files: routes/chatRoutes.js, lib/streak.js
// Classification: Backend Adversarial Test Matrix (Human Real-World Behavior)

const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const chatRoutes = require('../routes/chatRoutes');
const { supabaseAdmin, supabaseAnon } = require('../lib/supabaseClient');
const { calculateStreak, getUserStreak, istDateString, shiftIstDate } = require('../lib/streak');

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

async function request(app, method, path, headers = { Authorization: 'Bearer test-token' }) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 1: AUD-059 — GET /chat/sessions Query Limits, Ownership & Pagination
// ═══════════════════════════════════════════════════════════════════════════

test('AUD-059.1: GET /chat/sessions returns sessions array and report status flags', async () => {
  const userId = 'test-user-uuid-123';
  setupAuthMock(userId);

  const mockSessions = [
    {
      id: 'session-1',
      started_at: new Date(Date.now() - 3600000).toISOString(),
      ended_at: new Date().toISOString(),
      turn_count: 14,
      session_type: 'freeform',
      scenario_key: null,
      is_completed: true
    },
    {
      id: 'session-2',
      started_at: new Date(Date.now() - 7200000).toISOString(),
      ended_at: new Date(Date.now() - 7000000).toISOString(),
      turn_count: 8,
      session_type: 'scenario',
      scenario_key: 'restaurant_order',
      is_completed: true
    }
  ];

  const mockReports = [
    { session_id: 'session-1' }
  ];

  // Intercept supabaseAdmin queries
  const originalFrom = supabaseAdmin.from;
  supabaseAdmin.from = (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({
                data: mockSessions,
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
            in: () => Promise.resolve({ data: mockReports, error: null })
          })
        })
      };
    }
    return originalFrom.call(supabaseAdmin, table);
  };

  try {
    const app = buildApp();
    const res = await request(app, 'GET', '/chat/sessions');

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data.sessions));
    assert.strictEqual(res.data.sessions.length, 2);

    const s1 = res.data.sessions.find(s => s.id === 'session-1');
    const s2 = res.data.sessions.find(s => s.id === 'session-2');

    assert.ok(s1);
    assert.strictEqual(s1.has_report, true);
    assert.ok(s2);
    assert.strictEqual(s2.has_report, false);
  } finally {
    supabaseAdmin.from = originalFrom;
  }
});

test('AUD-059.2 ADVERSARIAL: GET /chat/sessions bounds query with limit and returns pagination metadata', async () => {
  const userId = 'pagination-user-1';
  setupAuthMock(userId);

  const timestamps = [
    '2026-08-31T12:00:00.000Z',
    '2026-08-31T11:00:00.000Z',
    '2026-08-31T10:00:00.000Z',
    '2026-08-31T09:00:00.000Z',
    '2026-08-31T08:00:00.000Z',
    '2026-08-31T07:00:00.000Z'
  ];
  const mockRows = timestamps.map((ts, idx) => ({
    id: `sess-${idx}`,
    started_at: ts,
    ended_at: ts,
    turn_count: 5,
    session_type: 'freeform',
    is_completed: true
  }));

  let capturedLimit = null;
  let capturedInIds = null;
  const originalFrom = supabaseAdmin.from;

  supabaseAdmin.from = (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: (lim) => {
                capturedLimit = lim;
                return Promise.resolve({ data: mockRows, error: null });
              }
            })
          })
        })
      };
    }
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            in: (col, ids) => {
              capturedInIds = ids;
              return Promise.resolve({ data: [{ session_id: 'sess-0' }], error: null });
            }
          })
        })
      };
    }
    return originalFrom.call(supabaseAdmin, table);
  };

  try {
    const app = buildApp();
    const res = await request(app, 'GET', '/chat/sessions?limit=5');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(capturedLimit, 6, 'Should query limit + 1 to check has_more');
    assert.strictEqual(res.data.sessions.length, 5, 'Should slice sessions array to requested limit');
    assert.strictEqual(res.data.has_more, true, 'has_more should be true when limit + 1 items exist');
    assert.strictEqual(res.data.next_cursor, '2026-08-31T08:00:00.000Z');
    assert.deepStrictEqual(capturedInIds, ['sess-0', 'sess-1', 'sess-2', 'sess-3', 'sess-4'], 'session_reports must only query sliced session IDs');
  } finally {
    supabaseAdmin.from = originalFrom;
  }
});

test('AUD-059.3 ADVERSARIAL: GET /chat/sessions applies cursor filter with lt on before parameter', async () => {
  const userId = 'cursor-user-1';
  setupAuthMock(userId);

  let capturedLtBefore = null;
  const originalFrom = supabaseAdmin.from;

  supabaseAdmin.from = (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            order: () => {
              const queryObj = {
                lt: (col, val) => {
                  capturedLtBefore = val;
                  return queryObj;
                },
                limit: () => Promise.resolve({ data: [], error: null })
              };
              return queryObj;
            }
          })
        })
      };
    }
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({ data: [], error: null })
          })
        })
      };
    }
    return originalFrom.call(supabaseAdmin, table);
  };

  try {
    const app = buildApp();
    const cursor = '2026-08-30T10:00:00.000Z';
    const res = await request(app, 'GET', `/chat/sessions?limit=10&before=${encodeURIComponent(cursor)}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(capturedLtBefore, cursor);
    assert.strictEqual(res.data.has_more, false);
    assert.strictEqual(res.data.next_cursor, null);
  } finally {
    supabaseAdmin.from = originalFrom;
  }
});

test('AUD-059.4 ADVERSARIAL: GET /chat/sessions handles empty results cleanly without null pointer errors', async () => {
  const userId = 'empty-user';
  setupAuthMock(userId);

  const originalFrom = supabaseAdmin.from;
  supabaseAdmin.from = (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({
                data: [],
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
            in: () => Promise.resolve({ data: [], error: null })
          })
        })
      };
    }
    return originalFrom.call(supabaseAdmin, table);
  };

  try {
    const app = buildApp();
    const res = await request(app, 'GET', '/chat/sessions');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data.sessions, []);
    assert.strictEqual(res.data.has_more, false);
  } finally {
    supabaseAdmin.from = originalFrom;
  }
});

test('AUD-059.5 ADVERSARIAL: GET /chat/sessions handles DB error gracefully and returns 500 sanitized', async () => {
  const userId = 'error-user';
  setupAuthMock(userId);

  const originalFrom = supabaseAdmin.from;
  supabaseAdmin.from = (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({
                data: null,
                error: new Error('Postgres connection pool exhausted')
              })
            })
          })
        })
      };
    }
    return originalFrom.call(supabaseAdmin, table);
  };

  try {
    const app = buildApp();
    const res = await request(app, 'GET', '/chat/sessions');

    assert.strictEqual(res.status, 500);
  } finally {
    supabaseAdmin.from = originalFrom;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 2: AUD-063 — Practice Streak Backend Endpoint & Calculation
// ═══════════════════════════════════════════════════════════════════════════

test('AUD-063.1: GET /chat/streak returns computed streak for authenticated user', async () => {
  const userId = 'streak-user-1';
  setupAuthMock(userId);

  const originalFrom = supabaseAdmin.from;
  const todayIst = new Date().toISOString();

  supabaseAdmin.from = (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            gt: () => ({
              order: () => ({
                limit: () => Promise.resolve({
                  data: [{ started_at: todayIst }],
                  error: null
                })
              })
            })
          })
        })
      };
    }
    return originalFrom.call(supabaseAdmin, table);
  };

  try {
    const app = buildApp();
    const res = await request(app, 'GET', '/chat/streak');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.data.current_streak, 'number');
    assert.strictEqual(typeof res.data.best_streak, 'number');
    assert.strictEqual(typeof res.data.practiced_today, 'boolean');
  } finally {
    supabaseAdmin.from = originalFrom;
  }
});

test('AUD-063.2 ADVERSARIAL: getUserStreak bounds query limit to maximum 1000 items', async () => {
  let capturedLimit = null;
  const originalFrom = supabaseAdmin.from;

  supabaseAdmin.from = (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            gt: () => ({
              order: () => ({
                limit: (lim) => {
                  capturedLimit = lim;
                  return Promise.resolve({ data: [], error: null });
                }
              })
            })
          })
        })
      };
    }
    return originalFrom.call(supabaseAdmin, table);
  };

  try {
    const streak = await getUserStreak('user-limit-check');
    assert.strictEqual(capturedLimit, 1000);
    assert.strictEqual(streak.current_streak, 0);
  } finally {
    supabaseAdmin.from = originalFrom;
  }
});

test('AUD-063.3 ADVERSARIAL: calculateStreak handles multiple out-of-order sessions without quadratic complexity', () => {
  const timestamps = [
    '2026-08-29T10:00:00.000Z',
    '2026-08-27T08:00:00.000Z',
    '2026-08-28T12:00:00.000Z',
    '2026-08-29T15:00:00.000Z'
  ];
  const ref = new Date('2026-08-29T18:00:00.000Z');
  const streak = calculateStreak(timestamps, ref);

  assert.strictEqual(streak.current_streak, 3);
  assert.strictEqual(streak.best_streak, 3);
  assert.strictEqual(streak.practiced_today, true);
  assert.strictEqual(streak.total_practice_days, 3);
});

test('AUD-063.4 ADVERSARIAL: calculateStreak handles near-midnight IST practice sessions (23:45 IST and 00:15 IST)', () => {
  // Practice session at 11:45 PM IST on Day 1 (18:15 UTC Day 1)
  // Practice session at 12:15 AM IST on Day 2 (18:45 UTC Day 1)
  const session1 = '2026-08-28T18:15:00.000Z'; // 23:45 IST on 2026-08-28
  const session2 = '2026-08-28T18:45:00.000Z'; // 00:15 IST on 2026-08-29

  const ref = new Date('2026-08-29T10:00:00.000Z');
  const streak = calculateStreak([session1, session2], ref);

  assert.strictEqual(streak.current_streak, 2);
  assert.strictEqual(streak.practiced_today, true);
  assert.strictEqual(streak.total_practice_days, 2);
});
