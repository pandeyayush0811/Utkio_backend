const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

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
// Suite 1: AUD-031 Incomplete Scenario Analysis Gating
// ─────────────────────────────────────────────────────────────────────────────

test('adversarial: incomplete scenario session (is_completed: false) rejects POST /analyze with 400 Bad Request', async () => {
  const userId = 'user-incomplete-scen';
  const sessionId = 'session-scen-incomplete-001';
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
                  turn_count: 4,
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

  assert.strictEqual(res.status, 400, 'Incomplete scenario session must be rejected with 400');
  assert.ok(
    res.data.error && /in progress|complete/i.test(res.data.error),
    `Error message must indicate scenario is in progress. Got: ${JSON.stringify(res.data)}`
  );
});

test('adversarial: completed scenario session (is_completed: true) allows POST /analyze', async () => {
  const userId = 'user-completed-scen';
  const sessionId = 'session-scen-completed-001';
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
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: 'claim-scen-001' }, error: null })
          })
        }),
        delete: () => ({ eq: async () => ({ error: null }) })
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
                  turn_count: 4,
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

  assert.notStrictEqual(res.status, 400, 'Completed scenario session must not be rejected by completion 400 gate');
});

test('adversarial: legacy / omitted is_completed scenario session defaults to eligible', async () => {
  const userId = 'user-legacy-scen';
  const sessionId = 'session-scen-legacy-001';
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
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: 'claim-scen-legacy' }, error: null })
          })
        }),
        delete: () => ({ eq: async () => ({ error: null }) })
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
                  turn_count: 4,
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

  assert.notStrictEqual(res.status, 400, 'Legacy scenario without explicit false must not be rejected');
});

test('adversarial: freeform session ignores is_completed: false and analyzes with 10 turns', async () => {
  const userId = 'user-freeform';
  const sessionId = 'session-ff-001';
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
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: 'claim-ff-001' }, error: null })
          })
        }),
        delete: () => ({ eq: async () => ({ error: null }) })
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
                  turn_count: 10,
                  session_type: 'freeform',
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

  assert.notStrictEqual(res.status, 400, 'Freeform sessions are not blocked by is_completed: false');
});

test('validation: POST /chat/sessions rejects non-boolean is_completed with 400', async () => {
  const userId = 'user-validation';
  setupAuthMock(userId);

  const app = buildApp();
  const res = await post(app, '/chat/sessions', {
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    messages: [{ role: 'user', content: 'Hello' }],
    is_completed: 'not_a_boolean'
  });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.data.error, 'is_completed must be a boolean');
});
