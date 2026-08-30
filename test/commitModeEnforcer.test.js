const { test, mock } = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const { supabaseAdmin } = require('../lib/supabaseClient');
const { runCommitModeMidnightSweep } = require('../lib/commitModeEnforcer');

function createDummySingleQueryMock() {
  return {
    select: () => ({
      eq: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null })
              })
            })
          }),
          order: () => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null })
            })
          })
        }),
        order: () => ({
          limit: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null })
          })
        })
      })
    })
  };
}

test('runCommitModeMidnightSweep: empty active users returns 0 checked, 0 terminated, 0 kept, 0 skipped', async () => {
  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [], error: null })
          })
        })
      })
    };
  });

  const result = await runCommitModeMidnightSweep();
  assert.strictEqual(result.checked, 0);
  assert.strictEqual(result.terminated, 0);
  assert.strictEqual(result.kept, 0);
  assert.strictEqual(result.skipped, 0);
  mock.restoreAll();
});

test('runCommitModeMidnightSweep: multi-page pagination visits all users across multiple cursor batches', async () => {
  // Simulate 250 total users across 3 pages: 100, 100, 50
  const allUsers = Array.from({ length: 250 }, (_, i) => ({
    id: `user-${String(i + 1).padStart(4, '0')}`,
    plan: 'commit_mode',
    plan_expires_at: null
  }));

  const queriedIds = [];

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'profiles') {
      let gtValue = null;
      const builder = {
        select: () => builder,
        eq: () => builder,
        gt: (col, val) => {
          gtValue = val;
          return builder;
        },
        order: () => builder,
        limit: (limitCount) => {
          let filtered = allUsers;
          if (gtValue) {
            filtered = allUsers.filter(u => u.id > gtValue);
          }
          const page = filtered.slice(0, limitCount);
          return Promise.resolve({ data: page, error: null });
        }
      };
      return builder;
    }

    if (table === 'payments' || table === 'commit_mode_consents') {
      return createDummySingleQueryMock();
    }

    if (table === 'commit_mode_daily_progress') {
      return {
        insert: () => ({
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null })
          })
        }),
        select: () => ({
          eq: (col1, val1) => ({
            eq: (col2, val2) => ({
              single: () => {
                queriedIds.push(val1);
                return Promise.resolve({
                  data: {
                    id: `progress-${val1}`,
                    chat_requirement_met: true,
                    scenario_requirement_met: true,
                    judged_at: null
                  },
                  error: null
                });
              }
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

  assert.strictEqual(result.checked, 250);
  assert.strictEqual(result.kept, 250);
  assert.strictEqual(result.terminated, 0);
  assert.strictEqual(result.skipped, 0);
  assert.strictEqual(queriedIds.length, 250);
  assert.strictEqual(queriedIds[0], 'user-0001');
  assert.strictEqual(queriedIds[249], 'user-0250');
  mock.restoreAll();
});

test('runCommitModeMidnightSweep: single user failure does not abort pagination loop for remaining users', async () => {
  const users = [
    { id: 'user-001', plan: 'commit_mode', plan_expires_at: null },
    { id: 'user-002', plan: 'commit_mode', plan_expires_at: null },
    { id: 'user-003', plan: 'commit_mode', plan_expires_at: null }
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

    if (table === 'payments' || table === 'commit_mode_consents') {
      return createDummySingleQueryMock();
    }

    if (table === 'commit_mode_daily_progress') {
      return {
        insert: () => ({
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null })
          })
        }),
        select: () => ({
          eq: (col1, val1) => ({
            eq: (col2, val2) => ({
              single: () => {
                if (val1 === 'user-002') {
                  return Promise.resolve({ data: null, error: new Error('DB connection reset') });
                }
                return Promise.resolve({
                  data: {
                    id: `progress-${val1}`,
                    chat_requirement_met: val1 === 'user-001',
                    scenario_requirement_met: val1 === 'user-001',
                    judged_at: null
                  },
                  error: null
                });
              }
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

  assert.strictEqual(result.checked, 3);
  assert.strictEqual(result.kept, 1);
  assert.strictEqual(result.terminated, 1); // user-003 missed requirements -> terminated
  assert.strictEqual(result.skipped, 0);
  mock.restoreAll();
});

