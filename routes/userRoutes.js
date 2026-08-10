const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { supabaseAdmin } = require('../lib/supabaseClient');

// Allowed goal / level / time / occupation values — keeps bad data out of the DB.
const VALID_GOALS = ['interview', 'daily_confidence', 'exam_prep', 'travel', 'content_creation', 'general'];
const VALID_LEVELS = ['beginner', 'intermediate', 'advanced'];
const VALID_TIMES = ['5_10', '15_20', '30_plus'];
const VALID_OCCUPATIONS = ['student', 'professional'];

// Max lengths for free-text fields — the frontend already caps
// english_sample at 500 via maxlength, but that's a UI-only guard: a
// direct API call (Postman, curl, a modified app build) bypasses it
// completely, since nothing here enforced the same limit. These caps
// are the real, unbypassable limit. Chosen generously — comfortably
// above anything a real answer would need, just enough to stop
// unbounded storage bloat / layout-breaking values from a malformed or
// malicious request. Trim happens first so a string of only whitespace
// under the limit still correctly fails the "is it empty" checks below.
const MAX_NAME_LEN = 100;
const MAX_CITY_LEN = 100;
const MAX_OCCUPATION_DETAIL_LEN = 150; // class_grade / profession
const MAX_ENGLISH_SAMPLE_LEN = 500; // matches frontend's textarea maxlength

// Shared validation for onboarding fields. Used by both:
//  - POST /onboarding (first time — every field required)
//  - PATCH /profile    (later edits — only provided fields are checked/updated)
//
// Returns { updateObj, error }. error is a string if something's invalid.
function buildProfileUpdate(body, { partial }) {
  const { name, age, occupation_type, class_grade, profession, city, goal, self_level, english_sample, daily_time } = body;
  const update = {};

  const has = (v) => v !== undefined && v !== null;

  // name
  if (has(name) || !partial) {
    if (!name || !String(name).trim()) return { error: 'name is required' };
    const trimmedName = String(name).trim();
    if (trimmedName.length > MAX_NAME_LEN) return { error: `name must be at most ${MAX_NAME_LEN} characters` };
    update.name = trimmedName;
  }

  // age
  if (has(age) || !partial) {
    const ageNum = Number(age);
    if (!age || !Number.isInteger(ageNum) || ageNum < 5 || ageNum > 100) {
      return { error: 'age must be a whole number between 5 and 100' };
    }
    update.age = ageNum;
  }

  // occupation_type (+ its dependent field)
  if (has(occupation_type) || !partial) {
    if (!occupation_type || !VALID_OCCUPATIONS.includes(occupation_type)) {
      return { error: `occupation_type must be one of: ${VALID_OCCUPATIONS.join(', ')}` };
    }
    if (occupation_type === 'student' && (!class_grade || !String(class_grade).trim())) {
      return { error: 'class_grade is required when occupation_type is student' };
    }
    if (occupation_type === 'professional' && (!profession || !String(profession).trim())) {
      return { error: 'profession is required when occupation_type is professional' };
    }
    const trimmedClassGrade = occupation_type === 'student' ? String(class_grade).trim() : null;
    const trimmedProfession = occupation_type === 'professional' ? String(profession).trim() : null;
    if (trimmedClassGrade && trimmedClassGrade.length > MAX_OCCUPATION_DETAIL_LEN) {
      return { error: `class_grade must be at most ${MAX_OCCUPATION_DETAIL_LEN} characters` };
    }
    if (trimmedProfession && trimmedProfession.length > MAX_OCCUPATION_DETAIL_LEN) {
      return { error: `profession must be at most ${MAX_OCCUPATION_DETAIL_LEN} characters` };
    }
    update.occupation_type = occupation_type;
    update.class_grade = trimmedClassGrade;
    update.profession = trimmedProfession;
  }

  // city (always optional)
  if (has(city)) {
    const trimmedCity = city ? String(city).trim() : null;
    if (trimmedCity && trimmedCity.length > MAX_CITY_LEN) {
      return { error: `city must be at most ${MAX_CITY_LEN} characters` };
    }
    update.city = trimmedCity;
  }

  // goal
  if (has(goal) || !partial) {
    if (!goal || !VALID_GOALS.includes(goal)) {
      return { error: `goal must be one of: ${VALID_GOALS.join(', ')}` };
    }
    update.goal = goal;
  }

  // self_level
  if (has(self_level) || !partial) {
    if (!self_level || !VALID_LEVELS.includes(self_level)) {
      return { error: `self_level must be one of: ${VALID_LEVELS.join(', ')}` };
    }
    update.self_level = self_level;
  }

  // english_sample (always optional)
  if (has(english_sample)) {
    const trimmedSample = english_sample ? String(english_sample).trim() : null;
    if (trimmedSample && trimmedSample.length > MAX_ENGLISH_SAMPLE_LEN) {
      return { error: `english_sample must be at most ${MAX_ENGLISH_SAMPLE_LEN} characters` };
    }
    update.english_sample = trimmedSample;
  }

  // daily_time
  if (has(daily_time) || !partial) {
    if (!daily_time || !VALID_TIMES.includes(daily_time)) {
      return { error: `daily_time must be one of: ${VALID_TIMES.join(', ')}` };
    }
    update.daily_time = daily_time;
  }

  return { updateObj: update };
}

// Called once, right after signup, from the mandatory onboarding screen.
// Every field is required. Flips onboarding_completed to true.
router.post('/onboarding', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });
    }

    const { updateObj, error: validationError } = buildProfileUpdate(req.body, { partial: false });
    if (validationError) return res.status(400).json({ error: validationError });

    updateObj.onboarding_completed = true;

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(updateObj)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) return next(error); // 5xx internals stay server-side only — see errorHandler.js

    res.json({ profile: data });
  } catch (err) { next(err); }
});

// Called from the Profile page any time after onboarding, to edit details.
// Partial updates allowed — only send the fields that changed.
router.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });
    }

    const { updateObj, error: validationError } = buildProfileUpdate(req.body, { partial: true });
    if (validationError) return res.status(400).json({ error: validationError });

    if (Object.keys(updateObj).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided to update.' });
    }

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(updateObj)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) return next(error); // 5xx internals stay server-side only — see errorHandler.js

    res.json({ profile: data });
  } catch (err) { next(err); }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    let profile = null;
    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', req.user.id)
        .single();
      if (!error) profile = data;
    }

    res.json({
      id: req.user.id,
      email: req.user.email,
      created_at: req.user.created_at,
      profile
    });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.buildProfileUpdate = buildProfileUpdate; // exported for tests only