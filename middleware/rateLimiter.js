const rateLimit = require('express-rate-limit');

// In-memory rate-limit counters only work correctly when there's a
// single server process — with 2+ instances behind a load balancer,
// each instance would count independently, letting an attacker get
// effectively (max × instance count) requests through. Setting
// REDIS_URL switches every limiter below to a shared Redis-backed
// store instead, so counts are correct across instances.
//
// Not configured (the default right now, single instance): behaves
// exactly as before this change — plain in-memory store, no Redis
// dependency at runtime. Nothing about the default path changes.
let redisStoreFactory = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    const { RedisStore } = require('rate-limit-redis');
    const redisClient = new Redis(process.env.REDIS_URL, {
      // Don't let a slow/unreachable Redis hang requests — fail fast
      // and let the catch below fall back to in-memory.
      maxRetriesPerRequest: 1,
      lazyConnect: true
    });
    redisClient.on('error', (err) => console.error('Redis rate-limit store error:', err.message));
    redisStoreFactory = (prefix) => new RedisStore({
      prefix,
      sendCommand: (...args) => redisClient.call(...args)
    });
    console.log('Rate limiting: using Redis-backed store (REDIS_URL is set).');
  } catch (err) {
    console.error('REDIS_URL is set but Redis setup failed — falling back to in-memory rate limiting:', err.message);
    redisStoreFactory = null;
  }
}

function buildLimiter(prefix, options) {
  return rateLimit({
    ...options,
    standardHeaders: true,
    legacyHeaders: false,
    // omitting `store` here uses express-rate-limit's built-in
    // in-memory store — that's the default, unchanged path.
    ...(redisStoreFactory ? { store: redisStoreFactory(prefix) } : {})
  });
}

// General API traffic. Generous on purpose — your BYOK model means the
// heavy real-time voice traffic never touches this backend at all, so
// even at 1000 concurrent users this stays light (mostly login/profile calls).
const generalLimiter = buildLimiter('rl:general:', {
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests, please slow down.' }
});

// Auth routes (signup/login/google) — stricter, since these are what
// credential-stuffing bots and abuse scripts target.
const authLimiter = buildLimiter('rl:auth:', {
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts, please try again later.' }
});

// Writes (chat session saves, profile/onboarding updates) — tighter than
// the general limiter. These touch the database and, once the analysis
// LLM feature ships, some of these will trigger paid API calls — this
// limiter is the first line of defense against a script hammering them.
const writeLimiter = buildLimiter('rl:write:', {
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please slow down.' }
});

module.exports = { generalLimiter, authLimiter, writeLimiter };
