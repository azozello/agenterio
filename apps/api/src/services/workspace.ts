import type { WorkspaceDto } from "@agentslack/shared";
import type { Actor } from "../auth/actor.js";
import type { AppContext } from "../context.js";
import { listDms } from "./dms.js";
import { toAgentPerson, toChannelDto, toHumanPerson } from "./dto.js";
import { notFound } from "./errors.js";

/** Everything the sidebar needs, filtered to what the actor may see. */
export async function getWorkspace(ctx: AppContext, actor: Actor): Promise<WorkspaceDto> {
  const workspace = await ctx.db.workspace.findUnique({ where: { id: actor.workspaceId } });
  if (!workspace) throw notFound("workspace");

  const projectFilter = actor.kind === "agent" ? { id: actor.projectId } : {};
  const [workspaceChannels, projects, users, agents, dms] = await Promise.all([
    ctx.db.channel.findMany({
      where: { workspaceId: workspace.id, projectId: null, kind: "channel" },
      orderBy: { name: "asc" },
    }),
    ctx.db.project.findMany({
      where: { workspaceId: workspace.id, ...projectFilter },
      orderBy: { createdAt: "asc" },
      include: { channels: { where: { kind: "channel" }, orderBy: { createdAt: "asc" } } },
    }),
    ctx.db.user.findMany({ where: { workspaceId: workspace.id }, orderBy: { name: "asc" } }),
    ctx.db.agent.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { name: "asc" },
      include: { role: true },
    }),
    listDms(ctx, actor),
  ]);

  return {
    id: workspace.id,
    name: workspace.name,
    channels: workspaceChannels.map(toChannelDto),
    projects: projects.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      repos: p.repos,
      channels: p.channels.map(toChannelDto),
    })),
    people: [...users.map(toHumanPerson), ...agents.map(toAgentPerson)],
    dms,
  };
}
