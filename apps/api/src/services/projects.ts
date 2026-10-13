import type { DomainEvent } from "@agentslack/shared";
import type { Actor } from "../auth/actor.js";
import { publishAll, type AppContext } from "../context.js";
import { recordEvent } from "../events/record.js";

export const DEFAULT_PROJECT_CHANNELS = ["general", "standup", "reviews"] as const;

export interface CreateProjectInput {
  workspaceId: string;
  key: string;
  name: string;
  memberUserIds?: string[];
}

/** Creates a project with its default channels (#general, #standup, #reviews). */
export async function createProject(ctx: AppContext, actor: Actor | null, input: CreateProjectInput) {
  const { project, events } = await ctx.db.$transaction(async (tx) => {
    const events: DomainEvent[] = [];
    const project = await tx.project.create({
      data: {
        workspaceId: input.workspaceId,
        key: input.key.toUpperCase(),
        name: input.name,
        members: { create: (input.memberUserIds ?? []).map((userId) => ({ userId })) },
      },
    });
    events.push(
      await recordEvent(tx, {
        type: "project.created",
        workspaceId: project.workspaceId,
        projectId: project.id,
        actor,
        subjectType: "project",
        subjectId: project.id,
        payload: { key: project.key, name: project.name },
      }),
    );
    for (const name of DEFAULT_PROJECT_CHANNELS) {
      const channel = await tx.channel.create({
        data: { workspaceId: project.workspaceId, projectId: project.id, name },
      });
      events.push(
        await recordEvent(tx, {
          type: "channel.created",
          workspaceId: project.workspaceId,
          projectId: project.id,
          actor,
          subjectType: "channel",
          subjectId: channel.id,
          payload: { name, projectId: project.id },
        }),
      );
    }
    return { project, events };
  });

  await publishAll(ctx, events);
  return project;
}
