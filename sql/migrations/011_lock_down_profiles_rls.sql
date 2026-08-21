-- Migration 011: Lock Down Profiles Row Level Security (RLS)
--
-- Drops the unrestricted "Users can update own profile" policy on profiles.
--
-- WHY:
-- The profiles table holds sensitive billing and quota columns (plan,
-- plan_expires_at, trial_chats_used, trial_reports_used, commit_mode_status).
-- Since the frontend always communicates through the Express API backend
-- (which performs updates via the service-role client supabaseAdmin),
-- keeping a direct UPDATE policy for authenticated users exposed a vulnerability
-- where any user could bypass the backend paywall and patch their own row
-- directly via Supabase PostgREST REST API.
--
-- Dropping this policy completely locks down profiles writes to service-role
-- backend operations only, protecting billing and usage counters.

drop policy if exists "Users can update own profile" on profiles;
