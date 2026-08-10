const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { reconcilePendingPayments } = require('../lib/reconcilePayments');

// Not a per-user action, so requireAuth (Supabase user token) doesn't
// fit here — this needs its own operator-only secret instead. Uses the
// same timing-safe-compare pattern as Razorpay signature checks
// (lib/verifySignature.js) so a wrong guess can't be brute-forced via
// timing, even though ADMIN_SECRET is long/random enough that this is
// mostly belt-and-suspenders.
function requireAdminSecret(req, res, next) {
  const configured = process.env.ADMIN_SECRET;
  if (!configured) {
    return res.status(500).json({ error: 'Server misconfigured: ADMIN_SECRET not set.' });
  }

  const provided = req.headers['x-admin-secret'];
  if (!provided || typeof provided !== 'string') {
    return res.status(401).json({ error: 'Missing X-Admin-Secret header.' });
  }

  const expectedBuf = Buffer.from(configured);
  const providedBuf = Buffer.from(provided);
  const valid = expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!valid) return res.status(401).json({ error: 'Invalid admin secret.' });
  next();
}

// ═══════════════════════════════════════════════════════════════
// POST /admin/reconcile-payments
//
// Catches payments Razorpay actually captured but that our webhook AND
// the client's /payments/verify call both missed (see
// lib/reconcilePayments.js for the full why). Call this from:
//   - A scheduled job (cron, Render Cron Job, GitHub Actions schedule,
//     etc.) hitting this endpoint every 15-30 min, OR
//   - The optional in-process interval wired up in index.js when
//     RECONCILE_INTERVAL_MINUTES is set, OR
//   - Manually, if a user reports "I paid but don't have access" —
//     this endpoint doubles as the fastest way to check/fix that
//     specific class of support ticket without touching the DB by hand.
// ═══════════════════════════════════════════════════════════════
router.post('/reconcile-payments', requireAdminSecret, async (req, res, next) => {
  try {
    const summary = await reconcilePendingPayments();
    res.json(summary);
  } catch (err) { next(err); }
});

module.exports = router;
