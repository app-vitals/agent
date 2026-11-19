-- ACM-1.1: nullable memberId (AccountMember.id) on the email-keyed per-user
-- tables. Additive only: no defaults, no constraints, no index, no backfill;
-- the email columns are untouched.
-- AlterTable
ALTER TABLE "AgentMember" ADD COLUMN     "memberId" TEXT;

-- AlterTable
ALTER TABLE "ChatThreadWatch" ADD COLUMN     "memberId" TEXT;

-- AlterTable
ALTER TABLE "PushSubscription" ADD COLUMN     "memberId" TEXT;

-- AlterTable
ALTER TABLE "UserNotificationPrefs" ADD COLUMN     "memberId" TEXT;
