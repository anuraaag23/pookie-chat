-- CreateEnum
CREATE TYPE "RoomJoinPolicy" AS ENUM ('OPEN', 'APPROVAL_REQUIRED');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('ACTIVE', 'CLOSED', 'DELETED');

-- CreateEnum
CREATE TYPE "RoomMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "RoomJoinRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "codeHmac" TEXT NOT NULL,
    "codeText" TEXT,
    "joinPolicy" "RoomJoinPolicy" NOT NULL DEFAULT 'APPROVAL_REQUIRED',
    "maxMembers" INTEGER NOT NULL DEFAULT 10,
    "status" "RoomStatus" NOT NULL DEFAULT 'ACTIVE',
    "keyEpoch" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_members" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "RoomMemberRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_join_requests" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "status" "RoomJoinRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,

    CONSTRAINT "room_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_messages" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "sequenceNumber" BIGINT NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "messageType" "MessageType" NOT NULL DEFAULT 'TEXT',
    "keyEpoch" INTEGER NOT NULL DEFAULT 1,
    "replyToMessageId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "room_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_key_packages" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "keyEpoch" INTEGER NOT NULL DEFAULT 1,
    "recipientUserId" TEXT NOT NULL,
    "encryptedKey" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_key_packages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rooms_codeHmac_key" ON "rooms"("codeHmac");

-- CreateIndex
CREATE INDEX "rooms_ownerId_idx" ON "rooms"("ownerId");

-- CreateIndex
CREATE INDEX "rooms_status_idx" ON "rooms"("status");

-- CreateIndex
CREATE INDEX "room_members_roomId_idx" ON "room_members"("roomId");

-- CreateIndex
CREATE INDEX "room_members_userId_idx" ON "room_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "room_members_roomId_userId_key" ON "room_members"("roomId", "userId");

-- CreateIndex
CREATE INDEX "room_join_requests_roomId_status_createdAt_idx" ON "room_join_requests"("roomId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "room_join_requests_requesterId_status_idx" ON "room_join_requests"("requesterId", "status");

-- CreateIndex
CREATE INDEX "room_messages_roomId_sequenceNumber_idx" ON "room_messages"("roomId", "sequenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "room_messages_roomId_sequenceNumber_key" ON "room_messages"("roomId", "sequenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "room_messages_roomId_clientMessageId_key" ON "room_messages"("roomId", "clientMessageId");

-- CreateIndex
CREATE INDEX "room_key_packages_roomId_recipientUserId_idx" ON "room_key_packages"("roomId", "recipientUserId");

-- CreateIndex
CREATE UNIQUE INDEX "room_key_packages_roomId_keyEpoch_recipientUserId_key" ON "room_key_packages"("roomId", "keyEpoch", "recipientUserId");

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_join_requests" ADD CONSTRAINT "room_join_requests_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_join_requests" ADD CONSTRAINT "room_join_requests_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_join_requests" ADD CONSTRAINT "room_join_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_key_packages" ADD CONSTRAINT "room_key_packages_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_key_packages" ADD CONSTRAINT "room_key_packages_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_key_packages" ADD CONSTRAINT "room_key_packages_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
