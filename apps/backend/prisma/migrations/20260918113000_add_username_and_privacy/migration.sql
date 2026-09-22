-- Hand-authored, not `prisma migrate dev`-generated: adding a required,
-- unique column to a table that may already have rows needs the
-- nullable -> backfill -> NOT NULL sequence below, which Prisma's
-- migration diffing does not produce automatically. See the feature's
-- final report for why this shape was chosen.

-- Step 1: add the column nullable so this runs safely against a `users`
-- table that already has rows.
ALTER TABLE "users" ADD COLUMN "username" TEXT;

-- Step 2: backfill every existing row with a technical, collision-
-- resistant placeholder derived ONLY from that row's own already-unique
-- id.
--
-- This is deliberately NOT an attempt to derive a "real" identity for
-- existing accounts. This schema has no email and no phone number, and
-- the only other candidate field, displayName, is optional, free-text,
-- not unique, and not validated against the username character set —
-- none of that is safe raw material to turn into a required, unique,
-- validated username without either risking a collision or silently
-- assigning someone an identity-looking value they never chose. Instead,
-- every existing account gets a placeholder built only from its id:
--
--   'user_' || first 20 lowercase-hex characters of the UUID (hyphens
--   removed)
--
-- The 'user_' prefix guarantees the "must start with a letter" rule;
-- every character after it is already lowercase hex (0-9a-f), which
-- satisfies "letters/digits only" and "must end in a letter or digit"
-- with no further transformation; and 20 hex characters is 80 bits of
-- entropy taken from a value already guaranteed unique per row, making a
-- collision between two backfilled rows astronomically unlikely
-- regardless of how many existing accounts there are. These are
-- placeholders their owners should be free to change, not derived
-- identities.
UPDATE "users"
SET "username" = 'user_' || substr(replace(id::text, '-', ''), 1, 20)
WHERE "username" IS NULL;

-- Step 3: now that every row has a value, enforce the real constraints.
-- Storage is always already-lowercased at the application layer (see
-- src/domain/username.ts's normalizeUsername, used on every write path),
-- so a plain unique index gives case-insensitive uniqueness with no
-- functional/expression index needed.
ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- Per-account privacy control for username search/discovery (see
-- src/users/users.service.ts). Defaults to true so no existing account's
-- current discoverability changes just because this column now exists —
-- this migration only adds the *ability* to opt out.
ALTER TABLE "user_settings" ADD COLUMN "usernameSearchEnabled" BOOLEAN NOT NULL DEFAULT true;
