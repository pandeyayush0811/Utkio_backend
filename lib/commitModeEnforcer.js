const { supabaseAdmin } = require('./supabaseClient');
const { COMMIT_MODE_PLAN, istDateString } = require('./commitMode');

// ═══════════════════════════════════════════════════════════════
// The midnight (IST) sweep. Run this once shortly after each IST
// midnight (see index.js's scheduler — same setInterval-based pattern as
// lib/reconcilePayments.js, deliberately, so there's only one scheduling
// idiom in this codebase to reason about).
//
// What it does, per user currently on plan = 'commit_mode':
//   1. Find YESTERDAY's (IST) commit_mode_daily_progress row.
//   2. If it doesn't exist, or exists but doesn't have BOTH requirements
//      met -> TERMINATE: plan -> 'none', plan_expires_at -> now,
//      commit_mode_terminated_at/reason set. No refund — this is the
//      disclosed contract, not a bug.
//   3. Either way, mark yesterday's row `judged_at`/`judged_result` so it
//      can never be re-evaluated (idempotency: running this sweep twice,
//      or restarting mid-run, must never double-terminate or re-judge).
//   4. If no progress row exists at all for yesterday (user did NOTHING),
//      synthesize one first so there's still an auditable judged record,
//      not just a silent termination with no corresponding progress row.
//
// A user who is NOT on plan='commit_mode' today is skipped even if they
// have a stray progress row (e.g. they already got terminated by an
// earlier run, or downgraded some other way) — termination only ever
// fires once per missed day per the WHERE plan = 'commit_mode' guard.
// ═══════════════════════════════════════════════════════════════

const PAGE_SIZE = 100; // Keyset pagination batch size

async function runCommitModeMidnightSweep() {
  if (!supabaseAdmin) {
    throw new Error('runCommitModeMidnightSweep: supabaseAdmin not configured (SUPABASE_SERVICE_ROLE_KEY missing)');
  }

  const todayIst = istDateString();
  const yesterdayIst = istDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

  let checked = 0;
  let terminated = 0;
  let kept = 0;
  let lastSeenId = null;

  // Keyset cursor pagination loop: guarantees that 100% of Commit Mode users
  // are evaluated during the midnight sweep, whether there are 10 users or 50,000 users.
  while (true) {
    let query = supabaseAdmin
      .from('profiles')
      .select('id, plan, plan_expires_at')
      .eq('plan', COMMIT_MODE_PLAN);

    if (lastSeenId) {
      query = query.gt('id', lastSeenId);
    }

    const { data: activeUsers, error: usersErr } = await query
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);

    if (usersErr) throw usersErr;
    if (!activeUsers || activeUsers.length === 0) break;

    for (const user of activeUsers) {
      checked++;
      lastSeenId = user.id;
      try {
        const result = await judgeOneUser(user.id, yesterdayIst);
        if (result === 'terminated') terminated++;
        else kept++;
      } catch (err) {
        // One user's failure must never abort the whole sweep — every
        // other eligible user still needs to be judged tonight. Logged
        // loudly so it can be manually re-run/investigated; a user who
        // fails to get judged just gets picked up again on the NEXT
        // sweep tick (their yesterday row is still unjudged, so it's
        // safely re-attempted, not silently skipped forever).
        console.error(`[commitModeEnforcer] Failed to judge user ${user.id} for ${yesterdayIst}:`, err);
      }
    }

    if (activeUsers.length < PAGE_SIZE) break;
  }

  return { checked, terminated, kept, todayIst, yesterdayIst };
}

async function judgeOneUser(userId, yesterdayIst) {
  // Fetch-or-synthesize yesterday's row. Using upsert with
  // ignoreDuplicates would still race two concurrent sweep runs
  // creating-then-updating; instead we insert with onConflict do-nothing
  // first (cheap, idempotent), then always re-select before judging so
  // both a fresh insert and an already-existing row are read consistently.
  const { error: insertErr } = await supabaseAdmin
    .from('commit_mode_daily_progress')
    .insert({ user_id: userId, ist_date: yesterdayIst })
    .select()
    .maybeSingle();
  // Ignore unique-violation (row already existed) — that's the expected
  // case whenever the user did anything at all yesterday.
  if (insertErr && insertErr.code !== '23505') throw insertErr;

  const { data: row, error: fetchErr } = await supabaseAdmin
    .from('commit_mode_daily_progress')
    .select('id, chat_requirement_met, scenario_requirement_met, judged_at')
    .eq('user_id', userId)
    .eq('ist_date', yesterdayIst)
    .single();
  if (fetchErr) throw fetchErr;

  if (row.judged_at) {
    // Already judged by an earlier sweep run (restart, double-schedule,
    // manual re-trigger) — the profiles.plan check below already
    // prevents double-termination, but bailing here also avoids a
    // wasted write and keeps this function's behavior obviously
    // idempotent on inspection.
    return row.chat_requirement_met && row.scenario_requirement_met ? 'kept' : 'terminated';
  }

  const met = row.chat_requirement_met && row.scenario_requirement_met;

  // Judge the row FIRST (atomic, guarded by judged_at is null — mirrors
  // the trigger in migration 007). If this succeeds but the termination
  // update below fails/crashes, the next sweep tick will see judged_at
  // already set and skip re-judging, while profiles.plan is still
  // 'commit_mode' — so a manual admin check (or a small follow-up repair
  // job) can catch the gap. What must never happen is the reverse
  // (terminate first, judge later) — that ordering could terminate twice
  // if the process crashes between the two writes and a retry re-reads
  // an unjudged row.
  const { error: judgeErr } = await supabaseAdmin
    .from('commit_mode_daily_progress')
    .update({ judged_at: new Date().toISOString(), judged_result: met ? 'met' : 'missed' })
    .eq('id', row.id)
    .is('judged_at', null); // atomic guard, same idiom as activatePlan()'s status='created' guard
  if (judgeErr) throw judgeErr;

  if (met) return 'kept';

  // Missed the day -> terminate. Guarded by .eq('plan', COMMIT_MODE_PLAN)
  // so this is a no-op (0 rows matched) if the user was somehow already
  // moved off commit_mode between the SELECT above and here.
  const { error: terminateErr } = await supabaseAdmin
    .from('profiles')
    .update({
      plan: 'none',
      plan_expires_at: new Date().toISOString(),
      commit_mode_terminated_at: new Date().toISOString(),
      commit_mode_termination_reason: 'missed_daily_commitment'
    })
    .eq('id', userId)
    .eq('plan', COMMIT_MODE_PLAN);
  if (terminateErr) throw terminateErr;

  return 'terminated';
}

module.exports = { runCommitModeMidnightSweep };
