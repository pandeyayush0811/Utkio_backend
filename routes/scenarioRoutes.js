const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../lib/supabaseClient');
const { pickTodaysScenario, startOfUtcDay } = require('../lib/scenarioSelector');

// GET /chat/scenario/today
//
// Returns today's scenario for this user, plus whether they've already
// completed it (in which case the frontend locks the mic button — see
// scenario.html). This is the ONLY place the once-per-day rule is
// enforced with authority; scenario.html also checks it client-side for
// a snappier UI, but that's a courtesy, not the real gate (same pattern
// as requireActivePlan()/requirePlan() elsewhere in this app — the
// client check is UX, the server check is the boundary).
router.get('/today', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { data: activeScenarios, error: scenariosErr } = await supabaseAdmin
      .from('scenario_configs')
      .select('key, category, title, character_brief, opening_situation')
      .eq('active', true)
      .order('sort_order', { ascending: true });

    if (scenariosErr) return next(scenariosErr);
    if (!activeScenarios || !activeScenarios.length) {
      return res.status(503).json({ error: 'No scenarios are configured right now — check back later.' });
    }

    // Most recent scenario session this user has ever completed — used
    // both to avoid an immediate repeat (pickTodaysScenario) and to know
    // if TODAY's one is already done (below).
    const { data: lastScenarioSession, error: lastErr } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, scenario_key, started_at')
      .eq('user_id', req.user.id)
      .eq('session_type', 'scenario')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastErr) return next(lastErr);

    const now = new Date();
    const today = startOfUtcDay(now).getTime();
    const lastSessionDay = lastScenarioSession ? startOfUtcDay(new Date(lastScenarioSession.started_at)).getTime() : null;

    // IMPORTANT: only feed lastScenarioKey into the anti-repeat check when
    // it's from a PRIOR day. If we always passed it, then calling this
    // endpoint again on the SAME day after already completing today's
    // scenario would make pickTodaysScenario think today's own pick is
    // "yesterday's" (since same-day math is deterministic and now matches),
    // and it would shift to a DIFFERENT scenario mid-day — silently
    // breaking "already_completed_today" for the scenario the user
    // actually just did.
    const lastKeyForAntiRepeat = (lastScenarioSession && lastSessionDay !== today)
      ? lastScenarioSession.scenario_key
      : null;

    const scenario = pickTodaysScenario(activeScenarios, req.user.id, now, lastKeyForAntiRepeat);

    // "Already done today" = the last scenario session started on today's
    // UTC calendar day. (No need to also compare scenario_key — since
    // the rotation is deterministic per user per day, a same-day session
    // can only be for today's scenario in the first place.)
    const alreadyCompletedToday = lastScenarioSession != null && lastSessionDay === today;
    const completedSessionId = alreadyCompletedToday ? lastScenarioSession.id : null;

    res.json({ scenario, already_completed_today: alreadyCompletedToday, completed_session_id: completedSessionId });
  } catch (err) { next(err); }
});

module.exports = router;
