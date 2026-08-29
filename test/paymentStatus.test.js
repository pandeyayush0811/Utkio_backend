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
// GET /payments/status Unit & Regression Tests (Issue #8 / AUD-008)
// ═══════════════════════════════════════════════════════════════════════════

test('1. Active Paid Plan (Starter / Commit Mode): returns active: true, all permissions true, and trial: null', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-paid-1', email: 'paid@example.com' } },
    error: null
  }));

  const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
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
    Authorization: 'Bearer token-paid-user'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.plan, 'starter');
  assert.strictEqual(data.active, true);
  assert.strictEqual(data.can_chat, true);
  assert.strictEqual(data.can_report, true);
  assert.strictEqual(data.can_scenario, true);
  assert.strictEqual(data.trial, null);

  mock.restoreAll();
});

test('2. Active Free Trial with Full Credits: returns active: true and all permissions true', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-trial-full', email: 'trial@example.com' } },
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
    data: [{
      trial_active: true,
      trial_days_left: 3.0,
      chats_remaining: 5,
      reports_remaining: 5,
      scenarios_remaining: 1
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-trial-user'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.plan, 'none');
  assert.strictEqual(data.active, true);
  assert.strictEqual(data.can_chat, true);
  assert.strictEqual(data.can_report, true);
  assert.strictEqual(data.can_scenario, true);
  assert.strictEqual(data.trial.active, true);
  assert.strictEqual(data.trial.chats_remaining, 5);
  assert.strictEqual(data.trial.reports_remaining, 5);
  assert.strictEqual(data.trial.scenarios_remaining, 1);

  mock.restoreAll();
});

test('3. Exhausted Chats but Remaining Reports: can_chat is false, can_report is true, active is true', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-trial-no-chat', email: 'nochat@example.com' } },
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
    data: [{
      trial_active: true,
      trial_days_left: 2.0,
      chats_remaining: 0,
      reports_remaining: 3,
      scenarios_remaining: 0
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-user'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, true);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, true);
  assert.strictEqual(data.can_scenario, false);
  assert.strictEqual(data.trial.chats_remaining, 0);
  assert.strictEqual(data.trial.reports_remaining, 3);

  mock.restoreAll();
});

test('4. Exhausted Scenarios Quota: can_scenario is false, can_chat and can_report are true', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-trial-no-scenario', email: 'noscenario@example.com' } },
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
    data: [{
      trial_active: true,
      trial_days_left: 1.5,
      chats_remaining: 2,
      reports_remaining: 2,
      scenarios_remaining: 0
    }],
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-user'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, true);
  assert.strictEqual(data.can_chat, true);
  assert.strictEqual(data.can_report, true);
  assert.strictEqual(data.can_scenario, false);

  mock.restoreAll();
});

test('5. Completely Exhausted Trial: all permissions false, active is false', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-trial-exhausted', email: 'exhausted@example.com' } },
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
    Authorization: 'Bearer token-user'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, false);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);
  assert.strictEqual(data.trial.chats_remaining, 0);

  mock.restoreAll();
});

test('6. Expired Trial Window (3 Days Passed): active: false and all permissions false even if counts remain', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-trial-expired', email: 'expired@example.com' } },
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
    Authorization: 'Bearer token-user'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.active, false);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);
  assert.strictEqual(data.trial.active, false);

  mock.restoreAll();
});

test('7. RPC Error / Throws Exception (AUD-008 Verification): active: false and all permissions false for non-paid user', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-rpc-error', email: 'rpcerror@example.com' } },
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

  // Simulate RPC error/throw where trial remains null
  mock.method(supabaseAdmin, 'rpc', async () => {
    throw new Error('Postgres connection timeout');
  });

  const app = buildApp();
  const { status, data } = await request(app, 'GET', '/payments/status', {
    Authorization: 'Bearer token-user'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.plan, 'none');
  assert.strictEqual(data.active, false, 'active must be false when trial is null and user is unpaid');
  assert.strictEqual(data.can_chat, false, 'can_chat must be false when trial is null and user is unpaid');
  assert.strictEqual(data.can_report, false, 'can_report must be false when trial is null and user is unpaid');
  assert.strictEqual(data.can_scenario, false, 'can_scenario must be false when trial is null and user is unpaid');
  assert.strictEqual(data.trial.active, false);

  mock.restoreAll();
});

test('8. Expired Paid Plan with No Active Trial: active: false and all permissions false', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-expired-plan', email: 'expiredplan@example.com' } },
    error: null
  }));

  const pastExpiry = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  mock.method(supabaseAdmin, 'from', () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: {
            plan: 'starter',
            plan_expires_at: pastExpiry,
            commit_mode_terminated_at: null,
            commit_mode_termination_reason: null
          },
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
    Authorization: 'Bearer token-user'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.plan, 'starter');
  assert.strictEqual(data.active, false);
  assert.strictEqual(data.can_chat, false);
  assert.strictEqual(data.can_report, false);
  assert.strictEqual(data.can_scenario, false);
  assert.strictEqual(data.trial.active, false);

  mock.restoreAll();
});
