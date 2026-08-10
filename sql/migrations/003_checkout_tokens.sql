-- Run this once in Supabase Dashboard -> SQL Editor, after 002_payments_and_plans.sql.
-- Additive only — doesn't touch any existing table's existing columns or data.
--
-- WHY THIS TABLE EXISTS:
-- Razorpay's checkout widget doesn't work reliably inside a Capacitor
-- WebView (fraud-detection scripts get blocked, UPI app-switch-and-return
-- deep linking breaks, bank OTP redirect pages can't host properly).
-- The fix is to run checkout in the SYSTEM BROWSER instead (Chrome Custom
-- Tabs) — but the system browser is a completely separate browsing
-- context from the app's WebView, so it has no access to the user's
-- Supabase session sitting in the WebView's localStorage.
--
-- checkout_tokens bridges that gap: while the user is still authenticated
-- inside the app, the app asks the backend to mint one of these — a
-- random, single-use, short-lived token tied to a specific pending
-- payment. That token (not the user's real session token) is the only
-- thing passed to the system browser, via the checkout URL's query
-- string. The hosted checkout page uses it to fetch order details and
-- confirm payment, then it's burned.

create table if not exists checkout_tokens (
  token text primary key,
  payment_id uuid not null references payments(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists checkout_tokens_payment_id_idx on checkout_tokens(payment_id);

-- RLS enabled for defense-in-depth, but note this table is only ever
-- read/written by the backend via the service-role key (which bypasses
-- RLS) — the hosted checkout.html page is unauthenticated by design (it
-- can't send a Supabase Bearer token, that's the whole problem this
-- table solves), so it never talks to Supabase directly, only to your
-- own backend routes, which apply their own token-validity checks
-- (expiry + single-use) in application code.
alter table checkout_tokens enable row level security;
-- No policies defined => no direct client access at all, by anyone,
-- under any key except the service role. That's intentional here.

-- Cheap periodic cleanup — safe to run manually/on a cron. Not required
-- for correctness (expired/used tokens are already rejected by the
-- application code), just housekeeping.
-- delete from checkout_tokens where expires_at < now() - interval '1 day';
