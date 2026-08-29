const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const userRoutes = require('../routes/userRoutes');
const { buildProfileUpdate } = require('../routes/userRoutes');
const { supabaseAnon, supabaseAdmin } = require('../lib/supabaseClient');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/users', userRoutes);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

async function request(app, method, path, body = null, headers = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

const VALID_ONBOARDING = {
  name: 'Kavita Patel',
  age: 24,
  occupation_type: 'professional',
  profession: 'UX Designer',
  city: 'Ahmedabad',
  goal: 'interview',
  self_level: 'intermediate',
  daily_time: '15_20',
  english_sample: 'I want to improve my workplace presentation skills.'
};

// ═══════════════════════════════════════════════════════════════════════════
// BACKEND ADVERSARIAL SUITE — Issue #7 (AUD-007: buildProfileUpdate Partial Updates & Validation)
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: AUD-007 Core Bug Reproduction & Partial Field Updatability
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-007 CORE: partial update with ONLY profession correctly extracts and validates profession field', () => {
  // Why this matters: AUD-007 core bug: previously, profession was nested inside
  // `if (has(occupation_type) || !partial)`, silently dropping standalone profession updates.
  const { updateObj, error } = buildProfileUpdate({ profession: 'Senior Lead Architect' }, { partial: true });
  assert.strictEqual(error, undefined);
  // NOTE: When AUD-007 is fixed by Fixer, updateObj.profession must equal 'Senior Lead Architect'.
  // If the bug exists, updateObj.profession will be undefined and updateObj will be empty.
  assert.strictEqual(updateObj.profession, 'Senior Lead Architect', 'profession must not be dropped in partial update');
});

test('AUD-007 CORE: partial update with ONLY class_grade correctly extracts and validates class_grade field', () => {
  // Why this matters: AUD-007 core bug: submitting only class_grade was dropped if occupation_type was omitted.
  const { updateObj, error } = buildProfileUpdate({ class_grade: 'Class 12th PCM' }, { partial: true });
  assert.strictEqual(error, undefined);
  assert.strictEqual(updateObj.class_grade, 'Class 12th PCM', 'class_grade must not be dropped in partial update');
});

test('AUD-007 OCCUPATION SWITCH: switching to professional sets class_grade to null and updates profession', () => {
  // Why this matters: When switching career state, former dependent field must be cleaned up.
  const payload = {
    occupation_type: 'professional',
    profession: 'Financial Analyst'
  };
  const { updateObj, error } = buildProfileUpdate(payload, { partial: true });
  assert.strictEqual(error, undefined);
  assert.strictEqual(updateObj.occupation_type, 'professional');
  assert.strictEqual(updateObj.profession, 'Financial Analyst');
  assert.strictEqual(updateObj.class_grade, null);
});

test('AUD-007 OCCUPATION SWITCH: switching to student sets profession to null and updates class_grade', () => {
  // Why this matters: When switching career state, former dependent field must be cleaned up.
  const payload = {
    occupation_type: 'student',
    class_grade: 'B.Com 1st Year'
  };
  const { updateObj, error } = buildProfileUpdate(payload, { partial: true });
  assert.strictEqual(error, undefined);
  assert.strictEqual(updateObj.occupation_type, 'student');
  assert.strictEqual(updateObj.class_grade, 'B.Com 1st Year');
  assert.strictEqual(updateObj.profession, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: Boundary Length Violations & Free-Text Overflow Protections
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-007 BOUNDARY: rejects name exceeding MAX_NAME_LEN (100 chars)', () => {
  // Why this matters: Prevents DB column overflow and UI layout breakage from direct API spam.
  const longName = 'A'.repeat(101);
  const { error } = buildProfileUpdate({ name: longName }, { partial: true });
  assert.match(error, /name must be at most 100 characters/);

  // Exactly 100 characters must pass
  const validName = 'A'.repeat(100);
  const { updateObj, error: validErr } = buildProfileUpdate({ name: validName }, { partial: true });
  assert.strictEqual(validErr, undefined);
  assert.strictEqual(updateObj.name, validName);
});

test('AUD-007 BOUNDARY: rejects city exceeding MAX_CITY_LEN (100 chars)', () => {
  const longCity = 'C'.repeat(101);
  const { error } = buildProfileUpdate({ city: longCity }, { partial: true });
  assert.match(error, /city must be at most 100 characters/);
});

test('AUD-007 BOUNDARY: rejects class_grade or profession exceeding MAX_OCCUPATION_DETAIL_LEN (150 chars)', () => {
  const longDetail = 'D'.repeat(151);
  const errStudent = buildProfileUpdate({ occupation_type: 'student', class_grade: longDetail }, { partial: true });
  assert.match(errStudent.error, /class_grade must be at most 150 characters/);

  const errPro = buildProfileUpdate({ occupation_type: 'professional', profession: longDetail }, { partial: true });
  assert.match(errPro.error, /profession must be at most 150 characters/);
});

test('AUD-007 BOUNDARY: rejects english_sample exceeding MAX_ENGLISH_SAMPLE_LEN (500 chars)', () => {
  const longSample = 'S'.repeat(501);
  const { error } = buildProfileUpdate({ english_sample: longSample }, { partial: true });
  assert.match(error, /english_sample must be at most 500 characters/);

  // Exactly 500 chars passes
  const validSample = 'S'.repeat(500);
  const { updateObj, error: validErr } = buildProfileUpdate({ english_sample: validSample }, { partial: true });
  assert.strictEqual(validErr, undefined);
  assert.strictEqual(updateObj.english_sample, validSample);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: Whitespace Tampering, Unicode, Emojis & Indian Language Names
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-007 SANITIZATION: trims leading and trailing whitespace from string fields', () => {
  // Why this matters: Clumsy human typing or copy-pasted strings with spaces must be cleaned.
  const payload = {
    name: '   Pooja Sharma   ',
    city: '   Jaipur   ',
    english_sample: '   My sample text.   '
  };
  const { updateObj, error } = buildProfileUpdate(payload, { partial: true });
  assert.strictEqual(error, undefined);
  assert.strictEqual(updateObj.name, 'Pooja Sharma');
  assert.strictEqual(updateObj.city, 'Jaipur');
  assert.strictEqual(updateObj.english_sample, 'My sample text.');
});

test('AUD-007 SANITIZATION: whitespace-only strings fail required field validation', () => {
  // Why this matters: User typing spaces into required name field must not pass.
  const { error } = buildProfileUpdate({ name: '     ' }, { partial: true });
  assert.match(error, /name is required/);
});

test('AUD-007 UNICODE: accepts and preserves Devanagari script, regional names and emojis safely', () => {
  // Why this matters: Utkio is built for Indian users who may enter names or details in Devanagari/Hinglish.
  const payload = {
    name: 'अमित कुमार शर्मा',
    city: 'वाराणसी (काशी)',
    occupation_type: 'professional',
    profession: 'सॉफ्टवेयर इंजीनियर 🚀💻'
  };
  const { updateObj, error } = buildProfileUpdate(payload, { partial: true });
  assert.strictEqual(error, undefined);
  assert.strictEqual(updateObj.name, 'अमित कुमार शर्मा');
  assert.strictEqual(updateObj.city, 'वाराणसी (काशी)');
  assert.strictEqual(updateObj.profession, 'सॉफ्टवेयर इंजीनियर 🚀💻');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: Age Boundary & Numerical Adversarial Inputs
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-007 AGE: strictly enforces whole integer between 5 and 100', () => {
  // Boundary 1: age = 4 (below minimum)
  assert.match(buildProfileUpdate({ age: 4 }, { partial: true }).error, /age must be/);

  // Boundary 2: age = 5 (minimum valid age for school child)
  const age5 = buildProfileUpdate({ age: 5 }, { partial: true });
  assert.strictEqual(age5.error, undefined);
  assert.strictEqual(age5.updateObj.age, 5);

  // Boundary 3: age = 100 (maximum valid age)
  const age100 = buildProfileUpdate({ age: 100 }, { partial: true });
  assert.strictEqual(age100.error, undefined);
  assert.strictEqual(age100.updateObj.age, 100);

  // Boundary 4: age = 101 (above maximum)
  assert.match(buildProfileUpdate({ age: 101 }, { partial: true }).error, /age must be/);

  // Boundary 5: float age = 24.5
  assert.match(buildProfileUpdate({ age: 24.5 }, { partial: true }).error, /age must be/);

  // Boundary 6: string number age = "24"
  const ageStr = buildProfileUpdate({ age: '24' }, { partial: true });
  assert.strictEqual(ageStr.error, undefined);
  assert.strictEqual(ageStr.updateObj.age, 24);

  // Boundary 7: NaN / garbage string age = "twenty"
  assert.match(buildProfileUpdate({ age: 'twenty' }, { partial: true }).error, /age must be/);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: Injection Attacks & Unauthorized Field Stripping
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-007 SECURITY: SQL injection and XSS payloads are handled safely as pure text strings', () => {
  // Why this matters: Malicious input must not cause SQL syntax errors or execute scripts.
  const payload = {
    name: "Robert'; DROP TABLE profiles; --",
    city: "<script>alert('xss')</script>"
  };
  const { updateObj, error } = buildProfileUpdate(payload, { partial: true });
  assert.strictEqual(error, undefined);
  assert.strictEqual(updateObj.name, "Robert'; DROP TABLE profiles; --");
  assert.strictEqual(updateObj.city, "<script>alert('xss')</script>");
});

test('AUD-007 SECURITY: arbitrary unauthorized fields are stripped and never returned in updateObj', () => {
  // Why this matters: Rogue client attempting privilege escalation (e.g. flipping plan to unlimited or making admin).
  const payload = {
    city: 'Pune',
    is_admin: true,
    role: 'superuser',
    plan: 'unlimited',
    plan_expires_at: '2099-01-01T00:00:00Z',
    trial_chats_used: 0
  };
  const { updateObj, error } = buildProfileUpdate(payload, { partial: true });
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(updateObj, { city: 'Pune' });
  assert.strictEqual(updateObj.plan, undefined);
  assert.strictEqual(updateObj.is_admin, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6: HTTP Routes End-to-End Integration (PATCH /profile & POST /onboarding)
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-007 ROUTE: PATCH /users/profile rejects empty request body with 400', async () => {
  // Why this matters: Submitting an empty object is a client no-op and must be rejected.
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-empty-patch', email: 'empty@example.in' } },
    error: null
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'PATCH', '/users/profile', {}, {
    Authorization: 'Bearer valid-token-user'
  });

  assert.strictEqual(status, 400);
  assert.match(data.error, /No valid fields provided to update/);

  mock.restoreAll();
});

test('AUD-007 ROUTE: POST /users/onboarding successfully completes mandatory onboarding', async () => {
  mock.method(supabaseAnon.auth, 'getUser', async () => ({
    data: { user: { id: 'user-onboard-valid', email: 'onboard@example.in' } },
    error: null
  }));

  mock.method(supabaseAdmin, 'from', () => ({
    update: (updatePayload) => {
      assert.strictEqual(updatePayload.onboarding_completed, true);
      assert.strictEqual(updatePayload.name, 'Kavita Patel');
      return {
        eq: () => ({
          select: () => ({
            single: async () => ({
              data: { ...updatePayload, id: 'user-onboard-valid' },
              error: null
            })
          })
        })
      };
    }
  }));

  const app = buildApp();
  const { status, data } = await request(app, 'POST', '/users/onboarding', VALID_ONBOARDING, {
    Authorization: 'Bearer valid-token-user'
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(data.profile.onboarding_completed, true);

  mock.restoreAll();
});
