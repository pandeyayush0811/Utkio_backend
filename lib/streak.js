const { supabaseAdmin } = require('./supabaseClient');

// IST is a fixed UTC+5:30 offset with no DST.
const IST_OFFSET_MINUTES = 5 * 60 + 30;

function istDateString(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Given a 'YYYY-MM-DD' IST date string and deltaDays (e.g. -1 for yesterday),
// returns the resulting 'YYYY-MM-DD' string in IST.
function shiftIstDate(istDateStr, deltaDays) {
  const [y, m, d] = istDateStr.split('-').map(Number);
  // UTC constructor avoids local timezone pitfalls
  const utcMs = Date.UTC(y, m - 1, d) + deltaDays * 24 * 60 * 60 * 1000;
  const shifted = new Date(utcMs);
  const resY = shifted.getUTCFullYear();
  const resM = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const resD = String(shifted.getUTCDate()).padStart(2, '0');
  return `${resY}-${resM}-${resD}`;
}

/**
 * Pure streak calculator.
 * @param {Array<string|Date>} timestamps - list of session started_at timestamps
 * @param {Date} [referenceDate=new Date()] - current reference instant (for testing)
 * @returns {{ current_streak: number, best_streak: number, practiced_today: boolean, last_practiced_ist: string|null, total_practice_days: number }}
 */
function calculateStreak(timestamps = [], referenceDate = new Date()) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) {
    return {
      current_streak: 0,
      best_streak: 0,
      practiced_today: false,
      last_practiced_ist: null,
      total_practice_days: 0
    };
  }

  // Convert all timestamps to IST dates and deduplicate
  const uniqueDates = new Set();
  for (const ts of timestamps) {
    if (!ts) continue;
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) continue;
    uniqueDates.add(istDateString(d));
  }

  if (uniqueDates.size === 0) {
    return {
      current_streak: 0,
      best_streak: 0,
      practiced_today: false,
      last_practiced_ist: null,
      total_practice_days: 0
    };
  }

  const sortedDates = Array.from(uniqueDates).sort(); // ascending 'YYYY-MM-DD'
  const todayIst = istDateString(referenceDate);
  const yesterdayIst = shiftIstDate(todayIst, -1);
  const practicedToday = uniqueDates.has(todayIst);
  const lastPracticedIst = sortedDates[sortedDates.length - 1];

  // 1. Calculate Current Streak
  let currentStreak = 0;
  if (practicedToday) {
    currentStreak = 1;
    let checkDate = shiftIstDate(todayIst, -1);
    while (uniqueDates.has(checkDate)) {
      currentStreak++;
      checkDate = shiftIstDate(checkDate, -1);
    }
  } else if (uniqueDates.has(yesterdayIst)) {
    // User hasn't practiced yet today, but practiced yesterday — streak is still alive!
    currentStreak = 1;
    let checkDate = shiftIstDate(yesterdayIst, -1);
    while (uniqueDates.has(checkDate)) {
      currentStreak++;
      checkDate = shiftIstDate(checkDate, -1);
    }
  } else {
    // Missed yesterday and today — streak is 0
    currentStreak = 0;
  }

  // 2. Calculate Historical Best Streak
  let bestStreak = 0;
  let runningStreak = 0;
  let prevDate = null;

  for (const d of sortedDates) {
    if (!prevDate) {
      runningStreak = 1;
    } else {
      const expectedNext = shiftIstDate(prevDate, 1);
      if (d === expectedNext) {
        runningStreak++;
      } else {
        runningStreak = 1;
      }
    }
    if (runningStreak > bestStreak) {
      bestStreak = runningStreak;
    }
    prevDate = d;
  }

  return {
    current_streak: currentStreak,
    best_streak: Math.max(bestStreak, currentStreak),
    practiced_today: practicedToday,
    last_practiced_ist: lastPracticedIst,
    total_practice_days: uniqueDates.size
  };
}

/**
 * Fetch and compute a user's practice streak from database sessions.
 * @param {string} userId - UUID of the user
 * @param {Date} [referenceDate] - reference instant (defaults to now)
 */
async function getUserStreak(userId, referenceDate = new Date()) {
  if (!supabaseAdmin || !userId) {
    return {
      current_streak: 0,
      best_streak: 0,
      practiced_today: false,
      last_practiced_ist: null,
      total_practice_days: 0
    };
  }

  const { data: sessions, error } = await supabaseAdmin
    .from('chat_sessions')
    .select('started_at')
    .eq('user_id', userId);

  if (error) {
    console.error('getUserStreak error:', error.message);
    return {
      current_streak: 0,
      best_streak: 0,
      practiced_today: false,
      last_practiced_ist: null,
      total_practice_days: 0
    };
  }

  const timestamps = (sessions || []).map(s => s.started_at);
  return calculateStreak(timestamps, referenceDate);
}

module.exports = {
  calculateStreak,
  getUserStreak,
  istDateString,
  shiftIstDate
};
