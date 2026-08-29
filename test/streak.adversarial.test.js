const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const { calculateStreak, getUserStreak, istDateString, shiftIstDate } = require('../lib/streak');
const { supabaseAnon, supabaseAdmin } = require('../lib/supabaseClient');
const chatRoutes = require('../routes/chatRoutes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/chat', chatRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

async function request(app, method, path, headers = {}) {
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
// BACKEND ADVERSARIAL SUITE — Issue #6 (AUD-006: Practice Streak Calculator & Query Bounds)
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: Massive Scale & Unbounded Session Volume Stress (AUD-006 Memory Defense)
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-006 SCALE: computes streak correctly across 5,000 historical sessions without memory leak or slowdown', () => {
  // Why this matters: Power users with 2+ years of daily sessions and multiple sessions per day
  // must not degrade server performance or crash memory.
  const refDate = new Date('2026-08-29T14:00:00.000Z'); // 2026-08-29 in IST
  const timestamps = [];

  // Generate 1,000 consecutive days of practice with 5 sessions per day (5,000 total sessions)
  let currIst = istDateString(refDate);
  for (let d = 0; d < 1000; d++) {
    const [y, m, day] = currIst.split('-').map(Number);
    for (let s = 0; s < 5; s++) {
      // 5 sessions throughout each day (04:00, 08:00, 12:00, 16:00, 20:00 IST)
      const hourUtc = s * 3;
      const iso = new Date(Date.UTC(y, m - 1, day, hourUtc, 0, 0)).toISOString();
      timestamps.push(iso);
    }
    currIst = shiftIstDate(currIst, -1);
  }

  const startTime = Date.now();
  const res = calculateStreak(timestamps, refDate);
  const elapsedMs = Date.now() - startTime;

  assert.strictEqual(res.current_streak, 1000);
  assert.strictEqual(res.best_streak, 1000);
  assert.strictEqual(res.practiced_today, true);
  assert.strictEqual(res.total_practice_days, 1000);
  assert.ok(elapsedMs < 500, `Streak calculation took ${elapsedMs}ms, expected under 500ms`);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: Human Behavior Edge Cases & Out-of-Order Synchronizations
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-006 HUMAN: out-of-order session syncing (offline device sync) resolves to correct ascending streak', () => {
  // Why this matters: User was offline for 3 days; phone reconnects and syncs sessions in arbitrary reverse order.
  const refDate = new Date('2026-08-29T14:00:00.000Z'); // 2026-08-29
  const shuffledSessions = [
    '2026-08-28T04:00:00.000Z', // day -1
    '2026-08-26T04:00:00.000Z', // day -3
    '2026-08-29T04:00:00.000Z', // today
    '2026-08-27T04:00:00.000Z', // day -2
    '2026-08-25T04:00:00.000Z'  // day -4
  ];

  const res = calculateStreak(shuffledSessions, refDate);
  assert.strictEqual(res.current_streak, 5);
  assert.strictEqual(res.best_streak, 5);
  assert.strictEqual(res.practiced_today, true);
  assert.strictEqual(res.total_practice_days, 5);
});

test('AUD-006 HUMAN: rapid spam / retry of 50 sessions in one hour collapses to 1 unique practice day', () => {
  // Why this matters: User retries 50 times in an hour or network retries spam identical day.
  const refDate = new Date('2026-08-29T14:00:00.000Z');
  const spamSessions = Array.from({ length: 50 }, (_, i) =>
    new Date(Date.UTC(2026, 7, 29, 6, i, 0)).toISOString()
  );

  const res = calculateStreak(spamSessions, refDate);
  assert.strictEqual(res.current_streak, 1);
  assert.strictEqual(res.best_streak, 1);
  assert.strictEqual(res.total_practice_days, 1);
});

test('AUD-006 HUMAN: multiple historical streaks accurately retains highest best_streak', () => {
  // Why this matters: User had 10-day streak in Jan, 3-day streak in Feb, and 4-day streak ending yesterday.
  const refDate = new Date('2026-08-29T14:00:00.000Z'); // Aug 29
  const sessions = [
    // Streak 1: 10 days in Jan (2026-01-01 to 2026-01-10)
    ...Array.from({ length: 10 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}T06:00:00.000Z`),
    // Streak 2: 3 days in Feb (2026-02-05 to 2026-02-07)
    '2026-02-05T06:00:00.000Z', '2026-02-06T06:00:00.000Z', '2026-02-07T06:00:00.000Z',
    // Streak 3: 4 days ending yesterday (2026-08-25 to 2026-08-28)
    '2026-08-25T06:00:00.000Z', '2026-08-26T06:00:00.000Z', '2026-08-27T06:00:00.000Z', '2026-08-28T06:00:00.000Z'
  ];

  const res = calculateStreak(sessions, refDate);
  assert.strictEqual(res.current_streak, 4, 'Current streak is 4 (practiced yesterday)');
  assert.strictEqual(res.best_streak, 10, 'Best streak must remain 10 from Jan');
  assert.strictEqual(res.practiced_today, false);
  assert.strictEqual(res.total_practice_days, 17);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: Calendar Transitions, Leap Years & IST Midnight Boundaries
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-006 CALENDAR: leap year continuity across Feb 28 -> Feb 29 -> Mar 1', () => {
  // Why this matters: In leap years (e.g. 2028), February has 29 days. Missing leap day detection breaks streaks.
  const refDate = new Date('2028-03-01T14:00:00.000Z'); // 2028-03-01 IST
  const leapSessions = [
    '2028-02-28T06:00:00.000Z', // Feb 28, 2028
    '2028-02-29T06:00:00.000Z', // Feb 29, 2028 (Leap day!)
    '2028-03-01T06:00:00.000Z'  // Mar 01, 2028 (Today)
  ];

  const res = calculateStreak(leapSessions, refDate);
  assert.strictEqual(res.current_streak, 3);
  assert.strictEqual(res.best_streak, 3);
  assert.strictEqual(res.practiced_today, true);
  assert.strictEqual(res.total_practice_days, 3);
});

test('AUD-006 CALENDAR: year boundary transition across Dec 31 -> Jan 01', () => {
  // Why this matters: Year increment must not break daily sequence continuity.
  const refDate = new Date('2027-01-02T14:00:00.000Z'); // 2027-01-02 IST
  const yearEndSessions = [
    '2026-12-30T06:00:00.000Z',
    '2026-12-31T06:00:00.000Z',
    '2027-01-01T06:00:00.000Z',
    '2027-01-02T06:00:00.000Z'
  ];

  const res = calculateStreak(yearEndSessions, refDate);
  assert.strictEqual(res.current_streak, 4);
  assert.strictEqual(res.best_streak, 4);
  assert.strictEqual(res.practiced_today, true);
});

test('AUD-006 MIDNIGHT: late-night practice across IST midnight counts as two consecutive calendar days', () => {
  // Why this matters: User practices at 11:58 PM IST and again at 12:02 AM IST.
  // 11:58 PM IST = 18:28 UTC. 12:02 AM IST = 18:32 UTC (next IST day).
  const session1Utc = new Date('2026-08-28T18:28:00.000Z'); // 2026-08-28 23:58 IST
  const session2Utc = new Date('2026-08-28T18:32:00.000Z'); // 2026-08-29 00:02 IST
  const refDate = new Date('2026-08-29T04:00:00.000Z');     // 2026-08-29 09:30 IST

  const res = calculateStreak([session1Utc, session2Utc], refDate);
  assert.strictEqual(res.current_streak, 2);
  assert.strictEqual(res.best_streak, 2);
  assert.strictEqual(res.practiced_today, true);
  assert.strictEqual(res.total_practice_days, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: Malformed Data & Defensive Input Sanitization
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-006 DEFENSE: handles null, undefined, boolean, empty strings and invalid epoch timestamps gracefully', () => {
  // Why this matters: Dirty DB records or client serialization bugs must never crash calculation.
  const refDate = new Date('2026-08-29T14:00:00.000Z');
  const dirtyTimestamps = [
    null,
    undefined,
    false,
    '',
    'invalid-iso-string',
    '2026-99-99T99:99:99Z',
    NaN,
    {},
    [],
    '2026-08-29T06:00:00.000Z' // 1 valid today session
  ];

  const res = calculateStreak(dirtyTimestamps, refDate);
  assert.strictEqual(res.current_streak, 1);
  assert.strictEqual(res.best_streak, 1);
  assert.strictEqual(res.practiced_today, true);
  assert.strictEqual(res.total_practice_days, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: Database Query Resilience & Route Integration
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-006 DB: getUserStreak returns safe fail-open fallback when database connection fails', async () => {
  // Why this matters: If Supabase throws or disconnects, streak widget must not crash the whole app.
  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        gt: () => ({
          order: () => ({
            limit: async () => ({
              data: null,
              error: { message: 'Connection pool exhausted' }
            })
          })
        })
      })
    })
  }));

  const res = await getUserStreak('user-fail-db');
  assert.strictEqual(res.current_streak, 0);
  assert.strictEqual(res.best_streak, 0);
  assert.strictEqual(res.practiced_today, false);
  assert.strictEqual(res.total_practice_days, 0);

  mock.restoreAll();
});

test('AUD-006 DB: getUserStreak returns zero stats immediately for null or empty userId without DB call', async () => {
  // Why this matters: Protects against unauthenticated or bad caller UUIDs.
  const resNull = await getUserStreak(null);
  assert.strictEqual(resNull.current_streak, 0);

  const resEmpty = await getUserStreak('');
  assert.strictEqual(resEmpty.current_streak, 0);
});

test('AUD-006 ROUTE: GET /chat/streak returns computed streak for authenticated user', async () => {
  // Why this matters: Verifies end-to-end API response contract with frontends.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-streak-test', email: 'streak@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        gt: () => ({
          order: () => ({
            limit: async () => ({
              data: [
                { started_at: new Date().toISOString() }
              ],
              error: null
            })
          })
        })
      })
    })
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/chat/streak', {
    Authorization: 'Bearer valid-token-user'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.practiced_today, true);
  assert.strictEqual(data.current_streak, 1);

  mock.restoreAll();
});
