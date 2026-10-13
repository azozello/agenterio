import type { Event } from "@agentslack/db";
import type { ActivityDto, ProfileDto } from "@agentslack/shared";
import type { Actor } from "../auth/actor.js";
import type { AppContext } from "../context.js";
import { isUuid, notFound } from "./errors.js";
import { toAgentPerson, toHumanPerson, toTaskRef } from "./dto.js";

type ChannelInfo = { name: string; kind: "channel" | "dm" };

function summarize(e: Event, channels: Map<string, ChannelInfo>): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "message.created": {
      const channel = channels.get(String(p.channelId));
      if (!channel) return "Posted a message";
      return channel.kind === "dm" ? "Sent a direct message" : `Posted in #${channel.name}`;
    }
    case "channel.created":
      return p.kind === "dm" ? "Started a direct message" : `Created #${String(p.name)}`;
    case "project.created":
      return `Created project ${String(p.key)}`;
    case "agent.created":
      return `Joined the team as ${String(p.role)}`;
    case "user.created":
      return "Joined the workspace";
    case "task.created": {
      const task = p.task as { key?: string; title?: string } | undefined;
      return `Created ${task?.key ?? "a task"}: ${task?.title ?? ""}`.trim();
    }
    case "task.updated": {
      const task = p.task as { key?: string } | undefined;
      return `Updated ${task?.key ?? "a task"}`;
    }
    case "agent.updated": {
      const person = p.person as { status?: string; statusText?: string } | undefined;
      return person?.statusText ? `Status: ${person.statusText}` : `Went ${person?.status ?? "idle"}`;
    }
    default:
      return e.type;
  }
}

/**
 * Profile for the side panel. Activity is what the person did, plus events about them
 * (such as joining). Agents viewing a profile only see activity from their project and the workspace.
 */
export async function getProfile(ctx: AppContext, actor: Actor, personId: string): Promise<ProfileDto> {
  if (!isUuid(personId)) throw notFound("person");
  const [user, agent] = await Promise.all([
    ctx.db.user.findUnique({ where: { id: personId } }),
    ctx.db.agent.findUnique({ where: { id: personId }, include: { role: true, currentProject: true } }),
  ]);
  const person = agent ? toAgentPerson(agent) : user ? toHumanPerson(user) : null;
  if (!person || (agent ?? user)!.workspaceId !== actor.workspaceId) throw notFound("person");

  const events = await ctx.db.event.findMany({
    where: {
      workspaceId: actor.workspaceId,
      OR: agent
        ? [{ actorAgentId: personId }, { subjectType: "agent", subjectId: personId }]
        : [{ actorUserId: personId }, { subjectType: "user", subjectId: personId }],
      ...(actor.kind === "agent" ? { AND: [{ OR: [{ projectId: actor.projectId }, { projectId: null }] }] } : {}),
    },
    orderBy: { id: "desc" },
    take: 20,
  });

  const channelIds = [
    ...new Set(
      events
        .filter((e) => e.type === "message.created")
        .map((e) => String((e.payload as Record<string, unknown>).channelId))
        .filter(isUuid),
    ),
  ];
  const channels = new Map(
    (await ctx.db.channel.findMany({ where: { id: { in: channelIds } } })).map((c) => [c.id, c as ChannelInfo]),
  );

  const recentActivity: ActivityDto[] = events.map((e) => ({
    id: e.id.toString(),
    type: e.type,
    summary: summarize(e, channels),
    createdAt: e.createdAt.toISOString(),
  }));

  const currentTask = agent
    ? await ctx.db.task.findFirst({
        where: { assigneeAgentId: agent.id, status: { in: ["in_progress", "blocked", "ready", "in_review"] } },
        orderBy: { updatedAt: "desc" },
        include: { project: true },
      })
    : null;

  return {
    person,
    project: agent?.currentProject
      ? { id: agent.currentProject.id, key: agent.currentProject.key, name: agent.currentProject.name }
      : null,
    model: agent?.model ?? null,
    effort: agent?.effort ?? null,
    currentTask: currentTask ? toTaskRef(currentTask) : null,
    recentActivity,
  };
}
