const { supabaseAdmin } = require('./supabaseClient');
const { razorpay } = require('./razorpayClient');
const { activatePlan } = require('./planActivation');

// ═══════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// Today a payment only gets activated two ways: the client calling
// POST /payments/verify right after checkout succeeds, or Razorpay's
// webhook calling POST /payments/webhook. Both are best-effort:
//   - The client path dies if the user closes the app/tab, the network
//     drops, or the process crashes between "payment succeeded" and
//     the verify call completing.
//   - The webhook path dies if our server is down/restarting at the
//     wrong moment, or (rarer) Razorpay's retries are exhausted before
//     we come back up.
//
// If BOTH miss for the same payment, Razorpay has captured the money
// but our `payments` row is stuck at status = 'created' forever, and
// the user's plan never activates — with nothing logging or alerting
// on it. The only way anyone finds out today is the user emailing
// support. This job closes that gap by periodically asking Razorpay
// itself, for any of our still-'created' rows, "did this actually get
// paid?" — and activating the plan if so.
//
// Safe to run as often as you like: it only ever reads from Razorpay
// and writes through the exact same activatePlan() used by /verify and
// /webhook, with the same atomic `status = 'created'` guard — so it
// can never double-activate a payment /verify or /webhook already
// caught, and /verify or /webhook firing at the same moment as this
// job can't double-activate it either.
// ═══════════════════════════════════════════════════════════════

// Skip anything younger than this — a payment created 30 seconds ago
// is very likely still mid-checkout; reconciling it this early just
// wastes a Razorpay API call on something /verify or /webhook is about
// to handle normally within seconds.
const MIN_AGE_MS = 10 * 60 * 1000; // 10 minutes

// Don't bother checking payments older than this — if Razorpay never
// captured a payment within a few days of order creation, the order
// itself has expired on Razorpay's side and the user almost certainly
// just abandoned checkout. Keeps this job's work bounded regardless of
// how much old junk accumulates in `payments`.
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// One reconciliation run only looks at this many candidate rows, to
// keep a single run's Razorpay API usage and runtime bounded. If more
// than this many payments are stuck 'created' at once, something else
// is badly wrong (e.g. webhook endpoint down for hours) and is worth a
// human looking at directly rather than one job silently chewing
// through thousands of rows.
const BATCH_LIMIT = 50;

/**
 * Finds payments stuck at status='created' and asks Razorpay whether
 * they were actually captured. Activates the plan for any that were.
 *
 * @returns {Promise<{checked: number, activated: number, stillPending: number, errors: Array<{orderId: string, message: string}>}>}
 */
async function reconcilePendingPayments() {
  const summary = { checked: 0, activated: 0, stillPending: 0, errors: [] };

  if (!supabaseAdmin) {
    throw new Error('reconcilePendingPayments: supabaseAdmin not configured (SUPABASE_SERVICE_ROLE_KEY missing)');
  }
  if (!razorpay) {
    throw new Error('reconcilePendingPayments: Razorpay client not configured (RAZORPAY_KEY_ID/SECRET missing)');
  }

  const now = Date.now();
  const createdBefore = new Date(now - MIN_AGE_MS).toISOString();
  const createdAfter = new Date(now - MAX_AGE_MS).toISOString();

  const { data: candidates, error: fetchError } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('status', 'created')
    .lte('created_at', createdBefore)
    .gte('created_at', createdAfter)
    .order('created_at', { ascending: true })
    .limit(BATCH_LIMIT);

  if (fetchError) throw fetchError;
  if (!candidates || candidates.length === 0) return summary;

  for (const payment of candidates) {
    summary.checked += 1;
    try {
      // Ask Razorpay for this order's own view of its payments — this
      // is the same data the webhook would have told us, just pulled
      // instead of pushed. orders.fetchPayments returns every payment
      // attempt against the order (a user can fail a payment attempt
      // and retry, so there can be more than one).
      const { items: orderPayments } = await razorpay.orders.fetchPayments(payment.razorpay_order_id);

      const captured = (orderPayments || []).find((p) => p.status === 'captured');

      if (!captured) {
        summary.stillPending += 1;
        // If the order has remained uncaptured for >= 30 minutes, mark status = 'failed'
        // so it cannot starve newer valid orders from auto-reconciliation.
        const orderAgeMs = Date.now() - new Date(payment.created_at).getTime();
        if (orderAgeMs >= 30 * 60 * 1000) {
          try {
            await supabaseAdmin
              .from('payments')
              .update({ status: 'failed' })
              .eq('id', payment.id)
              .eq('status', 'created');
          } catch (markErr) {
            console.error(`[reconcile] Failed to mark abandoned order ${payment.razorpay_order_id} as failed:`, markErr);
          }
        }
        continue;
      }

      // Defense in depth: confirm the captured amount actually matches
      // what we expect for this order before activating anything.
      // Razorpay's own order/payment linkage already guarantees this in
      // practice, but a cheap sanity check here costs nothing and turns
      // a "how did this even happen" incident into a loud error instead
      // of a silent wrong-plan activation.
      if (captured.amount !== payment.amount_paise) {
        summary.errors.push({
          orderId: payment.razorpay_order_id,
          message: `Amount mismatch: captured ${captured.amount}, expected ${payment.amount_paise} — skipped, needs manual review`
        });
        continue;
      }

      const result = await activatePlan({ payment, razorpay_payment_id: captured.id });
      if (result.activated) {
        summary.activated += 1;
        console.log(`[reconcile] Activated plan "${result.plan}" for user ${payment.user_id} (order ${payment.razorpay_order_id}) — webhook and /verify both missed this payment.`);
      }
      // result.activated === false means /verify or /webhook (or a
      // concurrent reconcile run) already claimed it — nothing to do,
      // not an error.
    } catch (err) {
      summary.errors.push({ orderId: payment.razorpay_order_id, message: err.message || String(err) });
      console.error(`[reconcile] Failed to reconcile order ${payment.razorpay_order_id}:`, err);
    }
  }

  return summary;
}

module.exports = { reconcilePendingPayments, MIN_AGE_MS, MAX_AGE_MS, BATCH_LIMIT };
