const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
  acquireLock,
  releaseLock,
  withDistributedLock,
  getRedisClient,
  setRedisClient,
  _resetMemoryLocks,
  DEFAULT_LOCK_TTL_MS
} = require('../lib/distributedLock');

// ═══════════════════════════════════════════════════════════════════════════
// ADVERSARIAL TEST SUITE: Distributed Lock & Concurrency Coordination
//
// Role: 06_TestWriter (Adversarial Frontend & Backend Quality Assurance)
// Target: Issue #12 (AUD-012: Background Reconciliation Distributed Locking)
// ═══════════════════════════════════════════════════════════════════════════

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
// SUITE 1: Token Safety, Hijack Prevention & Lock Ownership Verification
// ─────────────────────────────────────────────────────────────────────────────

test('adversarial: Token Hijack Prevention in Redis Mode via Lua Script verification', async () => {
  // Why this matters: Worker A acquires lock with Token A. Worker A experiences a slow GC pause
  // or network lag causing TTL to expire. Worker B acquires the same lock with Token B.
  // When Worker A wakes up and calls releaseLock(key, Token A), it MUST NOT delete Worker B's lock!
  const redisStore = new Map();
  let luaExecutionCount = 0;

  const mockRedis = {
    set: async (key, val, mode, ttl, cond) => {
      if (redisStore.has(key)) return null;
      redisStore.set(key, val);
      return 'OK';
    },
    eval: async (script, numKeys, key, token) => {
      luaExecutionCount++;
      // Exact Lua script logic: if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end
      if (redisStore.get(key) === token) {
        redisStore.delete(key);
        return 1;
      }
      return 0;
    }
  };

  setRedisClient(mockRedis);

  // 1. Worker A acquires lock
  const lockA = await acquireLock('test:lock:tamper', 5000);
  assert.strictEqual(lockA.acquired, true);
  assert.strictEqual(redisStore.get('test:lock:tamper'), lockA.token);

  // 2. Simulate TTL expiration and Worker B acquiring with a new token
  const tokenB = 'token-worker-b-999';
  redisStore.set('test:lock:tamper', tokenB);

  // 3. Worker A attempts to release using Token A (stale/expired)
  const releasedByA = await releaseLock('test:lock:tamper', lockA.token);
  assert.strictEqual(releasedByA, false, 'Worker A must NOT be allowed to release Worker B’s lock');
  assert.strictEqual(redisStore.get('test:lock:tamper'), tokenB, 'Worker B’s lock must remain untouched in Redis');
  assert.strictEqual(luaExecutionCount, 1);

  // 4. Worker B releases with correct Token B
  const releasedByB = await releaseLock('test:lock:tamper', tokenB);
  assert.strictEqual(releasedByB, true);
  assert.strictEqual(redisStore.has('test:lock:tamper'), false);
});

test('adversarial: Token Hijack Prevention in Memory Mode when lock expires and is re-acquired', async () => {
  // Why this matters: In in-memory mode, if a slow process releases a lock after it was
  // re-assigned to another caller, it must not invalidate the new caller's lock.
  const lock1 = await acquireLock('test:mem:tamper', 40); // 40ms TTL
  assert.strictEqual(lock1.acquired, true);

  // Wait for TTL to expire
  await new Promise((r) => setTimeout(r, 60));

  // Lock 2 acquires the now-expired key
  const lock2 = await acquireLock('test:mem:tamper', 5000);
  assert.strictEqual(lock2.acquired, true);
  assert.notStrictEqual(lock1.token, lock2.token);

  // Stale Lock 1 tries to release
  const staleRelease = await releaseLock('test:mem:tamper', lock1.token);
  assert.strictEqual(staleRelease, false, 'Stale token must fail release');

  // Key must still be locked by lock2
  const lock3 = await acquireLock('test:mem:tamper', 5000);
  assert.strictEqual(lock3.acquired, false, 'Key must still be held by lock2');

  // Valid Lock 2 releases
  const validRelease = await releaseLock('test:mem:tamper', lock2.token);
  assert.strictEqual(validRelease, true);
});

test('adversarial: releaseLock with invalid, empty, or malicious tokens returns false safely', async () => {
  // Why this matters: Ensures malformed release calls do not crash or erroneously unlock keys.
  const lock = await acquireLock('test:token:invalid', 5000);
  assert.strictEqual(lock.acquired, true);

  const invalidTokens = [
    null,
    undefined,
    '',
    '   ',
    'wrong-token',
    12345,
    {},
    [],
    true,
    false,
    '__proto__',
    'constructor'
  ];

  for (const badToken of invalidTokens) {
    const res = await releaseLock('test:token:invalid', badToken);
    assert.strictEqual(res, false, `Bad token ${JSON.stringify(badToken)} must return false`);
  }

  // Lock must still be held
  const contention = await acquireLock('test:token:invalid', 5000);
  assert.strictEqual(contention.acquired, false);

  // Clean release with actual token
  const clean = await releaseLock('test:token:invalid', lock.token);
  assert.strictEqual(clean, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: High Concurrency Stampede & Race Conditions
// ─────────────────────────────────────────────────────────────────────────────

test('adversarial: 50 concurrent acquisition attempts on the same key yield EXACTLY 1 winner', async () => {
  // Why this matters: Simulates extreme thundering herd on server cluster initialization.
  const KEY = 'test:stampede:50';
  const NUM_ATTEMPTS = 50;

  const promises = Array.from({ length: NUM_ATTEMPTS }, () => acquireLock(KEY, 10000));
  const results = await Promise.all(promises);

  const acquired = results.filter((r) => r.acquired === true);
  const rejected = results.filter((r) => r.acquired === false);

  assert.strictEqual(acquired.length, 1, `Expected exactly 1 winner out of ${NUM_ATTEMPTS}, but got ${acquired.length}`);
  assert.strictEqual(rejected.length, NUM_ATTEMPTS - 1);
  assert.ok(typeof acquired[0].token === 'string' && acquired[0].token.length > 0);

  // Release the winner's lock
  const released = await releaseLock(KEY, acquired[0].token);
  assert.strictEqual(released, true);

  // New acquisition should now succeed
  const nextLock = await acquireLock(KEY, 1000);
  assert.strictEqual(nextLock.acquired, true);
});

test('adversarial: Multiple distinct lock keys operate in complete isolation without crosstalk', async () => {
  // Why this matters: Locking payment reconciliation must never block other background tasks (e.g. commit-mode sweep).
  const keys = ['lock:reconcile_payments', 'lock:commit_mode_sweep', 'lock:user_cleanup', 'lock:analytics_flush'];

  const locks = await Promise.all(keys.map((k) => acquireLock(k, 5000)));

  for (let i = 0; i < keys.length; i++) {
    assert.strictEqual(locks[i].acquired, true, `Key ${keys[i]} must be acquired independently`);
  }

  // Release half the locks
  await releaseLock(keys[0], locks[0].token);
  await releaseLock(keys[2], locks[2].token);

  // Released keys must be acquirable again
  const reacquire0 = await acquireLock(keys[0], 5000);
  const reacquire2 = await acquireLock(keys[2], 5000);
  assert.strictEqual(reacquire0.acquired, true);
  assert.strictEqual(reacquire2.acquired, true);

  // Unreleased keys must still be locked
  const try1 = await acquireLock(keys[1], 5000);
  const try3 = await acquireLock(keys[3], 5000);
  assert.strictEqual(try1.acquired, false);
  assert.strictEqual(try3.acquired, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: Adversarial Key Names, TTL Boundaries & Special Characters
// ─────────────────────────────────────────────────────────────────────────────

test('adversarial: Handles special characters, spaces, unicode, emojis, and injection-like key names', async () => {
  // Why this matters: Ensures key identifiers with unusual formatting do not break Map indexing or Redis commands.
  const weirdKeys = [
    'lock:with spaces and tabs\t',
    'lock:emoji:💳:💰:🚀',
    'lock:quotes:"\'`',
    'lock:newlines:\r\nSET hijacked 1',
    'lock:unicode:हिन्दी_की_जांच',
    'lock:symbols:!@#$%^&*()_+-=[]{}|;:,.<>?',
    'a'.repeat(2000) // 2KB long key string
  ];

  for (const key of weirdKeys) {
    const lock = await acquireLock(key, 2000);
    assert.strictEqual(lock.acquired, true, `Failed to acquire lock for key: ${key.slice(0, 30)}`);

    const contention = await acquireLock(key, 2000);
    assert.strictEqual(contention.acquired, false, `Contention failed for key: ${key.slice(0, 30)}`);

    const released = await releaseLock(key, lock.token);
    assert.strictEqual(released, true, `Failed to release lock for key: ${key.slice(0, 30)}`);
  }
});

test('adversarial: TTL boundary handling (default fallback on undefined, rapid expiration)', async () => {
  // Why this matters: Default TTL must apply when omitted or undefined, preventing indefinite locking.
  assert.strictEqual(DEFAULT_LOCK_TTL_MS, 60000);

  // Omitted TTL uses default
  const defaultLock = await acquireLock('test:ttl:default');
  assert.strictEqual(defaultLock.acquired, true);
  await releaseLock('test:ttl:default', defaultLock.token);

  // Rapid micro-TTL (20ms) expires cleanly
  const fastLock = await acquireLock('test:ttl:fast', 20);
  assert.strictEqual(fastLock.acquired, true);

  await new Promise((r) => setTimeout(r, 40));

  const afterExpire = await acquireLock('test:ttl:fast', 2000);
  assert.strictEqual(afterExpire.acquired, true);
  await releaseLock('test:ttl:fast', afterExpire.token);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: withDistributedLock High-Level Wrapper Adversarial Scenarios
// ─────────────────────────────────────────────────────────────────────────────

test('adversarial: withDistributedLock always releases lock even when fn rejects or throws synchronously', async () => {
  // Why this matters: A critical bug in a sweep function must NEVER leave a permanent deadlock.
  const KEY = 'test:withLock:throw';

  // 1. Sync throw
  await assert.rejects(
    async () => {
      await withDistributedLock(KEY, 5000, () => {
        throw new Error('Fatal synchronous error in critical section');
      });
    },
    /Fatal synchronous error/
  );

  // Lock must be free immediately
  const lockAfterSync = await acquireLock(KEY, 5000);
  assert.strictEqual(lockAfterSync.acquired, true);
  await releaseLock(KEY, lockAfterSync.token);

  // 2. Async rejection
  await assert.rejects(
    async () => {
      await withDistributedLock(KEY, 5000, async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error('Fatal async rejection in critical section');
      });
    },
    /Fatal async rejection/
  );

  // Lock must be free immediately
  const lockAfterAsync = await acquireLock(KEY, 5000);
  assert.strictEqual(lockAfterAsync.acquired, true);
  await releaseLock(KEY, lockAfterAsync.token);
});

test('adversarial: withDistributedLock correctly preserves return value types (objects, primitives, arrays, null)', async () => {
  // Why this matters: The wrapper must be transparent to all return values without mutation.
  const testCases = [
    { name: 'object', value: { checked: 10, activated: 2 } },
    { name: 'number', value: 42 },
    { name: 'string', value: 'completed_ok' },
    { name: 'boolean', value: false },
    { name: 'null', value: null },
    { name: 'array', value: ['item1', 'item2'] }
  ];

  for (const tc of testCases) {
    const res = await withDistributedLock(`test:withLock:${tc.name}`, 5000, async () => tc.value);
    assert.deepStrictEqual(res, tc.value, `Failed preserving return value for ${tc.name}`);
  }
});

test('adversarial: withDistributedLock merges custom defaultResult on lock contention', async () => {
  // Why this matters: Allows callers to specify custom payload metadata when skipped.
  const KEY = 'test:withLock:customDefault';

  // Hold lock manually
  const directLock = await acquireLock(KEY, 5000);
  assert.strictEqual(directLock.acquired, true);

  const customResult = await withDistributedLock(
    KEY,
    5000,
    async () => ({ executed: true }),
    { defaultResult: { customField: 'custom_value', customCode: 409 } }
  );

  assert.strictEqual(customResult.skipped, true);
  assert.strictEqual(customResult.reason, 'locked');
  assert.strictEqual(customResult.customField, 'custom_value');
  assert.strictEqual(customResult.customCode, 409);

  await releaseLock(KEY, directLock.token);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: Redis Errors, Network Drops & Fallback Robustness
// ─────────────────────────────────────────────────────────────────────────────

test('adversarial: Redis connection error during acquire falls back to in-memory lock without throwing', async () => {
  // Why this matters: In production, transient Redis blips should degrade to in-memory locking rather than crashing Express.
  const failingRedis = {
    set: async () => {
      const err = new Error('READONLY You cannot write against a read only replica.');
      err.name = 'ReplyError';
      throw err;
    },
    eval: async () => {
      throw new Error('ECONNRESET Connection reset by peer');
    }
  };

  setRedisClient(failingRedis);

  // Acquire should gracefully fallback to memory lock
  const lock = await acquireLock('test:redis:fail', 5000);
  assert.strictEqual(lock.acquired, true);
  assert.ok(typeof lock.token === 'string');

  // Second acquire on the same key must be rejected by memory fallback
  const contention = await acquireLock('test:redis:fail', 5000);
  assert.strictEqual(contention.acquired, false);

  // Release should gracefully fallback to memory release
  const released = await releaseLock('test:redis:fail', lock.token);
  assert.strictEqual(released, true);
});

test('adversarial: Redis returning unexpected responses (null / non-OK string) treats lock as unacquired', async () => {
  // Why this matters: Redis SET NX returns null when key exists; any unexpected response must not falsely claim acquisition.
  const weirdResponses = [null, undefined, '', 'QUEUED', 0, false];

  for (const resp of weirdResponses) {
    const mockClient = {
      set: async () => resp,
      eval: async () => 0
    };
    setRedisClient(mockClient);

    const lock = await acquireLock('test:redis:weird', 5000);
    assert.strictEqual(lock.acquired, false, `Response ${JSON.stringify(resp)} must be treated as unacquired`);
  }
});
