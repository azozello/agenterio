import type { MessageDto, TaskDto } from "@agentslack/shared";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Dedupes by id and keeps chat order (oldest first). */
export function mergeMessages(current: MessageDto[], incoming: MessageDto[]) {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Renders as a task card or a compact activity line rather than a chat bubble. */
export function isPlainMessage(m: MessageDto) {
  return !m.isActivity && !(m.task && m.parentId === null);
}

/** Whether `m` continues `prev`'s group (same author within a few minutes, no header needed). */
export function continuesGroup(prev: MessageDto | undefined, m: MessageDto) {
  return (
    prev !== undefined &&
    isPlainMessage(prev) &&
    isPlainMessage(m) &&
    prev.author.id === m.author.id &&
    Date.parse(m.createdAt) - Date.parse(prev.createdAt) < GROUP_WINDOW_MS
  );
}

/**
 * Counts a new thread reply on its root. A reply no newer than the root's last reply is already
 * included in the count the API returned, so it is not counted twice.
 */
export function withReply(messages: MessageDto[], reply: MessageDto): MessageDto[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.id !== reply.parentId || (m.lastReplyAt !== null && reply.createdAt <= m.lastReplyAt)) return m;
    changed = true;
    return { ...m, replyCount: m.replyCount + 1, lastReplyAt: reply.createdAt };
  });
  return changed ? next : messages;
}

/** Keeps task cards in sync with the board. */
export function withTask(messages: MessageDto[], task: TaskDto): MessageDto[] {
  if (!messages.some((m) => m.task?.id === task.id)) return messages;
  return messages.map((m) =>
    m.task?.id === task.id ? { ...m, task: { ...m.task, key: task.key, title: task.title, status: task.status } } : m,
  );
}
