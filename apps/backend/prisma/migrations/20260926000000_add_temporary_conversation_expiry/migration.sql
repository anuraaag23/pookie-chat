-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "temporaryCreatorUserId" TEXT;

-- CreateIndex
CREATE INDEX "conversations_expiresAt_idx" ON "conversations"("expiresAt");
