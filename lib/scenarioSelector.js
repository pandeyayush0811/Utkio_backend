// Deterministic "which scenario is today's scenario for this user" logic,
// kept as pure functions (no DB/network) so it's cheaply unit-testable and
// so the route handler stays a thin wrapper around it.
//
// Design goals:
//   - Same user, same calendar day -> same scenario, even across multiple
//     requests/retries (idempotent — no randomness, no DB write needed
//     just to "reserve" a pick).
//   - Different users get spread across the rotation on the same day
//     (not everyone doing "directions" on day 1), so the app doesn't feel
//     like a shared fixed script.
//   - Never repeats the user's own immediately-previous scenario two days
//     in a row, as long as more than one active scenario exists.

// Small, dependency-free string hash (djb2) — good enough for spreading
// users across the rotation; this is UX variety, not cryptography, so no
// need to pull in a hashing library for it.
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0; // >>> 0 keeps it a positive 32-bit int
  }
  return hash;
}

const IST_OFFSET_MS = 330 * 60 * 1000; // +5:30 IST offset in milliseconds

// Day counter aligned with Indian Standard Time (IST) midnight (00:00 IST).
// Ensures scenario rotation flips exactly at 12:00 AM IST in sync with
// Commit Mode and streaks.
function epochIstDayIndex(date) {
  const d = date instanceof Date ? date : new Date(date);
  return Math.floor((d.getTime() + IST_OFFSET_MS) / (24 * 60 * 60 * 1000));
}

// "Today" for the purposes of the once-per-day scenario completion lock,
// aligned to IST midnight boundary (00:00 IST).
function startOfIstDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  const istEpochDays = Math.floor((d.getTime() + IST_OFFSET_MS) / (24 * 60 * 60 * 1000));
  return new Date(istEpochDays * (24 * 60 * 60 * 1000) - IST_OFFSET_MS);
}

// Returns the scenario_configs row (from `activeScenarios`, already
// filtered to active:true and sorted by sort_order) that today's pick
// should be, for this specific user.
//
// `activeScenarios`: array of { key, ...rest }, must be non-empty.
// `userId`: string, used only to spread different users across the rotation.
// `date`: JS Date representing "now" (injected for testability).
// `lastScenarioKey`: the key of the last scenario THIS user completed, or
//   null/undefined if they've never done one. Used only to avoid an
//   immediate repeat.
function pickTodaysScenario(activeScenarios, userId, date, lastScenarioKey) {
  if (!Array.isArray(activeScenarios) || activeScenarios.length === 0) {
    throw new Error('pickTodaysScenario: activeScenarios must be a non-empty array');
  }

  const n = activeScenarios.length;
  const dayIndex = epochIstDayIndex(date || new Date());
  const userOffset = hashString(String(userId || '')) % n;

  let index = (dayIndex + userOffset) % n;
  let picked = activeScenarios[index];

  // Avoid repeating yesterday's (or whenever-last) scenario back-to-back,
  // but only if doing so is even possible (n > 1) — with exactly one
  // active scenario, a "repeat" is unavoidable and not a bug.
  if (n > 1 && lastScenarioKey && picked.key === lastScenarioKey) {
    index = (index + 1) % n;
    picked = activeScenarios[index];
  }

  return picked;
}

module.exports = {
  pickTodaysScenario,
  startOfIstDay,
  epochIstDayIndex,
  hashString,
  // Backward compatibility aliases for existing imports/tests
  startOfUtcDay: startOfIstDay,
  epochDayIndex: epochIstDayIndex
};
