const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════
// DISTRIBUTED LOCK UTILITY
//
// In multi-instance or clustered deployments (e.g., autoscaled containers
// on Render/PaaS), background workers or scheduled sweeps must be
// coordinated across instances to prevent duplicate external API calls
// (such as Razorpay query quotas) and uncoordinated DB contention.
//
// - When REDIS_URL is configured: Uses Redis with atomic SET NX PX
//   and safe Lua script release (verifying token ownership before release).
// - When REDIS_URL is unset or Redis is unreachable: Automatically falls
//   back to a process-level in-memory lock map with auto-expiring timers.
// ═══════════════════════════════════════════════════════════════

const DEFAULT_LOCK_TTL_MS = 60000; // 60 seconds

// In-memory fallback map: key -> { token, expiresAt, timer }
const memoryLocks = new Map();

// Redis client singleton / mock holder
let redisClientInstance = null;
let redisInitialized = false;

const RELEASE_LUA_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

function getRedisClient() {
  if (redisClientInstance !== null) {
    return redisClientInstance;
  }
  if (!redisInitialized && process.env.REDIS_URL) {
    redisInitialized = true;
    try {
      const Redis = require('ioredis');
      const client = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        lazyConnect: true
      });
      client.on('error', (err) => {
        console.error('[distributedLock] Redis client error:', err.message);
      });
      redisClientInstance = client;
    } catch (err) {
      console.error('[distributedLock] Failed to initialize Redis client, falling back to in-memory:', err.message);
      redisClientInstance = null;
    }
  }
  return redisClientInstance;
}

function setRedisClient(client) {
  redisClientInstance = client;
  redisInitialized = client !== null;
}

function _resetMemoryLocks() {
  for (const [, entry] of memoryLocks.entries()) {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
  }
  memoryLocks.clear();
}

/**
 * Acquires an in-memory lock for a key.
 * @param {string} key
 * @param {number} ttlMs
 * @returns {{ acquired: boolean, token?: string }}
 */
function acquireMemoryLock(key, ttlMs) {
  const now = Date.now();
  const existing = memoryLocks.get(key);

  if (existing) {
    if (existing.expiresAt > now) {
      return { acquired: false };
    }
    // Expired lock cleanup
    if (existing.timer) clearTimeout(existing.timer);
    memoryLocks.delete(key);
  }

  const token = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const expiresAt = now + ttlMs;

  const timer = setTimeout(() => {
    const current = memoryLocks.get(key);
    if (current && current.token === token) {
      memoryLocks.delete(key);
    }
  }, ttlMs);

  if (timer.unref) {
    timer.unref();
  }

  memoryLocks.set(key, { token, expiresAt, timer });
  return { acquired: true, token };
}

/**
 * Releases an in-memory lock for a key if the token matches.
 * @param {string} key
 * @param {string} token
 * @returns {boolean}
 */
function releaseMemoryLock(key, token) {
  const existing = memoryLocks.get(key);
  if (!existing) {
    return false;
  }

  if (existing.token === token) {
    if (existing.timer) clearTimeout(existing.timer);
    memoryLocks.delete(key);
    return true;
  }

  return false;
}

/**
 * Attempts to acquire a distributed lock.
 *
 * @param {string} key - Lock identifier name
 * @param {number} [ttlMs=60000] - Lock expiration in milliseconds
 * @returns {Promise<{ acquired: boolean, token?: string }>}
 */
async function acquireLock(key, ttlMs = DEFAULT_LOCK_TTL_MS) {
  const redis = getRedisClient();

  if (redis) {
    try {
      const token = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
      if (result === 'OK') {
        return { acquired: true, token };
      }
      return { acquired: false };
    } catch (err) {
      console.warn(`[distributedLock] Redis acquire failed for "${key}", falling back to in-memory:`, err.message);
      // Fallback to in-memory lock
    }
  }

  return acquireMemoryLock(key, ttlMs);
}

/**
 * Releases a distributed lock using token verification to prevent releasing someone else's lock.
 *
 * @param {string} key - Lock identifier name
 * @param {string} token - Token returned by acquireLock
 * @returns {Promise<boolean>}
 */
async function releaseLock(key, token) {
  if (!token) return false;
  const redis = getRedisClient();

  if (redis) {
    try {
      const res = await redis.eval(RELEASE_LUA_SCRIPT, 1, key, token);
      return res === 1 || res === '1';
    } catch (err) {
      console.warn(`[distributedLock] Redis release failed for "${key}", falling back to in-memory:`, err.message);
    }
  }

  return releaseMemoryLock(key, token);
}

/**
 * Helper to execute an async critical section guarded by a distributed lock.
 *
 * @template T
 * @param {string} key - Lock key
 * @param {number} ttlMs - Lock TTL in ms
 * @param {() => Promise<T>} fn - Critical section async function
 * @param {object} [options={}] - Options, e.g. defaultResult on lock contention
 * @returns {Promise<T | { skipped: true, reason: 'locked' }>}
 */
async function withDistributedLock(key, ttlMs, fn, options = {}) {
  const defaultSkipped = {
    checked: 0,
    activated: 0,
    stillPending: 0,
    errors: [],
    skipped: true,
    reason: 'locked',
    ...(options.defaultResult || {})
  };

  const lock = await acquireLock(key, ttlMs);
  if (!lock.acquired) {
    return defaultSkipped;
  }

  try {
    return await fn();
  } finally {
    try {
      await releaseLock(key, lock.token);
    } catch (releaseErr) {
      console.error(`[distributedLock] Failed to release lock for "${key}":`, releaseErr);
    }
  }
}

module.exports = {
  DEFAULT_LOCK_TTL_MS,
  acquireLock,
  releaseLock,
  withDistributedLock,
  getRedisClient,
  setRedisClient,
  _resetMemoryLocks
};
