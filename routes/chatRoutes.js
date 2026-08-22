const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { requirePlan } = require('../middleware/requirePlan');
const { supabaseAdmin } = require('../lib/supabaseClient');
const { startOfIstDay } = require('../lib/scenarioSelector');
const { recordCommitModeProgress, getTodaysCommitModeProgress } = require('../lib/commitMode');
const { getUserStreak } = require('../lib/streak');
const OpenAI = require('openai');

const SESSION_TYPES = new Set(['freeform', 'scenario']);

const MIN_TURNS_FOR_ANALYSIS = 10; // matches the frontend's button-enable threshold

const MAX_MESSAGES_PER_SESSION = 500; // sanity cap — a normal session is a few dozen turns

// Configurable via env so this can be swapped (e.g. if OpenAI deprecates
// gpt-4.1, or you want to A/B a different model) without a code change +
// redeploy — just update ANALYSIS_MODEL in the environment and restart.
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || 'gpt-4.1';

// A claimed-but-unfinished report row (see the atomic-claim comment on
// POST /sessions/:id/analyze below) should normally resolve in 10-20s.
// If the server crashes/restarts in that exact window, the `res.once
// ('finish')` cleanup never runs and the claim row is orphaned forever —
// which, thanks to the unique constraint, would permanently block that
// session from ever getting a report. Anything older than this is
// treated as abandoned and safe to reclaim, rather than trusting a
// single crash-prone in-process cleanup as the only safety net.
const STALE_CLAIM_MS = 3 * 60 * 1000; // 3 minutes — generous vs. the ~20s normal case

// Pure validator for the two new optional POST /sessions fields — kept
// standalone (like validateMessages below) so it's unit-testable without
// spinning up Express or Supabase.
function validateSessionType(sessionType, scenarioKey) {
  const resolved = sessionType === undefined ? 'freeform' : sessionType;
  if (!SESSION_TYPES.has(resolved)) {
    return { error: `session_type must be one of: ${[...SESSION_TYPES].join(', ')}` };
  }
  if (resolved === 'scenario' && (!scenarioKey || typeof scenarioKey !== 'string')) {
    return { error: 'scenario_key is required when session_type is "scenario"' };
  }
  return { error: null, resolvedSessionType: resolved };
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'messages must be a non-empty array';
  if (messages.length > MAX_MESSAGES_PER_SESSION) return `messages exceeds max of ${MAX_MESSAGES_PER_SESSION}`;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return `messages[${i}].role must be "user" or "assistant"`;
    if (typeof m.content !== 'string' || !m.content.trim()) return `messages[${i}].content must be a non-empty string`;
  }
  return null;
}

// List the current user's past sessions (most recent first). Lightweight —
// no message content here, that's a separate call (GET /sessions/:id) so
// the history list loads fast even with lots of past sessions.
router.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { data, error } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, started_at, ended_at, turn_count, created_at, session_type, scenario_key')
      .eq('user_id', req.user.id)
      .order('started_at', { ascending: false });

    if (error) return next(error); // 5xx internals stay server-side only — see errorHandler.js

    // One extra lightweight query to know which sessions already have a
    // report — avoids an N+1 (one report-check call per card) on the
    // History page.
    const { data: reportRows } = await supabaseAdmin
      .from('session_reports')
      .select('session_id')
      .eq('user_id', req.user.id);
    const reportedIds = new Set((reportRows || []).map(r => r.session_id));

    const sessions = data.map(s => ({ ...s, has_report: reportedIds.has(s.id) }));
    res.json({ sessions });
  } catch (err) { next(err); }
});

// Full transcript for one session — used by the History page (expand to
// read) and by chat.html when resuming (to seed Bolo's memory).
router.get('/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { id } = req.params;

    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('chat_sessions')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user.id) // ownership check — can't fetch someone else's session
      .single();

    if (sessionErr || !session) return res.status(404).json({ error: 'Session not found' });

    const { data: messages, error: messagesErr } = await supabaseAdmin
      .from('chat_messages')
      .select('role, content, turn_index')
      .eq('session_id', id)
      .order('turn_index', { ascending: true });

    if (messagesErr) return next(messagesErr); // 5xx internals stay server-side only — see errorHandler.js

    // has_report: same lookup History's list view does (see GET /sessions
    // above) — needed here too now so chat.html can (a) offer the report
    // link inline instead of forcing a trip through History, and (b) know
    // to lock this session against further messages (see the resume-mode
    // check in POST /sessions below — this is what that lock enforces).
    const { data: reportRow } = await supabaseAdmin
      .from('session_reports')
      .select('id')
      .eq('session_id', id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    res.json({ session, messages, has_report: !!reportRow });
  } catch (err) { next(err); }
});

// GET /chat/commit-mode/today — today's (IST) Commit Mode progress, for
// the persistent progress widget (see shared/commit-mode-widget.js).
// Deliberately NOT gated behind requirePlan — a user whose Commit Mode
// just got terminated overnight still needs to be able to load this once
// to see why/confirm, and a non-Commit-Mode user hitting this by mistake
// just gets harmless all-false zeros back, not an error.
router.get('/commit-mode/today', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });
    const progress = await getTodaysCommitModeProgress(req.user.id);
    res.json(progress);
  } catch (err) { next(err); }
});

// GET /chat/streak — returns the user's real calculated day streak (in IST).
router.get('/streak', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });
    const streak = await getUserStreak(req.user.id);
    res.json(streak);
  } catch (err) { next(err); }
});

// Called once a voice session ends (or on app-open recovery for a
// session that never made it to the backend last time). Two modes:
//   - No session_id  -> creates a brand new session (turn_index starts at 0)
//   - session_id set -> RESUME: appends these turns to an existing
//                        session (turn_index continues where it left off,
//                        ended_at + turn_count get updated)
router.post('/sessions', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    // session_type/scenario_key are new, optional fields (see
    // sql/migrations/006_scenario_simulation.sql) — a freeform chat.html
    // save omits both entirely, which is why they default here rather
    // than being required. Kept validated the same way everything else in
    // this handler is: reject before requirePlan runs, so a malformed
    // request never burns a trial credit.
    const { session_id, started_at, ended_at, messages, session_type, scenario_key } = req.body;

    if (!started_at || isNaN(Date.parse(started_at))) return res.status(400).json({ error: 'started_at must be a valid ISO timestamp' });
    if (!ended_at || isNaN(Date.parse(ended_at))) return res.status(400).json({ error: 'ended_at must be a valid ISO timestamp' });
    const msgError = validateMessages(messages);
    if (msgError) return res.status(400).json({ error: msgError });
    const sessionTypeCheck = validateSessionType(session_type, scenario_key);
    if (sessionTypeCheck.error) return res.status(400).json({ error: sessionTypeCheck.error });
    const resolvedSessionType = sessionTypeCheck.resolvedSessionType;

    // Function to handle the actual database insertion / resume once plan check passes (or is bypassed for resumes)
    const handleSessionSave = async () => {
      try {
        // Server-side enforcement of "one scenario per day" — only
        // applies to brand-new scenario sessions: resuming an
        // already-started one (session_id set) is a continuation of the
        // SAME day's attempt, not a new one, so it's exempt.
        if (!session_id && resolvedSessionType === 'scenario') {
          const todayStart = startOfIstDay(new Date()).toISOString();
          const { data: todaysScenarioSession, error: todayCheckErr } = await supabaseAdmin
            .from('chat_sessions')
            .select('id')
            .eq('user_id', req.user.id)
            .eq('session_type', 'scenario')
            .gte('started_at', todayStart)
            .limit(1)
            .maybeSingle();
          if (todayCheckErr) return next(todayCheckErr);
          if (todaysScenarioSession) {
            return res.status(409).json({
              error: 'scenario_already_done_today',
              message: 'Aaj ka scenario already complete ho chuka hai — kal ek naya milega.',
              session_id: todaysScenarioSession.id
            });
          }
        }

        // ---- Resume mode: append to an existing session ----
        if (session_id) {
          const { data: existing, error: existErr } = await supabaseAdmin
            .from('chat_sessions')
            .select('id, turn_count, ended_at')
            .eq('id', session_id)
            .eq('user_id', req.user.id) // ownership check
            .single();

          if (existErr || !existing) return res.status(404).json({ error: 'Session to resume was not found' });

          // Locked once a report exists: a report is an analysis of the
          // conversation as it stood at generation time, and this app's design
          // is that it stays that fixed snapshot — adding more turns after the
          // fact would silently make the report stale/wrong with no re-analysis
          // to match. Enforced here (not just hidden in the UI) so this can't
          // be bypassed by an old cached page, a retried pending sync, or a
          // direct API call.
          const { data: reportRow } = await supabaseAdmin
            .from('session_reports')
            .select('id')
            .eq('session_id', session_id)
            .eq('user_id', req.user.id)
            .maybeSingle();
          if (reportRow) {
            return res.status(409).json({ error: 'locked', message: 'Iss chat ka report ban chuka hai — ab isme naye messages nahi jud sakte. Naya chat shuru karo.' });
          }

          const startIndex = existing.turn_count;
          const rows = messages.map((m, i) => ({
            session_id,
            role: m.role,
            content: m.content.trim(),
            turn_index: startIndex + i
          }));

          const { error: insertErr } = await supabaseAdmin
            .from('chat_messages')
            .upsert(rows, { onConflict: 'session_id,turn_index', ignoreDuplicates: true });
          if (insertErr) return next(insertErr); // 5xx internals stay server-side only — see errorHandler.js

          const newTurnCount = startIndex + rows.length;
          const { error: updateErr } = await supabaseAdmin
            .from('chat_sessions')
            .update({ ended_at, turn_count: newTurnCount })
            .eq('id', session_id);

          if (updateErr) return next(updateErr);

          // Commit Mode progress: only meaningful for freeform ('chat') sessions.
          // Resumed session progress uses the actual elapsed duration of this leg (ended_at - started_at)
          // instead of the multi-day wall-clock gap from previous leg's ended_at.
          if (resolvedSessionType === 'freeform') {
            const legSeconds = Math.max(0, (new Date(ended_at) - new Date(started_at)) / 1000);
            recordCommitModeProgress({ userId: req.user.id, kind: 'chat', seconds: legSeconds, at: new Date(ended_at) });
          }

          return res.json({ session_id, turn_count: newTurnCount });
        }

        // ---- Normal mode: brand new session ----
        const { data: session, error: sessionErr } = await supabaseAdmin
          .from('chat_sessions')
          .insert({
            user_id: req.user.id,
            started_at,
            ended_at,
            turn_count: messages.length,
            session_type: resolvedSessionType,
            scenario_key: resolvedSessionType === 'scenario' ? scenario_key : null
          })
          .select()
          .single();

        if (sessionErr) return next(sessionErr);

        const rows = messages.map((m, i) => ({ session_id: session.id, role: m.role, content: m.content.trim(), turn_index: i }));
        const { error: messagesErr } = await supabaseAdmin
          .from('chat_messages')
          .upsert(rows, { onConflict: 'session_id,turn_index', ignoreDuplicates: true });

        if (messagesErr) {
          await supabaseAdmin.from('chat_sessions').delete().eq('id', session.id); // don't leave an orphaned empty session
          return next(messagesErr);
        }

        if (resolvedSessionType === 'freeform') {
          const durationSeconds = (new Date(ended_at) - new Date(started_at)) / 1000;
          recordCommitModeProgress({ userId: req.user.id, kind: 'chat', seconds: durationSeconds, at: new Date(ended_at) });
        }

        return res.json({ session_id: session.id, turn_count: session.turn_count });
      } catch (err) { next(err); }
    };

    // Resuming an existing session is a continuation of an already-started session and does not consume a new chat credit.
    // Brand new sessions require active plan / free trial credit.
    if (session_id) {
      await handleSessionSave();
    } else {
      const planKind = resolvedSessionType === 'scenario' ? 'scenario' : 'chat';
      requirePlan(planKind)(req, res, handleSessionSave);
    }
  } catch (err) { next(err); }
});

// Called from Settings -> "Clear all chat history". Deletes every session
// for this user; chat_messages cascade-delete automatically (foreign key
// has ON DELETE CASCADE), so we only need to touch chat_sessions here.
router.delete('/sessions', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { error } = await supabaseAdmin.from('chat_sessions').delete().eq('user_id', req.user.id);
    if (error) return next(error); // 5xx internals stay server-side only — see errorHandler.js

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// The report moved from a structured-JSON shape (separate opening_line/
// strengths/mistakes[]/growth_note/focus_next/confidence_score/quiz[]
// fields, each rendered as its own card) to a single natural-language
// Hinglish write-up — see sql/migrations/008_natural_report_format.sql.
// So there's no JSON schema to force anymore: the OpenAI call below is
// plain free-text completion, and the whole response is stored as-is in
// session_reports.report_text. report.html renders it directly (bold
// via **markers**, paragraphs via blank lines) instead of building cards
// from separate fields. No quiz is generated anymore either.

// Only used if prompt_configs is unreachable/misconfigured — the real
// prompt always comes from the DB (see getAnalysisPrompt below).
const DEFAULT_ANALYSIS_PROMPT = 'You are a warm, encouraging English coach. Read the USER\'s turns only (ignore the assistant\'s lines) and write a natural, human-sounding feedback report in Hinglish — plain text, not JSON, not bullet-labeled fields.';

// Folds the user's profile (name/age/occupation/city/goal/level) into the
// analysis prompt, so the report is anchored to WHO this person is, not
// just what they happened to say in one session — same principle as the
// live chat persona's personalization block.
function buildPersonalizationBlock(profile) {
  if (!profile) return '';
  const lines = [];
  if (profile.name) lines.push(`User ka naam "${profile.name}" hai — report ke andar unhe naam se hi address karo, generic "aap/user" jaisa mat likho.`);
  if (profile.age) lines.push(`Age: ${profile.age} saal.`);
  if (profile.occupation_type === 'student' && profile.class_grade) {
    lines.push(`Student hai, "${profile.class_grade}" mein padhta/padhti hai.`);
  } else if (profile.occupation_type === 'professional' && profile.profession) {
    lines.push(`Working professional hai — role: "${profile.profession}".`);
  }
  if (profile.city) lines.push(`Shehar: "${profile.city}".`);
  if (profile.goal) lines.push(`English seekhne ka goal: "${profile.goal}".`);
  if (profile.self_level) lines.push(`Khud-bataya level: "${profile.self_level}".`);
  if (!lines.length) return '';
  return '\n\n═══════════════════════════════\nUSER KE BAARE MEIN — isko dhyan mein rakh ke report likho, jaise ek mentor apne student ko personally jaanta ho\n═══════════════════════════════\n\n' + lines.join('\n');
}

// Fetch the editable prompt from prompt_configs — this is what lets you
// tune the analysis behavior from the Supabase dashboard, no deploy needed.
async function getAnalysisPrompt() {
  if (!supabaseAdmin) return DEFAULT_ANALYSIS_PROMPT;
  const { data, error } = await supabaseAdmin.from('prompt_configs').select('prompt').eq('key', 'chat_analysis').single();
  if (error || !data) return DEFAULT_ANALYSIS_PROMPT;
  return data.prompt;
}

// Columns for the new report shape — kept in one place so the idempotent
// fast-path and the GET route can't drift apart.
const REPORT_COLUMNS = 'id, session_id, report_text, model_version, generated_at';

// Returns the existing report for a session, if one has been generated.
// 404 (not 200 with null) if none exists — the frontend uses this to
// decide whether to show "See report" or "Generate report".
router.get('/sessions/:id/report', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { data, error } = await supabaseAdmin
      .from('session_reports')
      .select(REPORT_COLUMNS)
      .eq('session_id', req.params.id)
      .eq('user_id', req.user.id) // ownership check
      .single();

    if (error || !data) return res.status(404).json({ error: 'No report yet for this session.' });
    res.json({ report: data });
  } catch (err) { next(err); }
});

// Generates (or returns the already-generated) report for one session.
// Synchronous — a single transcript is small enough that this finishes
// in a few seconds, so no job queue/polling is needed for this feature.
//
// CONCURRENCY / DOUBLE-CHARGE FIX:
// The OpenAI call below takes 10-20 seconds. During that window the
// report doesn't exist in the DB yet, so a second request for the SAME
// session (double-tap, or the user backing out of report.html and
// re-triggering "Generate" from chat.html/history.html before the first
// call finished) used to sail straight past the "does a report already
// exist?" fast-path below, then ALSO consume a trial/plan credit via
// requirePlan(), even though only one of the two ever ends up saved
// (session_reports.session_id is unique, so only the first INSERT can
// land) — net effect: 1 report, but 2-3 credits gone.
//
// Fixed by claiming the row atomically BEFORE requirePlan runs, using
// the exact same unique constraint that used to only protect the final
// INSERT: insert a bare placeholder row (session_id + user_id only,
// every report field left NULL) right away. Only one concurrent request
// can win that INSERT — Postgres guarantees it via the unique constraint
// on session_id. The loser gets a 23505 (unique_violation) and bails
// out immediately with a 409, having never called requirePlan or
// OpenAI. The winner later UPDATEs its own claimed row with the real
// report once OpenAI responds.
router.post('/sessions/:id/analyze', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Server misconfigured: OPENAI_API_KEY missing.' });

    const sessionId = req.params.id;

    // Fast-path: does a row already exist for this session?
    // A row here means one of two things — tell them apart by
    // report_text, which is NULL only on a still-in-progress claim row
    // and is ALWAYS a non-empty string on a completed report (see
    // safeReport below, which never leaves it null):
    //   - report_text set  -> a finished report. Return it as-is, no
    //     credit charged (this is the original idempotent fast-path).
    //   - report_text NULL -> someone else's request already claimed
    //     this session and is still waiting on OpenAI. Tell the caller
    //     to wait instead of starting a second, credit-burning attempt
    //     at the same report.
    const { data: existing } = await supabaseAdmin
      .from('session_reports')
      .select(REPORT_COLUMNS)
      .eq('session_id', sessionId)
      .eq('user_id', req.user.id)
      .single();
    if (existing) {
      if (existing.report_text) {
        return res.json({ report: existing, already_existed: true });
      }
      // Still-in-progress claim — unless it's old enough to be almost
      // certainly abandoned (server crashed mid-generation, see
      // STALE_CLAIM_MS above), in which case delete it and fall through
      // to claim it fresh instead of blocking this session forever.
      const claimAgeMs = Date.now() - new Date(existing.generated_at).getTime();
      if (claimAgeMs < STALE_CLAIM_MS) {
        return res.status(409).json({
          error: 'report_in_progress',
          message: 'Report already generate ho raha hai — thoda ruko.'
        });
      }
      console.warn(`[analyze] Reclaiming stale report claim for session ${sessionId} (${Math.round(claimAgeMs / 1000)}s old) — previous attempt likely crashed.`);
      await supabaseAdmin.from('session_reports').delete().eq('id', existing.id);
    }

    // Ownership + min-turns check ALSO happen before requirePlan below —
    // a request that was never going to succeed (wrong session, or too
    // few turns) shouldn't cost the user a trial credit either.
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, turn_count')
      .eq('id', sessionId)
      .eq('user_id', req.user.id)
      .single();
    if (sessionErr || !session) return res.status(404).json({ error: 'Session not found' });

    if (session.turn_count < MIN_TURNS_FOR_ANALYSIS) {
      return res.status(400).json({ error: `Session needs at least ${MIN_TURNS_FOR_ANALYSIS} turns to analyze (has ${session.turn_count}).` });
    }

    // ---- Atomic claim (see comment above the route for the full why) ----
    const { data: claim, error: claimErr } = await supabaseAdmin
      .from('session_reports')
      .insert({ session_id: sessionId, user_id: req.user.id })
      .select('id')
      .single();

    if (claimErr) {
      if (claimErr.code === '23505') { // unique_violation — someone else won the race
        return res.status(409).json({
          error: 'report_in_progress',
          message: 'Report already generate ho raha hai — thoda ruko.'
        });
      }
      return next(claimErr);
    }

    // Safety net: if ANYTHING below fails (requirePlan denies, OpenAI
    // errors, the final UPDATE fails) the claim row must not sit around
    // forever half-finished — that would permanently block this session
    // from ever getting a report (the unique constraint would reject
    // every future attempt). `reportSaved` flags the one success path
    // that should survive; every other way this response can finish
    // (including requirePlan's own res.status(402) denial, which never
    // calls next()) triggers cleanup here instead of needing a manual
    // delete() in every single failure branch below.
    let reportSaved = false;
    res.once('finish', () => {
      if (!reportSaved && res.statusCode >= 400) {
        supabaseAdmin.from('session_reports').delete().eq('id', claim.id)
          .then(() => {})
          .catch((e) => console.error('Failed to release report claim row after failure:', e));
      }
    });

    // All pre-checks (and the claim) passed — only NOW check plan/trial
    // access, right before the actual (paid) OpenAI call.
    requirePlan('report')(req, res, async () => {
      try {
        // Fetch user's profile — report ko sirf transcript se nahi, balki YE
        // user kaun hai (naam/age/profession/city/goal) usse bhi personalize
        // karna hai, bilkul waise hi jaise live chat persona ko bhi profile
        // pata hota hai.
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('name, age, occupation_type, class_grade, profession, city, goal, self_level')
          .eq('id', req.user.id)
          .single();

        const { data: messages, error: messagesErr } = await supabaseAdmin
          .from('chat_messages')
          .select('role, content, turn_index')
          .eq('session_id', sessionId)
          .order('turn_index', { ascending: true });
        if (messagesErr) return next(messagesErr);

        const transcript = messages.map(m => (m.role === 'user' ? 'User' : 'Bolo') + ': ' + m.content).join('\n');
        const systemPrompt = (await getAnalysisPrompt()) + buildPersonalizationBlock(profile);

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const model = ANALYSIS_MODEL;

        let rawText;
        try {
          const response = await openai.chat.completions.create({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: transcript }
            ]
            // No response_format here on purpose — the new prompt asks
            // for a natural free-text write-up, not JSON. Forcing a JSON
            // schema would fight that instruction.
          });
          rawText = response.choices[0].message.content;
        } catch (aiErr) {
          console.error('Analysis LLM call failed:', aiErr);
          return res.status(502).json({ error: 'Analysis failed — please try again.' });
        }

        // Defensive validation — never trust model output blindly. Cap
        // length so one weird/runaway response can't bloat the DB.
        const safeReport = {
          report_text: typeof rawText === 'string' ? rawText.trim().slice(0, 20000) : '',
          model_version: model,
          raw_response: { text: rawText }
        };

        if (!safeReport.report_text) {
          console.error('Analysis LLM returned empty content for session', sessionId);
          return res.status(502).json({ error: 'Analysis failed — please try again.' });
        }

        // UPDATE the claimed row (not insert) — the row already exists
        // (created by the claim step above), we're just filling it in.
        const { data: saved, error: saveErr } = await supabaseAdmin
          .from('session_reports')
          .update(safeReport)
          .eq('id', claim.id)
          .select(REPORT_COLUMNS)
          .single();

        if (saveErr) return next(saveErr);
        reportSaved = true;
        res.json({ report: saved, already_existed: false });
      } catch (err) { next(err); }
    });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.validateMessages = validateMessages; // exported for tests only
module.exports.validateSessionType = validateSessionType; // exported for tests only