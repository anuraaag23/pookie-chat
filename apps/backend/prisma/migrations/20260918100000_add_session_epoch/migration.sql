-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "sessionEpoch" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "pending_handshakes" ADD COLUMN "sessionEpoch" INTEGER NOT NULL;
