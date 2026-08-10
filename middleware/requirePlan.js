const { supabaseAdmin } = require('../lib/supabaseClient');

// Protects a route that requires an active paid plan (Starter or
// Unlimited). Must run AFTER requireAuth (needs req.user.id already set).
//
// Checks profiles.plan/plan_expires_at directly — NOT the payments
// table. profiles.plan is the single source of truth for "is this user
// currently allowed in"; payments is just the audit trail of how they
// got there. Keeping the check to one column read (already indexed)
// keeps this cheap enough to run on every gated request.
async function requirePlan(req, res, next) {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });
    }

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('plan, plan_expires_at')
      .eq('id', req.user.id)
      .single();

    if (error || !data) {
      return res.status(500).json({ error: 'Could not verify plan status.' });
    }

    const hasPlan = data.plan && data.plan !== 'none';
    // NULL plan_expires_at = no expiry (reserved for a future lifetime/
    // comped plan) — Starter always has a real expiry set by
    // paymentRoutes.js, so in practice this branch only matters for
    // plans that are meant to never expire.
    const notExpired = !data.plan_expires_at || new Date(data.plan_expires_at) > new Date();

    if (!hasPlan || !notExpired) {
      return res.status(402).json({
        error: 'active_plan_required',
        message: hasPlan
          ? 'Tumhara plan expire ho gaya hai — renew karo practice jaari rakhne ke liye.'
          : 'Practice sessions ke liye ek active plan chahiye.'
      });
    }

    req.userPlan = data.plan;
    next();
  } catch (err) { next(err); }
}

module.exports = { requirePlan };
