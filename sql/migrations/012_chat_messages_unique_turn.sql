-- Run this once in Supabase Dashboard -> SQL Editor, after 011_lock_down_profiles_rls.sql.
-- Additive only — creates a unique index on (session_id, turn_index) to prevent
-- concurrent sync requests from inserting duplicate turns.

create unique index if not exists chat_messages_session_turn_idx
  on chat_messages (session_id, turn_index);
