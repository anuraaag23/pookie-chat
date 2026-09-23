-- AlterTable
ALTER TABLE "pairing_codes" ADD COLUMN "codeText" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "unique_active_forever_code_per_creator" ON "pairing_codes" ("creatorUserId") WHERE "expiresAt" IS NULL AND "status" = 'ACTIVE';

