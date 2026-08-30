const { test, mock } = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const { supabaseAdmin } = require('../lib/supabaseClient');
const { istDateString } = require('../lib/commitMode');
const { runCommitModeMidnightSweep, judgeOneUser, getUserCommitModeEnrollmentDate } = require('../lib/commitModeEnforcer');

/**
 * Robust in-memory mock harness for Supabase tables:
 * - profiles
 * - payments
 * - commit_mode_consents
 * - commit_mode_daily_progress
 */
function setupDatabaseMock({
  users = [],
  payments = [],
  consents = [],
  progressRows = [],
  paymentsError = null,
  consentsError = null
}) {
  const state = {
    profiles: JSON.parse(JSON.stringify(users)),
    payments: JSON.parse(JSON.stringify(payments)),
    consents: JSON.parse(JSON.stringify(consents)),
    progress: JSON.parse(JSON.stringify(progressRows)),
    terminationUpdates: [],
    progressUpdates: []
  };

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') {
      let gtId = null;
      const builder = {
        select: () => builder,
        eq: (col, val) => {
          return {
            ...builder,
            gt: (gtCol, gtVal) => {
              gtId = gtVal;
              return builder;
            },
            order: () => ({
              limit: (limitCount) => {
                let filtered = state.profiles.filter(p => p[col] === val);
                if (gtId) {
                  filtered = filtered.filter(p => p.id > gtId);
                }
                const page = filtered.slice(0, limitCount);
                return Promise.resolve({ data: page, error: null });
              }
            })
          };
        },
        update: (updates) => ({
          eq: (col1, val1) => ({
            eq: (col2, val2) => {
              state.terminationUpdates.push({ userId: val1, requiredPlan: val2, updates });
              const target = state.profiles.find(p => p.id === val1 && p[col2] === val2);
              if (target) {
                Object.assign(target, updates);
              }
              return Promise.resolve({ error: null });
            }
          })
        })
      };
      return builder;
    }

    if (table === 'payments') {
      return {
        select: () => ({
          eq: (col1, val1) => ({
            eq: (col2, val2) => ({
              eq: (col3, val3) => ({
                order: (orderCol, { ascending } = {}) => ({
                  limit: () => ({
                    maybeSingle: () => {
                      if (paymentsError) {
                        return Promise.resolve({ data: null, error: paymentsError });
                      }
                      const matches = state.payments
                        .filter(p => p[col1] === val1 && p[col2] === val2 && p[col3] === val3)
                        .sort((a, b) => {
                          const aTime = new Date(a[orderCol] || 0).getTime();
                          const bTime = new Date(b[orderCol] || 0).getTime();
                          return ascending ? aTime - bTime : bTime - aTime;
                        });
                      return Promise.resolve({ data: matches[0] || null, error: null });
                    }
                  })
                })
              })
            })
          })
        })
      };
    }

    if (table === 'commit_mode_consents') {
      return {
        select: () => ({
          eq: (col1, val1) => ({
            order: (orderCol, { ascending } = {}) => ({
              limit: () => ({
                maybeSingle: () => {
                  if (consentsError) {
                    return Promise.resolve({ data: null, error: consentsError });
                  }
                  const matches = state.consents
                    .filter(c => c[col1] === val1)
                    .sort((a, b) => {
                      const aTime = new Date(a[orderCol] || 0).getTime();
                      const bTime = new Date(b[orderCol] || 0).getTime();
                      return ascending ? aTime - bTime : bTime - aTime;
                    });
                  return Promise.resolve({ data: matches[0] || null, error: null });
                }
              })
            })
          })
        })
      };
    }

    if (table === 'commit_mode_daily_progress') {
      return {
        insert: (row) => ({
          select: () => ({
            maybeSingle: () => {
              const existing = state.progress.find(p => p.user_id === row.user_id && p.ist_date === row.ist_date);
              if (existing) {
                const err = new Error('Unique violation');
                err.code = '23505';
                return Promise.resolve({ data: null, error: err });
              }
              const created = {
                id: `prog-${state.progress.length + 1}`,
                user_id: row.user_id,
                ist_date: row.ist_date,
                chat_requirement_met: false,
                scenario_requirement_met: false,
                judged_at: null,
                judged_result: null
              };
              state.progress.push(created);
              return Promise.resolve({ data: created, error: null });
            }
          })
        }),
        select: () => ({
          eq: (col1, val1) => ({
            eq: (col2, val2) => ({
              single: () => {
                const found = state.progress.find(p => p[col1] === val1 && p[col2] === val2);
                if (!found) {
                  return Promise.resolve({ data: null, error: new Error('Not found') });
                }
                return Promise.resolve({ data: found, error: null });
              }
            })
          })
        }),
        update: (updates) => ({
          eq: (col1, val1) => ({
            is: (col2, val2) => {
              state.progressUpdates.push({ id: val1, isCol: col2, isVal: val2, updates });
              const found = state.progress.find(p => p.id === val1 && p[col2] === val2);
              if (found) {
                Object.assign(found, updates);
              }
              return Promise.resolve({ error: null });
            }
          })
        })
      };
    }

    throw new Error(`Unexpected table: ${table}`);
  });

  return state;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. BASELINE ADVERSARIAL: Same-day enrollment protection
// ══════════════════════════════════════════════════════════════════════════════

// Why this matters: Verifies that newly enrolled users who paid today are NOT prematurely
// judged or terminated by midnight sweep evaluating yesterday's missing progress.
test('AUD-021 ADVERSARIAL: User subscribing TODAY is skipped by midnight sweep evaluating yesterday', async () => {
  const yesterdayIst = istDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const nowIso = new Date().toISOString();

  const users = [
    {
      id: 'user-new-today',
      plan: 'commit_mode',
      plan_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: nowIso
    }
  ];

  const payments = [
    {
      user_id: 'user-new-today',
      plan: 'commit_mode',
      status: 'paid',
      paid_at: nowIso,
      created_at: nowIso
    }
  ];

  const state = setupDatabaseMock({ users, payments });

  const result = await runCommitModeMidnightSweep();

  assert.strictEqual(result.checked, 1, 'Should check 1 active user');
  assert.strictEqual(result.skipped, 1, 'Same-day subscriber must be skipped');
  assert.strictEqual(result.terminated, 0, 'Same-day subscriber must NOT be terminated');
  assert.strictEqual(result.kept, 0, 'Same-day subscriber was not active yesterday');

  const userProfile = state.profiles.find(p => p.id === 'user-new-today');
  assert.strictEqual(userProfile.plan, 'commit_mode', 'Plan must remain commit_mode');
  assert.strictEqual(state.terminationUpdates.length, 0, 'No termination updates should execute');

  const yesterdayProgress = state.progress.find(p => p.user_id === 'user-new-today' && p.ist_date === yesterdayIst);
  assert.strictEqual(yesterdayProgress, undefined, 'No progress row for yesterday should be synthesized for today subscriber');

  mock.restoreAll();
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. PRIOR-DAY ENROLLMENTS: Met vs Missed Evaluation
// ══════════════════════════════════════════════════════════════════════════════

// Why this matters: Verifies that users enrolled on or before yesterday who fulfilled daily requirements are KEPT.
test('AUD-021 ADVERSARIAL: User enrolled yesterday who completed commitments is KEPT', async () => {
  const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const yesterdayIst = istDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const users = [
    {
      id: 'user-enrolled-yesterday-met',
      plan: 'commit_mode',
      plan_expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString()
    }
  ];

  const payments = [
    {
      user_id: 'user-enrolled-yesterday-met',
      plan: 'commit_mode',
      status: 'paid',
      paid_at: yesterdayIso
    }
  ];

  const progressRows = [
    {
      id: 'prog-user-1',
      user_id: 'user-enrolled-yesterday-met',
      ist_date: yesterdayIst,
      chat_requirement_met: true,
      scenario_requirement_met: true,
      judged_at: null,
      judged_result: null
    }
  ];

  const state = setupDatabaseMock({ users, payments, progressRows });

  const result = await runCommitModeMidnightSweep();

  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.kept, 1);
  assert.strictEqual(result.terminated, 0);
  assert.strictEqual(result.skipped, 0);

  const userProfile = state.profiles.find(p => p.id === 'user-enrolled-yesterday-met');
  assert.strictEqual(userProfile.plan, 'commit_mode');

  mock.restoreAll();
});

// Why this matters: Verifies that users enrolled on or before yesterday who missed requirements are properly TERMINATED.
test('AUD-021 ADVERSARIAL: User enrolled yesterday who missed commitments is TERMINATED', async () => {
  const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const yesterdayIst = istDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const users = [
    {
      id: 'user-enrolled-yesterday-missed',
      plan: 'commit_mode',
      plan_expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString()
    }
  ];

  const payments = [
    {
      user_id: 'user-enrolled-yesterday-missed',
      plan: 'commit_mode',
      status: 'paid',
      paid_at: yesterdayIso
    }
  ];

  const progressRows = [
    {
      id: 'prog-user-2',
      user_id: 'user-enrolled-yesterday-missed',
      ist_date: yesterdayIst,
      chat_requirement_met: true,
      scenario_requirement_met: false, // missed scenario
      judged_at: null,
      judged_result: null
    }
  ];

  const state = setupDatabaseMock({ users, payments, progressRows });

  const result = await runCommitModeMidnightSweep();

  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.terminated, 1);
  assert.strictEqual(result.kept, 0);
  assert.strictEqual(result.skipped, 0);

  const userProfile = state.profiles.find(p => p.id === 'user-enrolled-yesterday-missed');
  assert.strictEqual(userProfile.plan, 'none');
  assert.strictEqual(userProfile.commit_mode_termination_reason, 'missed_daily_commitment');

  mock.restoreAll();
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. COMPLEX LIFECYCLES: Re-subscriptions and Multi-Payment History
// ══════════════════════════════════════════════════════════════════════════════

// Why this matters: Verifies that users with old terminated subscriptions who re-subscribe today are protected.
test('AUD-021 ADVERSARIAL: Re-subscribing user (past terminated subscription + new subscription today) is SKIPPED today', async () => {
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago

  const users = [
    {
      id: 'user-resubscribed-today',
      plan: 'commit_mode',
      plan_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }
  ];

  const payments = [
    {
      user_id: 'user-resubscribed-today',
      plan: 'commit_mode',
      status: 'paid',
      paid_at: oldIso
    },
    {
      user_id: 'user-resubscribed-today',
      plan: 'commit_mode',
      status: 'paid',
      paid_at: nowIso
    }
  ];

  const state = setupDatabaseMock({ users, payments });

  const result = await runCommitModeMidnightSweep();

  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.terminated, 0);

  const userProfile = state.profiles.find(p => p.id === 'user-resubscribed-today');
  assert.strictEqual(userProfile.plan, 'commit_mode');

  mock.restoreAll();
});

// Why this matters: Verifies that the payment query accurately filters by `plan='commit_mode'` AND `status='paid'`,
// ignoring failed attempts, starter orders, and picking the newest paid commit_mode timestamp.
test('AUD-021 ADVERSARIAL: Multi-payment history (failed attempt + starter plan + old commit mode + new commit mode) picks correct latest paid commit_mode order', async () => {
  const nowIso = new Date().toISOString();
  const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const ninetyDaysAgoIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const users = [
    {
      id: 'user-complex-payments',
      plan: 'commit_mode',
      plan_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }
  ];

  const payments = [
    {
      user_id: 'user-complex-payments',
      plan: 'commit_mode',
      status: 'paid',
      paid_at: ninetyDaysAgoIso // Old expired plan
    },
    {
      user_id: 'user-complex-payments',
      plan: 'commit_mode',
      status: 'failed',
      paid_at: null,
      created_at: nowIso // Failed attempt today
    },
    {
      user_id: 'user-complex-payments',
      plan: 'starter',
      status: 'paid',
      paid_at: yesterdayIso // Starter plan yesterday
    },
    {
      user_id: 'user-complex-payments',
      plan: 'commit_mode',
      status: 'paid',
      paid_at: nowIso // Paid commit_mode today
    }
  ];

  const state = setupDatabaseMock({ users, payments });

  const enrollmentDate = await getUserCommitModeEnrollmentDate('user-complex-payments', users[0]);
  assert.strictEqual(enrollmentDate, nowIso, 'Must resolve to latest paid commit_mode order');

  const result = await runCommitModeMidnightSweep();
  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.terminated, 0);

  mock.restoreAll();
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. TIMEZONE & MIDNIGHT BOUNDARY PRECISION
// ══════════════════════════════════════════════════════════════════════════════

// Why this matters: Verifies that IST midnight calculations are exact (18:30 UTC boundary).
// A user subscribing at 23:59:59 IST yesterday is evaluated for yesterday,
// whereas a user subscribing at 00:00:01 IST today is skipped.
test('AUD-021 ADVERSARIAL: IST midnight boundary precision - user enrolled at 23:59:59 IST yesterday vs 00:00:01 IST today', async () => {
  // IST is UTC+5:30.
  // 2026-08-29 23:59:59 IST is 2026-08-29 18:29:59 UTC
  // 2026-08-30 00:00:01 IST is 2026-08-29 18:30:01 UTC
  const enrolledYesterdayLateUtc = '2026-08-29T18:29:59.000Z'; // 23:59:59 IST of 2026-08-29
  const enrolledTodayEarlyUtc = '2026-08-29T18:30:01.000Z';     // 00:00:01 IST of 2026-08-30

  const yesterdayIst = '2026-08-29';

  const userYesterday = { id: 'user-late-yesterday', plan: 'commit_mode' };
  const userToday = { id: 'user-early-today', plan: 'commit_mode' };

  const payments = [
    { user_id: 'user-late-yesterday', plan: 'commit_mode', status: 'paid', paid_at: enrolledYesterdayLateUtc },
    { user_id: 'user-early-today', plan: 'commit_mode', status: 'paid', paid_at: enrolledTodayEarlyUtc }
  ];

  setupDatabaseMock({ users: [userYesterday, userToday], payments });

  // 1. User enrolled yesterday at 23:59:59 IST has enrolledIstDate = 2026-08-29 (not > yesterdayIst)
  const resYesterday = await judgeOneUser(userYesterday, yesterdayIst);
  // They did nothing yesterday, so they should be terminated
  assert.strictEqual(resYesterday, 'terminated', 'User enrolled yesterday before midnight must be evaluated');

  // 2. User enrolled today at 00:00:01 IST has enrolledIstDate = 2026-08-30 (> yesterdayIst)
  const resToday = await judgeOneUser(userToday, yesterdayIst);
  assert.strictEqual(resToday, 'skipped', 'User enrolled today after midnight must be skipped');

  mock.restoreAll();
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. TIERED FALLBACK HIERARCHY TESTS
// ══════════════════════════════════════════════════════════════════════════════

// Why this matters: Verifies that database query errors on payments table do NOT crash the sweep
// and gracefully fall back to the commit_mode_consents table.
test('AUD-021 ADVERSARIAL: Fallback hierarchy Tier 1 - payments error triggers graceful fallback to consents', async () => {
  const nowIso = new Date().toISOString();

  const users = [
    {
      id: 'user-db-error-payments',
      plan: 'commit_mode',
      plan_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }
  ];

  const consents = [
    {
      user_id: 'user-db-error-payments',
      consented_at: nowIso
    }
  ];

  // Force payments table to throw an error
  setupDatabaseMock({
    users,
    payments: [],
    consents,
    paymentsError: new Error('Payments connection pool timeout')
  });

  const enrollmentDate = await getUserCommitModeEnrollmentDate('user-db-error-payments', users[0]);
  assert.strictEqual(enrollmentDate, nowIso, 'Should fallback to consent date when payments query errors');

  const result = await runCommitModeMidnightSweep();
  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.terminated, 0);

  mock.restoreAll();
});

// Why this matters: Verifies that if both payments and consents are unavailable/erroring,
// the enforcer falls back to profile.plan_expires_at (deriving enrollment date by subtracting 30 days).
test('AUD-021 ADVERSARIAL: Fallback hierarchy Tier 2 - payments empty & consents error triggers fallback to profile.plan_expires_at', async () => {
  // Plan expires in 30 days from now (enrolled today)
  const planExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const users = [
    {
      id: 'user-fallback-plan-expires',
      plan: 'commit_mode',
      plan_expires_at: planExpiresAt
    }
  ];

  setupDatabaseMock({
    users,
    payments: [],
    consents: [],
    consentsError: new Error('Consents table locked')
  });

  const enrollmentDate = await getUserCommitModeEnrollmentDate('user-fallback-plan-expires', users[0]);
  assert.ok(enrollmentDate, 'Must derive enrollment date from plan_expires_at');
  
  const derivedIst = istDateString(new Date(enrollmentDate));
  const todayIst = istDateString();
  assert.strictEqual(derivedIst, todayIst, 'Derived date must match today IST');

  const result = await runCommitModeMidnightSweep();
  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.terminated, 0);

  mock.restoreAll();
});

// Why this matters: Verifies that corrupted plan_expires_at strings fallback to profile.created_at.
test('AUD-021 ADVERSARIAL: Fallback hierarchy Tier 3 - invalid plan_expires_at string triggers fallback to profile.created_at', async () => {
  const nowIso = new Date().toISOString();

  const users = [
    {
      id: 'user-corrupted-plan-expires',
      plan: 'commit_mode',
      plan_expires_at: 'NOT_A_VALID_DATE',
      created_at: nowIso
    }
  ];

  setupDatabaseMock({ users, payments: [], consents: [] });

  const enrollmentDate = await getUserCommitModeEnrollmentDate('user-corrupted-plan-expires', users[0]);
  assert.strictEqual(enrollmentDate, nowIso, 'Must fallback to created_at when plan_expires_at is invalid');

  const result = await runCommitModeMidnightSweep();
  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.terminated, 0);

  mock.restoreAll();
});

// Why this matters: Verifies that if no enrollment date can be resolved at all (legacy user without metadata),
// the system defaults to evaluating yesterday rather than crashing or hanging.
test('AUD-021 ADVERSARIAL: Fallback hierarchy Tier 4 - completely unresolvable enrollment date safely defaults to standard yesterday judgment', async () => {
  const yesterdayIst = istDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const users = [
    {
      id: 'user-legacy-no-metadata',
      plan: 'commit_mode',
      plan_expires_at: null,
      created_at: null
    }
  ];

  const state = setupDatabaseMock({ users, payments: [], consents: [] });

  const enrollmentDate = await getUserCommitModeEnrollmentDate('user-legacy-no-metadata', users[0]);
  assert.strictEqual(enrollmentDate, null, 'Must return null for unresolvable user');

  const result = await judgeOneUser(users[0], yesterdayIst);
  assert.strictEqual(result, 'terminated', 'Unresolvable user with no progress is evaluated and terminated');

  const userProfile = state.profiles.find(p => p.id === 'user-legacy-no-metadata');
  assert.strictEqual(userProfile.plan, 'none');

  mock.restoreAll();
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. INVOCATION FLEXIBILITY & CLOCK DRIFT
// ══════════════════════════════════════════════════════════════════════════════

// Why this matters: Verifies that judgeOneUser works whether passed a profile object or just a string userId.
test('AUD-021 ADVERSARIAL: Direct judgeOneUser invocation with string userId vs userProfile object', async () => {
  const nowIso = new Date().toISOString();
  const yesterdayIst = istDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const users = [
    { id: 'user-str-id', plan: 'commit_mode', created_at: nowIso },
    { id: 'user-obj-id', plan: 'commit_mode', created_at: nowIso }
  ];

  const payments = [
    { user_id: 'user-str-id', plan: 'commit_mode', status: 'paid', paid_at: nowIso },
    { user_id: 'user-obj-id', plan: 'commit_mode', status: 'paid', paid_at: nowIso }
  ];

  setupDatabaseMock({ users, payments });

  // 1. Invocation with string userId
  const res1 = await judgeOneUser('user-str-id', yesterdayIst);
  assert.strictEqual(res1, 'skipped', 'String userId invocation should skip today subscriber');

  // 2. Invocation with profile object
  const res2 = await judgeOneUser(users[1], yesterdayIst);
  assert.strictEqual(res2, 'skipped', 'Profile object invocation should skip today subscriber');

  mock.restoreAll();
});

// Why this matters: Verifies that future-dated enrollments (e.g. clock drift or future activation) are skipped.
test('AUD-021 ADVERSARIAL: Future-dated enrollment (clock drift / scheduled activation) is safely skipped', async () => {
  const tomorrowIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const yesterdayIst = istDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const users = [
    {
      id: 'user-future-drift',
      plan: 'commit_mode',
      plan_expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString()
    }
  ];

  const payments = [
    {
      user_id: 'user-future-drift',
      plan: 'commit_mode',
      status: 'paid',
      paid_at: tomorrowIso
    }
  ];

  setupDatabaseMock({ users, payments });

  const result = await judgeOneUser(users[0], yesterdayIst);
  assert.strictEqual(result, 'skipped', 'Future-dated enrollment must be skipped');

  mock.restoreAll();
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. LARGE MULTI-USER BATCH AGGREGATION & IDEMPOTENCY
// ══════════════════════════════════════════════════════════════════════════════

// Why this matters: Verifies that running midnight sweep against a diverse 50-user population
// correctly partitions into skipped, kept, and terminated without leaking state or dropping records.
test('AUD-021 ADVERSARIAL: Large multi-user batch (50 users across skipped, kept, terminated, consent-only) accurately aggregates counters and updates profiles', async () => {
  const nowIso = new Date().toISOString();
  const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const yesterdayIst = istDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const users = [];
  const payments = [];
  const consents = [];
  const progressRows = [];

  // Group 1: 15 Users subscribed today (should be skipped)
  for (let i = 1; i <= 15; i++) {
    const id = `u-today-${i}`;
    users.push({ id, plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() });
    payments.push({ user_id: id, plan: 'commit_mode', status: 'paid', paid_at: nowIso });
  }

  // Group 2: 15 Users enrolled yesterday with met commitments (should be kept)
  for (let i = 1; i <= 15; i++) {
    const id = `u-kept-${i}`;
    users.push({ id, plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString() });
    payments.push({ user_id: id, plan: 'commit_mode', status: 'paid', paid_at: yesterdayIso });
    progressRows.push({
      id: `prog-kept-${i}`,
      user_id: id,
      ist_date: yesterdayIst,
      chat_requirement_met: true,
      scenario_requirement_met: true,
      judged_at: null
    });
  }

  // Group 3: 15 Users enrolled yesterday with missed commitments (should be terminated)
  for (let i = 1; i <= 15; i++) {
    const id = `u-term-${i}`;
    users.push({ id, plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString() });
    payments.push({ user_id: id, plan: 'commit_mode', status: 'paid', paid_at: yesterdayIso });
    progressRows.push({
      id: `prog-term-${i}`,
      user_id: id,
      ist_date: yesterdayIst,
      chat_requirement_met: false,
      scenario_requirement_met: false,
      judged_at: null
    });
  }

  // Group 4: 5 Users subscribed today via promotional consent only (should be skipped)
  for (let i = 1; i <= 5; i++) {
    const id = `u-consent-today-${i}`;
    users.push({ id, plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() });
    consents.push({ user_id: id, consented_at: nowIso });
  }

  const state = setupDatabaseMock({ users, payments, consents, progressRows });

  const result = await runCommitModeMidnightSweep();

  assert.strictEqual(result.checked, 50, 'Must process all 50 users');
  assert.strictEqual(result.skipped, 20, '15 paid-today + 5 consent-today = 20 skipped');
  assert.strictEqual(result.kept, 15, '15 met users kept');
  assert.strictEqual(result.terminated, 15, '15 missed users terminated');

  // Verify plan statuses in mock state
  const activeCount = state.profiles.filter(p => p.plan === 'commit_mode').length;
  const terminatedCount = state.profiles.filter(p => p.plan === 'none').length;
  assert.strictEqual(activeCount, 35, '35 users should remain on commit_mode');
  assert.strictEqual(terminatedCount, 15, '15 users should be terminated');

  mock.restoreAll();
});

// Why this matters: Verifies that consecutive sweep invocations are completely idempotent.
test('AUD-021 ADVERSARIAL: Double execution idempotency - consecutive sweep executions do not double-terminate or corrupt skipped users', async () => {
  const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const yesterdayIst = istDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const todayIso = new Date().toISOString();

  const users = [
    { id: 'u-idemp-today', plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
    { id: 'u-idemp-kept', plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString() },
    { id: 'u-idemp-term', plan: 'commit_mode', plan_expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString() }
  ];

  const payments = [
    { user_id: 'u-idemp-today', plan: 'commit_mode', status: 'paid', paid_at: todayIso },
    { user_id: 'u-idemp-kept', plan: 'commit_mode', status: 'paid', paid_at: yesterdayIso },
    { user_id: 'u-idemp-term', plan: 'commit_mode', status: 'paid', paid_at: yesterdayIso }
  ];

  const progressRows = [
    {
      id: 'p-kept',
      user_id: 'u-idemp-kept',
      ist_date: yesterdayIst,
      chat_requirement_met: true,
      scenario_requirement_met: true,
      judged_at: null
    },
    {
      id: 'p-term',
      user_id: 'u-idemp-term',
      ist_date: yesterdayIst,
      chat_requirement_met: false,
      scenario_requirement_met: false,
      judged_at: null
    }
  ];

  const state = setupDatabaseMock({ users, payments, progressRows });

  // First execution
  const run1 = await runCommitModeMidnightSweep();
  assert.strictEqual(run1.checked, 3);
  assert.strictEqual(run1.skipped, 1);
  assert.strictEqual(run1.kept, 1);
  assert.strictEqual(run1.terminated, 1);

  // Second execution (re-run sweep immediately)
  // `u-idemp-term` is now plan='none', so only 2 active commit_mode users remain
  const run2 = await runCommitModeMidnightSweep();
  assert.strictEqual(run2.checked, 2);
  assert.strictEqual(run2.skipped, 1);
  assert.strictEqual(run2.kept, 1);
  assert.strictEqual(run2.terminated, 0);

  // Third execution (targeted judgeOneUser on already judged rows)
  const resTerm = await judgeOneUser('u-idemp-term', yesterdayIst);
  assert.strictEqual(resTerm, 'terminated', 'Re-judging already-judged terminated row returns terminated idempotently');

  const resKept = await judgeOneUser('u-idemp-kept', yesterdayIst);
  assert.strictEqual(resKept, 'kept', 'Re-judging already-judged kept row returns kept idempotently');

  mock.restoreAll();
});
