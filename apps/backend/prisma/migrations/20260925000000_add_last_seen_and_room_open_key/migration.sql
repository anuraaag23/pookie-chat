-- AlterTable
ALTER TABLE "user_settings" ADD COLUMN "lastSeenEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "rooms" ADD COLUMN "openKeyCiphertext" BYTEA,
ADD COLUMN "openKeyNonce" BYTEA;
