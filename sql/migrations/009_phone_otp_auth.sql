-- Adds phone number support for OTP-based signup / login / password-reset.
--
-- Supabase's own auth.users.phone column already stores the verified phone
-- (set automatically when a user verifies via signInWithOtp/verifyOtp), so
-- this migration does NOT duplicate that as the source of truth. It only
-- mirrors it onto `profiles` for fast app-side lookups/joins (e.g. showing
-- masked phone in Settings) without needing service-role access to
-- auth.users from every route.
alter table profiles add column if not exists phone text;

-- Partial unique index (not a plain unique constraint) so multiple NULL
-- phones are allowed — a user who signed up with Google/email only may
-- never set a phone, and NULL <> NULL in Postgres uniqueness semantics,
-- but being explicit here documents that this is intentional, not an
-- oversight.
create unique index if not exists profiles_phone_unique_idx
  on profiles (phone) where phone is not null;

create index if not exists profiles_phone_idx on profiles (phone);
