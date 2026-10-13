-- CreateEnum
CREATE TYPE "InboxKind" AS ENUM ('mention', 'dm', 'thread_reply', 'task_assigned', 'task_unblocked');

-- AlterTable
ALTER TABLE "message" ADD COLUMN     "is_activity" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "task_id" UUID;

-- AlterTable
ALTER TABLE "task" ADD COLUMN     "branch" TEXT,
ADD COLUMN     "thread_message_id" UUID;

-- AlterTable
ALTER TABLE "task_link" ADD COLUMN     "state" TEXT;

-- CreateTable
CREATE TABLE "inbox_item" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "kind" "InboxKind" NOT NULL,
    "message_id" UUID,
    "task_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handled_at" TIMESTAMP(3),

    CONSTRAINT "inbox_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inbox_item_agent_id_handled_at_created_at_idx" ON "inbox_item"("agent_id", "handled_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "task_thread_message_id_key" ON "task"("thread_message_id");

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_item" ADD CONSTRAINT "inbox_item_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_item" ADD CONSTRAINT "inbox_item_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_item" ADD CONSTRAINT "inbox_item_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

