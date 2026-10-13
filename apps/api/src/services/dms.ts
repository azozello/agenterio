import { HTTPException } from "hono/http-exception";
import type { Channel, ChannelMember } from "@agentslack/db";
import type { DmDto } from "@agentslack/shared";
import { actorId, type Actor } from "../auth/actor.js";
import { publishAll, type AppContext } from "../context.js";
import { recordEvent } from "../events/record.js";
import { forbidden, isUuid, notFound } from "./errors.js";
import { toChannelDto } from "./dto.js";

/** Deterministic name, so the same pair always finds the same DM. */
const dmName = (a: string, b: string) => `dm:${[a, b].sort().join(":")}`;

const toDmDto = (c: Channel & { members: ChannelMember[] }): DmDto => ({
  channel: toChannelDto(c),
  memberIds: c.members.map((m) => (m.userId ?? m.agentId)!),
});

export async function listDms(ctx: AppContext, actor: Actor): Promise<DmDto[]> {
  const me = actorId(actor);
  const channels = await ctx.db.channel.findMany({
    where: {
      workspaceId: actor.workspaceId,
      kind: "dm",
      members: { some: actor.kind === "human" ? { userId: me } : { agentId: me } },
    },
    include: { members: true },
    orderBy: { createdAt: "asc" },
  });
  return channels.map(toDmDto);
}

/**
 * Returns the 1:1 DM between the caller and `personId`, creating it on first use.
 * Agents may DM humans and agents on their own project.
 */
export async function openDm(ctx: AppContext, actor: Actor, personId: string): Promise<DmDto> {
  const me = actorId(actor);
  if (personId === me) throw new HTTPException(400, { message: "you can't DM yourself" });
  if (!isUuid(personId)) throw notFound("person");

  const [user, agent] = await Promise.all([
    ctx.db.user.findUnique({ where: { id: personId } }),
    ctx.db.agent.findUnique({ where: { id: personId } }),
  ]);
  const other = user ?? agent;
  if (!other || other.workspaceId !== actor.workspaceId) throw notFound("person");
  if (actor.kind === "agent" && agent && agent.currentProjectId !== actor.projectId) {
    throw forbidden("agents can only DM people on their project");
  }

  const name = dmName(me, personId);
  const existing = await ctx.db.channel.findFirst({
    where: { workspaceId: actor.workspaceId, kind: "dm", name },
    include: { members: true },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return toDmDto(existing);

  const { dm, event } = await ctx.db.$transaction(async (tx) => {
    const channel = await tx.channel.create({
      data: {
        workspaceId: actor.workspaceId,
        name,
        kind: "dm",
        members: {
          create: [
            actor.kind === "human" ? { userId: me } : { agentId: me },
            agent ? { agentId: personId } : { userId: personId },
          ],
        },
      },
      include: { members: true },
    });
    const dm = toDmDto(channel);
    const event = await recordEvent(tx, {
      type: "channel.created",
      workspaceId: actor.workspaceId,
      projectId: null,
      actor,
      subjectType: "channel",
      subjectId: channel.id,
      payload: { kind: "dm", dm },
    });
    return { dm, event };
  });

  await publishAll(ctx, [event]);
  return dm;
}
