import type { Prisma } from "@agentslack/db";
import type { MessageDto } from "@agentslack/shared";
import { toTaskRef } from "./dto.js";

export const messageInclude = {
  authorUser: true,
  authorAgent: true,
  task: { include: { project: true } },
  _count: { select: { replies: true } },
  replies: { select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
} satisfies Prisma.MessageInclude;

export type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

const SYSTEM_AUTHOR = { kind: "system" as const, id: "system", name: "AgentSlack", handle: null };

export function toMessageDto(m: MessageRow): MessageDto {
  const author = m.authorAgent
    ? { kind: "agent" as const, id: m.authorAgent.id, name: m.authorAgent.name, handle: m.authorAgent.handle }
    : m.authorUser
      ? { kind: "human" as const, id: m.authorUser.id, name: m.authorUser.name, handle: null }
      : SYSTEM_AUTHOR;
  return {
    id: m.id,
    channelId: m.targetId,
    parentId: m.parentId,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
    author,
    isActivity: m.isActivity,
    task: m.task ? toTaskRef(m.task) : null,
    replyCount: m._count.replies,
    lastReplyAt: m.replies[0]?.createdAt.toISOString() ?? null,
  };
}
