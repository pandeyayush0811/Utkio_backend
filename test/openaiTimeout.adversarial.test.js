const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'dummy-openai-key';

const chatRoutes = require('../routes/chatRoutes');
const { supabaseAdmin, supabaseAnon } = require('../lib/supabaseClient');
const OpenAI = require('openai');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/chat', chatRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function setupAuthMock(userId) {
  mock.method(supabaseAnon.auth, 'getUser', async (token) => {
    if (token === 'test-token') {
      return { data: { user: { id: userId, email: `${userId}@example.com` } }, error: null };
    }
    return { data: { user: null }, error: new Error('Invalid token') };
  });
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
// AUD-011 Comprehensive Adversarial Test Suite: OpenAI Timeout, Claim & Refund
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-011: OPENAI_TIMEOUT_MS constant is exported, numeric, and defaults to 45000ms', () => {
  assert.strictEqual(typeof chatRoutes.OPENAI_TIMEOUT_MS, 'number');
  assert.strictEqual(chatRoutes.OPENAI_TIMEOUT_MS, 45000, 'Expected default 45000ms timeout');
});

test('AUD-011 ADVERSARIAL: OpenAI APIConnectionTimeoutError returns HTTP 504 and triggers trial credit refund & claim deletion', async () => {
  const userId = 'user-timeout-001';
  const sessionId = 'session-timeout-001';
  let refundCalledWith = null;
  let claimDeleted = false;

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
            single: async () => ({ data: { id: 'claim-timeout-001' }, error: null })
          })
        }),
        delete: () => ({
          eq: async (col, val) => {
            if (col === 'id' && val === 'claim-timeout-001') {
              claimDeleted = true;
            }
            return { error: null };
          }
        })
      };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: { id: sessionId, turn_count: 12, session_type: 'freeform' }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { name: 'Timeout Tester', plan: 'none', trial_reports_used: 1 }, error: null })
          })
        }),
        update: (payload) => {
          refundCalledWith = payload;
          return { eq: async () => ({ error: null }) };
        }
      };
    }
    if (table === 'chat_messages') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({
              data: [
                { role: 'user', content: 'Hello', turn_index: 1 },
                { role: 'assistant', content: 'Hi', turn_index: 2 }
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
            single: async () => ({ data: { prompt: 'Analyze prompt' }, error: null })
          })
        })
      };
    }
    throw new Error(`Unexpected table queried: ${table}`);
  });

  mock.method(supabaseAdmin, 'rpc', async (fn) => {
    if (fn === 'consume_access') {
      return { data: [{ allowed: true, reason: 'trial_ok' }], error: null };
    }
    return { data: null, error: null };
  });

  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => {
    const err = new Error('Request timed out.');
    err.name = 'APIConnectionTimeoutError';
    err.status = undefined;
    throw err;
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 504, 'Expected HTTP 504 Gateway Timeout on OpenAI timeout error');
  assert.strictEqual(data.error, 'Analysis timed out — please try again.');
  assert.deepStrictEqual(refundCalledWith, { trial_reports_used: 0 }, 'Trial credit must be refunded on timeout');
  assert.strictEqual(claimDeleted, true, 'Claim row must be deleted on timeout via res.once(finish)');

  mock.restoreAll();
});

test('AUD-011 ADVERSARIAL: AbortError (client/signal abort) returns HTTP 504 and refunds credit', async () => {
  const userId = 'user-abort-002';
  const sessionId = 'session-abort-002';
  let refundCalledWith = null;
  let claimDeleted = false;

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
            single: async () => ({ data: { id: 'claim-abort-002' }, error: null })
          })
        }),
        delete: () => ({
          eq: async (col, val) => {
            if (col === 'id' && val === 'claim-abort-002') claimDeleted = true;
            return { error: null };
          }
        })
      };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: { id: sessionId, turn_count: 12, session_type: 'freeform' }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { name: 'Abort Tester', plan: 'none', trial_reports_used: 2 }, error: null })
          })
        }),
        update: (payload) => {
          refundCalledWith = payload;
          return { eq: async () => ({ error: null }) };
        }
      };
    }
    if (table === 'chat_messages') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [{ role: 'user', content: 'Hi', turn_index: 1 }], error: null })
          })
        })
      };
    }
    if (table === 'prompt_configs') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { prompt: 'Analyze prompt' }, error: null })
          })
        })
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'trial_ok' }], error: null }));

  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    throw err;
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 504);
  assert.strictEqual(data.error, 'Analysis timed out — please try again.');
  assert.deepStrictEqual(refundCalledWith, { trial_reports_used: 1 });
  assert.strictEqual(claimDeleted, true);

  mock.restoreAll();
});

test('AUD-011 ADVERSARIAL: ETIMEDOUT (TCP socket timeout) returns HTTP 504 and refunds credit', async () => {
  const userId = 'user-etimedout-003';
  const sessionId = 'session-etimedout-003';
  let refundCalledWith = null;

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
            single: async () => ({ data: { id: 'claim-etime-003' }, error: null })
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
              single: async () => ({ data: { id: sessionId, turn_count: 12, session_type: 'freeform' }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { name: 'Socket Tester', plan: 'none', trial_reports_used: 3 }, error: null })
          })
        }),
        update: (payload) => {
          refundCalledWith = payload;
          return { eq: async () => ({ error: null }) };
        }
      };
    }
    if (table === 'chat_messages') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [{ role: 'user', content: 'Hi', turn_index: 1 }], error: null })
          })
        })
      };
    }
    if (table === 'prompt_configs') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { prompt: 'Analyze prompt' }, error: null })
          })
        })
      };
    }
  });

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'trial_ok' }], error: null }));

  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => {
    const err = new Error('connect ETIMEDOUT 104.18.7.192:443');
    err.code = 'ETIMEDOUT';
    throw err;
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 504);
  assert.strictEqual(data.error, 'Analysis timed out — please try again.');
  assert.deepStrictEqual(refundCalledWith, { trial_reports_used: 2 });

  mock.restoreAll();
});

test('AUD-011 ADVERSARIAL: request_timeout type returns HTTP 504', async () => {
  const userId = 'user-reqtime-004';
  const sessionId = 'session-reqtime-004';

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
            single: async () => ({ data: { id: 'claim-reqtime-004' }, error: null })
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
              single: async () => ({ data: { id: sessionId, turn_count: 12, session_type: 'freeform' }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { name: 'Req Tester', plan: 'none', trial_reports_used: 1 }, error: null })
          })
        }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
    }
    if (table === 'chat_messages') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [{ role: 'user', content: 'Hi', turn_index: 1 }], error: null })
          })
        })
      };
    }
    if (table === 'prompt_configs') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { prompt: 'Analyze prompt' }, error: null })
          })
        })
      };
    }
  });

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'trial_ok' }], error: null }));

  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => {
    const err = new Error('HTTP client request timed out');
    err.type = 'request_timeout';
    throw err;
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 504);
  assert.strictEqual(data.error, 'Analysis timed out — please try again.');

  mock.restoreAll();
});

test('AUD-011 ADVERSARIAL: Non-timeout OpenAI errors (e.g. 500, RateLimitError) return HTTP 502', async () => {
  const userId = 'user-502-005';
  const sessionId = 'session-502-005';
  let refundCalledWith = null;

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
            single: async () => ({ data: { id: 'claim-502-005' }, error: null })
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
              single: async () => ({ data: { id: sessionId, turn_count: 12, session_type: 'freeform' }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { name: '502 Tester', plan: 'none', trial_reports_used: 1 }, error: null })
          })
        }),
        update: (payload) => {
          refundCalledWith = payload;
          return { eq: async () => ({ error: null }) };
        }
      };
    }
    if (table === 'chat_messages') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [{ role: 'user', content: 'Hi', turn_index: 1 }], error: null })
          })
        })
      };
    }
    if (table === 'prompt_configs') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { prompt: 'Analyze prompt' }, error: null })
          })
        })
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'trial_ok' }], error: null }));

  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => {
    const err = new Error('Rate limit exceeded');
    err.name = 'RateLimitError';
    err.status = 429;
    throw err;
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 502);
  assert.strictEqual(data.error, 'Analysis failed — please try again.');
  assert.deepStrictEqual(refundCalledWith, { trial_reports_used: 0 });

  mock.restoreAll();
});

test('AUD-011 ADVERSARIAL: Paid plan user (plan = starter / commit_mode) does NOT mutate trial_reports_used on timeout', async () => {
  const userId = 'user-paid-timeout-006';
  const sessionId = 'session-paid-timeout-006';
  let updateCalled = false;

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
            single: async () => ({ data: { id: 'claim-paid-006' }, error: null })
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
              single: async () => ({ data: { id: sessionId, turn_count: 12, session_type: 'freeform' }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { name: 'Paid User', plan: 'starter', trial_reports_used: 0 }, error: null })
          })
        }),
        update: () => {
          updateCalled = true;
          return { eq: async () => ({ error: null }) };
        }
      };
    }
    if (table === 'chat_messages') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [{ role: 'user', content: 'Hi', turn_index: 1 }], error: null })
          })
        })
      };
    }
    if (table === 'prompt_configs') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { prompt: 'Analyze prompt' }, error: null })
          })
        })
      };
    }
  });

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'paid_plan' }], error: null }));

  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => {
    const err = new Error('Timeout');
    err.name = 'APIConnectionTimeoutError';
    throw err;
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 504);
  assert.strictEqual(data.error, 'Analysis timed out — please try again.');
  assert.strictEqual(updateCalled, false, 'Paid user should not have trial_reports_used modified');

  mock.restoreAll();
});

test('AUD-011 ADVERSARIAL: Trial user with trial_reports_used === 0 does not underflow to negative on refund', async () => {
  const userId = 'user-zero-refund-007';
  const sessionId = 'session-zero-refund-007';
  let updateCalled = false;

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
            single: async () => ({ data: { id: 'claim-zero-007' }, error: null })
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
              single: async () => ({ data: { id: sessionId, turn_count: 12, session_type: 'freeform' }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { name: 'Zero Used', plan: 'none', trial_reports_used: 0 }, error: null })
          })
        }),
        update: () => {
          updateCalled = true;
          return { eq: async () => ({ error: null }) };
        }
      };
    }
    if (table === 'chat_messages') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [{ role: 'user', content: 'Hi', turn_index: 1 }], error: null })
          })
        })
      };
    }
    if (table === 'prompt_configs') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { prompt: 'Analyze prompt' }, error: null })
          })
        })
      };
    }
  });

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'trial_ok' }], error: null }));

  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => {
    const err = new Error('Timeout');
    err.name = 'APIConnectionTimeoutError';
    throw err;
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 504);
  assert.strictEqual(updateCalled, false, 'Refund should not update if trial_reports_used <= 0');

  mock.restoreAll();
});

test('AUD-011 ADVERSARIAL: Successful OpenAI generation returns 200 and claim row is NOT deleted', async () => {
  const userId = 'user-success-008';
  const sessionId = 'session-success-008';
  let claimDeleted = false;
  let reportUpdated = false;

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
            single: async () => ({ data: { id: 'claim-success-008' }, error: null })
          })
        }),
        update: () => ({
          eq: () => ({
            select: () => ({
              single: async () => {
                reportUpdated = true;
                return {
                  data: {
                    id: 'claim-success-008',
                    session_id: sessionId,
                    report_text: 'Great conversational fluency!'
                  },
                  error: null
                };
              }
            })
          })
        }),
        delete: () => ({
          eq: async (col, val) => {
            if (col === 'id' && val === 'claim-success-008') claimDeleted = true;
            return { error: null };
          }
        })
      };
    }
    if (table === 'chat_sessions') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: { id: sessionId, turn_count: 12, session_type: 'freeform' }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { name: 'Success Tester', plan: 'starter' }, error: null })
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
                { role: 'user', content: 'Hello', turn_index: 1 },
                { role: 'assistant', content: 'Hi there', turn_index: 2 }
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
            single: async () => ({ data: { prompt: 'Analyze prompt' }, error: null })
          })
        })
      };
    }
  });

  mock.method(supabaseAdmin, 'rpc', async () => ({ data: [{ allowed: true, reason: 'paid_plan' }], error: null }));

  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => ({
    choices: [{ message: { content: 'Great conversational fluency!' } }]
  }));

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 200);
  assert.strictEqual(data.report.report_text, 'Great conversational fluency!');
  assert.strictEqual(reportUpdated, true, 'Report row must be updated with generated report');
  assert.strictEqual(claimDeleted, false, 'Claim row must NOT be deleted on success');

  mock.restoreAll();
});
