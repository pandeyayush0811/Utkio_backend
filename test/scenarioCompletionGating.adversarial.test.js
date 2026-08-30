const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// Role: 06_TestWriter (Senior Frontend/Backend Adversarial QA)
// Issue: AUD-031 — Incomplete Scenario Report Gating, Suppressed History Resumption & Chat Hijacking
// Scope: Backend Adversarial Test Suite for POST /chat/sessions/:id/analyze completion gating,
// POST /chat/sessions lifecycle updates & type validation, and snapshot lock integrity.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'dummy-openai-key';

const chatRoutes = require('../routes/chatRoutes');
const { supabaseAdmin, supabaseAnon } = require('../lib/supabaseClient');

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

async function post(app, path, body = {}, headers = { Authorization: 'Bearer test-token' }) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: AUD-031 POST /chat/sessions/:id/analyze Completion Gating
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-031 ADVERSARIAL: Incomplete scenario session (is_completed: false) with 2, 3, 5, 20 turns strictly returns 400', async () => {
  const userId = 'user-scen-incomplete-matrix';
  setupAuthMock(userId);

  const turnCounts = [2, 3, 5, 8, 20];
  for (const turns of turnCounts) {
    const sessionId = `session-incomplete-${turns}`;

    mock.method(supabaseAdmin, 'from', (table) => {
      if (table === 'session_reports') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: null, error: null })
              })
            })
          })
        };
      }
      if (table === 'chat_sessions') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: sessionId,
                    turn_count: turns,
                    session_type: 'scenario',
                    is_completed: false
                  },
                  error: null
                })
              })
            })
          })
        };
      }
      return { select: () => ({ eq: () => ({ single: async () => ({ data: {}, error: null }) }) }) };
    });

    const app = buildApp();
    const res = await post(app, `/chat/sessions/${sessionId}/analyze`);

    assert.strictEqual(res.status, 400, `Incomplete scenario with ${turns} turns must return 400`);
    assert.ok(
      /in progress|complete/i.test(res.data.error),
      `Expected scenario in-progress error message, got: ${JSON.stringify(res.data)}`
    );
  }
});

test('AUD-031 ADVERSARIAL: Incomplete scenario session with 1 turn returns 400 in-progress error before/with turn threshold', async () => {
  const userId = 'user-scen-1turn-incomplete';
  const sessionId = 'session-scen-1turn-inc';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: null })
            })
          })
        })
      };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: sessionId,
                  turn_count: 1,
                  session_type: 'scenario',
                  is_completed: false
                },
                error: null
              })
            })
          })
        })
      };
    }
    return { select: () => ({ eq: () => ({ single: async () => ({ data: {}, error: null }) }) }) };
  });

  const app = buildApp();
  const res = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(res.status, 400);
  assert.ok(
    /in progress|complete/i.test(res.data.error),
    `Expected completion error. Got: ${JSON.stringify(res.data)}`
  );
});

test('AUD-031 ADVERSARIAL: Completed scenario session with 1 turn fails turn threshold check (needs >= 2 turns)', async () => {
  const userId = 'user-scen-1turn-completed';
  const sessionId = 'session-scen-1turn-comp';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: null })
            })
          })
        })
      };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: sessionId,
                  turn_count: 1,
                  session_type: 'scenario',
                  is_completed: true
                },
                error: null
              })
            })
          })
        })
      };
    }
    return { select: () => ({ eq: () => ({ single: async () => ({ data: {}, error: null }) }) }) };
  });

  const app = buildApp();
  const res = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(res.status, 400);
  assert.ok(
    /needs at least 2 turns/i.test(res.data.error),
    `Expected min 2 turns error. Got: ${JSON.stringify(res.data)}`
  );
});

test('AUD-031 ADVERSARIAL: Direct attacker POST /analyze for another user scenario returns 404', async () => {
  const userId = 'user-attacker';
  const sessionId = 'session-victim-scen-001';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: null })
            })
          })
        })
      };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { message: 'Row not found' } })
            })
          })
        })
      };
    }
    return { select: () => ({ eq: () => ({ single: async () => ({ data: {}, error: null }) }) }) };
  });

  const app = buildApp();
  const res = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.data.error, 'Session not found');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: AUD-031 POST /chat/sessions Lifecycle & Type Validation
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-031 VALIDATION: POST /chat/sessions rejects non-boolean is_completed variations with 400', async () => {
  const userId = 'user-val-types';
  setupAuthMock(userId);

  const invalidValues = ['true', 'false', 1, 0, {}, []];
  for (const badVal of invalidValues) {
    const app = buildApp();
    const res = await post(app, '/chat/sessions', {
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      messages: [{ role: 'user', content: 'Testing validation' }],
      is_completed: badVal
    });

    assert.strictEqual(res.status, 400, `Value ${JSON.stringify(badVal)} must be rejected with 400`);
    assert.strictEqual(res.data.error, 'is_completed must be a boolean');
  }
});

test('AUD-031 LIFECYCLE: POST /chat/sessions resumes scenario and updates is_completed to true', async () => {
  const userId = 'user-lifecycle-resume';
  const sessionId = 'session-scen-resumed-001';
  setupAuthMock(userId);

  let updatedPayload = null;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: sessionId,
                  user_id: userId,
                  turn_count: 2,
                  ended_at: new Date().toISOString()
                },
                error: null
              })
            })
          })
        }),
        update: (payload) => {
          updatedPayload = payload;
          return {
            eq: async () => ({ error: null })
          };
        }
      };
    }
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null })
            })
          })
        })
      };
    }
    if (table === 'chat_messages') {
      return {
        upsert: async () => ({ error: null })
      };
    }
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) })
    };
  });

  const app = buildApp();
  const res = await post(app, '/chat/sessions', {
    session_id: sessionId,
    started_at: new Date(Date.now() - 60000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'restaurant_order',
    is_completed: true,
    messages: [
      { role: 'assistant', content: 'Phase 2 feedback monologue' }
    ]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.session_id, sessionId);
  assert.ok(updatedPayload !== null, 'Update payload must be executed');
  assert.strictEqual(updatedPayload.is_completed, true, 'is_completed must be updated to true on finalization');
  assert.strictEqual(updatedPayload.turn_count, 3, 'turn_count must be updated to 3');
});

test('AUD-031 SNAPSHOT INTEGRITY: POST /chat/sessions returns 409 locked if session report already generated', async () => {
  const userId = 'user-locked-snapshot';
  const sessionId = 'session-scen-snapshotted';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: sessionId,
                  user_id: userId,
                  turn_count: 4,
                  ended_at: new Date().toISOString()
                },
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
              maybeSingle: async () => ({ data: { id: 'report-snapshot-001' }, error: null })
            })
          })
        })
      };
    }
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
  });

  const app = buildApp();
  const res = await post(app, '/chat/sessions', {
    session_id: sessionId,
    started_at: new Date(Date.now() - 30000).toISOString(),
    ended_at: new Date().toISOString(),
    session_type: 'scenario',
    scenario_key: 'restaurant_order',
    messages: [{ role: 'user', content: 'Another turn attempt' }]
  });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.data.error, 'locked');
  assert.ok(/already has an analysis report/i.test(res.data.message));
});
