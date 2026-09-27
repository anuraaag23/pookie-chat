-- Migration: add joinLocked to rooms (Issue #10) and feature password hashes to user_settings (Issues #6, #7, #11)
ALTER TABLE "rooms" ADD COLUMN "joinLocked" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "user_settings" ADD COLUMN "burnPasswordHash" TEXT;
ALTER TABLE "user_settings" ADD COLUMN "chatLockPasswordHash" TEXT;
ALTER TABLE "user_settings" ADD COLUMN "hideChatPasswordHash" TEXT;
