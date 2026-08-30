const { supabaseAdmin } = require('../lib/supabaseClient');
const { TRIAL_DAYS, TRIAL_CHAT_LIMIT, TRIAL_REPORT_LIMIT, TRIAL_SCENARIO_LIMIT } = require('../lib/accessLimits');

// Protects a route that costs backend money: saving a chat session,
// saving a scenario session, or generating a report (analyze).
// Must run AFTER requireAuth (needs req.user.id already set).
function requirePlan(kind) {
  if (kind !== 'chat' && kind !== 'report' && kind !== 'scenario') {
    throw new Error(`requirePlan(kind): kind must be 'chat', 'report', or 'scenario', got ${JSON.stringify(kind)}`);
  }

  const limit = kind === 'chat' ? TRIAL_CHAT_LIMIT : (kind === 'scenario' ? TRIAL_SCENARIO_LIMIT : TRIAL_REPORT_LIMIT);

  return async function (req, res, next) {
    try {
      if (!supabaseAdmin) {
        return res.status(500).json({ error: 'Server configuration error. Please try again later.' });
      }

      const { data, error } = await supabaseAdmin.rpc('consume_access', {
        p_user_id: req.user.id,
        p_kind: kind,
        p_trial_days: TRIAL_DAYS,
        p_trial_limit: limit
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
  const what = kind === 'chat' ? 'practice session' : (kind === 'scenario' ? 'scenario simulation' : 'analysis report');
  const limit = kind === 'chat' ? TRIAL_CHAT_LIMIT : (kind === 'scenario' ? TRIAL_SCENARIO_LIMIT : TRIAL_REPORT_LIMIT);
  switch (reason) {
    case 'trial_expired':
      return 'Your 3-day free trial has expired. Please choose a plan to continue.';
    case 'trial_limit_reached':
      return `You have used all ${limit} free ${what}${limit > 1 ? 's' : ''} in your trial. Please choose a plan to continue.`;
    case 'trial_not_started':
    case 'user_not_found':
    default:
      return 'An active plan or trial is required to start practice sessions.';
  }
}

module.exports = { requirePlan };