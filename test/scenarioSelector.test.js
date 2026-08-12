const { test } = require('node:test');
const assert = require('node:assert');

const { pickTodaysScenario, startOfUtcDay, epochDayIndex, hashString } = require('../lib/scenarioSelector');

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

test('is deterministic across different times on the same UTC day', () => {
  const morning = new Date('2026-08-12T01:00:00Z');
  const night = new Date('2026-08-12T23:59:00Z');
  const a = pickTodaysScenario(SCENARIOS, 'user-abc', morning, null);
  const b = pickTodaysScenario(SCENARIOS, 'user-abc', night, null);
  assert.strictEqual(a.key, b.key);
});

test('rotates to a different scenario on a different day (for a fixed user)', () => {
  const day1 = new Date('2026-08-12T10:00:00Z');
  const day2 = new Date('2026-08-13T10:00:00Z');
  const a = pickTodaysScenario(SCENARIOS, 'user-abc', day1, null);
  const b = pickTodaysScenario(SCENARIOS, 'user-abc', day2, null);
  // Not a hard guarantee for every possible rotation length, but with 4
  // scenarios and a +1-per-day index, consecutive days must differ.
  assert.notStrictEqual(a.key, b.key);
});

test('different users can get different scenarios on the same day', () => {
  const date = new Date('2026-08-12T10:00:00Z');
  const picks = new Set();
  for (const uid of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8']) {
    picks.add(pickTodaysScenario(SCENARIOS, uid, date, null).key);
  }
  // With 8 users spread over 4 scenarios via a hash, expect more than one
  // distinct scenario to show up — guards against an accidental constant
  // pick that ignores userId entirely.
  assert.ok(picks.size > 1, `expected variety across users, got: ${[...picks]}`);
});

test('avoids repeating the immediately-previous scenario when possible', () => {
  const date = new Date('2026-08-12T10:00:00Z');
  const picked = pickTodaysScenario(SCENARIOS, 'user-abc', date, null);
  // Force a collision: tell it "yesterday's scenario" was today's natural pick.
  const avoided = pickTodaysScenario(SCENARIOS, 'user-abc', date, picked.key);
  assert.notStrictEqual(avoided.key, picked.key);
});

test('does not attempt to avoid repeats with only one active scenario', () => {
  const date = new Date('2026-08-12T10:00:00Z');
  const onlyOne = [{ key: 'solo' }];
  const picked = pickTodaysScenario(onlyOne, 'user-abc', date, 'solo');
  assert.strictEqual(picked.key, 'solo'); // unavoidable repeat, not a bug
});

test('lastScenarioKey that is not today\'s natural pick is left untouched', () => {
  const date = new Date('2026-08-12T10:00:00Z');
  const naturalPick = pickTodaysScenario(SCENARIOS, 'user-abc', date, null);
  const otherKey = SCENARIOS.find(s => s.key !== naturalPick.key).key;
  // lastScenarioKey doesn't match today's natural pick -> no shift should happen
  const stillNatural = pickTodaysScenario(SCENARIOS, 'user-abc', date, 'zzz-not-in-list');
  assert.strictEqual(stillNatural.key, naturalPick.key);
  assert.notStrictEqual(otherKey, undefined); // sanity check on the test fixture itself
});

test('startOfUtcDay truncates to UTC midnight', () => {
  const d = new Date('2026-08-12T17:42:33.123Z');
  const truncated = startOfUtcDay(d);
  assert.strictEqual(truncated.toISOString(), '2026-08-12T00:00:00.000Z');
});

test('startOfUtcDay of two timestamps on the same UTC day are equal', () => {
  const a = startOfUtcDay(new Date('2026-08-12T00:00:00.001Z'));
  const b = startOfUtcDay(new Date('2026-08-12T23:59:59.999Z'));
  assert.strictEqual(a.getTime(), b.getTime());
});

test('startOfUtcDay of two timestamps on different UTC days differ', () => {
  const a = startOfUtcDay(new Date('2026-08-12T23:59:59.999Z'));
  const b = startOfUtcDay(new Date('2026-08-13T00:00:00.001Z'));
  assert.notStrictEqual(a.getTime(), b.getTime());
});

test('epochDayIndex increments by exactly 1 per UTC day', () => {
  const a = epochDayIndex(new Date('2026-08-12T05:00:00Z'));
  const b = epochDayIndex(new Date('2026-08-13T05:00:00Z'));
  assert.strictEqual(b - a, 1);
});

test('hashString is deterministic and non-negative', () => {
  assert.strictEqual(hashString('user-abc'), hashString('user-abc'));
  assert.ok(hashString('user-abc') >= 0);
  assert.ok(hashString('') >= 0);
});
