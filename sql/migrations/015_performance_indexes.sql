-- Migration 015: Performance Indexes & Security Definer Hardening
-- Run this once in Supabase Dashboard -> SQL Editor, after 014_add_trial_scenarios_used.sql.

-- 1. Index on session_reports(session_id) for instant O(1) report lookups (refs ISSUE #5)
create index if not exists idx_session_reports_session_id
  on session_reports (session_id);

-- 2. Composite index on chat_sessions(user_id, started_at DESC) for instant history queries (refs ISSUE #14)
create index if not exists idx_chat_sessions_user_started
  on chat_sessions (user_id, started_at desc);

-- 3. Composite index on payments(user_id, status, created_at DESC) for user receipts & reconciliation queries
create index if not exists idx_payments_user_status_created
  on payments (user_id, status, created_at desc);

-- 4. Dynamic Security Definer search_path hardening (refs ISSUE #18)
-- Dynamically queries pg_proc for all SECURITY DEFINER functions in the public schema
-- and locks their search_path to public to prevent search-path escalation attacks.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as func_signature
    from pg_proc p
    join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'public'
      and p.prosecdef = true
  loop
    execute format('alter function %s set search_path = public', r.func_signature);
  end loop;
end $$;
