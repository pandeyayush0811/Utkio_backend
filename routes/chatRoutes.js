const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { requirePlan } = require('../middleware/requirePlan');
const { supabaseAdmin } = require('../lib/supabaseClient');
const OpenAI = require('openai');

const MIN_TURNS_FOR_ANALYSIS = 10; // matches the frontend's button-enable threshold

const MAX_MESSAGES_PER_SESSION = 500; // sanity cap — a normal session is a few dozen turns

// Configurable via env so this can be swapped (e.g. if OpenAI deprecates
// gpt-4.1, or you want to A/B a different model) without a code change +
// redeploy — just update ANALYSIS_MODEL in the environment and restart.
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || 'gpt-4.1';

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
      .select('id, started_at, ended_at, turn_count, created_at')
      .eq('user_id', req.user.id)
      .order('started_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

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

    if (messagesErr) return res.status(500).json({ error: messagesErr.message });

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

// Called once a voice session ends (or on app-open recovery for a
// session that never made it to the backend last time). Two modes:
//   - No session_id  -> creates a brand new session (turn_index starts at 0)
//   - session_id set -> RESUME: appends these turns to an existing
//                        session (turn_index continues where it left off,
//                        ended_at + turn_count get updated)
router.post('/sessions', requireAuth, requirePlan('chat'), async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { session_id, started_at, ended_at, messages } = req.body;

    if (!started_at || isNaN(Date.parse(started_at))) return res.status(400).json({ error: 'started_at must be a valid ISO timestamp' });
    if (!ended_at || isNaN(Date.parse(ended_at))) return res.status(400).json({ error: 'ended_at must be a valid ISO timestamp' });
    const msgError = validateMessages(messages);
    if (msgError) return res.status(400).json({ error: msgError });

    // ---- Resume mode: append to an existing session ----
    if (session_id) {
      const { data: existing, error: existErr } = await supabaseAdmin
        .from('chat_sessions')
        .select('id, turn_count')
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

      const { error: insertErr } = await supabaseAdmin.from('chat_messages').insert(rows);
      if (insertErr) return res.status(500).json({ error: insertErr.message });

      const newTurnCount = startIndex + rows.length;
      const { error: updateErr } = await supabaseAdmin
        .from('chat_sessions')
        .update({ ended_at, turn_count: newTurnCount })
        .eq('id', session_id);

      if (updateErr) return res.status(500).json({ error: updateErr.message });

      return res.json({ session_id, turn_count: newTurnCount });
    }

    // ---- Normal mode: brand new session ----
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('chat_sessions')
      .insert({ user_id: req.user.id, started_at, ended_at, turn_count: messages.length })
      .select()
      .single();

    if (sessionErr) return res.status(500).json({ error: sessionErr.message });

    const rows = messages.map((m, i) => ({ session_id: session.id, role: m.role, content: m.content.trim(), turn_index: i }));
    const { error: messagesErr } = await supabaseAdmin.from('chat_messages').insert(rows);

    if (messagesErr) {
      await supabaseAdmin.from('chat_sessions').delete().eq('id', session.id); // don't leave an orphaned empty session
      return res.status(500).json({ error: messagesErr.message });
    }

    res.json({ session_id: session.id, turn_count: rows.length });
  } catch (err) { next(err); }
});

// Called from Settings -> "Clear all chat history". Deletes every session
// for this user; chat_messages cascade-delete automatically (foreign key
// has ON DELETE CASCADE), so we only need to touch chat_sessions here.
router.delete('/sessions', requireAuth, async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });

    const { error } = await supabaseAdmin.from('chat_sessions').delete().eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Response schema the model must conform to — structured output means no
// parsing guesswork and no risk of the model wandering into free-form
// prose that's hard to render or reason about safely.
// (Plain JSON Schema, used with OpenAI's response_format: json_schema.)
// NOTE: this must stay in lockstep with the `chat_analysis` prompt in
// prompt_configs — if you change the prompt's expected fields, update
// this schema (and the safeReport sanitizer + SQL columns below) too.
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    opening_line: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    mistakes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          occurred_count: { type: 'integer' },
          context: { type: 'string' },
          reason: { type: 'string' },
          examples: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                hindi: { type: 'string' },
                wrong_english: { type: 'string' },
                correct_english: { type: 'string' }
              },
              required: ['hindi', 'wrong_english', 'correct_english'],
              additionalProperties: false
            }
          }
        },
        required: ['title', 'occurred_count', 'context', 'reason', 'examples'],
        additionalProperties: false
      }
    },
    growth_note: { type: 'string' },
    focus_next: { type: 'string' },
    // 1-10 — a single glanceable number for the top of the report /
    // share card. Keeps the report from being 100% text.
    confidence_score: { type: 'integer' },
    // Turn-immediately-after-session quiz, generated in the SAME call so
    // it's grounded in this session's actual mistakes — no extra LLM
    // round trip. Every question object carries all possible fields;
    // irrelevant ones are "" / [] / false for that question's type (kept
    // flat on purpose — strict structured-output schemas don't handle
    // polymorphic/union shapes well).
    quiz: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          // yes_no: judge if `sentence` is correct (swipe right/left).
          // choose_3: pick the correct one of 3 `options`.
          // hindi_to_english: `hindi` shown, pick correct of 3 `options`.
          // speak: user must SPEAK `expected_answer` out loud.
          type: { type: 'string', enum: ['yes_no', 'choose_3', 'hindi_to_english', 'speak'] },
          prompt: { type: 'string' }, // the instruction line shown above the card
          sentence: { type: 'string' }, // yes_no: the English sentence to judge
          hindi: { type: 'string' }, // hindi_to_english / speak: the Hindi thought
          options: { type: 'array', items: { type: 'string' } }, // choose_3 / hindi_to_english: exactly 3
          correct_option: { type: 'string' }, // choose_3 / hindi_to_english: must exactly match one option
          is_correct: { type: 'boolean' }, // yes_no: whether `sentence` is actually correct
          expected_answer: { type: 'string' } // speak: the correct English the user should say
        },
        required: ['type', 'prompt', 'sentence', 'hindi', 'options', 'correct_option', 'is_correct', 'expected_answer'],
        additionalProperties: false
      }
    }
  },
  required: ['opening_line', 'strengths', 'mistakes', 'growth_note', 'focus_next', 'confidence_score', 'quiz'],
  additionalProperties: false
};

// Only used if prompt_configs is unreachable/misconfigured — the real
// prompt always comes from the DB (see getAnalysisPrompt below).
const DEFAULT_ANALYSIS_PROMPT = 'You are a warm, encouraging English mentor. Analyze the USER\'s English only (ignore the assistant\'s lines) and return structured JSON matching the given schema.';

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
const REPORT_COLUMNS = 'id, session_id, opening_line, strengths, mistakes, growth_note, focus_next, confidence_score, quiz, generated_at';

const QUIZ_TYPES = new Set(['yes_no', 'choose_3', 'hindi_to_english', 'speak']);

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
router.post('/sessions/:id/analyze', requireAuth, requirePlan('report'), async (req, res, next) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing.' });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Server misconfigured: OPENAI_API_KEY missing.' });

    const sessionId = req.params.id;

    // Idempotent: if a report already exists, just return it instead of
    // burning another paid API call (also enforced by the DB's unique
    // constraint on session_id, this is just the friendly fast-path).
    const { data: existing } = await supabaseAdmin
      .from('session_reports')
      .select(REPORT_COLUMNS)
      .eq('session_id', sessionId)
      .eq('user_id', req.user.id)
      .single();
    if (existing) return res.json({ report: existing, already_existed: true });

    // Ownership + fetch messages.
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
    if (messagesErr) return res.status(500).json({ error: messagesErr.message });

    const transcript = messages.map(m => (m.role === 'user' ? 'User' : 'Bolo') + ': ' + m.content).join('\n');
    const systemPrompt = (await getAnalysisPrompt()) + buildPersonalizationBlock(profile);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = ANALYSIS_MODEL;

    let parsed;
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: transcript }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'analysis_report', schema: ANALYSIS_SCHEMA, strict: true }
        }
      });
      parsed = JSON.parse(response.choices[0].message.content);
    } catch (aiErr) {
      console.error('Analysis LLM call failed:', aiErr);
      return res.status(502).json({ error: 'Analysis failed — please try again.' });
    }

    // Defensive validation — never trust model output blindly, even with
    // a schema. Cap array/string sizes so one weird response can't bloat
    // the DB. Field names here MUST match ANALYSIS_SCHEMA above.
    const safeReport = {
      session_id: sessionId,
      user_id: req.user.id,
      opening_line: typeof parsed.opening_line === 'string' ? parsed.opening_line.slice(0, 500) : '',
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 15).map(s => String(s).slice(0, 300)) : [],
      mistakes: Array.isArray(parsed.mistakes) ? parsed.mistakes.slice(0, 20).map(m => ({
        title: String(m.title || '').slice(0, 200),
        occurred_count: Number.isInteger(m.occurred_count) && m.occurred_count >= 0 ? m.occurred_count : 1,
        context: String(m.context || '').slice(0, 1000),
        reason: String(m.reason || '').slice(0, 500),
        examples: Array.isArray(m.examples) ? m.examples.slice(0, 6).map(e => ({
          hindi: String(e.hindi || '').slice(0, 400),
          wrong_english: String(e.wrong_english || '').slice(0, 400),
          correct_english: String(e.correct_english || '').slice(0, 400)
        })) : []
      })) : [],
      growth_note: typeof parsed.growth_note === 'string' ? parsed.growth_note.slice(0, 1000) : '',
      focus_next: typeof parsed.focus_next === 'string' ? parsed.focus_next.slice(0, 1000) : '',
      confidence_score: Number.isInteger(parsed.confidence_score)
        ? Math.min(10, Math.max(1, parsed.confidence_score))
        : 5,
      quiz: Array.isArray(parsed.quiz) ? parsed.quiz.slice(0, 10).map(q => ({
        type: QUIZ_TYPES.has(q.type) ? q.type : 'yes_no',
        prompt: String(q.prompt || '').slice(0, 300),
        sentence: String(q.sentence || '').slice(0, 300),
        hindi: String(q.hindi || '').slice(0, 300),
        options: Array.isArray(q.options) ? q.options.slice(0, 3).map(o => String(o).slice(0, 200)) : [],
        correct_option: String(q.correct_option || '').slice(0, 200),
        is_correct: typeof q.is_correct === 'boolean' ? q.is_correct : false,
        expected_answer: String(q.expected_answer || '').slice(0, 300)
      })) : [],
      model_version: model,
      raw_response: parsed
    };

    const { data: saved, error: saveErr } = await supabaseAdmin
      .from('session_reports')
      .insert(safeReport)
      .select(REPORT_COLUMNS)
      .single();

    if (saveErr) return res.status(500).json({ error: saveErr.message });
    res.json({ report: saved, already_existed: false });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.validateMessages = validateMessages; // exported for tests only