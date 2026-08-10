-- Run this once in Supabase Dashboard -> SQL Editor, after 003_checkout_tokens.sql.
-- Additive only — doesn't touch any existing table's existing columns or data.
--
-- WHY THIS EXISTS:
-- Today `requirePlan` is a pure binary gate: paid (starter/unlimited) = full
-- access, unpaid = zero access. There is no free trial, so a brand-new
-- signup hits the paywall before ever using the product, and there's no
-- metering at all on the two backend calls that actually cost money
-- (POST /chat/sessions save + POST /chat/sessions/:id/analyze — the voice
-- chat itself is BYOK, device-to-Gemini, and never touches this server).
--
-- This migration adds a time+count-boxed FREE TRIAL:
--   - 3 days from signup (TRIAL_DAYS, enforced in code — see limits.js)
--   - up to 5 saved chat sessions (TRIAL_CHAT_LIMIT)
--   - up to 5 analyze/report calls, which also produce the per-chat quiz
--     in the same call (TRIAL_REPORT_LIMIT)
--
-- Paid plans (starter/unlimited) remain uncapped, exactly as today —
-- `profiles.plan` + `plan_expires_at` stay the single source of truth for
-- "is this user's paid access currently active". Trial columns are only
-- ever consulted when plan = 'none' (or expired).
--
-- Reading existing report/quiz data (GET /chat/sessions/:id/report,
-- history, mistakes review) is NOT gated by any of this and never was —
-- those are free reads of data already paid for once at generation time.

-- ═══════════════════════════════════════════════════════════════
-- TRIAL STATE — lives on profiles for the same reason plan does: one
-- trial per user, not a many-to-many relationship.
-- ═══════════════════════════════════════════════════════════════

alter table profiles add column if not exists trial_started_at timestamptz;
alter table profiles add column if not exists trial_chats_used int not null default 0;
alter table profiles add column if not exists trial_reports_used int not null default 0;

-- Backfill: every existing row (new columns default to NULL/0 above) gets
-- its trial clock started NOW, not backdated to their original signup —
-- so nobody who was already using the app unmetered gets silently locked
-- out the instant this migration runs. Remove/adjust this UPDATE if you'd
-- rather grandfather existing users with a different rule (e.g. treat
-- everyone who already has plan <> 'none' history as trial-exempt).
update profiles
set trial_started_at = now()
where trial_started_at is null;

-- New signups get trial_started_at set the moment their profile row is
-- created (see lib/supabaseClient.js profile-creation path / onboarding),
-- but default it here too as a safety net so it's never left NULL.
alter table profiles alter column trial_started_at set default now();

create index if not exists profiles_trial_started_at_idx on profiles(trial_started_at);

-- ═══════════════════════════════════════════════════════════════
-- consume_access(p_user_id, p_kind, p_trial_days, p_trial_limit)
--
-- Single atomic check-and-increment, run under a row lock (`for update`)
-- so two concurrent requests from the same user can never both slip
-- through when exactly 1 credit is left (classic TOCTOU race that a
-- separate "select count" + "update" from application code would have).
--
-- p_kind is 'chat' or 'report' — each has its own independent counter,
-- per product requirement (5 free chats AND 5 free reports, not a
-- shared pool).
--
-- Returns a single row: (allowed boolean, reason text). Reason is not
-- shown to the user verbatim — the calling middleware maps it to a
-- friendly message — but it's useful in logs/tests to know WHY a
-- request was allowed or denied (paid plan vs trial credit vs expired).
-- ═══════════════════════════════════════════════════════════════
create or replace function consume_access(
  p_user_id uuid,
  p_kind text,
  p_trial_days int,
  p_trial_limit int
) returns table(allowed boolean, reason text) as $$
declare
  v_plan text;
  v_plan_expires timestamptz;
  v_trial_started timestamptz;
  v_used int;
begin
  if p_kind not in ('chat', 'report') then
    raise exception 'consume_access: p_kind must be ''chat'' or ''report'', got %', p_kind;
  end if;

  -- Row lock: any other consume_access() call for this same user blocks
  -- here until this transaction commits/rolls back. Different users
  -- never contend with each other (lock is per primary-key row).
  select
    plan,
    plan_expires_at,
    trial_started_at,
    case when p_kind = 'chat' then trial_chats_used else trial_reports_used end
  into v_plan, v_plan_expires, v_trial_started, v_used
  from profiles
  where id = p_user_id
  for update;

  if not found then
    return query select false, 'user_not_found';
    return;
  end if;

  -- Active paid plan => always allowed, trial counters untouched.
  if v_plan is not null and v_plan <> 'none'
     and (v_plan_expires is null or v_plan_expires > now()) then
    return query select true, 'paid_plan';
    return;
  end if;

  -- No trial clock somehow (shouldn't happen post-migration, but a
  -- fresh row inserted with an explicit NULL would hit this) — treat as
  -- not yet started rather than silently granting access.
  if v_trial_started is null then
    return query select false, 'trial_not_started';
    return;
  end if;

  if now() > v_trial_started + make_interval(days => p_trial_days) then
    return query select false, 'trial_expired';
    return;
  end if;

  if v_used >= p_trial_limit then
    return query select false, 'trial_limit_reached';
    return;
  end if;

  if p_kind = 'chat' then
    update profiles set trial_chats_used = trial_chats_used + 1 where id = p_user_id;
  else
    update profiles set trial_reports_used = trial_reports_used + 1 where id = p_user_id;
  end if;

  return query select true, 'trial_ok';
end;
$$ language plpgsql security definer set search_path = public;

-- security definer so the row lock + increment always succeeds regardless
-- of caller role — but note this function is only ever invoked by the
-- backend via supabaseAdmin (service role), same trust boundary as every
-- other write in this codebase. It is deliberately NOT exposed to the
-- anon/authenticated Postgres roles.
revoke execute on function consume_access(uuid, text, int, int) from public, anon, authenticated;
grant execute on function consume_access(uuid, text, int, int) to service_role;

-- ═══════════════════════════════════════════════════════════════
-- peek_access(p_user_id, p_trial_days, p_trial_limit_chats, p_trial_limit_reports)
--
-- Read-only companion to consume_access — used by GET /payments/status
-- so the frontend can show "3 of 5 free chats left" without consuming
-- anything or taking a lock. No side effects, safe to call as often as
-- the UI wants.
-- ═══════════════════════════════════════════════════════════════
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
    -- FIX: trial_active must mean "is the trial window itself still
    -- live" (time-wise), NOT "does the user have credits left in
    -- BOTH independent counters". consume_access() gates chat and
    -- report access completely independently (see its comment above),
    -- so a user who has used all 5 free reports but 0 of 5 free chats
    -- can still successfully consume_access('chat') — this flag must
    -- agree with that, or GET /payments/status shows a paywall for a
    -- user who can actually still start a free chat right now.
    (not v_paid) and now() <= v_trial_deadline,
    greatest(0, extract(epoch from (v_trial_deadline - now())) / 86400.0),
    greatest(0, p_trial_limit_chats - v_chats_used),
    greatest(0, p_trial_limit_reports - v_reports_used);
end;
$$ language plpgsql security definer set search_path = public stable;

revoke execute on function peek_access(uuid, int, int, int) from public, anon, authenticated;
grant execute on function peek_access(uuid, int, int, int) to service_role;