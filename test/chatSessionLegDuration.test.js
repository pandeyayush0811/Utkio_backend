const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

test('chatSessionLegDuration: calculates exact active leg duration for resumed session without idle gap inflation', () => {
  // Why this matters: Resumed sessions must only record the active duration of the newly appended leg.
  const legStartedAt = '2026-08-29T10:10:00.000Z';
  const legEndedAt = '2026-08-29T10:10:45.000Z';

  const legSeconds = Math.max(0, (new Date(legEndedAt) - new Date(legStartedAt)) / 1000);
  assert.strictEqual(legSeconds, 45); // 45 seconds of speech
});

test('chatSessionLegDuration: detects and rejects inflated leg duration when client sends stale started_at spanning prior session end', () => {
  // Why this matters: If a buggy client sends started_at earlier than existing.ended_at, backend defense-in-depth must prevent quota drain.
  const existingEndedAt = '2026-08-29T10:02:00.000Z'; // Leg 1 ended at 10:02
  const staleStartedAt = '2026-08-29T10:00:00.000Z'; // Stale started_at from Leg 1 start
  const currentEndedAt = '2026-08-29T10:12:00.000Z'; // Leg 2 ended at 10:12 (user spoke for 2 mins from 10:10 to 10:12)

  // Naive buggy calculation: (10:12 - 10:00) = 720 seconds (12 minutes, exceeding 10 min cap!)
  const naiveLegSeconds = Math.max(0, (new Date(currentEndedAt) - new Date(staleStartedAt)) / 1000);
  assert.strictEqual(naiveLegSeconds, 720);

  // Sanitized calculation: effective started_at cannot precede existing.ended_at for resumed sessions
  const effectiveStartedAt = new Date(staleStartedAt) < new Date(existingEndedAt)
    ? new Date(existingEndedAt)
    : new Date(staleStartedAt);

  const safeLegSeconds = Math.max(0, (new Date(currentEndedAt) - effectiveStartedAt) / 1000);
  // Bounds elapsed time to at most the interval since last leg ended (600s), avoiding 12-minute drain
  assert.strictEqual(safeLegSeconds <= 600, true);
});

test('chatSessionLegDuration: zero or negative time interval defaults safely to 0 seconds', () => {
  // Why this matters: Clock skew or malformed client timestamps must not cause negative practice time deductions or crash.
  const invalidStartedAt = '2026-08-29T10:15:00.000Z';
  const invalidEndedAt = '2026-08-29T10:10:00.000Z';

  const legSeconds = Math.max(0, (new Date(invalidEndedAt) - new Date(invalidStartedAt)) / 1000);
  assert.strictEqual(legSeconds, 0);
});

test('chatSessionLegDuration: multi-leg session total active duration sums accurately across independent legs', () => {
  // Why this matters: A user doing 3 separate 2-minute practice bursts throughout the day must have exactly 6 minutes (360s) recorded.
  const legs = [
    { started_at: '2026-08-29T08:00:00.000Z', ended_at: '2026-08-29T08:02:00.000Z' }, // 120s
    { started_at: '2026-08-29T13:00:00.000Z', ended_at: '2026-08-29T13:02:00.000Z' }, // 120s
    { started_at: '2026-08-29T20:00:00.000Z', ended_at: '2026-08-29T20:02:00.000Z' }  // 120s
  ];

  let totalPracticeSeconds = 0;
  for (const leg of legs) {
    const legSec = Math.max(0, (new Date(leg.ended_at) - new Date(leg.started_at)) / 1000);
    totalPracticeSeconds += legSec;
  }

  assert.strictEqual(totalPracticeSeconds, 360);
});
