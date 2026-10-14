import type { Agent, Project, Role, Task, User } from "@agentslack/db";
import type { ChannelDto, MeDto, PersonDto, PersonRefDto, TaskRefDto } from "@agentslack/shared";
import type { Actor } from "../auth/actor.js";
import type { AppContext } from "../context.js";

export const taskKey = (t: { number: number; project: { key: string } }) => `${t.project.key}-${t.number}`;

export const toTaskRef = (t: Task & { project: Project }): TaskRefDto => ({
  id: t.id,
  key: taskKey(t),
  title: t.title,
  type: t.type,
  status: t.status,
});

export const humanRef = (u: User): PersonRefDto => ({ kind: "human", id: u.id, name: u.name, handle: null });
export const agentRef = (a: Agent): PersonRefDto => ({ kind: "agent", id: a.id, name: a.name, handle: a.handle });

type ChannelRow = { id: string; name: string; projectId: string | null; kind: "channel" | "dm"; topic: string };

export const toChannelDto = (c: ChannelRow): ChannelDto => ({
  id: c.id,
  name: c.name,
  projectId: c.projectId,
  kind: c.kind,
  topic: c.topic,
});

export const toHumanPerson = (u: User): PersonDto => ({
  kind: "human",
  id: u.id,
  name: u.name,
  handle: null,
  role: u.isAdmin ? "Admin" : null,
  status: null,
  statusText: "",
  projectId: null,
  paused: false,
});

export const toAgentPerson = (a: Agent & { role: Role }): PersonDto => ({
  kind: "agent",
  id: a.id,
  name: a.name,
  handle: a.handle,
  role: a.role.name,
  status: a.status,
  statusText: a.statusText,
  projectId: a.currentProjectId,
  paused: a.pausedAt !== null,
});

const HUMAN_ONLY = { handle: null, role: null, model: null, effort: null, systemPrompt: null, rolePrompt: null, paused: false };

export function toHumanMe(u: { id: string; name: string; workspaceId: string }): MeDto {
  return { kind: "human", id: u.id, name: u.name, workspaceId: u.workspaceId, projectId: null, ...HUMAN_ONLY };
}

/** For agents this includes what the supervisor needs to configure itself. */
export async function loadMe(ctx: AppContext, actor: Actor): Promise<MeDto> {
  if (actor.kind === "human") return toHumanMe({ id: actor.userId, name: actor.name, workspaceId: actor.workspaceId });
  const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: actor.agentId }, include: { role: true } });
  return {
    kind: "agent",
    id: agent.id,
    name: agent.name,
    workspaceId: agent.workspaceId,
    projectId: actor.projectId,
    handle: agent.handle,
    role: agent.role.name,
    model: agent.model,
    effort: agent.effort,
    systemPrompt: agent.systemPrompt,
    rolePrompt: agent.role.basePrompt,
    paused: agent.pausedAt !== null,
  };
}
