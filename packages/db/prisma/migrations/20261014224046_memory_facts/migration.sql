-- CreateEnum
CREATE TYPE "MemoryScope" AS ENUM ('agent', 'project');

-- CreateTable
CREATE TABLE "memory_fact" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "project_id" UUID,
    "scope" "MemoryScope" NOT NULL DEFAULT 'agent',
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_fact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_fact_agent_id_created_at_idx" ON "memory_fact"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "memory_fact_project_id_scope_idx" ON "memory_fact"("project_id", "scope");

-- AddForeignKey
ALTER TABLE "memory_fact" ADD CONSTRAINT "memory_fact_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_fact" ADD CONSTRAINT "memory_fact_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_fact" ADD CONSTRAINT "memory_fact_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
