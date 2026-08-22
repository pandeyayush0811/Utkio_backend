const { test } = require('node:test');
const assert = require('node:assert');

const { pickTodaysScenario, startOfIstDay, epochIstDayIndex, hashString } = require('../lib/scenarioSelector');

const SCENARIOS = [
  { key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }
];

test('throws on empty scenario list', () => {
  assert.throws(() => pickTodaysScenario([], 'user1', new Date(), null), /non-empty array/);
});

test('is deterministic for the same user + same day', () => {
  const date = new Date('2026-08-12T10:00:00Z');
  const first = pickTodaysScenario(SCENARIOS, 'user-abc', date, null);
  const second = pickTodaysScenario(SCENARIOS, 'user-abc', date, null);
  assert.strictEqual(first.key, second.key);
});

test('is deterministic across different times on the same IST day', () => {
  // 01:00 AM IST (2026-08-12 19:30 UTC) and 11:30 PM IST (2026-08-13 18:00 UTC) on 2026-08-13 IST
  const morning = new Date('2026-08-12T19:30:00Z'); // 2026-08-13 01:00 IST
  const night = new Date('2026-08-13T18:00:00Z'); // 2026-08-13 23:30 IST
  const a = pickTodaysScenario(SCENARIOS, 'user-abc', morning, null);
  const b = pickTodaysScenario(SCENARIOS, 'user-abc', night, null);
  assert.strictEqual(a.key, b.key);
});

test('rotates to a different scenario on a different IST day (for a fixed user)', () => {
  const day1 = new Date('2026-08-12T10:00:00Z');
  const day2 = new Date('2026-08-13T10:00:00Z');
  const a = pickTodaysScenario(SCENARIOS, 'user-abc', day1, null);
  const b = pickTodaysScenario(SCENARIOS, 'user-abc', day2, null);
  assert.notStrictEqual(a.key, b.key);
});

test('different users can get different scenarios on the same day', () => {
  const date = new Date('2026-08-12T10:00:00Z');
  const picks = new Set();
  for (const uid of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8']) {
    picks.add(pickTodaysScenario(SCENARIOS, uid, date, null).key);
  }
  assert.ok(picks.size > 1, `expected variety across users, got: ${[...picks]}`);
});

test('avoids repeating the immediately-previous scenario when possible', () => {
  const date = new Date('2026-08-12T10:00:00Z');
  const picked = pickTodaysScenario(SCENARIOS, 'user-abc', date, null);
  const avoided = pickTodaysScenario(SCENARIOS, 'user-abc', date, picked.key);
  assert.notStrictEqual(avoided.key, picked.key);
});

test('does not attempt to avoid repeats with only one active scenario', () => {
  const date = new Date('2026-08-12T10:00:00Z');
  const onlyOne = [{ key: 'solo' }];
  const picked = pickTodaysScenario(onlyOne, 'user-abc', date, 'solo');
  assert.strictEqual(picked.key, 'solo');
});

test('lastScenarioKey that is not today\'s natural pick is left untouched', () => {
  const date = new Date('2026-08-12T10:00:00Z');
  const naturalPick = pickTodaysScenario(SCENARIOS, 'user-abc', date, null);
  const otherKey = SCENARIOS.find(s => s.key !== naturalPick.key).key;
  const stillNatural = pickTodaysScenario(SCENARIOS, 'user-abc', date, 'zzz-not-in-list');
  assert.strictEqual(stillNatural.key, naturalPick.key);
  assert.notStrictEqual(otherKey, undefined);
});

test('startOfIstDay truncates to IST midnight (18:30 UTC of previous day)', () => {
  // 2026-08-13 14:30:00 IST == 2026-08-13 09:00:00Z UTC
  const d = new Date('2026-08-13T09:00:00.000Z');
  const truncated = startOfIstDay(d);
  // IST midnight for 2026-08-13 is 2026-08-12T18:30:00.000Z
  assert.strictEqual(truncated.toISOString(), '2026-08-12T18:30:00.000Z');
});

test('startOfIstDay of two timestamps on the same IST day are equal', () => {
  // 2026-08-13 00:01 IST (2026-08-12 18:31 UTC) and 2026-08-13 23:59 IST (2026-08-13 18:29 UTC)
  const a = startOfIstDay(new Date('2026-08-12T18:31:00.000Z'));
  const b = startOfIstDay(new Date('2026-08-13T18:29:00.000Z'));
  assert.strictEqual(a.getTime(), b.getTime());
});

test('startOfIstDay of two timestamps across the 12 AM IST midnight boundary differ', () => {
  // Just before 12 AM IST (2026-08-12 23:59 IST == 2026-08-12 18:29 UTC)
  const a = startOfIstDay(new Date('2026-08-12T18:29:00.000Z'));
  // Just after 12 AM IST (2026-08-13 00:01 IST == 2026-08-12 18:31 UTC)
  const b = startOfIstDay(new Date('2026-08-12T18:31:00.000Z'));
  assert.notStrictEqual(a.getTime(), b.getTime());
});

test('epochIstDayIndex increments by exactly 1 at 12:00 AM IST', () => {
  const a = epochIstDayIndex(new Date('2026-08-12T18:29:00.000Z')); // 2026-08-12 23:59 IST
  const b = epochIstDayIndex(new Date('2026-08-12T18:31:00.000Z')); // 2026-08-13 00:01 IST
  assert.strictEqual(b - a, 1);
});

test('hashString is deterministic and non-negative', () => {
  const h1 = hashString('user-123');
  const h2 = hashString('user-123');
  assert.strictEqual(h1, h2);
  assert.ok(h1 >= 0);
});
