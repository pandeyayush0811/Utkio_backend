const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../lib/supabaseClient');
const { razorpay } = require('../lib/razorpayClient');
const { TRIAL_DAYS, TRIAL_CHAT_LIMIT, TRIAL_REPORT_LIMIT } = require('../lib/accessLimits');
const { verifyHmacSignature } = require('../lib/verifySignature');
// PLAN_PRICES_PAISE, PLAN_VALIDITY_DAYS and activatePlan now live in
// lib/planActivation.js — shared with the reconciliation job (see
// lib/reconcilePayments.js) so there is exactly one implementation of
// "what does a captured payment turn into", not two copies that can
// silently drift apart.
const { PLAN_PRICES_PAISE, activatePlan } = require('../lib/planActivation');
const {
  COMMIT_MODE_PLAN,
  COMMIT_MODE_DISCLOSURE_VERSION,
  getUnconsumedConsent,
  recordConsent,
  consumeConsent
} = require('../lib/commitMode');

// Shared by /create-order and /checkout/init below — a commit_mode
// purchase attempt is blocked (402, not 400: this is an access/consent
// problem, not a malformed request) unless a fresh, unconsumed consent
// row is on file. Returns the consent row (so the caller can consume it
// after the payment row is inserted) or sends the 402 itself and returns
// null, so callers just do: `const consent = await ...; if (!consent) return;`
async function requireCommitModeConsentOrRespond(req, res, plan) {
  if (plan !== COMMIT_MODE_PLAN) return { skip: true };
  const consent = await getUnconsumedConsent(req.user.id);
  if (!consent) {
    res.status(402).json({
      error: 'commit_mode_consent_required',
      message: 'Commit Mode lene se pehle rules wala disclosure dekhna aur agree karna zaroori hai.',
      disclosure_version: COMMIT_MODE_DISCLOSURE_VERSION
    });
    return { skip: false, consent: null };
  }
  return { skip: false, consent };
}

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

    const consentCheck = await requireCommitModeConsentOrRespond(req, res, plan);
    if (!consentCheck.skip && !consentCheck.consent) return; // 402 already sent

    // receipt is Razorpay's own free-text reference field (max 40
    // chars) — not shown to the user, just useful for cross-referencing
    // in the Razorpay dashboard while debugging.
    const receipt = `${plan}_${req.user.id}_${Date.now()}`.slice(0, 40);

    // Dedup guard: Razorpay's standard Orders API does NOT support an
    // idempotency key (unlike their Payouts/Refunds/Transfers APIs) —
    // so a retried/double-tapped call would otherwise create a second
    // live order. Instead, reuse a still-pending order for this exact
    // user+plan if one was created in the last DEDUP_WINDOW_MS: this
    // covers the double-tap/retry case without touching Razorpay's API
    // at all. A genuinely new purchase attempt after the window (or for
    // a different plan) still creates a fresh order as before.
    const dedupSince = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const { data: recentPending } = await supabaseAdmin
      .from('payments')
      .select('razorpay_order_id, amount_paise, currency')
      .eq('user_id', req.user.id)
      .eq('plan', plan)
      .eq('status', 'created')
      .gte('created_at', dedupSince)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentPending) {
      return res.json({
        order_id: recentPending.razorpay_order_id,
        amount: recentPending.amount_paise,
        currency: recentPending.currency,
        key_id: process.env.RAZORPAY_KEY_ID
      });
    }

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt,
      notes: { user_id: req.user.id, plan }
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

    // Tie this purchase to the consent that unlocked it, so it can never
    // be reused to back a second purchase without re-showing the rules.
    if (!consentCheck.skip && consentCheck.consent) {
      await consumeConsent(consentCheck.consent.id, paymentRow.id);
    }

    res.json({
      order_id: order.id,
      amount,
      currency: 'INR',
      key_id: process.env.RAZORPAY_KEY_ID // publishable — safe to send to client, needed by the checkout widget
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// POST /payments/commit-mode/consent
// Called the moment the user taps "I understand and agree" on the
// pre-purchase disclosure card — BEFORE create-order/checkout/init, which
// both now reject plan=commit_mode without an unconsumed row from here.
// This is the legal record: server-timestamped, independent of the
// client. See lib/commitMode.js recordConsent() + migration 007.
// ═══════════════════════════════════════════════════════════════
router.post('/commit-mode/consent', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });
    const consent = await recordConsent(req.user.id);
    res.json({ consented_at: consent.consented_at, disclosure_version: COMMIT_MODE_DISCLOSURE_VERSION });
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
    // endpoint directly with made-up IDs. Timing-safe compare — see
    // lib/verifySignature.js for why a plain !== isn't used here.
    const validSignature = verifyHmacSignature({
      secret: process.env.RAZORPAY_KEY_SECRET,
      payload: `${razorpay_order_id}|${razorpay_payment_id}`,
      providedSignature: razorpay_signature
    });

    if (!validSignature) {
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
    const validSignature = verifyHmacSignature({
      secret: process.env.RAZORPAY_WEBHOOK_SECRET,
      payload: req.rawBody || Buffer.from(JSON.stringify(req.body)),
      providedSignature: signature
    });

    if (!validSignature) {
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

// How long a still-'created' payment for the same user+plan is treated
// as "the same purchase attempt" for dedup purposes (see /create-order
// and /checkout/init above). Long enough to absorb a slow retry/double
// tap, short enough that someone who genuinely abandons checkout and
// comes back later still gets a fresh order rather than being stuck
// reusing a stale one.
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

router.post('/checkout/init', requireAuth, async (req, res, next) => {
  try {
    if (!razorpay) return res.status(500).json({ error: 'Payments not configured on server.' });
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { plan } = req.body;
    if (!plan || !PLAN_PRICES_PAISE[plan]) {
      return res.status(400).json({ error: `plan must be one of: ${Object.keys(PLAN_PRICES_PAISE).join(', ')}` });
    }

    const amount = PLAN_PRICES_PAISE[plan];

    const consentCheck = await requireCommitModeConsentOrRespond(req, res, plan);
    if (!consentCheck.skip && !consentCheck.consent) return; // 402 already sent

    const receipt = `${plan}_${req.user.id}_${Date.now()}`.slice(0, 40);

    // Same dedup guard as /create-order above — see comment there for why
    // this exists instead of a Razorpay-side idempotency key.
    const dedupSince = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const { data: recentPending } = await supabaseAdmin
      .from('payments')
      .select('id, razorpay_order_id')
      .eq('user_id', req.user.id)
      .eq('plan', plan)
      .eq('status', 'created')
      .gte('created_at', dedupSince)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentPending) {
      const { data: existingToken } = await supabaseAdmin
        .from('checkout_tokens')
        .select('token, expires_at')
        .eq('payment_id', recentPending.id)
        .is('used_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingToken) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        return res.json({ checkout_url: `${baseUrl}/checkout.html?token=${existingToken.token}` });
      }
      // Pending order exists but its checkout token already expired —
      // fall through and mint a fresh token for the SAME order instead
      // of creating a new Razorpay order.
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + CHECKOUT_TOKEN_TTL_MS).toISOString();
      const { error: tokenError } = await supabaseAdmin.from('checkout_tokens').insert({
        token,
        payment_id: recentPending.id,
        user_id: req.user.id,
        expires_at: expiresAt
      });
      if (tokenError) return next(tokenError);

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      return res.json({ checkout_url: `${baseUrl}/checkout.html?token=${token}` });
    }

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

    if (!consentCheck.skip && consentCheck.consent) {
      await consumeConsent(consentCheck.consent.id, paymentRow.id);
    }

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

    const validSignature = verifyHmacSignature({
      secret: process.env.RAZORPAY_KEY_SECRET,
      payload: `${razorpay_order_id}|${razorpay_payment_id}`,
      providedSignature: razorpay_signature
    });

    if (!validSignature) {
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
      .select('plan, plan_expires_at, commit_mode_terminated_at, commit_mode_termination_reason')
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
      // Only meaningful right after a termination — the frontend shows a
      // one-time explanation banner (see settings.html) then this stays
      // in the response forever after (harmless; a stale historical
      // fact, not something that needs to be "dismissed" server-side).
      commit_mode_terminated_at: data.commit_mode_terminated_at,
      commit_mode_termination_reason: data.commit_mode_termination_reason,
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