import type { Prisma } from "@agentslack/db";
import type { DomainEvent } from "@agentslack/shared";
import type { Actor } from "../auth/actor.js";

export interface EventInput {
  type: string;
  workspaceId: string;
  projectId: string | null;
  actor: Actor | null;
  subjectType: string;
  subjectId: string;
  payload: Prisma.InputJsonValue;
}

/**
 * Appends to the `event` audit table inside the caller's transaction.
 * Publish the returned event on the bus after the transaction commits.
 */
export async function recordEvent(tx: Prisma.TransactionClient, input: EventInput): Promise<DomainEvent> {
  const row = await tx.event.create({
    data: {
      type: input.type,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorKind: input.actor?.kind ?? "system",
      actorUserId: input.actor?.kind === "human" ? input.actor.userId : null,
      actorAgentId: input.actor?.kind === "agent" ? input.actor.agentId : null,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payload: input.payload,
    },
  });
  return {
    id: row.id.toString(),
    type: row.type,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    actor: { kind: row.actorKind, id: row.actorUserId ?? row.actorAgentId },
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}
