-- Migration 010: Safe Unverified Phone Handling
--
-- Drops the strict unique index on unverified phone numbers to prevent
-- registration Denial-of-Service / account collision vulnerabilities.
-- Retains the standard non-unique index for fast profile queries.

drop index if exists profiles_phone_unique_idx;

create index if not exists profiles_phone_idx on profiles (phone);
