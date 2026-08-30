-- Run this once in Supabase Dashboard -> SQL Editor, after 016_fix_trial_started_at_null_fallback.sql.
-- Additive only — doesn't break or alter existing columns or rows.
--
-- FEATURE: Incomplete Scenario Report Gating & Resumption (AUD-031).
--
-- Distinguishes in-progress / paused scenario roleplay sessions from fully completed ones.
-- Defaults to true so that all historical freeform and finished scenario sessions remain valid.

alter table chat_sessions add column if not exists is_completed boolean not null default true;

-- Composite index to optimize queries filtering by completion status
create index if not exists chat_sessions_user_completed_idx
  on chat_sessions(user_id, session_type, is_completed);
