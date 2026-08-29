const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'dummy-openai-key';

const chatRoutes = require('../routes/chatRoutes');
const { MIN_TURNS_FOR_ANALYSIS, MIN_SCENARIO_TURNS_FOR_ANALYSIS } = require('../routes/chatRoutes');
const { supabaseAdmin, supabaseAnon } = require('../lib/supabaseClient');
const { OpenAI } = require('openai');

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
// Suite 1: Constants & Export Verification
// ─────────────────────────────────────────────────────────────────────────────

test('constants: exports MIN_SCENARIO_TURNS_FOR_ANALYSIS === 2 and MIN_TURNS_FOR_ANALYSIS === 10', () => {
  // Why this matters: Verifies constants match system contract and are properly exported.
  assert.strictEqual(MIN_SCENARIO_TURNS_FOR_ANALYSIS, 2, 'Scenario turn threshold must be 2');
  assert.strictEqual(MIN_TURNS_FOR_ANALYSIS, 10, 'Freeform turn threshold must remain 10');
  assert.strictEqual(typeof MIN_SCENARIO_TURNS_FOR_ANALYSIS, 'number');
  assert.strictEqual(typeof MIN_TURNS_FOR_ANALYSIS, 'number');
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Differentiated Turn Thresholds for POST /chat/sessions/:id/analyze
// ─────────────────────────────────────────────────────────────────────────────

test('adversarial: scenario session with 4 turns (2 <= turns < 10) allows analysis and returns 200', async () => {
  // Why this matters: Core AUD-023 fix — valid 3-minute scenario with 4 turns must be analyzed.
  const userId = 'user-scenario-4turns';
  const sessionId = 'session-scen-004';
  setupAuthMock(userId);

  let updatedReportData = null;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: null }) // no existing report
            })
          })
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: 'claim-scen-004' }, error: null })
          })
        }),
        update: (payload) => {
          updatedReportData = payload;
          return {
            eq: () => ({
              select: () => ({
                single: async () => ({
                  data: {
                    id: 'claim-scen-004',
                    session_id: sessionId,
                    report_text: 'Great scenario simulation!',
                    created_at: new Date().toISOString()
                  },
                  error: null
                })
              })
            })
          };
        },
        delete: () => ({ eq: async () => ({ error: null }) })
      };
    }
    if (table === 'chat_sessions') {
      return {
        select: (cols) => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: sessionId, turn_count: 4, session_type: 'scenario' },
                error: null
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
              data: {
                name: 'Priya',
                age: 22,
                occupation_type: 'student',
                class_grade: 'College',
                profession: null,
                city: 'Delhi',
                goal: 'Fluency',
                self_level: 'intermediate'
              },
              error: null
            })
          })
        })
      };
    }
    if (table === 'chat_messages') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({
              data: [
                { role: 'user', content: 'Excuse me, where is the metro?', turn_index: 1 },
                { role: 'assistant', content: 'Take the next left.', turn_index: 2 },
                { role: 'user', content: 'Thank you so much!', turn_index: 3 },
                { role: 'assistant', content: 'You are welcome!', turn_index: 4 }
              ],
              error: null
            })
          })
        })
      };
    }
    if (table === 'prompt_configs') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { prompt: 'Scenario analysis prompt: ' }, error: null })
          })
        })
      };
    }
    throw new Error(`Unexpected table queried: ${table}`);
  });

  mock.method(supabaseAdmin, 'rpc', async (fn) => {
    if (fn === 'consume_access') {
      return { data: [{ allowed: true, reason: 'plan_ok' }], error: null };
    }
    return { data: null, error: null };
  });

  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => ({
    choices: [{ message: { content: '## Feedback\nBohot badhiya scenario practice!' } }]
  }));

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 200, `Expected 200 for 4-turn scenario session, got ${status} with body: ${JSON.stringify(data)}`);
  assert.strictEqual(data.already_existed, false);
  assert.ok(data.report, 'Expected report in response body');
  assert.strictEqual(data.report.report_text, 'Great scenario simulation!');
  assert.ok(updatedReportData, 'Expected session_reports update to have been called');

  mock.restoreAll();
});

test('adversarial: scenario session with exact 2 turns (boundary) allows analysis and returns 200', async () => {
  // Why this matters: Verifies exact boundary condition (turn_count === 2).
  const userId = 'user-scenario-2turns';
  const sessionId = 'session-scen-002';
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
            single: async () => ({ data: { id: 'claim-scen-002' }, error: null })
          })
        }),
        update: () => ({
          eq: () => ({
            select: () => ({
              single: async () => ({
                data: { id: 'claim-scen-002', session_id: sessionId, report_text: 'Report for 2 turns' },
                error: null
              })
            })
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
                data: { id: sessionId, turn_count: 2, session_type: 'scenario' },
                error: null
              })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { name: 'Rahul' }, error: null }) }) }) };
    }
    if (table === 'chat_messages') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ role: 'user', content: 'Hi', turn_index: 1 }], error: null }) }) }) };
    }
    if (table === 'prompt_configs') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { prompt: 'P' }, error: null }) }) }) };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'plan_ok' }], error: null }));
  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => ({
    choices: [{ message: { content: 'Report text' } }]
  }));

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 200);
  assert.ok(data.report);

  mock.restoreAll();
});

test('adversarial: scenario session with 1 turn (< 2) returns 400 with min 2 turns requirement', async () => {
  // Why this matters: Strict rejection of incomplete 1-turn simulation.
  const userId = 'user-scenario-1turn';
  const sessionId = 'session-scen-001';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }) };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: sessionId, turn_count: 1, session_type: 'scenario' },
                error: null
              })
            })
          })
        })
      };
    }
    throw new Error(`Unexpected table queried: ${table}`);
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 400);
  assert.strictEqual(data.error, 'Session needs at least 2 turns to analyze (has 1).');

  mock.restoreAll();
});

test('adversarial: scenario session with 0 turns returns 400 with min 2 turns requirement', async () => {
  // Why this matters: 0-turn aborted simulation must be rejected.
  const userId = 'user-scenario-0turn';
  const sessionId = 'session-scen-000';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }) };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: sessionId, turn_count: 0, session_type: 'scenario' },
                error: null
              })
            })
          })
        })
      };
    }
    throw new Error(`Unexpected table queried: ${table}`);
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 400);
  assert.strictEqual(data.error, 'Session needs at least 2 turns to analyze (has 0).');

  mock.restoreAll();
});

test('adversarial: freeform session with 4 turns (< 10) returns 400 with min 10 turns requirement', async () => {
  // Why this matters: Freeform chats must NOT be relaxed to 2 turns; 10 turns required.
  const userId = 'user-freeform-4turns';
  const sessionId = 'session-ff-004';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }) };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: sessionId, turn_count: 4, session_type: 'freeform' },
                error: null
              })
            })
          })
        })
      };
    }
    throw new Error(`Unexpected table queried: ${table}`);
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 400);
  assert.strictEqual(data.error, 'Session needs at least 10 turns to analyze (has 4).');

  mock.restoreAll();
});

test('adversarial: freeform session with 9 turns (boundary off-by-one) returns 400', async () => {
  // Why this matters: Off-by-one guard for freeform chats.
  const userId = 'user-freeform-9turns';
  const sessionId = 'session-ff-009';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }) };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: sessionId, turn_count: 9, session_type: 'freeform' },
                error: null
              })
            })
          })
        })
      };
    }
    throw new Error(`Unexpected table queried: ${table}`);
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 400);
  assert.strictEqual(data.error, 'Session needs at least 10 turns to analyze (has 9).');

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Dirty & Legacy Database States
// ─────────────────────────────────────────────────────────────────────────────

test('adversarial: session with session_type null/undefined defaults to freeform (needs 10 turns)', async () => {
  // Why this matters: Backward compatibility with pre-migration records without session_type.
  const userId = 'user-legacy-null-type';
  const sessionId = 'session-legacy-005';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }) };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: sessionId, turn_count: 5, session_type: null },
                error: null
              })
            })
          })
        })
      };
    }
    throw new Error(`Unexpected table queried: ${table}`);
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 400);
  assert.strictEqual(data.error, 'Session needs at least 10 turns to analyze (has 5).');

  mock.restoreAll();
});

test('adversarial: negative turn_count is rejected with 400', async () => {
  // Why this matters: Corrupted database integers must not pass the check.
  const userId = 'user-corrupt-turns';
  const sessionId = 'session-scen-neg';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }) };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: sessionId, turn_count: -1, session_type: 'scenario' },
                error: null
              })
            })
          })
        })
      };
    }
    throw new Error(`Unexpected table queried: ${table}`);
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 400);
  assert.strictEqual(data.error, 'Session needs at least 2 turns to analyze (has -1).');

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: Cross-Tenant Security & Authentication
// ─────────────────────────────────────────────────────────────────────────────

test('adversarial: unauthorized request without token returns 401', async () => {
  // Why this matters: Unauthenticated calls cannot trigger AI analysis or database lookups.
  const app = buildApp();
  const { status } = await post(app, '/chat/sessions/any-session/analyze', {}, {});
  assert.strictEqual(status, 401);
});

test('adversarial: user cannot analyze another user scenario session (ownership check -> 404)', async () => {
  // Why this matters: Strict tenant isolation prevents stealing reports or burning quota.
  const attackerId = 'attacker-user';
  const victimSessionId = 'victim-scen-session';
  setupAuthMock(attackerId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }) };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: (col, val) => ({
            eq: (col2, val2) => ({
              single: async () => ({ data: null, error: { message: 'Row not found' } })
            })
          })
        })
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${victimSessionId}/analyze`);

  assert.strictEqual(status, 404);
  assert.strictEqual(data.error, 'Session not found');

  mock.restoreAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5: Pre-existing Reports, Concurrency & Stale Claims
// ─────────────────────────────────────────────────────────────────────────────

test('adversarial: pre-existing report returns 200 already_existed: true without re-running turn checks or AI', async () => {
  // Why this matters: If report is already saved, viewing it must be free and fast.
  const userId = 'user-has-report';
  const sessionId = 'session-with-rep';
  setupAuthMock(userId);

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'existing-rep-id',
                  session_id: sessionId,
                  report_text: 'Prior existing analysis text',
                  created_at: new Date().toISOString()
                },
                error: null
              })
            })
          })
        })
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 200);
  assert.strictEqual(data.already_existed, true);
  assert.strictEqual(data.report.report_text, 'Prior existing analysis text');

  mock.restoreAll();
});

test('adversarial: concurrent analyze request hits 409 report_in_progress', async () => {
  // Why this matters: Prevents duplicate OpenAI calls when user triggers multiple tabs.
  const userId = 'user-concurrent';
  const sessionId = 'session-scen-concurrent';
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
            single: async () => ({ data: null, error: { code: '23505', message: 'unique constraint violation' } })
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
                data: { id: sessionId, turn_count: 4, session_type: 'scenario' },
                error: null
              })
            })
          })
        })
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 409);
  assert.strictEqual(data.error, 'report_in_progress');

  mock.restoreAll();
});

test('adversarial: stale claim (>3 min) is deleted and reclaimed successfully for scenario session', async () => {
  // Why this matters: Server crashes during generation must not permanently lock session from analysis.
  const userId = 'user-stale-claim';
  const sessionId = 'session-scen-stale';
  setupAuthMock(userId);

  let deletedStaleClaim = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'session_reports') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'stale-claim-1',
                  session_id: sessionId,
                  report_text: null, // in-progress claim
                  created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() // 5 minutes old
                },
                error: null
              })
            })
          })
        }),
        delete: () => ({
          eq: async (col, val) => {
            if (val === 'stale-claim-1') deletedStaleClaim = true;
            return { error: null };
          }
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: 'new-claim-2' }, error: null })
          })
        }),
        update: () => ({
          eq: () => ({
            select: () => ({
              single: async () => ({
                data: { id: 'new-claim-2', session_id: sessionId, report_text: 'Recovered analysis' },
                error: null
              })
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
                data: { id: sessionId, turn_count: 4, session_type: 'scenario' },
                error: null
              })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { name: 'Priya' }, error: null }) }) }) };
    }
    if (table === 'chat_messages') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ role: 'user', content: 'Hi', turn_index: 1 }], error: null }) }) }) };
    }
    if (table === 'prompt_configs') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { prompt: 'P' }, error: null }) }) }) };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'plan_ok' }], error: null }));
  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => ({
    choices: [{ message: { content: 'Recovered analysis' } }]
  }));

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 200);
  assert.strictEqual(deletedStaleClaim, true, 'Expected stale claim to have been deleted');
  assert.strictEqual(data.report.report_text, 'Recovered analysis');

  mock.restoreAll();
});
