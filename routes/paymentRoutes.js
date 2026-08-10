const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../lib/supabaseClient');
const { razorpay } = require('../lib/razorpayClient');
const { TRIAL_DAYS, TRIAL_CHAT_LIMIT, TRIAL_REPORT_LIMIT } = require('../lib/accessLimits');

// Only Starter is actually purchasable right now — Unlimited is
// waitlist-only (see POST /unlimited/waitlist below). Adding Unlimited
// here later is a one-line addition, not a restructure.
const PLAN_PRICES_PAISE = {
  starter: 9900 // ₹99
};
const PLAN_VALIDITY_DAYS = {
  starter: 30
};

// ═══════════════════════════════════════════════════════════════
// POST /payments/create-order
// Client calls this right before opening the Razorpay checkout widget.
// ═══════════════════════════════════════════════════════════════
router.post('/create-order', requireAuth, async (req, res, next) => {
  try {
    if (!razorpay) return res.status(500).json({ error: 'Payments not configured on server.' });
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { plan } = req.body;
    if (!plan || !PLAN_PRICES_PAISE[plan]) {
      return res.status(400).json({ error: `plan must be one of: ${Object.keys(PLAN_PRICES_PAISE).join(', ')}` });
    }

    const amount = PLAN_PRICES_PAISE[plan];

    // receipt is Razorpay's own free-text reference field (max 40
    // chars) — not shown to the user, just useful for cross-referencing
    // in the Razorpay dashboard while debugging.
    const receipt = `${plan}_${req.user.id}_${Date.now()}`.slice(0, 40);

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt,
      notes: { user_id: req.user.id, plan }
    });

    const { error: insertError } = await supabaseAdmin.from('payments').insert({
      user_id: req.user.id,
      plan,
      amount_paise: amount,
      currency: 'INR',
      razorpay_order_id: order.id,
      status: 'created'
    });
    if (insertError) return next(insertError);

    res.json({
      order_id: order.id,
      amount,
      currency: 'INR',
      key_id: process.env.RAZORPAY_KEY_ID // publishable — safe to send to client, needed by the checkout widget
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// POST /payments/verify
// Called by the client immediately after Razorpay's checkout widget
// reports success — gives the user instant feedback ("plan active!")
// without waiting for the webhook round trip.
//
// IMPORTANT: this is a UX convenience, NOT the source of truth. A
// client-side "success" callback can be skipped entirely (closed tab,
// crashed browser, network drop right after paying) — the webhook below
// is what actually guarantees the plan gets activated even if this
// endpoint is never called. Both paths write the exact same
// idempotent update, so whichever fires first wins and the other is a
// harmless no-op.
// ═══════════════════════════════════════════════════════════════
router.post('/verify', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are all required' });
    }
    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: 'Payments not configured on server.' });
    }

    // Razorpay's own signature scheme for this callback: HMAC-SHA256 of
    // "order_id|payment_id" using your key SECRET (never the publishable
    // key_id). This is what proves the payment success message actually
    // came from Razorpay and wasn't just faked by someone calling this
    // endpoint directly with made-up IDs.
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid payment signature.' });
    }

    const { data: payment, error: fetchError } = await supabaseAdmin
      .from('payments')
      .select('*')
      .eq('razorpay_order_id', razorpay_order_id)
      .single();

    if (fetchError || !payment) return res.status(404).json({ error: 'Order not found.' });
    // Make sure this order actually belongs to the person calling this
    // endpoint — otherwise anyone who's seen someone else's order_id
    // (e.g. in a shared screenshot) could try to mark it verified for
    // themselves. Doesn't change plan_expires_at math, but worth being
    // strict about since money is involved.
    if (payment.user_id !== req.user.id) return res.status(403).json({ error: 'This order does not belong to you.' });

    await activatePlan({ payment, razorpay_payment_id });

    res.json({ status: 'active', plan: payment.plan });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// POST /payments/webhook
// Configured in the Razorpay dashboard (Settings -> Webhooks), NOT
// called by the app. Server-to-server, no user auth — Razorpay itself
// is the caller, authenticated via a webhook signature instead of a
// Bearer token. This is the real source of truth (see note on /verify
// above) — it fires even if the user's browser/app never gets a chance
// to call /verify.
//
// NOTE: needs the raw request body (exact bytes Razorpay sent) to check
// the signature — index.js's express.json() is configured with a
// `verify` callback that stashes that onto req.rawBody specifically so
// this route can use it, since by the time this handler runs the body
// has already been parsed into req.body.
// ═══════════════════════════════════════════════════════════════
router.post('/webhook', async (req, res, next) => {
  try {
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      console.error('RAZORPAY_WEBHOOK_SECRET not set — cannot verify incoming webhook, rejecting.');
      return res.status(500).send('Webhook not configured');
    }
    if (!supabaseAdmin) return res.status(500).send('Server misconfigured');

    const signature = req.headers['x-razorpay-signature'];
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
      .digest('hex');

    if (!signature || signature !== expectedSignature) {
      console.error('Webhook signature mismatch — rejecting (possible spoofed request).');
      return res.status(400).send('Invalid signature');
    }

    const event = req.body;

    // Only act on the one event that means "money actually landed".
    // Ignore everything else (order.paid, payment.failed, etc.) — 200
    // them so Razorpay doesn't keep retrying, just don't act on them.
    if (event.event === 'payment.captured') {
      const paymentEntity = event.payload && event.payload.payment && event.payload.payment.entity;
      if (paymentEntity && paymentEntity.order_id) {
        const { data: payment, error: fetchError } = await supabaseAdmin
          .from('payments')
          .select('*')
          .eq('razorpay_order_id', paymentEntity.order_id)
          .single();

        if (payment && !fetchError) {
          await activatePlan({ payment, razorpay_payment_id: paymentEntity.id });
        } else {
          console.error('Webhook: payment.captured for unknown order_id', paymentEntity.order_id);
        }
      }
    }

    // Always 200 a signature-valid webhook, even if we didn't act on
    // this particular event type — Razorpay retries (with backoff, then
    // eventually gives up and alerts you) on anything non-2xx, and
    // there's nothing to retry here.
    res.status(200).json({ received: true });
  } catch (err) { next(err); }
});

// Shared by both /verify and /webhook — whichever fires first wins,
// the other is a harmless no-op thanks to the `status = 'created'`
// guard below (an already-'paid' row just gets skipped, not
// re-processed / re-dated).
async function activatePlan({ payment, razorpay_payment_id }) {
  // Idempotency guard: if this order was already marked paid (by
  // whichever of /verify or the webhook got here first), don't do it
  // again — re-running this would push plan_expires_at another 30 days
  // into the future for a SINGLE payment, effectively giving the user
  // free extra time.
  if (payment.status === 'paid') return;

  const validityDays = PLAN_VALIDITY_DAYS[payment.plan] || 30;

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('plan, plan_expires_at')
    .eq('id', payment.user_id)
    .single();

  // Renewing before expiry extends from the CURRENT expiry date, not
  // from today — so paying a few days early never costs the user those
  // days. Renewing after it already expired (or first purchase) starts
  // fresh from now.
  const currentExpiry = profile && profile.plan_expires_at ? new Date(profile.plan_expires_at) : null;
  const base = currentExpiry && currentExpiry > new Date() ? currentExpiry : new Date();
  const newExpiry = new Date(base.getTime() + validityDays * 24 * 60 * 60 * 1000);

  await supabaseAdmin
    .from('payments')
    .update({ status: 'paid', razorpay_payment_id, paid_at: new Date().toISOString() })
    .eq('id', payment.id);

  await supabaseAdmin
    .from('profiles')
    .update({ plan: payment.plan, plan_expires_at: newExpiry.toISOString() })
    .eq('id', payment.user_id);
}

// ═══════════════════════════════════════════════════════════════
// BROWSER-BASED CHECKOUT (fixes Razorpay-inside-WebView failures)
//
// Flow:
//   1. App (still authenticated, inside WebView) calls POST /checkout/init.
//      Backend creates the Razorpay order exactly like /create-order does,
//      then mints a random single-use token tied to it and returns a
//      checkout_url pointing at the hosted /checkout.html page.
//   2. App opens checkout_url in the SYSTEM BROWSER (Capacitor Browser
//      plugin), not the in-app WebView.
//   3. checkout.html (unauthenticated, public) calls GET /checkout/:token
//      to fetch order details, then runs Razorpay's checkout widget —
//      now in a real browser, where it actually works.
//   4. On success, checkout.html calls POST /checkout/:token/verify.
//      Same signature-verification + idempotent activatePlan() as the
//      in-app flow. Token is burned (single use) either way.
//   5. The webhook above remains the real source of truth regardless —
//      if the user closes the browser tab right after paying before step
//      4 fires, the webhook still activates the plan. This flow is a UX
//      nicety on top, same relationship /verify already has to /webhook.
// ═══════════════════════════════════════════════════════════════

const CHECKOUT_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes — plenty for a checkout, short enough to limit exposure if a URL leaks (e.g. shared-clipboard, chat screenshot)

router.post('/checkout/init', requireAuth, async (req, res, next) => {
  try {
    if (!razorpay) return res.status(500).json({ error: 'Payments not configured on server.' });
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { plan } = req.body;
    if (!plan || !PLAN_PRICES_PAISE[plan]) {
      return res.status(400).json({ error: `plan must be one of: ${Object.keys(PLAN_PRICES_PAISE).join(', ')}` });
    }

    const amount = PLAN_PRICES_PAISE[plan];
    const receipt = `${plan}_${req.user.id}_${Date.now()}`.slice(0, 40);

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt,
      notes: { user_id: req.user.id, plan, via: 'browser_checkout' }
    });

    const { data: paymentRow, error: insertError } = await supabaseAdmin
      .from('payments')
      .insert({
        user_id: req.user.id,
        plan,
        amount_paise: amount,
        currency: 'INR',
        razorpay_order_id: order.id,
        status: 'created'
      })
      .select('id')
      .single();
    if (insertError) return next(insertError);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + CHECKOUT_TOKEN_TTL_MS).toISOString();

    const { error: tokenError } = await supabaseAdmin.from('checkout_tokens').insert({
      token,
      payment_id: paymentRow.id,
      user_id: req.user.id,
      expires_at: expiresAt
    });
    if (tokenError) return next(tokenError);

    // req.get('host') respects the real public host even behind Render's
    // proxy (works together with app.set('trust proxy', 1) in index.js).
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ checkout_url: `${baseUrl}/checkout.html?token=${token}` });
  } catch (err) { next(err); }
});

// Looks up a checkout token and returns { row, payment } if valid, or
// null if missing/expired/already used. Shared by the two routes below
// so the "is this token still good" logic lives in exactly one place.
async function resolveCheckoutToken(token) {
  const { data: row } = await supabaseAdmin
    .from('checkout_tokens')
    .select('*, payments(*)')
    .eq('token', token)
    .maybeSingle();

  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (!row.payments) return null; // payment row was somehow deleted — treat as invalid

  return { row, payment: row.payments };
}

// GET /payments/checkout/:token — public (no Authorization header; the
// token itself IS the auth, scoped to exactly one pending order).
router.get('/checkout/:token', async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured.' });

    const resolved = await resolveCheckoutToken(req.params.token);
    if (!resolved) return res.status(410).json({ error: 'This checkout link has expired or was already used. Go back to the app and try again.' });

    const { payment } = resolved;
    res.json({
      order_id: payment.razorpay_order_id,
      amount: payment.amount_paise,
      currency: payment.currency,
      plan: payment.plan,
      key_id: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) { next(err); }
});

// POST /payments/checkout/:token/verify — public, called by checkout.html
// right after Razorpay's widget reports success in the browser.
router.post('/checkout/:token/verify', async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured.' });
    if (!process.env.RAZORPAY_KEY_SECRET) return res.status(500).json({ error: 'Payments not configured on server.' });

    const resolved = await resolveCheckoutToken(req.params.token);
    if (!resolved) return res.status(410).json({ error: 'This checkout link has expired or was already used.' });

    const { row, payment } = resolved;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are all required' });
    }
    // The token was minted for one specific order — refuse to let it
    // verify a *different* order_id than the one it was issued for.
    if (razorpay_order_id !== payment.razorpay_order_id) {
      return res.status(400).json({ error: 'Order mismatch.' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid payment signature.' });
    }

    await activatePlan({ payment, razorpay_payment_id });

    // Burn the token — single use, regardless of what happens next.
    await supabaseAdmin
      .from('checkout_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('token', row.token);

    res.json({ status: 'active', plan: payment.plan });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /payments/status — frontend calls this to decide what to show
// (paywall vs. app, "renew" banner near expiry, etc.)
// ═══════════════════════════════════════════════════════════════
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('plan, plan_expires_at')
      .eq('id', req.user.id)
      .single();
    if (error) return next(error);

    const hasPaidPlan = data.plan !== 'none' && (!data.plan_expires_at || new Date(data.plan_expires_at) > new Date());

    // Read-only trial peek (no side effects, safe to poll) — only meaningful
    // when there's no active paid plan, but we fetch it regardless so the
    // response shape is stable either way.
    const { data: trialData, error: trialError } = await supabaseAdmin.rpc('peek_access', {
      p_user_id: req.user.id,
      p_trial_days: TRIAL_DAYS,
      p_trial_limit_chats: TRIAL_CHAT_LIMIT,
      p_trial_limit_reports: TRIAL_REPORT_LIMIT
    });
    if (trialError) return next(trialError);
    const trial = Array.isArray(trialData) ? trialData[0] : trialData;

    // `active` = "can the user actually use gated features right now"
    // (unchanged field name/meaning for frontend backward-compat — was
    // paid-only before, now also true during an in-progress free trial).
    const active = hasPaidPlan || Boolean(trial && trial.trial_active);

    res.json({
      plan: data.plan,
      plan_expires_at: data.plan_expires_at,
      active,
      trial: hasPaidPlan ? null : {
        active: Boolean(trial && trial.trial_active),
        days_left: trial ? Math.max(0, Math.floor(Number(trial.trial_days_left) * 10) / 10) : 0,
        chats_remaining: trial ? trial.chats_remaining : 0,
        reports_remaining: trial ? trial.reports_remaining : 0,
        chat_limit: TRIAL_CHAT_LIMIT,
        report_limit: TRIAL_REPORT_LIMIT
      }
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// POST /payments/unlimited/waitlist — Unlimited isn't purchasable yet.
// ═══════════════════════════════════════════════════════════════
router.post('/unlimited/waitlist', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { error } = await supabaseAdmin
      .from('unlimited_waitlist')
      .upsert({ user_id: req.user.id }, { onConflict: 'user_id', ignoreDuplicates: true });
    if (error) return next(error);

    res.status(201).json({ joined: true });
  } catch (err) { next(err); }
});

router.get('/unlimited/waitlist', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { data, error } = await supabaseAdmin
      .from('unlimited_waitlist')
      .select('user_id')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) return next(error);

    res.json({ joined: !!data });
  } catch (err) { next(err); }
});

module.exports = router;