const { supabaseAdmin } = require('../lib/supabaseClient');
const { TRIAL_DAYS, TRIAL_CHAT_LIMIT, TRIAL_REPORT_LIMIT } = require('../lib/accessLimits');

// Protects a route that costs backend money: saving a chat session or
// generating a report/quiz (analyze). Must run AFTER requireAuth (needs
// req.user.id already set).
//
// Access is granted if EITHER is true:
//   1. profiles.plan is an active, non-expired paid plan (starter/unlimited)
//      — unchanged from before, still fully uncapped.
//   2. The user is within their free trial window (TRIAL_DAYS from signup)
//      AND still has credits left for this specific kind of action
//      (TRIAL_CHAT_LIMIT for 'chat', TRIAL_REPORT_LIMIT for 'report' —
//      two independent counters, not a shared pool).
//
// The check-and-increment for (2) happens atomically in Postgres via
// consume_access() (see migrations/004_trial_and_usage_limits.sql) so a
// user firing two requests at once can't both consume the same last
// credit — a plain "select count then update" here in JS would race.
//
// requirePlan('chat') and requirePlan('report') are the two call sites
// today (POST /chat/sessions and POST /chat/sessions/:id/analyze).
// Reading already-generated data (history, report, mistakes/quiz review)
// is intentionally NEVER gated by this — it's a free read of something
// already paid for once at generation time.
function requirePlan(kind) {
  if (kind !== 'chat' && kind !== 'report') {
    throw new Error(`requirePlan(kind): kind must be 'chat' or 'report', got ${JSON.stringify(kind)}`);
  }

  return async function (req, res, next) {
    try {
      if (!supabaseAdmin) {
        return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });
      }

      const { data, error } = await supabaseAdmin.rpc('consume_access', {
        p_user_id: req.user.id,
        p_kind: kind,
        p_trial_days: TRIAL_DAYS,
        p_trial_limit: kind === 'chat' ? TRIAL_CHAT_LIMIT : TRIAL_REPORT_LIMIT
      });

      if (error) return next(error);

      const result = Array.isArray(data) ? data[0] : data;
      if (!result) return res.status(500).json({ error: 'Could not verify access.' });

      if (!result.allowed) {
        return res.status(402).json({
          error: 'active_plan_required',
          reason: result.reason,
          message: accessDeniedMessage(result.reason, kind)
        });
      }

      req.accessReason = result.reason; // 'paid_plan' or 'trial_ok' — handy in logs
      next();
    } catch (err) { next(err); }
  };
}

function accessDeniedMessage(reason, kind) {
  const what = kind === 'chat' ? 'session' : 'report';
  switch (reason) {
    case 'trial_expired':
      return 'Tumhara 3-din ka free trial khatam ho gaya hai — jaari rakhne ke liye plan lo.';
    case 'trial_limit_reached':
      return `Tumhare free trial ke ${kind === 'chat' ? TRIAL_CHAT_LIMIT : TRIAL_REPORT_LIMIT} free ${what}s use ho chuke hain — jaari rakhne ke liye plan lo.`;
    case 'trial_not_started':
    case 'user_not_found':
    default:
      return 'Practice sessions ke liye ek active plan ya free trial chahiye.';
  }
}

module.exports = { requirePlan };