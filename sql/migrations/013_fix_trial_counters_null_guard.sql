-- Run this once in Supabase Dashboard -> SQL Editor, after 012_chat_messages_unique_turn.sql.
-- Hardens consume_access and peek_access RPC functions with COALESCE guards
-- against NULL trial counter values.

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

  select
    plan,
    plan_expires_at,
    trial_started_at,
    case when p_kind = 'chat' then coalesce(trial_chats_used, 0) else coalesce(trial_reports_used, 0) end
  into v_plan, v_plan_expires, v_trial_started, v_used
  from profiles
  where id = p_user_id
  for update;

  if not found then
    return query select false, 'user_not_found';
    return;
  end if;

  if v_plan is not null and v_plan <> 'none'
     and (v_plan_expires is null or v_plan_expires > now()) then
    return query select true, 'paid_plan';
    return;
  end if;

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
    update profiles set trial_chats_used = coalesce(trial_chats_used, 0) + 1 where id = p_user_id;
  else
    update profiles set trial_reports_used = coalesce(trial_reports_used, 0) + 1 where id = p_user_id;
  end if;

  return query select true, 'trial_ok';
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function consume_access(uuid, text, int, int) from public, anon, authenticated;
grant execute on function consume_access(uuid, text, int, int) to service_role;

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
  select plan, plan_expires_at, trial_started_at, coalesce(trial_chats_used, 0), coalesce(trial_reports_used, 0)
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
    (not v_paid) and now() <= v_trial_deadline,
    greatest(0, extract(epoch from (v_trial_deadline - now())) / 86400.0),
    greatest(0, p_trial_limit_chats - v_chats_used),
    greatest(0, p_trial_limit_reports - v_reports_used);
end;
$$ language plpgsql security definer set search_path = public stable;

revoke execute on function peek_access(uuid, int, int, int) from public, anon, authenticated;
grant execute on function peek_access(uuid, int, int, int) to service_role;
