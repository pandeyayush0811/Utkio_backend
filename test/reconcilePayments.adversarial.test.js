const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_123';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'dummy-secret';
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-secret-xyz';

const { supabaseAdmin } = require('../lib/supabaseClient');
const { razorpay } = require('../lib/razorpayClient');
const { reconcilePendingPayments, MIN_AGE_MS, MAX_AGE_MS, BATCH_LIMIT } = require('../lib/reconcilePayments');
const adminRoutes = require('../routes/adminRoutes');

// Helper to build express admin app for HTTP route testing
function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

async function requestAdmin(app, method, path, headers = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-admin-secret': process.env.ADMIN_SECRET,
        ...headers
      }
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ADVERSARIAL TEST SUITE — Issue #12 (AUD-012: Background Payment Reconciliation Distributed Locking)
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: Concurrency & Multi-Instance Stampede (AUD-012 Core Bug)
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-012 CORE: concurrent executions of reconcilePendingPayments must acquire lock; second instance must be skipped', async () => {
  // Why this matters: In multi-instance or clustered deployments on Render/PaaS, independent
  // server nodes execute reconcilePendingPayments simultaneously. Without distributed locking,
  // both instances query Supabase and fire duplicate requests to Razorpay for the exact same order.
  const oldDate = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const candidate = {
    id: 'pay-concurrent-001',
    user_id: 'user-conc-001',
    plan: 'starter',
    amount_paise: 9900,
    razorpay_order_id: 'order_concurrent_001',
    status: 'created',
    created_at: oldDate
  };

  let fetchPaymentsCallCount = 0;
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
      update: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ error: null })
        })
      })
    };
  });

  // Delay the Razorpay response slightly to simulate real network latency while lock is held
  mock.method(razorpay.orders, 'fetchPayments', async (orderId) => {
    fetchPaymentsCallCount += 1;
    await new Promise((r) => setTimeout(r, 60));
    return { items: [] }; // uncaptured
  });

  // Launch two concurrent sweeps at the exact same moment (simulating Instance A & Instance B)
  const [result1, result2] = await Promise.all([
    reconcilePendingPayments(),
    reconcilePendingPayments()
  ]);

  // One instance MUST succeed and the other instance MUST be skipped due to lock contention
  const executed = [result1, result2].find((r) => !r.skipped);
  const skipped = [result1, result2].find((r) => r.skipped === true);

  assert.ok(executed, 'At least one instance must execute the reconciliation sweep');
  assert.strictEqual(executed.checked, 1, 'Executing instance must check the candidate order');

  assert.ok(skipped, 'AUD-012 BUG DETECTED: Second concurrent instance was NOT skipped. Both instances ran simultaneously without distributed locking.');
  assert.strictEqual(skipped.skipped, true, 'Skipped instance must return skipped: true');
  assert.strictEqual(skipped.reason, 'locked', 'Skipped instance must specify reason: locked');
  assert.strictEqual(skipped.checked, 0, 'Skipped instance must not process any payments');

  // Razorpay API must only receive 1 fetch call, not 2 duplicate calls
  assert.strictEqual(fetchPaymentsCallCount, 1, 'Razorpay orders.fetchPayments must be called exactly once across both instances');

  mock.restoreAll();
});

test('AUD-012 CORE: 5-instance stampede executes exactly once and skips 4 duplicate sweeps', async () => {
  // Why this matters: Simulates autoscaled deployment with 5 server containers firing cron sweeps at the same second.
  const oldDate = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const candidate = {
    id: 'pay-stampede-001',
    user_id: 'user-stampede-001',
    plan: 'commit_mode',
    amount_paise: 12100,
    razorpay_order_id: 'order_stampede_001',
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
    await new Promise((r) => setTimeout(r, 80));
    return { items: [] };
  });

  const results = await Promise.all([
    reconcilePendingPayments(),
    reconcilePendingPayments(),
    reconcilePendingPayments(),
    reconcilePendingPayments(),
    reconcilePendingPayments()
  ]);

  const executedRuns = results.filter((r) => !r.skipped);
  const skippedRuns = results.filter((r) => r.skipped === true);

  assert.strictEqual(executedRuns.length, 1, `Expected exactly 1 execution during stampede, but ${executedRuns.length} instances ran.`);
  assert.strictEqual(skippedRuns.length, 4, `Expected 4 instances to skip, but got ${skippedRuns.length}`);
  assert.strictEqual(fetchPaymentsCallCount, 1, `Expected 1 Razorpay API call, but got ${fetchPaymentsCallCount}`);

  mock.restoreAll();
});

test('AUD-012 ROUTE: POST /admin/reconcile-payments returns skipped: true when background sweep is already running', async () => {
  // Why this matters: When an operator or external webhook triggers the admin endpoint while
  // an in-process scheduled sweep is active, the endpoint must report locked/skipped cleanly
  // rather than triggering a concurrent duplicate sweep.
  const oldDate = new Date(Date.now() - 12 * 60 * 1000).toISOString();
  const candidate = {
    id: 'pay-admin-race-001',
    user_id: 'user-admin-001',
    plan: 'starter',
    amount_paise: 9900,
    razorpay_order_id: 'order_admin_race_001',
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
    await new Promise((r) => setTimeout(r, 100)); // Hold lock during sweep
    return { items: [] };
  });

  const app = buildAdminApp();

  // Start background sweep
  const bgPromise = reconcilePendingPayments();

  // Fire HTTP admin endpoint immediately while bg sweep is holding lock
  await new Promise((r) => setTimeout(r, 10)); // Ensure bgPromise started
  const { status, data } = await requestAdmin(app, 'POST', '/admin/reconcile-payments');

  await bgPromise;

  assert.strictEqual(status, 200, 'Admin endpoint must return HTTP 200');
  assert.strictEqual(data.skipped, true, 'Admin endpoint must return skipped: true when locked');
  assert.strictEqual(data.reason, 'locked', 'Admin endpoint reason must be "locked"');
  assert.strictEqual(data.checked, 0);

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: Distributed Lock Lifecycle, Crash Safety & Exception Handling
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-012 LOCK: sequential executions acquire and release lock cleanly without deadlocks', async () => {
  // Why this matters: Ensures lock release in finally block allows subsequent scheduled runs
  // to execute without getting permanently locked out.
  mock.method(supabaseAdmin, 'from', () => ({
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
  }));

  const firstRun = await reconcilePendingPayments();
  assert.strictEqual(firstRun.checked, 0);
  assert.strictEqual(firstRun.skipped, undefined);

  // Second run immediately following the first
  const secondRun = await reconcilePendingPayments();
  assert.strictEqual(secondRun.checked, 0);
  assert.strictEqual(secondRun.skipped, undefined, 'Second run must NOT be locked after first run completes');

  mock.restoreAll();
});

test('AUD-012 LOCK: lock is guaranteed to be released even when Supabase throws an unexpected error', async () => {
  // Why this matters: If a database error or network partition occurs during candidate selection,
  // the distributed lock MUST be released in a `finally` block so the next cycle can run.
  let shouldFailDb = true;

  mock.method(supabaseAdmin, 'from', () => {
    if (shouldFailDb) {
      return {
        select: () => ({
          eq: () => ({
            lte: () => ({
              gte: () => ({
                order: () => ({
                  limit: () => Promise.reject(new Error('Supabase network timeout / DB down'))
                })
              })
            })
          })
        })
      };
    }
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

  // First run fails with DB exception
  await assert.rejects(
    async () => await reconcilePendingPayments(),
    /Supabase network timeout/
  );

  // Second run: DB recovers. The lock MUST be released and not stuck in a deadlocked state.
  shouldFailDb = false;
  const recoveredRun = await reconcilePendingPayments();
  assert.strictEqual(recoveredRun.checked, 0);
  assert.strictEqual(recoveredRun.skipped, undefined, 'Lock must be freed after exception in prior run');

  mock.restoreAll();
});

test('AUD-012 LOCK: lock is guaranteed to be released even when Razorpay SDK throws unhandled errors', async () => {
  // Why this matters: If Razorpay API throws 500 / TLS errors, the loop captures errors but
  // the outer lock must be properly released.
  const oldDate = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const candidate = {
    id: 'pay-err-001',
    user_id: 'user-err-001',
    plan: 'starter',
    amount_paise: 9900,
    razorpay_order_id: 'order_err_001',
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
    throw new Error('Razorpay 503 Service Unavailable');
  });

  const failedRun = await reconcilePendingPayments();
  assert.strictEqual(failedRun.checked, 1);
  assert.strictEqual(failedRun.errors.length, 1);
  assert.match(failedRun.errors[0].message, /503 Service Unavailable/);

  // Subsequent run should succeed without lock obstruction
  mock.method(supabaseAdmin, 'from', () => ({
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
  }));

  const nextRun = await reconcilePendingPayments();
  assert.strictEqual(nextRun.checked, 0);
  assert.strictEqual(nextRun.skipped, undefined);

  mock.restoreAll();
});

test('AUD-012 LOCK: bypassLock option allows manual override even if lock is active', async () => {
  // Why this matters: Emergency operator diagnostic sweeps or test setups may need to run
  // with explicit lock bypassing ({ bypassLock: true }).
  const oldDate = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const candidate = {
    id: 'pay-bypass-001',
    user_id: 'user-bypass-001',
    plan: 'starter',
    amount_paise: 9900,
    razorpay_order_id: 'order_bypass_001',
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
    await new Promise((r) => setTimeout(r, 60));
    return { items: [] };
  });

  // Start background sweep
  const bgPromise = reconcilePendingPayments();

  // Run with bypassLock = true
  const bypassRun = await reconcilePendingPayments({ bypassLock: true });

  await bgPromise;

  assert.strictEqual(bypassRun.skipped, undefined, 'bypassLock: true must execute regardless of existing lock');
  assert.strictEqual(bypassRun.checked, 1);

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: Adversarial Payment State Transitions & Race Conditions Under Concurrency
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-012 ADVERSARIAL: uncaptured order >= 30 mins is marked status=failed without redundant duplicate updates', async () => {
  // Why this matters: When multiple sweeps attempt to process an abandoned order, status=failed
  // must only be updated once without race conditions or overwriting newly paid orders.
  const oldDate = new Date(Date.now() - 40 * 60 * 1000).toISOString(); // 40 minutes old
  const candidate = {
    id: 'pay-abandoned-001',
    user_id: 'user-ab-001',
    plan: 'starter',
    amount_paise: 9900,
    razorpay_order_id: 'order_ab_001',
    status: 'created',
    created_at: oldDate
  };

  let updateCallCount = 0;
  let updatePayloadLogged = null;

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
            updateCallCount += 1;
            updatePayloadLogged = { payload, col1, val1, col2, val2 };
            return Promise.resolve({ error: null });
          }
        })
      })
    };
  });

  mock.method(razorpay.orders, 'fetchPayments', async () => ({ items: [] }));

  const summary = await reconcilePendingPayments();

  assert.strictEqual(summary.checked, 1);
  assert.strictEqual(summary.stillPending, 1);
  assert.strictEqual(updateCallCount, 1);
  assert.strictEqual(updatePayloadLogged.payload.status, 'failed');
  assert.strictEqual(updatePayloadLogged.col1, 'id');
  assert.strictEqual(updatePayloadLogged.val1, 'pay-abandoned-001');
  assert.strictEqual(updatePayloadLogged.col2, 'status');
  assert.strictEqual(updatePayloadLogged.val2, 'created', 'Must have status=created condition to prevent overwriting concurrently paid orders');

  mock.restoreAll();
});

test('AUD-012 ADVERSARIAL: captured payment activation only activates once across sweeps', async () => {
  // Why this matters: When Razorpay returns captured: true, activatePlan is called and
  // plan is updated. Subsequent runs see no 'created' status and do not double-activate.
  const oldDate = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  let paymentRow = {
    id: 'pay-captured-001',
    user_id: 'user-cap-001',
    plan: 'starter',
    amount_paise: 9900,
    razorpay_order_id: 'order_cap_001',
    status: 'created',
    created_at: oldDate
  };

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'payments') {
      return {
        select: () => ({
          eq: () => ({
            lte: () => ({
              gte: () => ({
                order: () => ({
                  limit: () => Promise.resolve({
                    data: paymentRow.status === 'created' ? [paymentRow] : [],
                    error: null
                  })
                })
              })
            })
          })
        }),
        update: (payload) => ({
          eq: (col1, val1) => ({
            eq: (col2, val2) => ({
              select: () => ({
                maybeSingle: async () => {
                  if (paymentRow.status === 'created') {
                    paymentRow.status = 'paid';
                    return { data: { ...paymentRow }, error: null };
                  }
                  return { data: null, error: null };
                }
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
              data: { plan: 'none', plan_expires_at: null },
              error: null
            })
          })
        }),
        update: () => ({
          eq: async () => ({ error: null })
        })
      };
    }
  });

  mock.method(razorpay.orders, 'fetchPayments', async () => ({
    items: [{ id: 'pay_rzp_captured_999', status: 'captured', amount: 9900 }]
  }));

  // First sweep: Activates plan
  const summary1 = await reconcilePendingPayments();
  assert.strictEqual(summary1.checked, 1);
  assert.strictEqual(summary1.activated, 1);

  // Second sweep: Status is now 'paid', candidate list is empty
  const summary2 = await reconcilePendingPayments();
  assert.strictEqual(summary2.checked, 0);
  assert.strictEqual(summary2.activated, 0);

  mock.restoreAll();
});

test('AUD-012 BOUNDARY: respects BATCH_LIMIT, MIN_AGE_MS and MAX_AGE_MS query boundaries', async () => {
  // Why this matters: Prevents runaway sweeps from chewing through unbounded rows or fetching fresh checkouts.
  assert.strictEqual(MIN_AGE_MS, 10 * 60 * 1000, 'MIN_AGE_MS must be 10 minutes');
  assert.strictEqual(MAX_AGE_MS, 3 * 24 * 60 * 60 * 1000, 'MAX_AGE_MS must be 3 days');
  assert.strictEqual(BATCH_LIMIT, 50, 'BATCH_LIMIT must be 50 rows');

  let queryParams = {};
  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'payments');
    return {
      select: (cols) => {
        queryParams.select = cols;
        return {
          eq: (col, val) => {
            queryParams.eq = { col, val };
            return {
              lte: (colLte, valLte) => {
                queryParams.lte = { colLte, valLte };
                return {
                  gte: (colGte, valGte) => {
                    queryParams.gte = { colGte, valGte };
                    return {
                      order: (orderCol, opts) => {
                        queryParams.order = { orderCol, opts };
                        return {
                          limit: (limitVal) => {
                            queryParams.limit = limitVal;
                            return Promise.resolve({ data: [], error: null });
                          }
                        };
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
    };
  });

  await reconcilePendingPayments();

  assert.strictEqual(queryParams.eq.col, 'status');
  assert.strictEqual(queryParams.eq.val, 'created');
  assert.strictEqual(queryParams.lte.colLte, 'created_at');
  assert.strictEqual(queryParams.gte.colGte, 'created_at');
  assert.strictEqual(queryParams.order.orderCol, 'created_at');
  assert.strictEqual(queryParams.order.opts.ascending, true);
  assert.strictEqual(queryParams.limit, 50);

  mock.restoreAll();
});
