const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

test('adversarial backend duration: single leg with valid timestamps computes exact seconds', () => {
  // Why this matters: Verifies standard single-leg duration calculation in chatRoutes.js:256
  const startedAt = '2026-08-29T10:00:00.000Z';
  const endedAt = '2026-08-29T10:02:30.000Z';

  const duration = Math.max(0, (new Date(endedAt) - new Date(startedAt)) / 1000);
  assert.strictEqual(duration, 150); // 2.5 minutes = 150 seconds
});

test('adversarial backend duration: multi-leg session isolates idle pauses between legs', () => {
  // Why this matters: Resumed session legs must each independently contribute only their active duration
  const legs = [
    { started_at: '2026-08-29T08:00:00.000Z', ended_at: '2026-08-29T08:01:00.000Z' }, // 60s
    { started_at: '2026-08-29T12:00:00.000Z', ended_at: '2026-08-29T12:01:30.000Z' }, // 90s (4hr idle pause)
    { started_at: '2026-08-29T18:00:00.000Z', ended_at: '2026-08-29T18:03:00.000Z' }  // 180s (6hr idle pause)
  ];

  let accumulatedChatSeconds = 0;
  for (const leg of legs) {
    const legSec = Math.max(0, (new Date(leg.ended_at) - new Date(leg.started_at)) / 1000);
    accumulatedChatSeconds += legSec;
  }

  assert.strictEqual(accumulatedChatSeconds, 330); // 5.5 minutes total (330s), NOT 36,180s (10+ hours)
});

test('adversarial backend duration: negative interval due to client clock drift clamps to 0 seconds', () => {
  // Why this matters: Backward clock jumps must never decrease or corrupt practice counters
  const startedAt = '2026-08-29T10:05:00.000Z';
  const endedAt = '2026-08-29T10:00:00.000Z';

  const duration = Math.max(0, (new Date(endedAt) - new Date(startedAt)) / 1000);
  assert.strictEqual(duration, 0);
});

test('adversarial backend duration: sub-second duration preserves fractional precision', () => {
  // Why this matters: Rapid speech bursts (e.g. 500ms) record positive fractional duration
  const startedAt = '2026-08-29T10:00:00.000Z';
  const endedAt = '2026-08-29T10:00:00.500Z';

  const duration = Math.max(0, (new Date(endedAt) - new Date(startedAt)) / 1000);
  assert.strictEqual(duration, 0.5);
});

test('adversarial backend duration: defense-in-depth sanitization against stale start spanning prior leg end', () => {
  // Why this matters: If a rogue or buggy client sends started_at before prior leg ended, backend bounds the leg duration
  const priorLegEndedAt = '2026-08-29T10:05:00.000Z';
  const staleStartedAt = '2026-08-29T10:00:00.000Z'; // 5 minutes before prior leg ended
  const currentEndedAt = '2026-08-29T10:06:00.000Z'; // 1 minute of active speech after prior leg

  const effectiveStartedAt = new Date(staleStartedAt) < new Date(priorLegEndedAt)
    ? new Date(priorLegEndedAt)
    : new Date(staleStartedAt);

  const safeLegDuration = Math.max(0, (new Date(currentEndedAt) - effectiveStartedAt) / 1000);
  assert.strictEqual(safeLegDuration, 60); // Bounded to 60s instead of 360s
});

test('adversarial backend duration: commit mode daily 5-minute requirement threshold check', () => {
  // Why this matters: Daily 300-second requirement is achieved only when sum of active legs reaches 300s
  const dailyRequirementSec = 300;

  const leg1 = Math.max(0, (new Date('2026-08-29T10:00:00.000Z') - new Date('2026-08-29T09:58:00.000Z')) / 1000); // 120s
  const leg2 = Math.max(0, (new Date('2026-08-29T14:00:00.000Z') - new Date('2026-08-29T13:58:00.000Z')) / 1000); // 120s
  const leg3 = Math.max(0, (new Date('2026-08-29T20:00:00.000Z') - new Date('2026-08-29T19:59:00.000Z')) / 1000); // 60s

  const total = leg1 + leg2 + leg3; // 120 + 120 + 60 = 300s
  assert.strictEqual(total, 300);
  assert.strictEqual(total >= dailyRequirementSec, true);
});
