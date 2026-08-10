-- Run this once in Supabase Dashboard -> SQL Editor, after 004_trial_and_usage_limits.sql.
-- Safe to run even if 004 was already applied in production — this only
-- replaces the peek_access() function body, touches no tables/data.
--
-- BUG THIS FIXES:
-- peek_access()'s trial_active previously required BOTH chats_remaining
-- AND reports_remaining to be > 0. But consume_access() (the function
-- that actually gates access on every request) treats chat and report
-- credits as two fully independent counters — using up all 5 free
-- reports has no effect on whether a chat can still be started.
--
-- Consequence: GET /payments/status (which frontend uses to decide
-- whether to show the paywall) could report trial_active = false for a
-- user who still had free chats left, purely because they'd exhausted
-- their separate report credits (or vice versa) — a false paywall that
-- didn't match what consume_access would actually allow.
--
-- Fix: trial_active now only reflects whether the trial's time window
-- is still open (not paid, and within trial_days of trial_started_at).
-- Whether the user has chat/report credits left is exactly what
-- chats_remaining/reports_remaining already report separately — the
-- frontend/backend combine those with trial_active per-action, matching
-- how consume_access actually gates each action independently.

create or replace function peek_access(
  p_user_id uuid,
  p_trial_days int,
  p_trial_limit_chats int,
  p_trial_limit_reports int
) returns table(
  has_paid_plan boolean,
  trial_active boolean,
  trial_days_left numeric,
  chats_remaining int,
  reports_remaining int
) as $$
declare
  v_plan text;
  v_plan_expires timestamptz;
  v_trial_started timestamptz;
  v_chats_used int;
  v_reports_used int;
  v_paid boolean;
  v_trial_deadline timestamptz;
begin
  select plan, plan_expires_at, trial_started_at, trial_chats_used, trial_reports_used
  into v_plan, v_plan_expires, v_trial_started, v_chats_used, v_reports_used
  from profiles
  where id = p_user_id;

  if not found then
    return query select false, false, 0::numeric, 0, 0;
    return;
  end if;

  v_paid := v_plan is not null and v_plan <> 'none'
            and (v_plan_expires is null or v_plan_expires > now());

  if v_trial_started is null then
    return query select v_paid, false, 0::numeric, 0, 0;
    return;
  end if;

  v_trial_deadline := v_trial_started + make_interval(days => p_trial_days);

  return query select
    v_paid,
    -- trial_active = is the trial window itself still live (time-wise
    -- only). Credit exhaustion per action-type is reported separately
    -- via chats_remaining / reports_remaining, matching the fact that
    -- consume_access() gates 'chat' and 'report' completely
    -- independently — this flag must not conflate the two.
    (not v_paid) and now() <= v_trial_deadline,
    greatest(0, extract(epoch from (v_trial_deadline - now())) / 86400.0),
    greatest(0, p_trial_limit_chats - v_chats_used),
    greatest(0, p_trial_limit_reports - v_reports_used);
end;
$$ language plpgsql security definer set search_path = public stable;

revoke execute on function peek_access(uuid, int, int, int) from public, anon, authenticated;
grant execute on function peek_access(uuid, int, int, int) to service_role;
