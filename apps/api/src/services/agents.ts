import type { Prisma } from "@agentslack/db";
import type { DomainEvent, PersonDto, SetStatusRequest } from "@agentslack/shared";
import type { Actor } from "../auth/actor.js";
import { publishAll, type AppContext } from "../context.js";
import { recordEvent } from "../events/record.js";
import { toAgentPerson } from "./dto.js";
import { forbidden, isUuid, notFound, requireHuman } from "./errors.js";

type Tx = Prisma.TransactionClient;

/** Writes an agent change and the `agent.updated` event that relays it to every browser and supervisor. */
async function updateAgent(
  tx: Tx,
  actor: Actor | null,
  agentId: string,
  data: Prisma.AgentUpdateInput,
  change: "status" | "paused" | "resumed" | "offline",
): Promise<{ person: PersonDto; event: DomainEvent }> {
  const agent = await tx.agent.update({ where: { id: agentId }, data, include: { role: true } });
  const person = toAgentPerson(agent);
  const event = await recordEvent(tx, {
    type: "agent.updated",
    workspaceId: agent.workspaceId,
    projectId: agent.currentProjectId,
    actor,
    subjectType: "agent",
    subjectId: agent.id,
    payload: { person, change },
  });
  return { person, event };
}

/** The agent's presence and one-line status, e.g. working · "Implementing DEMO-3". */
export async function setAgentStatus(ctx: AppContext, actor: Actor, input: SetStatusRequest) {
  if (actor.kind !== "agent") throw forbidden("only agents have a status");
  const { person, event } = await ctx.db.$transaction((tx) =>
    updateAgent(tx, actor, actor.agentId, { status: input.status, statusText: input.statusText ?? "" }, "status"),
  );
  await publishAll(ctx, [event]);
  return person;
}

/**
 * `/pause` and `/resume`. A paused agent's supervisor stops its run after the current tool call,
 * takes no new work and stops its laptop; it still answers DMs with its last status.
 * `agentId` null means every agent in the workspace.
 */
export async function setPaused(ctx: AppContext, actor: Actor, agentId: string | null, paused: boolean): Promise<PersonDto[]> {
  requireHuman(actor);
  if (agentId !== null) {
    const agent = isUuid(agentId) ? await ctx.db.agent.findUnique({ where: { id: agentId } }) : null;
    if (!agent || agent.workspaceId !== actor.workspaceId) throw notFound("agent");
  }
  const results = await ctx.db.$transaction(async (tx) => {
    const agents = await tx.agent.findMany({
      where: {
        workspaceId: actor.workspaceId,
        ...(agentId ? { id: agentId } : {}),
        pausedAt: paused ? null : { not: null },
      },
      orderBy: { name: "asc" },
    });
    const out: { person: PersonDto; event: DomainEvent }[] = [];
    for (const agent of agents) {
      out.push(await updateAgent(tx, actor, agent.id, { pausedAt: paused ? new Date() : null }, paused ? "paused" : "resumed"));
    }
    return out;
  });
  await publishAll(ctx, results.map((r) => r.event));
  if (agentId === null) return results.map((r) => r.person);
  // Already in the requested state: return it unchanged.
  if (results.length > 0) return results.map((r) => r.person);
  const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId }, include: { role: true } });
  return [toAgentPerson(agent)];
}

/** Called when an agent's last socket has been gone for a while: its supervisor is not running. */
export async function markAgentOffline(ctx: AppContext, agentId: string): Promise<void> {
  const result = await ctx.db.$transaction(async (tx) => {
    const agent = await tx.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.status === "offline") return null;
    return updateAgent(tx, null, agentId, { status: "offline" }, "offline");
  });
  if (result) await publishAll(ctx, [result.event]);
}
