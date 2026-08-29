const { test, mock } = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_123';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'dummy-secret';

const { supabaseAdmin } = require('../lib/supabaseClient');
const { razorpay } = require('../lib/razorpayClient');
const { reconcilePendingPayments } = require('../lib/reconcilePayments');

test('reconcilePendingPayments: returns 0 when no candidate payments exist', async () => {
  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'payments');
    return {
      select: () => ({
        eq: () => ({
          lte: () => ({
            gte: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [], error: null })
              })
            })
          })
        })
      })
    };
  });

  const summary = await reconcilePendingPayments();
  assert.strictEqual(summary.checked, 0);
  assert.strictEqual(summary.activated, 0);
  assert.strictEqual(summary.stillPending, 0);
  mock.restoreAll();
});

test('reconcilePendingPayments: marks uncaptured order older than 30 minutes as failed', async () => {
  const oldDate = new Date(Date.now() - 45 * 60 * 1000).toISOString(); // 45 min old
  const candidate = {
    id: 'pay-001',
    user_id: 'user-001',
    plan: 'starter',
    amount_paise: 9900,
    razorpay_order_id: 'order_old_001',
    status: 'created',
    created_at: oldDate
  };

  let updateCalledWith = null;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'payments');
    return {
      select: () => ({
        eq: () => ({
          lte: () => ({
            gte: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [candidate], error: null })
              })
            })
          })
        })
      }),
      update: (payload) => ({
        eq: (col1, val1) => ({
          eq: (col2, val2) => {
            updateCalledWith = { payload, col1, val1, col2, val2 };
            return Promise.resolve({ error: null });
          }
        })
      })
    };
  });

  mock.method(razorpay.orders, 'fetchPayments', async (orderId) => {
    assert.strictEqual(orderId, 'order_old_001');
    return { items: [] }; // No payments on Razorpay
  });

  const summary = await reconcilePendingPayments();

  assert.strictEqual(summary.checked, 1);
  assert.strictEqual(summary.activated, 0);
  assert.strictEqual(summary.stillPending, 1);
  assert.notStrictEqual(updateCalledWith, null);
  assert.strictEqual(updateCalledWith.payload.status, 'failed');
  assert.strictEqual(updateCalledWith.val1, 'pay-001');
  assert.strictEqual(updateCalledWith.val2, 'created');
  mock.restoreAll();
});

test('reconcilePendingPayments: does not mark uncaptured order younger than 30 minutes as failed', async () => {
  const recentDate = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 min old (still in grace window)
  const candidate = {
    id: 'pay-002',
    user_id: 'user-002',
    plan: 'starter',
    amount_paise: 9900,
    razorpay_order_id: 'order_recent_002',
    status: 'created',
    created_at: recentDate
  };

  let updateCalled = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'payments');
    return {
      select: () => ({
        eq: () => ({
          lte: () => ({
            gte: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [candidate], error: null })
              })
            })
          })
        })
      }),
      update: () => {
        updateCalled = true;
        return {
          eq: () => ({
            eq: () => Promise.resolve({ error: null })
          })
        };
      }
    };
  });

  mock.method(razorpay.orders, 'fetchPayments', async () => ({ items: [] }));

  const summary = await reconcilePendingPayments();

  assert.strictEqual(summary.checked, 1);
  assert.strictEqual(summary.activated, 0);
  assert.strictEqual(summary.stillPending, 1);
  assert.strictEqual(updateCalled, false); // Not marked failed yet
  mock.restoreAll();
});

const { activatePlan } = require('../lib/planActivation');

test('activatePlan: resets commit_mode_terminated_at and reason when activating commit_mode', async () => {
  let profileUpdatePayload = null;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'payments') {
      return {
        update: (payload) => ({
          eq: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () => ({
                  data: { id: 'pay-001', user_id: 'user-001', plan: 'commit_mode', amount_paise: 12100 },
                  error: null
                })
              })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { plan: 'commit_mode', plan_expires_at: null },
              error: null
            })
          })
        }),
        update: (payload) => {
          profileUpdatePayload = payload;
          return {
            eq: async () => ({ error: null })
          };
        }
      };
    }
    throw new Error('Unexpected table: ' + table);
  });

  const res = await activatePlan({
    payment: { id: 'pay-001' },
    razorpay_payment_id: 'pay_rzp_123'
  });

  assert.strictEqual(res.activated, true);
  assert.strictEqual(res.plan, 'commit_mode');
  assert.strictEqual(profileUpdatePayload.commit_mode_terminated_at, null);
  assert.strictEqual(profileUpdatePayload.commit_mode_termination_reason, null);
  assert.strictEqual(profileUpdatePayload.plan, 'commit_mode');
  mock.restoreAll();
});

test('reconcilePendingPayments: concurrent executions skip duplicate runs without duplicate Razorpay fetches', async () => {
  const oldDate = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const candidate = {
    id: 'pay-conc-unit-001',
    user_id: 'user-conc-unit-001',
    plan: 'starter',
    amount_paise: 9900,
    razorpay_order_id: 'order_conc_unit_001',
    status: 'created',
    created_at: oldDate
  };

  let fetchPaymentsCallCount = 0;
  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        lte: () => ({
          gte: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [candidate], error: null })
            })
          })
        })
      })
    }),
    update: () => ({
      eq: () => ({
        eq: () => Promise.resolve({ error: null })
      })
    })
  }));

  mock.method(razorpay.orders, 'fetchPayments', async () => {
    fetchPaymentsCallCount += 1;
    await new Promise((r) => setTimeout(r, 50));
    return { items: [] };
  });

  const [res1, res2] = await Promise.all([
    reconcilePendingPayments(),
    reconcilePendingPayments()
  ]);

  const executed = [res1, res2].find((r) => !r.skipped);
  const skipped = [res1, res2].find((r) => r.skipped === true);

  assert.ok(executed, 'One execution must succeed');
  assert.ok(skipped, 'Second execution must be skipped due to lock');
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(skipped.reason, 'locked');
  assert.strictEqual(fetchPaymentsCallCount, 1, 'Only one fetch should occur');

  mock.restoreAll();
});

test('reconcilePendingPayments: bypassLock option allows execution without lock obstruction', async () => {
  const oldDate = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const candidate = {
    id: 'pay-bypass-unit-001',
    user_id: 'user-bypass-unit-001',
    plan: 'starter',
    amount_paise: 9900,
    razorpay_order_id: 'order_bypass_unit_001',
    status: 'created',
    created_at: oldDate
  };

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        lte: () => ({
          gte: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [candidate], error: null })
            })
          })
        })
      })
    }),
    update: () => ({
      eq: () => ({
        eq: () => Promise.resolve({ error: null })
      })
    })
  }));

  mock.method(razorpay.orders, 'fetchPayments', async () => {
    await new Promise((r) => setTimeout(r, 50));
    return { items: [] };
  });

  // Start background sweep
  const bgPromise = reconcilePendingPayments();
  const bypassRes = await reconcilePendingPayments({ bypassLock: true });

  await bgPromise;

  assert.strictEqual(bypassRes.skipped, undefined);
  assert.strictEqual(bypassRes.checked, 1);

  mock.restoreAll();
});

