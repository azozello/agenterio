import type { InboxKind, Prisma } from "@agentslack/db";
import type { ChannelDto, DomainEvent, InboxItemDto, MessageDto, TaskRefDto } from "@agentslack/shared";
import { forbidden } from "./errors.js";
import type { Actor } from "../auth/actor.js";
import type { AppContext } from "../context.js";
import { recordEvent } from "../events/record.js";
import { messageInclude, toMessageDto } from "./message-dto.js";
import { toChannelDto, toTaskRef } from "./dto.js";

type Tx = Prisma.TransactionClient;

export interface InboxDelivery {
  agentId: string;
  kind: InboxKind;
  message?: MessageDto | null;
  channel?: ChannelDto | null;
  task?: TaskRefDto | null;
}

/** Creates the inbox item and its event; publish the event after commit. */
export async function deliver(tx: Tx, workspaceId: string, d: InboxDelivery): Promise<DomainEvent> {
  const item = await tx.inboxItem.create({
    data: { agentId: d.agentId, kind: d.kind, messageId: d.message?.id ?? null, taskId: d.task?.id ?? null },
  });
  const dto: InboxItemDto = {
    id: item.id,
    kind: item.kind,
    createdAt: item.createdAt.toISOString(),
    message: d.message ?? null,
    channel: d.channel ?? null,
    task: d.task ?? null,
  };
  return recordEvent(tx, {
    type: "inbox.created",
    workspaceId,
    projectId: null,
    actor: null,
    subjectType: "agent",
    subjectId: d.agentId,
    payload: { agentId: d.agentId, item: dto },
  });
}

/** Unhandled items for the calling agent, oldest first. */
export async function listInbox(ctx: AppContext, actor: Actor): Promise<InboxItemDto[]> {
  if (actor.kind !== "agent") throw forbidden("only agents have an inbox");
  const items = await ctx.db.inboxItem.findMany({
    where: { agentId: actor.agentId, handledAt: null },
    orderBy: { createdAt: "asc" },
    take: 100,
    include: {
      message: { include: messageInclude },
      task: { include: { project: true } },
    },
  });
  const channelIds = [...new Set(items.flatMap((i) => (i.message ? [i.message.targetId] : [])))];
  const channels = new Map(
    (await ctx.db.channel.findMany({ where: { id: { in: channelIds } } })).map((c) => [c.id, toChannelDto(c)]),
  );
  return items.map((i) => ({
    id: i.id,
    kind: i.kind,
    createdAt: i.createdAt.toISOString(),
    message: i.message ? toMessageDto(i.message) : null,
    channel: i.message ? (channels.get(i.message.targetId) ?? null) : null,
    task: i.task ? toTaskRef(i.task) : null,
  }));
}

export async function ackInbox(ctx: AppContext, actor: Actor, ids: string[]): Promise<number> {
  if (actor.kind !== "agent") throw forbidden("only agents have an inbox");
  const { count } = await ctx.db.inboxItem.updateMany({
    where: { id: { in: ids }, agentId: actor.agentId, handledAt: null },
    data: { handledAt: new Date() },
  });
  return count;
}
