const { test } = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const { istDateString, msUntilNextIstMidnight, IST_OFFSET_MINUTES } = require('../lib/commitMode');

test('IST offset is fixed at +5:30', () => {
  assert.strictEqual(IST_OFFSET_MINUTES, 330);
});

test('istDateString: just before UTC midnight is still "today" in IST (ahead of UTC)', () => {
  // 2026-08-12 23:30 UTC == 2026-08-13 05:00 IST
  const d = new Date('2026-08-12T23:30:00Z');
  assert.strictEqual(istDateString(d), '2026-08-13');
});

test('istDateString: just after UTC midnight is still "yesterday" in IST', () => {
  // 2026-08-13 00:10 UTC == 2026-08-13 05:40 IST — still the 13th either way here,
  // use a time closer to the actual IST boundary instead:
  // IST midnight (2026-08-13 00:00 IST) == 2026-08-12 18:30 UTC.
  const justBeforeIstMidnight = new Date('2026-08-12T18:29:00Z'); // 2026-08-12 23:59 IST
  const justAfterIstMidnight = new Date('2026-08-12T18:31:00Z'); // 2026-08-13 00:01 IST
  assert.strictEqual(istDateString(justBeforeIstMidnight), '2026-08-12');
  assert.strictEqual(istDateString(justAfterIstMidnight), '2026-08-13');
});

test('istDateString: deliberately differs from a naive UTC date for the evening IST window', () => {
  // This is the exact gap that would silently break Commit Mode's "before
  // 12 AM IST" contract if the IST offset were ever dropped and UTC dates
  // were used instead (like scenarioSelector.js's startOfUtcDay does, on
  // purpose, for a different concern — see migration 007's header).
  const d = new Date('2026-08-12T20:00:00Z'); // 2026-08-13 01:30 IST
  const naiveUtcDate = d.toISOString().slice(0, 10);
  assert.strictEqual(naiveUtcDate, '2026-08-12');
  assert.strictEqual(istDateString(d), '2026-08-13');
});

test('msUntilNextIstMidnight: counts down correctly just before the boundary', () => {
  const oneMinuteBeforeIstMidnight = new Date('2026-08-12T18:29:00Z'); // 2026-08-12 23:59 IST
  const ms = msUntilNextIstMidnight(oneMinuteBeforeIstMidnight);
  assert.strictEqual(ms, 60 * 1000);
});

test('msUntilNextIstMidnight: just after the boundary, counts down ~24h', () => {
  const oneMinuteAfterIstMidnight = new Date('2026-08-12T18:31:00Z'); // 2026-08-13 00:01 IST
  const ms = msUntilNextIstMidnight(oneMinuteAfterIstMidnight);
  assert.strictEqual(ms, (24 * 60 - 1) * 60 * 1000);
});
