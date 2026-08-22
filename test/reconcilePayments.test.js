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
