-- Tracks when a username was last changed, for the 365-day
-- once-per-year cooldown enforced in AuthService.changeUsername. Unlike
-- the earlier username migration, this needs no backfill step: NULL is
-- itself a valid, correct value here ("this account has never changed
-- its username since registration or the earlier backfill" — which is
-- true for every existing row), not a placeholder standing in for
-- missing data.
ALTER TABLE "users" ADD COLUMN "usernameChangedAt" TIMESTAMP(3);
