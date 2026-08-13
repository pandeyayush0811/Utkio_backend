-- Run this once in Supabase Dashboard -> SQL Editor, after 006_scenario_simulation.sql.
-- Additive only — doesn't touch any existing table's existing columns or data.
--
-- WHY THIS EXISTS:
-- "Commit Mode" is a ₹121 plan (vs Starter's ₹99) with a built-in daily
-- accountability contract: every calendar day (IST), the user must do
-- BOTH (a) >= COMMIT_MODE_MIN_CHAT_SECONDS of freeform chat and (b) one
-- scenario session, before the day resets at 12:00 AM IST. Missing a day
-- TERMINATES the plan (not "cancels" — no refund, this is disclosed and
-- consented to up front). See lib/commitMode.js for the day-boundary and
-- completion logic, lib/commitModeEnforcer.js for the midnight sweep that
-- actually terminates missed days.
--
-- Deliberately a SEPARATE day-boundary concept from
-- lib/scenarioSelector.js's startOfUtcDay(): that one is UTC-midnight
-- (== 5:30 AM IST) and only governs "one scenario per day" for scenario
-- picking. Commit Mode's contract is explicitly "before 12 AM IST" per
-- the disclosed rules, so it MUST use real IST calendar days, not UTC
-- ones — conflating the two would silently give Commit Mode users an
-- extra 5.5 hours (or take away 5.5 hours) versus what was disclosed.

-- ═══════════════════════════════════════════════════════════════
-- PLAN STATE — extend the existing plan enum + add Commit Mode's own
-- termination bookkeeping on profiles (same "lives on profiles" rationale
-- as plan/plan_expires_at: one Commit Mode standing per user at a time).
-- ═══════════════════════════════════════════════════════════════

alter table profiles drop constraint if exists profiles_plan_check;
alter table profiles add constraint profiles_plan_check
  check (plan in ('none', 'starter', 'unlimited', 'commit_mode'));

alter table payments drop constraint if exists payments_plan_check;
alter table payments add constraint payments_plan_check
  check (plan in ('starter', 'unlimited', 'commit_mode'));

-- Set once the enforcer sweep terminates a Commit Mode membership for a
-- missed day. NULL means "never terminated" (currently active, or was a
-- normal plan that just expired/wasn't Commit Mode). Kept distinct from a
-- user-initiated cancellation (there isn't one — Commit Mode has no
-- early-exit path by design) so support/analytics can always tell apart
-- "ran its course", "still active", and "terminated for missing a day".
alter table profiles add column if not exists commit_mode_terminated_at timestamptz;
alter table profiles add column if not exists commit_mode_termination_reason text
  check (commit_mode_termination_reason in ('missed_daily_commitment') or commit_mode_termination_reason is null);

-- Explicit, timestamped proof that the pre-purchase disclosure card was
-- shown and acknowledged BEFORE the payment order was even created — the
-- legal/consent record this feature needs to exist independently of "the
-- frontend happened to render a modal". POST /payments/commit-mode/consent
-- writes this; POST /payments/create-order and /checkout/init both reject
-- plan=commit_mode unless a consent row newer than the last termination
-- (or first-ever) exists. One row per consent event, not per user, so a
-- user who does Commit Mode -> terminated -> Commit Mode again has two
-- separate consent records, each tied to its own purchase.
create table if not exists commit_mode_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  consented_at timestamptz not null default now(),
  disclosure_version text not null, -- bump this text whenever the disclosure copy changes materially
  -- consumed_by_payment_id is set once this consent is actually used to
  -- unlock a create-order/checkout call, so the SAME consent screen-view
  -- can't be silently reused to back a second, later purchase without the
  -- user seeing the rules again.
  consumed_by_payment_id uuid references payments(id) on delete set null
);

create index if not exists commit_mode_consents_user_id_idx on commit_mode_consents(user_id);
create index if not exists commit_mode_consents_unconsumed_idx on commit_mode_consents(user_id) where consumed_by_payment_id is null;

alter table commit_mode_consents enable row level security;

drop policy if exists "Users can view own commit_mode consents" on commit_mode_consents;
create policy "Users can view own commit_mode consents"
  on commit_mode_consents for select
  using (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════
-- DAILY PROGRESS — one row per user per IST calendar day, only while
-- plan = 'commit_mode'. Written incrementally as the user completes each
-- half of the day's requirement (freeform chat, scenario), then read (and
-- FROZEN — see lib/commitModeEnforcer.js) by the midnight sweep. A
-- dedicated table rather than deriving from chat_sessions on the fly
-- because the sweep needs a stable, single-write "final verdict" per day
-- that can't be retroactively changed by a late-arriving offline-sync'd
-- session claiming to belong to a day that's already been judged.
-- ═══════════════════════════════════════════════════════════════

create table if not exists commit_mode_daily_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  ist_date date not null, -- the IST calendar date this row is tracking
  chat_seconds_done int not null default 0, -- cumulative freeform chat duration this day, seconds
  chat_requirement_met boolean not null default false,
  scenario_requirement_met boolean not null default false,
  -- Set by the midnight sweep once this day is judged (pass or fail) and
  -- can never be written to again — see the trigger below. NULL = still
  -- today / not yet judged.
  judged_at timestamptz,
  judged_result text check (judged_result in ('met', 'missed') or judged_result is null),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, ist_date)
);

create index if not exists commit_mode_daily_progress_user_date_idx on commit_mode_daily_progress(user_id, ist_date);
-- Used by the enforcer sweep to find yesterday's unjudged rows across all users.
create index if not exists commit_mode_daily_progress_unjudged_idx on commit_mode_daily_progress(ist_date) where judged_at is null;

alter table commit_mode_daily_progress enable row level security;

drop policy if exists "Users can view own commit_mode progress" on commit_mode_daily_progress;
create policy "Users can view own commit_mode progress"
  on commit_mode_daily_progress for select
  using (auth.uid() = user_id);

-- Once judged_at is set, this row is a permanent verdict — block any
-- further UPDATE from the app layer even if a code bug or a
-- late/replayed request tries to touch it. The enforcer itself uses
-- supabaseAdmin and the WHERE judged_at is null guard (belt AND braces).
create or replace function commit_mode_progress_block_post_judge_update()
returns trigger as $$
begin
  if OLD.judged_at is not null then
    raise exception 'commit_mode_daily_progress row % already judged at % — cannot modify', OLD.id, OLD.judged_at;
  end if;
  NEW.updated_at := now();
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists commit_mode_progress_pre_update on commit_mode_daily_progress;
create trigger commit_mode_progress_pre_update
  before update on commit_mode_daily_progress
  for each row execute function commit_mode_progress_block_post_judge_update();

-- ═══════════════════════════════════════════════════════════════
-- record_commit_mode_progress(p_user_id, p_ist_date, p_kind, p_seconds)
--
-- Atomic upsert-and-mark, called right after a chat/scenario session is
-- saved (see routes/chatRoutes.js). p_kind is 'chat' or 'scenario'.
-- For 'chat', p_seconds is ADDED to the day's running total (a user might
-- do three 2-minute chats that together clear the 5-minute bar — the
-- requirement is cumulative minutes for the day, not one single session
-- of 5+ minutes) and chat_requirement_met flips true once the running
-- total crosses COMMIT_MODE_MIN_CHAT_SECONDS (passed in, not hardcoded in
-- SQL — single source of truth stays lib/commitMode.js). For 'scenario',
-- it's a flat true (one scenario session is always exactly enough).
--
-- Silently no-ops (does nothing, returns null) if the row is already
-- judged — belt-and-braces alongside the trigger above; a session synced
-- late for a day that's already been swept must never resurrect it.
-- ═══════════════════════════════════════════════════════════════
create or replace function record_commit_mode_progress(
  p_user_id uuid,
  p_ist_date date,
  p_kind text,
  p_seconds int default 0,
  p_min_chat_seconds int default 300
)
returns void as $$
begin
  if p_kind not in ('chat', 'scenario') then
    raise exception 'record_commit_mode_progress: p_kind must be chat or scenario, got %', p_kind;
  end if;

  insert into commit_mode_daily_progress (user_id, ist_date, chat_seconds_done, chat_requirement_met, scenario_requirement_met)
  values (
    p_user_id,
    p_ist_date,
    case when p_kind = 'chat' then greatest(p_seconds, 0) else 0 end,
    case when p_kind = 'chat' then greatest(p_seconds, 0) >= p_min_chat_seconds else false end,
    case when p_kind = 'scenario' then true else false end
  )
  on conflict (user_id, ist_date) do update
  set
    chat_seconds_done = commit_mode_daily_progress.chat_seconds_done
      + case when p_kind = 'chat' then greatest(p_seconds, 0) else 0 end,
    chat_requirement_met = case
      when p_kind = 'chat' then
        (commit_mode_daily_progress.chat_seconds_done + greatest(p_seconds, 0)) >= p_min_chat_seconds
      else commit_mode_daily_progress.chat_requirement_met
    end,
    scenario_requirement_met = case
      when p_kind = 'scenario' then true
      else commit_mode_daily_progress.scenario_requirement_met
    end
  where commit_mode_daily_progress.judged_at is null; -- no-op if already judged, per above
end;
$$ language plpgsql security definer;
