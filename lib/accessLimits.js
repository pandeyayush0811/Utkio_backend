// Single source of truth for free-trial limits. Read from env so these can
// be tuned in production (e.g. a promo running 7-day trials for a week)
// without a code change + redeploy — same pattern as ANALYSIS_MODEL in
// chatRoutes.js. Falls back to sane defaults if the env vars aren't set.
//
// Paid plans (starter/unlimited) are NOT governed by anything here — they
// stay fully uncapped, exactly as before this feature was added. These
// limits only ever apply to users on plan = 'none' (i.e. still on trial).

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const TRIAL_DAYS = envInt('TRIAL_DAYS', 3);
const TRIAL_CHAT_LIMIT = envInt('TRIAL_CHAT_LIMIT', 5);
const TRIAL_REPORT_LIMIT = envInt('TRIAL_REPORT_LIMIT', 5);

module.exports = { TRIAL_DAYS, TRIAL_CHAT_LIMIT, TRIAL_REPORT_LIMIT };
