-- CreateEnum
CREATE TYPE "ConversationRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "conversation_requests" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "status" "ConversationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_requests_recipientId_status_createdAt_idx" ON "conversation_requests"("recipientId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_requests_senderId_recipientId_status_idx" ON "conversation_requests"("senderId", "recipientId", "status");

-- Partial Unique Index: at most ONE active PENDING request per sender and recipient
CREATE UNIQUE INDEX "unique_pending_conversation_request" ON "conversation_requests"("senderId", "recipientId") WHERE status = 'PENDING';

-- AddForeignKey
ALTER TABLE "conversation_requests" ADD CONSTRAINT "conversation_requests_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_requests" ADD CONSTRAINT "conversation_requests_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
