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

// Day-of-year-ish counter that's stable regardless of timezone weirdness —
// we only need "a number that increments once per calendar day", not the
// exact calendar day itself, so this deliberately doesn't do calendar math
// (leap years, month lengths, etc). UTC epoch day is timezone-independent,
// which also means the daily scenario rotates at UTC midnight for every
// user, not local midnight — an acceptable simplification for a rotation
// (as opposed to the once-per-day COMPLETION lock below, which does need
// to match what "today" means to the user — see routes/scenarioRoutes.js).
function epochDayIndex(date) {
  return Math.floor(date.getTime() / (24 * 60 * 60 * 1000));
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
  const dayIndex = epochDayIndex(date);
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

// "Today" for the purposes of the once-per-day COMPLETION lock, expressed
// as a UTC calendar-day boundary. Kept separate from epochDayIndex (which
// drives the rotation) so the two concerns can't accidentally drift if one
// changes later — this one is about matching a real day, that one is about
// spreading load across a rotation.
function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

module.exports = { pickTodaysScenario, startOfUtcDay, epochDayIndex, hashString };
