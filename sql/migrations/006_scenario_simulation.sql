-- Run this once in Supabase Dashboard -> SQL Editor, after 005_fix_peek_access_trial_active.sql.
-- Additive only — doesn't touch any existing table's existing columns or data.
--
-- FEATURE: Daily 3-Minute Real-Life Scenario Simulation.
--
-- Deliberately reuses chat_sessions/chat_messages instead of a parallel
-- table set: a scenario run is still "a voice session with a transcript",
-- and piggy-backing on the existing tables means it gets History display,
-- trial/plan credit metering (requirePlan('chat')), and the crash-safe
-- local-write-batch-sync (POST /chat/sessions) for free, with zero new
-- billing logic. The only new things it actually needs are (a) knowing
-- which scenario ran, and (b) enforcing the once-per-day rule.

-- ═══════════════════════════════════════════════════════════════
-- chat_sessions: tag which "kind" of session this was, and which
-- scenario (if any) it was. Both nullable-safe: every existing row
-- implicitly becomes session_type='freeform', scenario_key=null.
-- ═══════════════════════════════════════════════════════════════

alter table chat_sessions add column if not exists session_type text not null default 'freeform'
  check (session_type in ('freeform', 'scenario'));

alter table chat_sessions add column if not exists scenario_key text; -- references scenario_configs.key when session_type='scenario', else null

-- Powers "has this user already done today's scenario?" (GET
-- /chat/scenario/today) — filters by user_id + session_type, then range-
-- scans on started_at, so this composite index carries the whole query.
create index if not exists chat_sessions_user_scenario_idx
  on chat_sessions(user_id, session_type, started_at)
  where session_type = 'scenario';

-- ═══════════════════════════════════════════════════════════════
-- scenario_configs — the scenario library. Editable from the Supabase
-- dashboard directly (same "tune without a deploy" pattern as
-- prompt_configs.chat_analysis), so new scenarios or prompt tweaks never
-- need a code deploy.
-- ═══════════════════════════════════════════════════════════════

create table if not exists scenario_configs (
  key text primary key,               -- stable identifier, e.g. 'directions_stranger' — never reuse/rename once shipped, old chat_sessions.scenario_key rows point at it
  category text not null,             -- groups related scenarios for display (History/report labeling)
  title text not null,                -- shown in the UI, e.g. "Asking a stranger for directions"
  character_brief text not null,      -- who the AI is playing + the situation — fed into the phase-1 (roleplay) system prompt
  opening_situation text not null,    -- 1-2 lines describing how/where the scene starts, used to generate a dynamic (non-hardcoded) opening line
  active boolean not null default true, -- flip off to retire a scenario from the daily rotation without deleting history that references it
  sort_order int not null default 0,  -- deterministic rotation order (see lib/scenarioSelector.js) — lower first
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists scenario_configs_active_idx on scenario_configs(active, sort_order);

-- Seed the 8 categories from the spec. Text is intentionally in
-- Hindi/Hinglish for character_brief/opening_situation (these get folded
-- into the Hinglish system-prompt style already used in chat.html), but
-- title stays in English since it's shown as a UI label.
insert into scenario_configs (key, category, title, character_brief, opening_situation, sort_order) values
  ('directions_stranger', 'directions', 'Asking a stranger for directions',
   'Tum ek random raahgir (stranger) ho kisi shehar ki sadak par — sirf English aati hai, koi bhi doosri bhasha (Hindi ho ya koi aur) bilkul nahi samajh aati. Tumhe pata hai kuch nearby jagah (station/mall/hospital) tak ka raasta.',
   'User se tum khud pehle baat shuru karoge — jaise koi genuinely apna raasta poochta hai ya user se raasta poochta hai. Scene: ek busy sadak/junction.',
   1),
  ('cab_driver', 'transport', 'Talking to a cab/auto driver',
   'Tum ek cab ya auto driver ho jisko sirf English aati hai. User tumhari cab mein baitha hai ya baithne wala hai.',
   'User cab book kar chuka hai ya abhi ruk ke poochta hai — tum destination confirm karte ho aur casual baat karte ho safar ke dauran.',
   2),
  ('restaurant_order', 'dining', 'Ordering food at a restaurant',
   'Tum ek waiter/waitress ho ek restaurant mein jisko sirf English aati hai. User table par baitha hai order dene ke liye.',
   'Tum menu leke user ke table par aate ho aur order poochte ho.',
   3),
  ('shop_bargaining', 'shopping', 'Bargaining at a shop',
   'Tum ek dukaandar/shopkeeper ho jisko sirf English aati hai. User kuch khareedna chahta hai aur price kam karwana chahta hai.',
   'User dukaan mein ek item dekh raha hai — tum price bata ke baat shuru karte ho.',
   4),
  ('office_smalltalk', 'workplace', 'Small talk with a colleague',
   'Tum ek office colleague ho jisko sirf English aati hai. Break room ya desk ke paas casual baat ho rahi hai.',
   'Tum casually user ke paas aake kuch halka-fulka poochte ho — weekend, kaam, ya coffee.',
   5),
  ('complaint', 'service', 'Making a complaint',
   'Tum ek customer service/front-desk person ho jisko sirf English aati hai. User ko kisi cheez (order, service, product) se dikkat hai.',
   'User complaint leke tumhare paas aata hai — tum poochte ho kya problem hai.',
   6),
  ('mini_interview', 'professional', 'A short interview-style conversation',
   'Tum ek interviewer ho (job ya college admission jaisa kuch) jisko sirf English aati hai. Casual par thoda formal tone.',
   'Tum user ko welcome karte ho aur ek simple opening question poochte ho apne baare mein batane ke liye.',
   7),
  ('casual_stranger', 'social', 'Casual conversation with a stranger',
   'Tum ek random stranger ho — kahin bhi mil sakte ho (park, waiting area, flight/train ka co-passenger) — sirf English aati hai.',
   'Tum casually baat shuru karte ho kisi chhoti si cheez pe (weather, wait time, jagah) jo natural lage.',
   8)
on conflict (key) do nothing; -- seed once; re-running this file must never clobber dashboard edits to existing rows
