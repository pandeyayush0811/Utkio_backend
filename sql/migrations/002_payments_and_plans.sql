-- Run this once in Supabase Dashboard -> SQL Editor, after schema.sql.
-- Additive only — doesn't touch any existing table's existing columns or data.

-- ═══════════════════════════════════════════════════════════════
-- PLAN STATE — lives on profiles, since there's exactly one active
-- plan per user at a time (not a many-to-many relationship).
-- ═══════════════════════════════════════════════════════════════

alter table profiles add column if not exists plan text not null default 'none'
  check (plan in ('none', 'starter', 'unlimited'));

-- NULL = no expiry (used for 'none', and could be used for a lifetime/
-- comped plan later). For 'starter', this is set to 30 days from the
-- last successful payment — see paymentRoutes.js. The app checks THIS
-- column (not the payments table) on every gated request, so it's the
-- single source of truth for "is this user currently allowed in".
alter table profiles add column if not exists plan_expires_at timestamptz;

create index if not exists profiles_plan_idx on profiles(plan);

-- ═══════════════════════════════════════════════════════════════
-- PAYMENTS — one row per Razorpay order. Starter is currently a
-- manually-renewed 30-day pass (user pays again when it expires), not
-- a Razorpay Subscription — simpler to build and debug for a v1 launch.
-- Upgrading to auto-renewing Subscriptions later doesn't require
-- changing this table's shape, just how rows get inserted.
-- ═══════════════════════════════════════════════════════════════

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  plan text not null check (plan in ('starter', 'unlimited')),
  amount_paise int not null,          -- Razorpay works in the smallest currency unit (paise, not rupees)
  currency text not null default 'INR',
  razorpay_order_id text not null unique,
  razorpay_payment_id text unique,    -- set once payment actually succeeds
  status text not null default 'created' check (status in ('created', 'paid', 'failed')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists payments_user_id_idx on payments(user_id);
create index if not exists payments_razorpay_order_id_idx on payments(razorpay_order_id);

alter table payments enable row level security;

drop policy if exists "Users can view own payments" on payments;
create policy "Users can view own payments"
  on payments for select
  using (auth.uid() = user_id);
-- Deliberately no insert/update/delete policy for regular users — rows
-- are only ever written by the backend via the service-role key (which
-- bypasses RLS entirely), never directly by a client. A user should
-- never be able to insert a fake "paid" row for themselves.

-- ═══════════════════════════════════════════════════════════════
-- WAITLIST — Unlimited (₹1199) isn't on sale yet, just collecting
-- interest. Kept as its own table (not a profiles column) since it's
-- temporary scaffolding that gets dropped once Unlimited actually
-- launches with real payment flow, not a permanent part of the user model.
-- ═══════════════════════════════════════════════════════════════

create table if not exists unlimited_waitlist (
  user_id uuid primary key references profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table unlimited_waitlist enable row level security;

drop policy if exists "Users can view own waitlist entry" on unlimited_waitlist;
create policy "Users can view own waitlist entry"
  on unlimited_waitlist for select
  using (auth.uid() = user_id);
