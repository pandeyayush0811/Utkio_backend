const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'dummy-openai-key';

const { refundTrialReportCredit } = require('../routes/chatRoutes');
const chatRoutes = require('../routes/chatRoutes');
const { supabaseAdmin, supabaseAnon } = require('../lib/supabaseClient');
const { OpenAI } = require('openai');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/chat', chatRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
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

// -----------------------------------------------------------------------------
// SECTION 1: UNIT & BOUNDARY ADVERSARIAL TESTS FOR refundTrialReportCredit()
// -----------------------------------------------------------------------------

// Verifies the core fix: standard free tier (plan = 'none') decrements counter
test('adversarial: plan === "none" decrements trial_reports_used from positive integer (AUD-001 core fix)', async () => {
  let updatedPayload = null;
  let targetUserId = null;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: (col, id) => {
          assert.strictEqual(col, 'id');
          targetUserId = id;
          return {
            single: async () => ({ data: { plan: 'none', trial_reports_used: 3 }, error: null })
          };
        }
      }),
      update: (payload) => {
        updatedPayload = payload;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-plan-none-3');
  assert.strictEqual(targetUserId, 'user-plan-none-3');
  assert.deepStrictEqual(updatedPayload, { trial_reports_used: 2 });
  mock.restoreAll();
});

// Verifies upper boundary decrement when user has reached max limit (5) before failure
test('adversarial: plan === "none" at upper boundary (limit 5) decrements to 4', async () => {
  let updatedPayload = null;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: 'none', trial_reports_used: 5 }, error: null })
        })
      }),
      update: (payload) => {
        updatedPayload = payload;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-plan-none-5');
  assert.deepStrictEqual(updatedPayload, { trial_reports_used: 4 });
  mock.restoreAll();
});

// Verifies legacy/defensive handling when plan is explicitly null in DB row
test('adversarial: plan === null decrements trial_reports_used (defensive null handling)', async () => {
  let updatedPayload = null;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: null, trial_reports_used: 1 }, error: null })
        })
      }),
      update: (payload) => {
        updatedPayload = payload;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-plan-null-1');
  assert.deepStrictEqual(updatedPayload, { trial_reports_used: 0 });
  mock.restoreAll();
});

// Verifies defensive handling when plan property is undefined on profile object
test('adversarial: plan === undefined decrements trial_reports_used', async () => {
  let updatedPayload = null;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { trial_reports_used: 4 }, error: null })
        })
      }),
      update: (payload) => {
        updatedPayload = payload;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-plan-undefined');
  assert.deepStrictEqual(updatedPayload, { trial_reports_used: 3 });
  mock.restoreAll();
});

// Verifies defensive handling when plan is an empty string
test('adversarial: plan === "" (empty string) decrements trial_reports_used', async () => {
  let updatedPayload = null;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: '', trial_reports_used: 2 }, error: null })
        })
      }),
      update: (payload) => {
        updatedPayload = payload;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-plan-empty-string');
  assert.deepStrictEqual(updatedPayload, { trial_reports_used: 1 });
  mock.restoreAll();
});

// Verifies paid tiers ('starter') are strictly protected and never decremented
test('adversarial: plan === "starter" (paid tier) NEVER updates trial_reports_used', async () => {
  let updateCalled = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: 'starter', trial_reports_used: 3 }, error: null })
        })
      }),
      update: () => {
        updateCalled = true;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-plan-starter');
  assert.strictEqual(updateCalled, false);
  mock.restoreAll();
});

// Verifies paid tiers ('unlimited') are strictly protected and never decremented
test('adversarial: plan === "unlimited" (paid tier) NEVER updates trial_reports_used', async () => {
  let updateCalled = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: 'unlimited', trial_reports_used: 2 }, error: null })
        })
      }),
      update: () => {
        updateCalled = true;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-plan-unlimited');
  assert.strictEqual(updateCalled, false);
  mock.restoreAll();
});

// Verifies paid tiers ('commit_mode') are strictly protected and never decremented
test('adversarial: plan === "commit_mode" (paid tier) NEVER updates trial_reports_used', async () => {
  let updateCalled = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: 'commit_mode', trial_reports_used: 5 }, error: null })
        })
      }),
      update: () => {
        updateCalled = true;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-plan-commit-mode');
  assert.strictEqual(updateCalled, false);
  mock.restoreAll();
});

// Verifies legacy string 'free' is not treated as valid 'none' plan (strict schema adherence)
test('adversarial: plan === "free" (invalid schema enum) does NOT trigger refund', async () => {
  let updateCalled = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: 'free', trial_reports_used: 2 }, error: null })
        })
      }),
      update: () => {
        updateCalled = true;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-plan-invalid-free');
  assert.strictEqual(updateCalled, false);
  mock.restoreAll();
});

// Verifies uppercase 'NONE' does not accidentally trigger refund (case-sensitive check)
test('adversarial: plan === "NONE" (uppercase) does NOT trigger refund', async () => {
  let updateCalled = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: 'NONE', trial_reports_used: 2 }, error: null })
        })
      }),
      update: () => {
        updateCalled = true;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-plan-uppercase-none');
  assert.strictEqual(updateCalled, false);
  mock.restoreAll();
});

// Verifies whitespace injection 'none ' does not match
test('adversarial: plan === "none " (whitespace injection) does NOT trigger refund', async () => {
  let updateCalled = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: 'none ', trial_reports_used: 2 }, error: null })
        })
      }),
      update: () => {
        updateCalled = true;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-plan-whitespace-none');
  assert.strictEqual(updateCalled, false);
  mock.restoreAll();
});

// Verifies boundary: zero trial reports used never decrements into negative
test('adversarial: boundary: trial_reports_used === 0 does NOT decrement to -1 or call update', async () => {
  let updateCalled = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: 'none', trial_reports_used: 0 }, error: null })
        })
      }),
      update: () => {
        updateCalled = true;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-zero-credits');
  assert.strictEqual(updateCalled, false);
  mock.restoreAll();
});

// Verifies boundary: negative trial reports used is ignored
test('adversarial: boundary: negative trial_reports_used (e.g. -1) is ignored and never updated', async () => {
  let updateCalled = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: 'none', trial_reports_used: -1 }, error: null })
        })
      }),
      update: () => {
        updateCalled = true;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-negative-credits');
  assert.strictEqual(updateCalled, false);
  mock.restoreAll();
});

// Verifies non-numeric / NaN trial_reports_used does not trigger DB update
test('adversarial: boundary: non-numeric/NaN trial_reports_used does NOT trigger update', async () => {
  let updateCalled = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: 'none', trial_reports_used: NaN }, error: null })
        })
      }),
      update: () => {
        updateCalled = true;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-nan-credits');
  assert.strictEqual(updateCalled, false);
  mock.restoreAll();
});

// Verifies invalid/falsy user IDs return early without any DB queries
test('adversarial: invalid user IDs (null, undefined, empty string, false, 0) return early safely', async () => {
  let fromCalled = false;

  mock.method(supabaseAdmin, 'from', () => {
    fromCalled = true;
    return {};
  });

  await refundTrialReportCredit(null);
  await refundTrialReportCredit(undefined);
  await refundTrialReportCredit('');
  await refundTrialReportCredit(false);
  await refundTrialReportCredit(0);

  assert.strictEqual(fromCalled, false);
  mock.restoreAll();
});

// Verifies user not found (data = null) exits gracefully without crashing
test('adversarial: user not found in profiles table exits cleanly without crash or update', async () => {
  let updateCalled = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null, error: null })
        })
      }),
      update: () => {
        updateCalled = true;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await refundTrialReportCredit('user-nonexistent');
  assert.strictEqual(updateCalled, false);
  mock.restoreAll();
});

// Verifies Supabase select error is handled gracefully without unhandled rejection
test('adversarial: Supabase select error (e.g. timeout/disconnect) does not throw or crash', async () => {
  let updateCalled = false;

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null, error: { message: 'connection reset by peer', code: 'ECONNRESET' } })
        })
      }),
      update: () => {
        updateCalled = true;
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  await assert.doesNotReject(async () => {
    await refundTrialReportCredit('user-db-error');
  });
  assert.strictEqual(updateCalled, false);
  mock.restoreAll();
});

// Verifies Supabase update error/rejection is caught internally by try/catch
test('adversarial: Supabase update rejection is caught safely and does not bubble', async () => {
  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: 'none', trial_reports_used: 1 }, error: null })
        })
      }),
      update: () => {
        throw new Error('Deadlock detected on profiles row lock');
      }
    };
  });

  await assert.doesNotReject(async () => {
    await refundTrialReportCredit('user-deadlock');
  });
  mock.restoreAll();
});

// Verifies multi-step consecutive failures cleanly decrement counter step-by-step
test('adversarial: consecutive AI failure refunds simulate step-by-step decrement down to 0', async () => {
  let currentUsage = 3;
  const history = [];

  mock.method(supabaseAdmin, 'from', (table) => {
    assert.strictEqual(table, 'profiles');
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { plan: 'none', trial_reports_used: currentUsage }, error: null })
        })
      }),
      update: (payload) => {
        currentUsage = payload.trial_reports_used;
        history.push(currentUsage);
        return { eq: async () => ({ error: null }) };
      }
    };
  });

  // 1st failure: 3 -> 2
  await refundTrialReportCredit('user-multi-fail');
  assert.strictEqual(currentUsage, 2);

  // 2nd failure: 2 -> 1
  await refundTrialReportCredit('user-multi-fail');
  assert.strictEqual(currentUsage, 1);

  // 3rd failure: 1 -> 0
  await refundTrialReportCredit('user-multi-fail');
  assert.strictEqual(currentUsage, 0);

  // 4th failure: 0 -> remains 0 (no update)
  await refundTrialReportCredit('user-multi-fail');
  assert.strictEqual(currentUsage, 0);

  assert.deepStrictEqual(history, [2, 1, 0]);
  mock.restoreAll();
});

// -----------------------------------------------------------------------------
// SECTION 2: END-TO-END ROUTE TRIGGER TESTS FOR POST /chat/sessions/:id/analyze
// -----------------------------------------------------------------------------

function setupAuthMock(userId) {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: userId, email: `${userId}@example.com` } },
    error: null
  }));
}

// Verifies route Trigger A: OpenAI API failure triggers refundTrialReportCredit and returns 502
test('adversarial route trigger: upstream OpenAI failure triggers refund and returns 502 with claim release', async () => {
  const userId = 'user-adv-route-1';
  const sessionId = 'session-adv-001';
  let refundCalledWith = null;
  let claimDeleted = false;

  setupAuthMock(userId);

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
            single: async () => ({ data: { id: 'claim-101' }, error: null }) // claim won
          })
        }),
        delete: () => ({
          eq: async () => {
            claimDeleted = true;
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
              single: async () => ({ data: { id: sessionId, turn_count: 12 }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { name: 'Adversarial Tester', plan: 'none', trial_reports_used: 1 }, error: null })
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
                { role: 'assistant', content: 'Hi there', turn_index: 2 },
                { role: 'user', content: 'How are you?', turn_index: 3 }
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
            single: async () => ({ data: { prompt: 'Analyze this conversation' }, error: null })
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
    const err = new Error('OpenAI service overloaded (502 Bad Gateway)');
    err.status = 502;
    throw err;
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 502);
  assert.strictEqual(data.error, 'Analysis failed — please try again.');
  assert.deepStrictEqual(refundCalledWith, { trial_reports_used: 0 });

  mock.restoreAll();
});

// Verifies route Trigger B: OpenAI returning empty text triggers refundTrialReportCredit and returns 502
test('adversarial route trigger: upstream OpenAI empty/whitespace output triggers refund and returns 502', async () => {
  const userId = 'user-adv-route-2';
  const sessionId = 'session-adv-002';
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
            single: async () => ({ data: { id: 'claim-102' }, error: null })
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
              single: async () => ({ data: { id: sessionId, turn_count: 14 }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { name: 'Tester', plan: 'none', trial_reports_used: 2 }, error: null })
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
                { role: 'user', content: 'Turn 1', turn_index: 1 },
                { role: 'assistant', content: 'Response 1', turn_index: 2 }
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
            single: async () => ({ data: { prompt: 'System prompt' }, error: null })
          })
        })
      };
    }
    throw new Error(`Unexpected table queried: ${table}`);
  });

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{ allowed: true, reason: 'trial_ok' }],
    error: null
  }));

  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => ({
    choices: [{ message: { content: '   ' } }] // only whitespace
  }));

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 502);
  assert.strictEqual(data.error, 'Analysis failed — please try again.');
  assert.deepStrictEqual(refundCalledWith, { trial_reports_used: 1 });

  mock.restoreAll();
});

// Verifies route Trigger C: DB report update error after successful LLM response triggers refund
test('adversarial route trigger: DB update error on session_reports triggers refund and propagates error', async () => {
  const userId = 'user-adv-route-3';
  const sessionId = 'session-adv-003';
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
            single: async () => ({ data: { id: 'claim-103' }, error: null })
          })
        }),
        update: () => ({
          eq: () => ({
            select: () => ({
              single: async () => ({
                data: null,
                error: { message: 'Database disk full or constraint error', status: 500 }
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
              single: async () => ({ data: { id: sessionId, turn_count: 15 }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { name: 'Tester', plan: 'none', trial_reports_used: 1 }, error: null })
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
              data: [{ role: 'user', content: 'Hi', turn_index: 1 }],
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
            single: async () => ({ data: { prompt: 'System' }, error: null })
          })
        })
      };
    }
    throw new Error(`Unexpected table queried: ${table}`);
  });

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{ allowed: true, reason: 'trial_ok' }],
    error: null
  }));

  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => ({
    choices: [{ message: { content: 'Valid generated report text here.' } }]
  }));

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 500);
  assert.match(data.error, /Database disk full/);
  assert.deepStrictEqual(refundCalledWith, { trial_reports_used: 0 });

  mock.restoreAll();
});

// Verifies route Non-Trigger: successful analysis generation NEVER triggers refund
test('adversarial route non-trigger: successful LLM analysis saves report and NEVER refunds', async () => {
  const userId = 'user-adv-route-4';
  const sessionId = 'session-adv-004';
  let refundCalled = false;

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
            single: async () => ({ data: { id: 'claim-104' }, error: null })
          })
        }),
        update: () => ({
          eq: () => ({
            select: () => ({
              single: async () => ({
                data: {
                  id: 'report-104',
                  session_id: sessionId,
                  report_text: 'Excellent English speaking flow!',
                  model_version: 'gpt-4o-mini',
                  generated_at: new Date().toISOString()
                },
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
              single: async () => ({ data: { id: sessionId, turn_count: 16 }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { name: 'Tester', plan: 'none', trial_reports_used: 1 }, error: null })
          })
        }),
        update: () => {
          refundCalled = true;
          return { eq: async () => ({ error: null }) };
        }
      };
    }
    if (table === 'chat_messages') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({
              data: [{ role: 'user', content: 'Turn', turn_index: 1 }],
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
            single: async () => ({ data: { prompt: 'System' }, error: null })
          })
        })
      };
    }
    throw new Error(`Unexpected table queried: ${table}`);
  });

  mock.method(supabaseAdmin, 'rpc', async () => ({
    data: [{ allowed: true, reason: 'trial_ok' }],
    error: null
  }));

  mock.method(OpenAI.Chat.Completions.prototype, 'create', async () => ({
    choices: [{ message: { content: 'Excellent English speaking flow!' } }]
  }));

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 200);
  assert.strictEqual(data.already_existed, false);
  assert.strictEqual(data.report.report_text, 'Excellent English speaking flow!');
  assert.strictEqual(refundCalled, false);

  mock.restoreAll();
});

// Verifies route Non-Trigger: session turn count < MIN_TURNS_FOR_ANALYSIS (10) rejects early with 400 and NEVER refunds
test('adversarial route non-trigger: turn_count < 10 pre-check rejects with 400 and NEVER triggers refund', async () => {
  const userId = 'user-adv-route-5';
  const sessionId = 'session-adv-005';
  let refundCalled = false;

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
              single: async () => ({ data: { id: sessionId, turn_count: 2 }, error: null })
            })
          })
        })
      };
    }
    if (table === 'profiles') {
      return {
        update: () => {
          refundCalled = true;
          return { eq: async () => ({ error: null }) };
        }
      };
    }
    throw new Error(`Unexpected table queried: ${table}`);
  });

  const app = buildApp();
  const { status, data } = await post(app, `/chat/sessions/${sessionId}/analyze`);

  assert.strictEqual(status, 400);
  assert.match(data.error, /needs at least 10 turns/);
  assert.strictEqual(refundCalled, false);

  mock.restoreAll();
});
