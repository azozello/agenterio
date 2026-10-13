import type { Channel, Prisma } from "@agentslack/db";
import { parseMentions, type DomainEvent, type MessageDto, type PostMessageRequest, type ThreadDto } from "@agentslack/shared";
import type { Actor } from "../auth/actor.js";
import { canAccessChannel } from "../auth/access.js";
import { publishAll, type AppContext } from "../context.js";
import { recordEvent } from "../events/record.js";
import { toChannelDto, toTaskRef } from "./dto.js";
import { forbidden, isUuid, notFound } from "./errors.js";
import { deliver, type InboxDelivery } from "./inbox.js";
import { messageInclude, toMessageDto } from "./message-dto.js";

type Tx = Prisma.TransactionClient;

export async function accessibleChannel(ctx: AppContext, actor: Actor, channelId: string) {
  if (!isUuid(channelId)) throw notFound("channel");
  const channel = await ctx.db.channel.findUnique({ where: { id: channelId } });
  if (!channel || channel.workspaceId !== actor.workspaceId) throw notFound("channel");
  if (!(await canAccessChannel(ctx.db, actor, channel))) throw forbidden("no access to this channel");
  return channel;
}

/** Latest top-level messages, oldest first. */
export async function listChannelMessages(
  ctx: AppContext,
  actor: Actor,
  channelId: string,
  limit: number,
): Promise<MessageDto[]> {
  await accessibleChannel(ctx, actor, channelId);
  const rows = await ctx.db.message.findMany({
    where: { targetType: "channel", targetId: channelId, parentId: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    include: messageInclude,
  });
  return rows.reverse().map(toMessageDto);
}

export async function getThread(ctx: AppContext, actor: Actor, messageId: string): Promise<ThreadDto> {
  if (!isUuid(messageId)) throw notFound("message");
  const root = await ctx.db.message.findUnique({ where: { id: messageId }, include: messageInclude });
  if (!root || root.targetType !== "channel" || root.parentId) throw notFound("thread");
  await accessibleChannel(ctx, actor, root.targetId);
  const replies = await ctx.db.message.findMany({
    where: { parentId: root.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: messageInclude,
  });
  return { root: toMessageDto(root), replies: replies.map(toMessageDto) };
}

export interface NewMessage {
  channel: Channel;
  /** null: a system message. */
  author: Actor | null;
  body: string;
  parentId?: string | null;
  isActivity?: boolean;
  taskId?: string | null;
}

/**
 * Writes a message and works out whose inbox it lands in. Returns the DTO and the events to
 * publish once the surrounding transaction commits.
 */
export async function createMessage(tx: Tx, m: NewMessage): Promise<{ dto: MessageDto; events: DomainEvent[] }> {
  const row = await tx.message.create({
    data: {
      workspaceId: m.channel.workspaceId,
      targetType: "channel",
      targetId: m.channel.id,
      parentId: m.parentId ?? null,
      body: m.body,
      isActivity: m.isActivity ?? false,
      taskId: m.taskId ?? null,
      authorUserId: m.author?.kind === "human" ? m.author.userId : null,
      authorAgentId: m.author?.kind === "agent" ? m.author.agentId : null,
    },
    include: messageInclude,
  });
  const dto = toMessageDto(row);
  const events = [
    await recordEvent(tx, {
      type: "message.created",
      workspaceId: m.channel.workspaceId,
      projectId: m.channel.projectId,
      actor: m.author,
      subjectType: "message",
      subjectId: row.id,
      payload: dto,
    }),
  ];
  if (!dto.isActivity) {
    for (const d of await recipients(tx, m, dto)) events.push(await deliver(tx, m.channel.workspaceId, d));
  }
  return { dto, events };
}

/**
 * Who gets this message in their inbox: DM members, @mentioned agents that can see the
 * channel, and for human replies in a thread the agents already in it plus the task's assignee.
 * Unmentioned channel chatter is not delivered.
 */
async function recipients(tx: Tx, m: NewMessage, dto: MessageDto): Promise<InboxDelivery[]> {
  const authorAgentId = m.author?.kind === "agent" ? m.author.agentId : null;
  const kinds = new Map<string, InboxDelivery["kind"]>();
  const add = (agentId: string | null | undefined, kind: InboxDelivery["kind"]) => {
    if (agentId && agentId !== authorAgentId && !kinds.has(agentId)) kinds.set(agentId, kind);
  };

  if (m.channel.kind === "dm") {
    const members = await tx.channelMember.findMany({ where: { channelId: m.channel.id, agentId: { not: null } } });
    for (const member of members) add(member.agentId, "dm");
  }

  const handles = parseMentions(m.body);
  if (handles.length > 0) {
    const mentioned = await tx.agent.findMany({ where: { workspaceId: m.channel.workspaceId, handle: { in: handles } } });
    for (const agent of mentioned) {
      const canSee =
        m.channel.kind === "dm" ? kinds.has(agent.id) : m.channel.projectId === null || agent.currentProjectId === m.channel.projectId;
      if (canSee) add(agent.id, "mention");
    }
  }

  // Replies from agents reach only the agents they @mention, so agents acknowledging each other
  // in a thread don't wake everyone in it (or resume a blocked task).
  if (m.parentId && m.author?.kind !== "agent") {
    const root = await tx.message.findUniqueOrThrow({ where: { id: m.parentId }, include: { task: true } });
    add(root.authorAgentId, "thread_reply");
    add(root.task?.assigneeAgentId, "thread_reply");
    const participants = await tx.message.findMany({
      where: { parentId: root.id, authorAgentId: { not: null }, isActivity: false },
      distinct: ["authorAgentId"],
      select: { authorAgentId: true },
    });
    for (const p of participants) add(p.authorAgentId, "thread_reply");
  }

  const channel = toChannelDto(m.channel);
  const task = m.parentId
    ? await tx.message
        .findUnique({ where: { id: m.parentId }, include: { task: { include: { project: true } } } })
        .then((root) => (root?.task ? toTaskRef(root.task) : null))
    : null;
  return [...kinds].map(([agentId, kind]) => ({ agentId, kind, message: dto, channel, task }));
}

export async function postChannelMessage(
  ctx: AppContext,
  actor: Actor,
  channelId: string,
  input: PostMessageRequest,
): Promise<MessageDto> {
  const channel = await accessibleChannel(ctx, actor, channelId);
  if (input.parentId) {
    const parent = await ctx.db.message.findUnique({ where: { id: input.parentId } });
    if (!parent || parent.targetType !== "channel" || parent.targetId !== channelId) throw notFound("parent message");
    if (parent.parentId) throw forbidden("replies go to the thread root");
  }

  const { dto, events } = await ctx.db.$transaction((tx) =>
    createMessage(tx, { channel, author: actor, body: input.body, parentId: input.parentId }),
  );
  await publishAll(ctx, events);
  return dto;
}
