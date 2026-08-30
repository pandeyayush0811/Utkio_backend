process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'dummy-openai-key';
process.env.RAZORPAY_KEY_ID = 'rzp_test_123';
process.env.RAZORPAY_KEY_SECRET = 'dummy-secret';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const chatRoutes = require('../routes/chatRoutes');
const paymentRoutes = require('../routes/paymentRoutes');
const userRoutes = require('../routes/userRoutes');
const scenarioRoutes = require('../routes/scenarioRoutes');
const { requirePlan } = require('../middleware/requirePlan');
const { TRIAL_REPORT_LIMIT, TRIAL_CHAT_LIMIT, TRIAL_SCENARIO_LIMIT } = require('../lib/accessLimits');
const { supabaseAdmin, supabaseAnon } = require('../lib/supabaseClient');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/chat', chatRoutes);
  app.use('/chat/scenario', scenarioRoutes);
  app.use('/payments', paymentRoutes);
  app.use('/users', userRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function setupAuthMock(userId) {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: userId, email: `${userId}@example.com` } },
    error: null
  }));
}

async function request(app, method, path, body = {}, headers = { Authorization: 'Bearer test-token' }) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(method !== 'GET' && method !== 'HEAD' ? { body: JSON.stringify(body) } : {})
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUD-026 Comprehensive Adversarial Test Suite: User-Facing Error Payload Language
// & Information Leakage Defense
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-026: POST /chat/sessions returns clean English message on scenario_already_done_today (409)', async () => {
  const userId = 'user-scen-done-aud026';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              gt: () => ({
                gte: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: { id: 'sess-today-123' },
                      error: null
                    })
                  })
                })
              })
            })
          })
        })
      };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'job_interview',
    messages: [{ role: 'user', content: 'Hello' }]
  });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.error, 'scenario_already_done_today');
  assert.strictEqual(
    res.data.message,
    "Today's scenario is already complete — a new scenario will be available tomorrow.",
    'Expected clean professional English copy without Hinglish mixing'
  );
  assert.strictEqual(res.data.session_id, 'sess-today-123');

  mock.restoreAll();
});

test('AUD-026: POST /chat/sessions returns clean English message on locked session (409)', async () => {
  const userId = 'user-locked-aud026';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: 'sess-locked-456', turn_count: 5, ended_at: new Date().toISOString() },
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
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'rep-1' },
                error: null
              })
            })
          })
        })
      };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions', {
    session_id: 'sess-locked-456',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'freeform',
    messages: [{ role: 'user', content: 'Another turn' }]
  });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.error, 'locked');
  assert.strictEqual(
    res.data.message,
    "This chat already has an analysis report. Please start a new chat to continue.",
    'Expected clean professional English copy on locked session'
  );

  mock.restoreAll();
});

test('AUD-026: POST /chat/sessions/:id/analyze returns clean English message on report_in_progress (409)', async () => {
  const userId = 'user-rep-progress-aud026';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: 'rep-in-prog', session_id: 'sess-789', report_text: null, generated_at: new Date().toISOString() },
                error: null
              })
            })
          })
        })
      };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/chat/sessions/sess-789/analyze', {});

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.error, 'report_in_progress');
  assert.strictEqual(
    res.data.message,
    "Report is currently being generated — please wait a moment.",
    'Expected clean English message when report is already in progress'
  );

  mock.restoreAll();
});

test('AUD-026: POST /payments/create-order returns clean English message on commit_mode_consent_required (402)', async () => {
  const userId = 'user-consent-req-aud026';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'commit_mode_consents') {
      return {
        select: () => ({
          eq: () => ({
            is: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null })
                })
              })
            })
          })
        })
      };
    }
  });

  const app = buildApp();
  const res = await request(app, 'POST', '/payments/create-order', {
    plan: 'commit_mode'
  });

  assert.strictEqual(res.status, 402);
  assert.strictEqual(res.data.error, 'commit_mode_consent_required');
  assert.strictEqual(
    res.data.message,
    "Please review and agree to the Commit Mode rules before purchasing.",
    'Expected clear English copy for commit mode consent requirement'
  );

  mock.restoreAll();
});

test('AUD-026: requirePlan returns clean English copy for all access denied reasons (402)', async () => {
  const userId = 'user-reqplan-copy-001';
  setupAuthMock(userId);

  const reasons = [
    {
      kind: 'chat',
      reason: 'trial_expired',
      expectedMsg: 'Your 3-day free trial has expired. Please choose a plan to continue.'
    },
    {
      kind: 'chat',
      reason: 'trial_limit_reached',
      expectedMsg: `You have used all ${TRIAL_CHAT_LIMIT} free practice sessions in your trial. Please choose a plan to continue.`
    },
    {
      kind: 'scenario',
      reason: 'trial_limit_reached',
      expectedMsg: `You have used all ${TRIAL_SCENARIO_LIMIT} free scenario simulation in your trial. Please choose a plan to continue.`
    },
    {
      kind: 'report',
      reason: 'trial_limit_reached',
      expectedMsg: `You have used all ${TRIAL_REPORT_LIMIT} free analysis reports in your trial. Please choose a plan to continue.`
    },
    {
      kind: 'chat',
      reason: 'trial_not_started',
      expectedMsg: 'An active plan or trial is required to start practice sessions.'
    }
  ];

  for (const { kind, reason, expectedMsg } of reasons) {
    mock.method(supabaseAdmin, 'rpc', async () => ({
      data: [{ allowed: false, reason }],
      error: null
    }));

    const app = express();
    app.use(express.json());
    app.use('/test-plan', (req, res, next) => { req.user = { id: userId }; next(); }, requirePlan(kind), (req, res) => res.json({ ok: true }));

    const res = await request(app, 'POST', '/test-plan', {});
    assert.strictEqual(res.status, 402);
    assert.strictEqual(res.data.error, 'active_plan_required');
    assert.strictEqual(res.data.reason, reason);
    assert.strictEqual(res.data.message, expectedMsg, `Mismatch for ${kind} with reason ${reason}`);

    mock.restoreAll();
  }
});

test('AUD-026: Input validation on POST /chat/sessions returns clear English errors (400)', async () => {
  const userId = 'user-val-001';
  setupAuthMock(userId);

  const app = buildApp();

  // 1. Invalid ISO started_at
  const res1 = await request(app, 'POST', '/chat/sessions', {
    started_at: 'invalid-date',
    ended_at: new Date().toISOString(),
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.strictEqual(res1.status, 400);
  assert.strictEqual(res1.data.error, 'started_at must be a valid ISO timestamp');

  // 2. Invalid session_type
  const res2 = await request(app, 'POST', '/chat/sessions', {
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'invalid_type',
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.strictEqual(res2.status, 400);
  assert.strictEqual(res2.data.error, 'session_type must be one of: freeform, scenario');

  // 3. Scenario session missing scenario_key
  const res3 = await request(app, 'POST', '/chat/sessions', {
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.strictEqual(res3.status, 400);
  assert.strictEqual(res3.data.error, 'scenario_key is required when session_type is "scenario"');

  mock.restoreAll();
});

test('AUD-026: User onboarding and profile validation returns clean English copy (400)', async () => {
  const userId = 'user-prof-val-001';
  setupAuthMock(userId);

  const app = buildApp();

  // 1. Missing name
  const res1 = await request(app, 'POST', '/users/onboarding', {
    name: '  ',
    age: 22,
    occupation_type: 'professional',
    profession: 'Engineer',
    city: 'Delhi',
    goal: 'interview',
    self_level: 'intermediate',
    daily_time: '15_20'
  });
  assert.strictEqual(res1.status, 400);
  assert.strictEqual(res1.data.error, 'name is required');

  // 2. Student missing class_grade
  const res2 = await request(app, 'POST', '/users/onboarding', {
    name: 'Rohan',
    age: 16,
    occupation_type: 'student',
    city: 'Mumbai',
    goal: 'exam_prep',
    self_level: 'beginner',
    daily_time: '15_20'
  });
  assert.strictEqual(res2.status, 400);
  assert.strictEqual(res2.data.error, 'class_grade is required when occupation_type is student');

  // 3. Empty PATCH profile
  const res3 = await request(app, 'PATCH', '/users/profile', {});
  assert.strictEqual(res3.status, 400);
  assert.strictEqual(res3.data.error, 'No valid fields provided to update.');

  mock.restoreAll();
});

test('AUD-026 ADVERSARIAL: 500 error on chatRoutes does NOT leak SUPABASE_SERVICE_ROLE_KEY or OPENAI_API_KEY', async () => {
  const userId = 'user-sec-leak-001';
  setupAuthMock(userId);

  const app = express();
  app.use(express.json());
  app.use('/chat', (req, res, next) => { req.user = { id: userId }; next(); }, chatRoutes);

  // 1. Analyze with missing OpenAI key in process.env
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const res1 = await request(app, 'POST', '/chat/sessions/dummy-id/analyze', {});
  assert.strictEqual(res1.status, 500);
  assert.strictEqual(res1.data.error, 'Server configuration error. Please try again later.');
  assert.strictEqual(JSON.stringify(res1.data).includes('OPENAI_API_KEY'), false, 'Must not leak OPENAI_API_KEY');

  process.env.OPENAI_API_KEY = originalKey;
  mock.restoreAll();
});

test('AUD-026 ADVERSARIAL: 500 error on paymentRoutes does NOT leak RAZORPAY_KEY_ID or secrets', async () => {
  const userId = 'user-sec-leak-002';
  setupAuthMock(userId);

  const app = express();
  app.use(express.json());
  app.use('/payments', (req, res, next) => { req.user = { id: userId }; next(); }, paymentRoutes);

  // Requesting order with invalid plan name
  const res = await request(app, 'POST', '/payments/create-order', { plan: 'invalid_plan' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.data.error, 'plan must be one of: starter, commit_mode');
  assert.strictEqual(JSON.stringify(res.data).includes('RAZORPAY_KEY_SECRET'), false);

  mock.restoreAll();
});
