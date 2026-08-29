const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
  acquireLock,
  releaseLock,
  withDistributedLock,
  getRedisClient,
  setRedisClient,
  _resetMemoryLocks
} = require('../lib/distributedLock');

beforeEach(() => {
  if (typeof _resetMemoryLocks === 'function') {
    _resetMemoryLocks();
  }
  setRedisClient(null);
});

afterEach(() => {
  mock.restoreAll();
  if (typeof _resetMemoryLocks === 'function') {
    _resetMemoryLocks();
  }
  setRedisClient(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory Lock Mechanics
// ─────────────────────────────────────────────────────────────────────────────

test('acquireLock: acquires lock on an open key and returns unique token', async () => {
  const lock = await acquireLock('test:lock:1', 5000);
  assert.strictEqual(lock.acquired, true);
  assert.ok(typeof lock.token === 'string' && lock.token.length > 0);
});

test('acquireLock: rejects second acquisition attempt for the same key while locked', async () => {
  const lock1 = await acquireLock('test:lock:2', 5000);
  assert.strictEqual(lock1.acquired, true);

  const lock2 = await acquireLock('test:lock:2', 5000);
  assert.strictEqual(lock2.acquired, false);
  assert.strictEqual(lock2.token, undefined);
});

test('releaseLock: successfully releases lock when provided the correct token', async () => {
  const lock = await acquireLock('test:lock:3', 5000);
  assert.strictEqual(lock.acquired, true);

  const released = await releaseLock('test:lock:3', lock.token);
  assert.strictEqual(released, true);

  // Now another acquisition should succeed
  const lockAgain = await acquireLock('test:lock:3', 5000);
  assert.strictEqual(lockAgain.acquired, true);
});

test('releaseLock: fails and preserves lock if an invalid/mismatched token is provided', async () => {
  const lock = await acquireLock('test:lock:4', 5000);
  assert.strictEqual(lock.acquired, true);

  const wrongRelease = await releaseLock('test:lock:4', 'wrong-token-12345');
  assert.strictEqual(wrongRelease, false);

  // Lock must still be held
  const lockAttempt = await acquireLock('test:lock:4', 5000);
  assert.strictEqual(lockAttempt.acquired, false);
});

test('TTL Expiration: lock auto-expires after ttlMs, allowing a new acquire', async () => {
  const lock1 = await acquireLock('test:lock:5', 50); // 50ms TTL
  assert.strictEqual(lock1.acquired, true);

  // Wait 70ms for expiration
  await new Promise((resolve) => setTimeout(resolve, 70));

  const lock2 = await acquireLock('test:lock:5', 5000);
  assert.strictEqual(lock2.acquired, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// withDistributedLock Helper
// ─────────────────────────────────────────────────────────────────────────────

test('withDistributedLock: successfully executes function and releases lock on resolution', async () => {
  let executed = false;
  const result = await withDistributedLock('test:lock:6', 5000, async () => {
    executed = true;
    return { success: true, count: 42 };
  });

  assert.strictEqual(executed, true);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.count, 42);

  // Key should be released immediately
  const lockAfter = await acquireLock('test:lock:6', 5000);
  assert.strictEqual(lockAfter.acquired, true);
});

test('withDistributedLock: guarantees lock release even if function throws an exception', async () => {
  await assert.rejects(
    async () => {
      await withDistributedLock('test:lock:7', 5000, async () => {
        throw new Error('Explosion inside critical section');
      });
    },
    /Explosion inside critical section/
  );

  // Lock must be released despite error
  const lockAfter = await acquireLock('test:lock:7', 5000);
  assert.strictEqual(lockAfter.acquired, true);
});

test('withDistributedLock: handles contention gracefully by returning skipped: true', async () => {
  let concurrentExecutions = 0;

  const fn = async () => {
    concurrentExecutions++;
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { done: true };
  };

  const [res1, res2] = await Promise.all([
    withDistributedLock('test:lock:8', 5000, fn),
    withDistributedLock('test:lock:8', 5000, fn)
  ]);

  const executed = [res1, res2].find((r) => r.done === true);
  const skipped = [res1, res2].find((r) => r.skipped === true);

  assert.ok(executed);
  assert.ok(skipped);
  assert.strictEqual(skipped.reason, 'locked');
  assert.strictEqual(concurrentExecutions, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Redis Mode Mechanics & Lua Script
// ─────────────────────────────────────────────────────────────────────────────

test('Redis Mode: acquires and releases lock via Redis SET NX and Lua script', async () => {
  const redisStore = new Map();
  let luaEvaluatedWith = null;

  const mockRedisClient = {
    set: async (key, value, mode, ttl, condition) => {
      assert.strictEqual(mode, 'PX');
      assert.strictEqual(condition, 'NX');
      if (redisStore.has(key)) {
        return null;
      }
      redisStore.set(key, value);
      return 'OK';
    },
    eval: async (script, numKeys, key, token) => {
      luaEvaluatedWith = { script, numKeys, key, token };
      if (redisStore.get(key) === token) {
        redisStore.delete(key);
        return 1;
      }
      return 0;
    }
  };

  setRedisClient(mockRedisClient);

  const lock1 = await acquireLock('test:redis:lock', 10000);
  assert.strictEqual(lock1.acquired, true);
  assert.strictEqual(redisStore.get('test:redis:lock'), lock1.token);

  // Second acquisition attempt should fail in Redis
  const lock2 = await acquireLock('test:redis:lock', 10000);
  assert.strictEqual(lock2.acquired, false);

  // Release with token
  const released = await releaseLock('test:redis:lock', lock1.token);
  assert.strictEqual(released, true);
  assert.strictEqual(redisStore.has('test:redis:lock'), false);
  assert.ok(luaEvaluatedWith.script.includes('redis.call("get", KEYS[1])'));
});

test('Redis Failure Fallback: falls back to in-memory lock if Redis commands fail', async () => {
  const brokenRedisClient = {
    set: async () => {
      throw new Error('Redis connection refused: ECONNREFUSED 127.0.0.1:6379');
    },
    eval: async () => {
      throw new Error('Redis connection refused: ECONNREFUSED 127.0.0.1:6379');
    }
  };

  setRedisClient(brokenRedisClient);

  // Should not throw, should fall back to in-memory lock
  const lock = await acquireLock('test:fallback:lock', 5000);
  assert.strictEqual(lock.acquired, true);

  const lockContention = await acquireLock('test:fallback:lock', 5000);
  assert.strictEqual(lockContention.acquired, false);

  const released = await releaseLock('test:fallback:lock', lock.token);
  assert.strictEqual(released, true);
});
