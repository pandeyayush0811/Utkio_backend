const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const { calculateStreak, istDateString, shiftIstDate } = require('../lib/streak');

test('streak: returns 0 for empty or invalid timestamps', () => {
  const res1 = calculateStreak([]);
  assert.strictEqual(res1.current_streak, 0);
  assert.strictEqual(res1.best_streak, 0);
  assert.strictEqual(res1.practiced_today, false);
  assert.strictEqual(res1.total_practice_days, 0);

  const res2 = calculateStreak(null);
  assert.strictEqual(res2.current_streak, 0);

  const res3 = calculateStreak(['invalid-date-string']);
  assert.strictEqual(res3.current_streak, 0);
});

test('streak: handles single session practiced today', () => {
  const ref = new Date('2026-08-21T14:00:00.000Z'); // 19:30 IST on 2026-08-21
  const sessionTime = new Date('2026-08-21T10:00:00.000Z'); // 15:30 IST on 2026-08-21
  const res = calculateStreak([sessionTime], ref);

  assert.strictEqual(res.current_streak, 1);
  assert.strictEqual(res.best_streak, 1);
  assert.strictEqual(res.practiced_today, true);
  assert.strictEqual(res.last_practiced_ist, '2026-08-21');
  assert.strictEqual(res.total_practice_days, 1);
});

test('streak: keeps streak active when practiced yesterday but not today yet', () => {
  const ref = new Date('2026-08-21T14:00:00.000Z'); // 2026-08-21 in IST
  const yesterdaySession = new Date('2026-08-20T10:00:00.000Z'); // 2026-08-20 in IST
  const res = calculateStreak([yesterdaySession], ref);

  assert.strictEqual(res.current_streak, 1);
  assert.strictEqual(res.best_streak, 1);
  assert.strictEqual(res.practiced_today, false);
  assert.strictEqual(res.last_practiced_ist, '2026-08-20');
});

test('streak: resets current streak to 0 if missed yesterday and today', () => {
  const ref = new Date('2026-08-21T14:00:00.000Z'); // 2026-08-21 in IST
  const oldSession = new Date('2026-08-19T10:00:00.000Z'); // 2026-08-19 in IST (2 days ago)
  const res = calculateStreak([oldSession], ref);

  assert.strictEqual(res.current_streak, 0);
  assert.strictEqual(res.best_streak, 1);
  assert.strictEqual(res.practiced_today, false);
  assert.strictEqual(res.last_practiced_ist, '2026-08-19');
});

test('streak: deduplicates multiple sessions on the same day', () => {
  const ref = new Date('2026-08-21T14:00:00.000Z');
  const sessions = [
    '2026-08-21T05:00:00.000Z',
    '2026-08-21T08:00:00.000Z',
    '2026-08-21T12:00:00.000Z'
  ];
  const res = calculateStreak(sessions, ref);

  assert.strictEqual(res.current_streak, 1);
  assert.strictEqual(res.best_streak, 1);
  assert.strictEqual(res.total_practice_days, 1);
});

test('streak: computes 5 consecutive days ending today', () => {
  const ref = new Date('2026-08-21T14:00:00.000Z'); // 2026-08-21
  const sessions = [
    '2026-08-17T06:00:00.000Z', // day 1
    '2026-08-18T06:00:00.000Z', // day 2
    '2026-08-19T06:00:00.000Z', // day 3
    '2026-08-20T06:00:00.000Z', // day 4
    '2026-08-21T06:00:00.000Z'  // day 5
  ];
  const res = calculateStreak(sessions, ref);

  assert.strictEqual(res.current_streak, 5);
  assert.strictEqual(res.best_streak, 5);
  assert.strictEqual(res.practiced_today, true);
  assert.strictEqual(res.total_practice_days, 5);
});

test('streak: computes 5 consecutive days ending yesterday (active pending today)', () => {
  const ref = new Date('2026-08-21T14:00:00.000Z'); // 2026-08-21
  const sessions = [
    '2026-08-16T06:00:00.000Z',
    '2026-08-17T06:00:00.000Z',
    '2026-08-18T06:00:00.000Z',
    '2026-08-19T06:00:00.000Z',
    '2026-08-20T06:00:00.000Z' // ended yesterday
  ];
  const res = calculateStreak(sessions, ref);

  assert.strictEqual(res.current_streak, 5);
  assert.strictEqual(res.best_streak, 5);
  assert.strictEqual(res.practiced_today, false);
});

test('streak: correctly calculates historical best streak higher than current streak', () => {
  const ref = new Date('2026-08-21T14:00:00.000Z');
  const sessions = [
    // 4-day streak in the past:
    '2026-08-01T06:00:00.000Z',
    '2026-08-02T06:00:00.000Z',
    '2026-08-03T06:00:00.000Z',
    '2026-08-04T06:00:00.000Z',
    // gap until 2026-08-20:
    '2026-08-20T06:00:00.000Z',
    '2026-08-21T06:00:00.000Z'
  ];
  const res = calculateStreak(sessions, ref);

  assert.strictEqual(res.current_streak, 2);
  assert.strictEqual(res.best_streak, 4);
  assert.strictEqual(res.practiced_today, true);
  assert.strictEqual(res.total_practice_days, 6);
});

test('streak: correctly converts near-midnight UTC to IST date', () => {
  // 2026-08-21 23:00 UTC = 2026-08-22 04:30 IST
  const dateUtcNight = new Date('2026-08-21T23:00:00.000Z');
  assert.strictEqual(istDateString(dateUtcNight), '2026-08-22');

  // 2026-08-21 18:29 UTC = 2026-08-21 23:59 IST
  const dateUtkBeforeMidnight = new Date('2026-08-21T18:29:00.000Z');
  assert.strictEqual(istDateString(dateUtkBeforeMidnight), '2026-08-21');
});
