const { supabaseAdmin } = require('./supabaseClient');

// ═══════════════════════════════════════════════════════════════
// Single source of truth for Commit Mode's rules. Read from env (like
// accessLimits.js's TRIAL_* constants) so these are tunable without a
// redeploy, but default to the disclosed values.
// ═══════════════════════════════════════════════════════════════

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const COMMIT_MODE_PLAN = 'commit_mode';
const COMMIT_MODE_MIN_CHAT_SECONDS = envInt('COMMIT_MODE_MIN_CHAT_SECONDS', 5 * 60); // 5 minutes
const COMMIT_MODE_DISCLOSURE_VERSION = process.env.COMMIT_MODE_DISCLOSURE_VERSION || '2026-08-v1';

// IST is a fixed UTC+5:30 offset with no DST — safe to hardcode as
// minutes, no timezone-database dependency needed.
const IST_OFFSET_MINUTES = 5 * 60 + 30;

// The single definition of "what calendar date is it in India right now"
// used EVERYWHERE Commit Mode reasons about days — deliberately NOT the
// same as scenarioSelector.js's startOfUtcDay (see migration 007's header
// comment for why conflating the two would be a real bug here, even
// though it's an acceptable simplification for the scenario-rotation
// use case).
//
// Returns 'YYYY-MM-DD' (a Postgres `date` literal), computed by shifting
// the instant forward by the IST offset and reading UTC fields off the
// shifted instant — this avoids any dependency on the server's local
// timezone setting.
function istDateString(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Milliseconds until the NEXT IST midnight after `date` — used both by
// the enforcer's self-scheduling and by any "time remaining today" UI
// the frontend wants to show.
function msUntilNextIstMidnight(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  const nextMidnightShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1);
  const nextMidnightUtcMs = nextMidnightShifted - IST_OFFSET_MINUTES * 60 * 1000;
  return nextMidnightUtcMs - date.getTime();
}

// Records progress toward today's requirement. Called right after a chat
// or scenario session is successfully saved (see routes/chatRoutes.js).
// Uses the DB-side atomic upsert (record_commit_mode_progress, migration
// 007) rather than a JS read-then-write, for the same concurrent-request
// race-safety reason consume_access() is a Postgres RPC and not app code.
//
// Deliberately swallows its own errors into a logged warning rather than
// throwing — this is called as a best-effort side effect of a session
// save that has ALREADY succeeded and already been returned to the user;
// a progress-tracking hiccup must never turn into a 500 on the session
// save itself. (Worst case: today's progress under-counts by one event,
// which self-heals via the next session, or — extremely rare — costs the
// user a day they otherwise would have kept, which is why this is logged
// loudly for support to be able to investigate/manually restore.)
async function recordCommitModeProgress({ userId, kind, seconds, at }) {
  try {
    if (!supabaseAdmin) return;
    const istDate = istDateString(at || new Date());
    const { error } = await supabaseAdmin.rpc('record_commit_mode_progress', {
      p_user_id: userId,
      p_ist_date: istDate,
      p_kind: kind,
      p_seconds: kind === 'chat' ? Math.max(0, Math.round(seconds || 0)) : 0,
      p_min_chat_seconds: COMMIT_MODE_MIN_CHAT_SECONDS
    });
    if (error) {
      console.error(`[commitMode] recordCommitModeProgress failed for user ${userId}, kind=${kind}, ist_date=${istDate}:`, error);
    }
  } catch (err) {
    console.error(`[commitMode] recordCommitModeProgress threw for user ${userId}:`, err);
  }
}

// Today's progress row for a user, for the frontend's progress widget
// (GET /chat/commit-mode/today). Returns a synthesized "empty" shape if
// no row exists yet (user hasn't done anything today) rather than null,
// so the caller never has to special-case "no row" vs "row with zeros".
async function getTodaysCommitModeProgress(userId) {
  const istDate = istDateString();
  const { data, error } = await supabaseAdmin
    .from('commit_mode_daily_progress')
    .select('chat_seconds_done, chat_requirement_met, scenario_requirement_met, judged_at, judged_result')
    .eq('user_id', userId)
    .eq('ist_date', istDate)
    .maybeSingle();

  if (error) throw error;

  return {
    ist_date: istDate,
    chat_seconds_done: data ? data.chat_seconds_done : 0,
    chat_seconds_required: COMMIT_MODE_MIN_CHAT_SECONDS,
    chat_requirement_met: data ? data.chat_requirement_met : false,
    scenario_requirement_met: data ? data.scenario_requirement_met : false,
    ms_until_reset: msUntilNextIstMidnight()
  };
}

// ═══════════════════════════════════════════════════════════════
// Consent gate — legal/disclosure requirement, not a UX nicety. A
// payment for plan='commit_mode' must never be creatable unless the user
// has an UNCONSUMED consent row on file (see migration 007). "Unconsumed"
// (consumed_by_payment_id is null) is what stops a single screen-view
// from silently backing more than one purchase — every fresh purchase
// attempt (including re-subscribing after a termination) must re-show
// the rules and get a fresh explicit acknowledgement.
// ═══════════════════════════════════════════════════════════════

// Returns the unconsumed consent row for this user, or null. Callers use
// this to decide whether to let create-order/checkout/init proceed.
async function getUnconsumedConsent(userId) {
  const { data, error } = await supabaseAdmin
    .from('commit_mode_consents')
    .select('id, consented_at, disclosure_version')
    .eq('user_id', userId)
    .is('consumed_by_payment_id', null)
    .order('consented_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Called by POST /payments/commit-mode/consent right after the frontend
// shows the pre-purchase disclosure card and the user taps "I understand
// and agree". This is the legal proof: a server-side, timestamped record
// that disclosure happened, independent of whatever the client claims.
async function recordConsent(userId) {
  const { data, error } = await supabaseAdmin
    .from('commit_mode_consents')
    .insert({ user_id: userId, disclosure_version: COMMIT_MODE_DISCLOSURE_VERSION })
    .select('id, consented_at')
    .single();
  if (error) throw error;
  return data;
}

// Marks a consent row as consumed by the payment it just unlocked — one
// consent screen-view can back exactly one purchase. Called from inside
// the create-order/checkout/init handlers right after the payments row
// is inserted, in the same request (not a separate atomic transaction —
// acceptable here because the worst case of the two writes falling out
// of sync is a user occasionally being asked to re-consent, never an
// unconsented purchase going through, since the gate check happens
// first).
async function consumeConsent(consentId, paymentId) {
  const { error } = await supabaseAdmin
    .from('commit_mode_consents')
    .update({ consumed_by_payment_id: paymentId })
    .eq('id', consentId)
    .is('consumed_by_payment_id', null);
  if (error) throw error;
}

module.exports = {
  COMMIT_MODE_PLAN,
  COMMIT_MODE_MIN_CHAT_SECONDS,
  COMMIT_MODE_DISCLOSURE_VERSION,
  IST_OFFSET_MINUTES,
  istDateString,
  msUntilNextIstMidnight,
  recordCommitModeProgress,
  getTodaysCommitModeProgress,
  getUnconsumedConsent,
  recordConsent,
  consumeConsent
};
