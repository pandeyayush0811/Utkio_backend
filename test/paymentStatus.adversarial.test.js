const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const paymentRoutes = require('../routes/paymentRoutes');
const { supabaseAnon, supabaseAdmin } = require('../lib/supabaseClient');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/payments', paymentRoutes);
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
// BACKEND ADVERSARIAL SUITE — Issue #8 (AUD-008: GET /payments/status Fallback & Entitlements)
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: AUD-008 Core Bug & Fail-Closed RPC Degradation Tests
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-008 CORE: unpaid user (plan: none) must fail-closed when peek_access RPC returns null data', async () => {
  // Why this matters: Catches the core bug where `trial ? ... : true` evaluated to true when trial was null,
  // granting free unrestricted access to unpaid users during RPC data anomalies.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-unpaid-rpc-null', email: 'unpaid@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: {
            plan: 'none',
            plan_expires_at: null,
            commit_mode_terminated_at: null,
            commit_mode_termination_reason: null
          },
          error: null
        })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: null, // peek_access returned null / no rows
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer valid-token-unpaid'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.plan, 'none');
  // Fail-closed requirements: unpaid user without active trial MUST NOT be granted access
  assert.strictEqual(data.active, false, 'active must be false when trial is null and user has no paid plan');
  assert.strictEqual(data.can_chat, false, 'can_chat must be false when trial is null');
  assert.strictEqual(data.can_report, false, 'can_report must be false when trial is null');
  assert.strictEqual(data.can_scenario, false, 'can_scenario must be false when trial is null');
  assert.strictEqual(data.trial.active, false);
  assert.strictEqual(data.trial.chats_remaining, 0);

  mock.restoreAll();
});

test('AUD-008 CORE: unpaid user must fail-closed when peek_access RPC returns an explicit DB error', async () => {
  // Why this matters: A database error/timeout during peek_access must not grant free access.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-unpaid-rpc-err', email: 'rpcerr@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: { plan: 'none', plan_expires_at: null },
          error: null
        })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: null,
    error: { message: 'statement timeout in peek_access RPC' }
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer valid-token-rpc-err'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, false);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);

  mock.restoreAll();
});

test('AUD-008 CORE: unpaid user must fail-closed when peek_access RPC throws an exception', async () => {
  // Why this matters: Exception in try/catch block around rpc must not trigger fail-open fallback.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-unpaid-rpc-throw', email: 'rpcthrow@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: { plan: 'none', plan_expires_at: null },
          error: null
        })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => {
    throw new Error('Connection terminated unexpectedly');
  });

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer valid-token-rpc-throw'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, false);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);

  mock.restoreAll();
});

test('AUD-008 SIBLING: expired paid plan (starter past expiration) must fail-closed when peek_access fails', async () => {
  // Why this matters: An expired paid subscriber whose subscription ended yesterday must not get free access on RPC error.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-expired-starter', email: 'expired@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: { plan: 'starter', plan_expires_at: yesterday },
          error: null
        })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: null,
    error: { message: 'DB connection timeout' }
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer valid-token-expired'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.plan, 'starter');
  assert.strictEqual(data.active, false, 'Expired plan with RPC failure must have active: false');
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);

  mock.restoreAll();
});

test('AUD-008 SIBLING: terminated commit mode user must fail-closed when peek_access fails', async () => {
  // Why this matters: A user terminated from commit mode for missing daily practice must not receive free access on RPC error.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-term-commit', email: 'terminated@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: {
            plan: 'none',
            plan_expires_at: null,
            commit_mode_terminated_at: new Date().toISOString(),
            commit_mode_termination_reason: 'missed_daily_requirement'
          },
          error: null
        })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: null,
    error: { message: 'RPC failure' }
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer valid-token-term'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, false);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);
  assert.strictEqual(data.commit_mode_termination_reason, 'missed_daily_requirement');

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: Standard Human Use Cases — Active Paid Subscribers
// ─────────────────────────────────────────────────────────────────────────────

test('human usecase: active starter subscriber receives full permissions and trial: null', async () => {
  // Why this matters: Verifies standard paid subscription happy path.
  const futureExpiry = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-starter-active', email: 'starter@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: {
            plan: 'starter',
            plan_expires_at: futureExpiry,
            commit_mode_terminated_at: null,
            commit_mode_termination_reason: null
          },
          error: null
        })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{ trial_active: false, chats_remaining: 0, reports_remaining: 0, scenarios_remaining: 0 }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-starter'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.plan, 'starter');
  assert.strictEqual(data.active, true);
  assert.strictEqual(data.can_chat, true);
  assert.strictEqual(data.can_report, true);
  assert.strictEqual(data.can_scenario, true);
  assert.strictEqual(data.trial, null, 'Active paid plan MUST return trial: null');

  mock.restoreAll();
});

test('human usecase: active unlimited subscriber with null plan_expires_at receives full permissions', async () => {
  // Why this matters: Unlimited plan may have no expiration date (null expiry).
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-unlimited', email: 'unlimited@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: { plan: 'unlimited', plan_expires_at: null },
          error: null
        })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: null, error: null }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-unlimited'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.plan, 'unlimited');
  assert.strictEqual(data.active, true);
  assert.strictEqual(data.can_chat, true);
  assert.strictEqual(data.can_report, true);
  assert.strictEqual(data.can_scenario, true);
  assert.strictEqual(data.trial, null);

  mock.restoreAll();
});

test('human usecase: active commit_mode subscriber receives full permissions', async () => {
  // Why this matters: Verifies Commit Mode subscribers receive active entitlement.
  const futureExpiry = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-commit-active', email: 'commit@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: { plan: 'commit_mode', plan_expires_at: futureExpiry },
          error: null
        })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: null, error: null }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-commit'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.plan, 'commit_mode');
  assert.strictEqual(data.active, true);
  assert.strictEqual(data.can_chat, true);
  assert.strictEqual(data.can_report, true);
  assert.strictEqual(data.can_scenario, true);
  assert.strictEqual(data.trial, null);

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: Standard Human Use Cases — Free Trial Granular Entitlements
// ─────────────────────────────────────────────────────────────────────────────

test('human usecase: new free trial user with full credits receives active permissions and trial object', async () => {
  // Why this matters: Verifies normal day-1 trial experience (5 chats, 5 reports, 1 scenario, 3 days left).
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-trial-new', email: 'trialnew@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { plan: 'none', plan_expires_at: null }, error: null })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async (fn, args) => {
    assert.strictEqual(fn, 'peek_access');
    assert.strictEqual(args.p_user_id, 'user-trial-new');
    return {
      data: [{
        trial_active: true,
        trial_days_left: 2.9,
        chats_remaining: 5,
        reports_remaining: 5,
        scenarios_remaining: 1
      }],
      error: null
    };
  });

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-trial-new'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.plan, 'none');
  assert.strictEqual(data.active, true);
  assert.strictEqual(data.can_chat, true);
  assert.strictEqual(data.can_report, true);
  assert.strictEqual(data.can_scenario, true);
  assert.deepStrictEqual(data.trial, {
    active: true,
    days_left: 2.9,
    chats_remaining: 5,
    reports_remaining: 5,
    scenarios_remaining: 1,
    chat_limit: 5,
    report_limit: 5,
    scenario_limit: 1
  });

  mock.restoreAll();
});

test('human usecase: trial user with chats exhausted but scenarios available has can_chat: false and can_scenario: true', async () => {
  // Why this matters: Granular permissions allow user to practice scenario even after 5 freeform chats are exhausted.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-trial-chat-exhausted', email: 'exhausted@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { plan: 'none', plan_expires_at: null }, error: null })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{
      trial_active: true,
      trial_days_left: 1.5,
      chats_remaining: 0,
      reports_remaining: 3,
      scenarios_remaining: 1
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-partial-exhaust'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, true, 'active remains true because user can still do scenarios or reports');
  assert.strictEqual(data.can_chat, false, 'can_chat must be false when chats_remaining is 0');
  assert.strictEqual(data.can_scenario, true, 'can_scenario must be true when scenarios_remaining is 1');
  assert.strictEqual(data.can_report, true, 'can_report must be true when reports_remaining is 3');
  assert.strictEqual(data.trial.chats_remaining, 0);
  assert.strictEqual(data.trial.scenarios_remaining, 1);

  mock.restoreAll();
});

test('human usecase: trial user with scenario exhausted but chats available has can_scenario: false and can_chat: true', async () => {
  // Why this matters: Gating scenario after 1 scenario used while preserving remaining chats.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-trial-scen-exhausted', email: 'scenex@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { plan: 'none', plan_expires_at: null }, error: null })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{
      trial_active: true,
      trial_days_left: 2.1,
      chats_remaining: 4,
      reports_remaining: 4,
      scenarios_remaining: 0
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-scen-ex'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, true);
  assert.strictEqual(data.can_chat, true);
  assert.strictEqual(data.can_scenario, false, 'can_scenario must be false when scenarios_remaining is 0');
  assert.strictEqual(data.can_report, true);

  mock.restoreAll();
});

test('human usecase: trial user with ALL credits depleted has active: false and all can_* false', async () => {
  // Why this matters: User reached all limits — status must report active: false.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-all-depleted', email: 'all0@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { plan: 'none', plan_expires_at: null }, error: null })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{
      trial_active: true,
      trial_days_left: 1.0,
      chats_remaining: 0,
      reports_remaining: 0,
      scenarios_remaining: 0
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-all0'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, false);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);

  mock.restoreAll();
});

test('human usecase: trial expired after 3 days (trial_active: false) has active: false and all can_* false', async () => {
  // Why this matters: Calendar expiration of trial period.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-trial-expired', email: 'expiredtrial@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { plan: 'none', plan_expires_at: null }, error: null })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{
      trial_active: false,
      trial_days_left: 0,
      chats_remaining: 2, // Even if unspent units remained, trial window closed
      reports_remaining: 2,
      scenarios_remaining: 0
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-trial-exp'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, false);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);
  assert.strictEqual(data.trial.active, false);

  mock.restoreAll();
});

test('adversarial: peek_access returning empty array [] fails-closed gracefully', async () => {
  // Why this matters: If RPC returns empty array [], trial becomes undefined. Must not crash and must fail closed.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-empty-array-rpc', email: 'emptyarr@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { plan: 'none', plan_expires_at: null }, error: null })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [], // Empty array
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-empty-arr'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, false);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);
  assert.strictEqual(data.trial.active, false);
  assert.strictEqual(data.trial.chats_remaining, 0);

  mock.restoreAll();
});

test('adversarial: negative counters in trial RPC payload are strictly evaluated as not permitted', async () => {
  // Why this matters: Malicious/corrupted DB state with negative counters (e.g. -1) must never evaluate to true.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-neg-counters', email: 'neg@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { plan: 'none', plan_expires_at: null }, error: null })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{
      trial_active: true,
      trial_days_left: 2.0,
      chats_remaining: -1,
      reports_remaining: -5,
      scenarios_remaining: -2
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-neg'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, false, 'active must be false when all counters are negative');
  assert.strictEqual(data.can_chat, false, 'can_chat must be false for negative chats_remaining');
  assert.strictEqual(data.can_report, false, 'can_report must be false for negative reports_remaining');
  assert.strictEqual(data.can_scenario, false, 'can_scenario must be false for negative scenarios_remaining');

  mock.restoreAll();
});

test('adversarial: non-numeric/NaN/null counters in RPC payload evaluate to false without crash', async () => {
  // Why this matters: Corrupted counter types (NaN, null, undefined) must fail closed.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-nan-counters', email: 'nan@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { plan: 'none', plan_expires_at: null }, error: null })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{
      trial_active: true,
      trial_days_left: '2.0',
      chats_remaining: null,
      reports_remaining: undefined,
      scenarios_remaining: NaN
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-nan'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, false);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);

  mock.restoreAll();
});

test('adversarial: trial window expired (trial_active: false) overrides remaining unused credits', async () => {
  // Why this matters: Even if a user has unspent credits (e.g. 5 chats, 5 reports), if the 3-day clock ran out, trial_active is false and all gates must close.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-expired-with-credits', email: 'expcredits@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { plan: 'none', plan_expires_at: null }, error: null })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{
      trial_active: false,
      trial_days_left: 0,
      chats_remaining: 5,
      reports_remaining: 5,
      scenarios_remaining: 1
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-exp-cred'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, false, 'active must be false when trial_active is false even if counters > 0');
  assert.strictEqual(data.can_chat, false, 'can_chat must be false when trial window expired');
  assert.strictEqual(data.can_report, false, 'can_report must be false when trial window expired');
  assert.strictEqual(data.can_scenario, false, 'can_scenario must be false when trial window expired');
  assert.strictEqual(data.trial.active, false);

  mock.restoreAll();
});

test('adversarial: expired unlimited plan (past plan_expires_at) with depleted trial fails-closed', async () => {
  // Why this matters: An unlimited plan that had an expiration date that has now passed must not retain paid access.
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-exp-unlimited', email: 'expunlimited@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: { plan: 'unlimited', plan_expires_at: twoDaysAgo },
          error: null
        })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{
      trial_active: false,
      trial_days_left: 0,
      chats_remaining: 0,
      reports_remaining: 0,
      scenarios_remaining: 0
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-exp-unlim'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.plan, 'unlimited');
  assert.strictEqual(data.active, false);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);
  assert.strictEqual(data.trial.active, false);

  mock.restoreAll();
});

test('adversarial: malformed plan_expires_at string fails paid plan check safely', async () => {
  // Why this matters: Corrupted or garbage timestamp string (e.g. "garbage-date") must evaluate hasPaidPlan to false.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-malformed-date', email: 'malformed@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: { plan: 'starter', plan_expires_at: 'not-a-valid-date-iso' },
          error: null
        })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{
      trial_active: false,
      trial_days_left: 0,
      chats_remaining: 0,
      reports_remaining: 0,
      scenarios_remaining: 0
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-malformed-date'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, false);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);

  mock.restoreAll();
});

test('adversarial: negative trial_days_left is clamped to 0 in response payload', async () => {
  // Why this matters: If database RPC calculates negative days left (e.g. -0.8), UI should receive 0, never negative numbers.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-neg-days', email: 'negdays@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { plan: 'none', plan_expires_at: null }, error: null })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{
      trial_active: false,
      trial_days_left: -1.88,
      chats_remaining: 0,
      reports_remaining: 0,
      scenarios_remaining: 0
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-neg-days'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.trial.days_left, 0, 'days_left must be clamped to minimum 0');

  mock.restoreAll();
});

test('adversarial: peek_access returning raw object instead of array format is parsed correctly', async () => {
  // Why this matters: Supabase RPC return shapes vary between array and direct object based on client versions.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-raw-obj', email: 'rawobj@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { plan: 'none', plan_expires_at: null }, error: null })
      })
    })
  }));

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: {
      trial_active: true,
      trial_days_left: 1.8888,
      chats_remaining: 2,
      reports_remaining: 2,
      scenarios_remaining: 1
    },
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-raw-obj'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, true);
  assert.strictEqual(data.can_chat, true);
  assert.strictEqual(data.trial.days_left, 1.8); // Formatted to 1 decimal place

  mock.restoreAll();
});

test('adversarial: unauthenticated request (missing Authorization header) returns 401', async () => {
  // Why this matters: Missing auth header must be blocked by requireAuth middleware.
  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status');

  assert.strictEqual(status, 401);
  assert.match(data.error, /authorization/i);
});

test('adversarial: database error fetching user profile propagates to error handler', async () => {
  // Why this matters: Profile table lookup failures must be handled cleanly via next(err).
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-profile-db-fail', email: 'dbfail@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: null, error: { message: 'relation profiles does not exist' } })
      })
    })
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-db-fail'
  });

  assert.strictEqual(status, 500);
  assert.strictEqual(data.error, 'relation profiles does not exist');

  mock.restoreAll();
});

