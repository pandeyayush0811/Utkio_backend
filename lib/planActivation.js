const { supabaseAdmin } = require('./supabaseClient');

// Single source of truth for plan pricing/validity — was previously
// duplicated inline in routes/paymentRoutes.js. Pulled out here so the
// reconciliation job (lib/reconcilePayments.js) and the route handlers
// both activate plans through the exact same code path. Two copies of
// "how do we turn a paid payment into an active plan" is how you get
// silent drift (e.g. someone fixes a bug in one copy and forgets the
// other) — there is now exactly one copy.
const PLAN_PRICES_PAISE = {
  starter: 9900 // ₹99
};
const PLAN_VALIDITY_DAYS = {
  starter: 30
};

// Shared by /verify, /webhook, /checkout/:token/verify, AND the
// reconciliation job — whichever caller fires first wins, the others
// are harmless no-ops thanks to the `status = 'created'` guard below
// (an already-'paid' row just gets skipped, not re-processed/re-dated).
async function activatePlan({ payment, razorpay_payment_id }) {
  // Idempotency guard — MUST be atomic, not a separate read-then-write.
  // See git history / code review notes for the full race-condition
  // explanation: two concurrent callers (e.g. /verify and /webhook, or
  // /webhook and the reconciliation job) racing on the same order must
  // never both push plan_expires_at forward. Folding the "still
  // created?" check into the UPDATE's WHERE clause makes Postgres
  // guarantee only one caller's UPDATE can match this row — the
  // loser's WHERE matches 0 rows and we bail out below.
  const { data: updatedPayment, error: updateErr } = await supabaseAdmin
    .from('payments')
    .update({ status: 'paid', razorpay_payment_id, paid_at: new Date().toISOString() })
    .eq('id', payment.id)
    .eq('status', 'created') // <-- the atomic guard: only succeeds if still unclaimed
    .select()
    .maybeSingle();

  if (updateErr) throw updateErr;
  if (!updatedPayment) {
    // 0 rows matched: someone else already handled this (the race
    // we're guarding against), or it was already marked 'failed'.
    // Either way, nothing left to do.
    return { activated: false, reason: 'already_handled' };
  }

  // Fail loud instead of silently defaulting to 30 days. A silent
  // fallback here is exactly the kind of bug that stays invisible
  // until someone adds a new plan to PLAN_PRICES_PAISE without also
  // updating this map — and then every purchase of that plan quietly
  // gets the wrong validity window instead of an error anyone notices.
  const validityDays = PLAN_VALIDITY_DAYS[updatedPayment.plan];
  if (!validityDays) {
    throw new Error(`activatePlan: no PLAN_VALIDITY_DAYS entry for plan "${updatedPayment.plan}"`);
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('plan, plan_expires_at')
    .eq('id', updatedPayment.user_id)
    .single();

  // Renewing before expiry extends from the CURRENT expiry date, not
  // from today — so paying a few days early never costs the user those
  // days. Renewing after it already expired (or first purchase) starts
  // fresh from now.
  const currentExpiry = profile && profile.plan_expires_at ? new Date(profile.plan_expires_at) : null;
  const base = currentExpiry && currentExpiry > new Date() ? currentExpiry : new Date();
  const newExpiry = new Date(base.getTime() + validityDays * 24 * 60 * 60 * 1000);

  await supabaseAdmin
    .from('profiles')
    .update({ plan: updatedPayment.plan, plan_expires_at: newExpiry.toISOString() })
    .eq('id', updatedPayment.user_id);

  return { activated: true, plan: updatedPayment.plan, plan_expires_at: newExpiry.toISOString() };
}

module.exports = { PLAN_PRICES_PAISE, PLAN_VALIDITY_DAYS, activatePlan };
