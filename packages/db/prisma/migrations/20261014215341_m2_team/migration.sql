-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InboxKind" ADD VALUE 'review_requested';
ALTER TYPE "InboxKind" ADD VALUE 'bug_filed';

-- AlterTable
ALTER TABLE "agent" ADD COLUMN     "paused_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "task" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by_agent_id" UUID,
ADD COLUMN     "approved_by_user_id" UUID,
ADD COLUMN     "reviewer_agent_id" UUID;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_reviewer_agent_id_fkey" FOREIGN KEY ("reviewer_agent_id") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_approved_by_agent_id_fkey" FOREIGN KEY ("approved_by_agent_id") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
