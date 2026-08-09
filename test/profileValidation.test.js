const { test } = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';

const { buildProfileUpdate } = require('../routes/userRoutes');

const VALID_FULL = {
  name: 'Ayush', age: 22, occupation_type: 'student', class_grade: 'BBA 2nd year',
  goal: 'daily_confidence', self_level: 'intermediate', daily_time: '15_20'
};

test('accepts a fully valid onboarding payload', () => {
  const { updateObj, error } = buildProfileUpdate(VALID_FULL, { partial: false });
  assert.strictEqual(error, undefined);
  assert.strictEqual(updateObj.name, 'Ayush');
  assert.strictEqual(updateObj.age, 22);
  assert.strictEqual(updateObj.class_grade, 'BBA 2nd year');
  assert.strictEqual(updateObj.profession, null); // student -> profession must be null, not undefined/leftover
});

test('rejects missing name on full onboarding', () => {
  const { error } = buildProfileUpdate({ ...VALID_FULL, name: '' }, { partial: false });
  assert.match(error, /name is required/);
});

test('rejects out-of-range age', () => {
  const { error } = buildProfileUpdate({ ...VALID_FULL, age: 200 }, { partial: false });
  assert.match(error, /age must be/);
});

test('rejects non-integer age', () => {
  const { error } = buildProfileUpdate({ ...VALID_FULL, age: 22.5 }, { partial: false });
  assert.match(error, /age must be/);
});

test('rejects student without class_grade', () => {
  const { error } = buildProfileUpdate({ ...VALID_FULL, class_grade: '' }, { partial: false });
  assert.match(error, /class_grade is required/);
});

test('rejects professional without profession', () => {
  const payload = { ...VALID_FULL, occupation_type: 'professional', profession: '' };
  delete payload.class_grade;
  const { error } = buildProfileUpdate(payload, { partial: false });
  assert.match(error, /profession is required/);
});

test('rejects invalid goal enum value', () => {
  const { error } = buildProfileUpdate({ ...VALID_FULL, goal: 'become_ceo' }, { partial: false });
  assert.match(error, /goal must be one of/);
});

test('rejects invalid self_level enum value', () => {
  const { error } = buildProfileUpdate({ ...VALID_FULL, self_level: 'expert' }, { partial: false });
  assert.match(error, /self_level must be one of/);
});

test('partial update: only touches fields that were actually sent', () => {
  const { updateObj, error } = buildProfileUpdate({ city: 'Patna' }, { partial: true });
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(updateObj, { city: 'Patna' });
});

test('partial update: empty object produces empty updateObj (caller decides this is a no-op)', () => {
  const { updateObj, error } = buildProfileUpdate({}, { partial: true });
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(updateObj, {});
});

test('partial update: still validates a field if it IS sent, even badly', () => {
  const { error } = buildProfileUpdate({ age: -5 }, { partial: true });
  assert.match(error, /age must be/);
});
