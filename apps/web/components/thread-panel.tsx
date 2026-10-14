"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { MessageDto, ThreadDto } from "@agentslack/shared";
import { api, errorMessage } from "@/lib/api";
import { mergeMessages, withTask } from "@/lib/messages";
import { getSocket, subscribeChannel } from "@/lib/socket";
import { useTaskChanged } from "@/lib/use-tasks";
import { useWorkspace } from "@/lib/workspace";
import { Composer } from "./composer";
import { MessageItem, MessageList } from "./message-item";

/** Right-hand panel with a thread: its root, replies oldest first, and a reply box. */
export function ThreadPanel() {
  const { panel, workspace, closePanel } = useWorkspace();
  const thread = panel?.kind === "thread" ? panel : null;
  const messageId = thread?.messageId ?? null;
  const channelId = thread?.channelId ?? null;
  const [data, setData] = useState<ThreadDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (!messageId || !channelId) return;
    let cancelled = false;
    setData(null);
    setError(null);
    stickToBottom.current = true;

    const load = () =>
      api.thread(messageId).then(
        (t) => {
          if (cancelled) return;
          setData((cur) => ({ root: t.root, replies: mergeMessages(cur?.replies ?? [], t.replies) }));
          setError(null);
        },
        (err: unknown) => !cancelled && setError(errorMessage(err)),
      );
    void load();

    const socket = getSocket();
    const onMessage = (m: MessageDto) => {
      if (m.parentId !== messageId) return;
      setData((cur) => (cur ? { ...cur, replies: mergeMessages(cur.replies, [m]) } : cur));
    };
    const onConnect = () => void load();
    const release = subscribeChannel(channelId);
    socket.on("message.created", onMessage);
    socket.on("connect", onConnect);
    return () => {
      cancelled = true;
      socket.off("message.created", onMessage);
      socket.off("connect", onConnect);
      release();
    };
  }, [messageId, channelId]);

  useTaskChanged((task) =>
    setData((cur) => {
      if (!cur || cur.root.task?.id !== task.id) return cur;
      return { ...cur, root: withTask([cur.root], task)[0]! };
    }),
  );

  useEffect(() => {
    if (!messageId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closePanel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [messageId, closePanel]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [data]);

  if (!messageId || !channelId) return null;

  const channel =
    workspace.channels.find((c) => c.id === channelId) ??
    workspace.projects.flatMap((p) => p.channels).find((c) => c.id === channelId) ??
    workspace.dms.find((d) => d.channel.id === channelId)?.channel;
  const where = channel?.kind === "channel" ? `#${channel.name}` : null;

  async function reply(body: string) {
    const message = await api.postMessage(channelId!, body, messageId!);
    stickToBottom.current = true;
    setData((cur) => (cur ? { ...cur, replies: mergeMessages(cur.replies, [message]) } : cur));
  }

  const count = data?.replies.length ?? 0;

  return (
    <aside aria-label="Thread" className="flex w-96 max-w-[45%] shrink-0 flex-col border-l border-border bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="truncate">
          <span className="font-semibold">Thread</span>
          {where && <span className="ml-2 text-sm text-muted-foreground">{where}</span>}
        </h2>
        <button
          type="button"
          onClick={closePanel}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close thread"
          title="Close (Esc)"
        >
          <X className="size-4" />
        </button>
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="relative min-h-0 flex-1 overflow-y-auto pb-3"
        aria-live="polite"
        aria-label="Thread messages"
      >
        {error && <p className="px-4 pt-3 text-sm text-red-600">Couldn&apos;t load the thread: {error}</p>}
        {!data && !error && <p className="px-4 pt-3 text-sm text-muted-foreground">Loading…</p>}
        {data && (
          <>
            <ol className="pt-1">
              <MessageItem message={data.root} className="px-4" />
            </ol>
            <div className="my-2 flex items-center gap-2 px-4 text-xs text-muted-foreground">
              <span>{count === 0 ? "No replies yet" : `${count} ${count === 1 ? "reply" : "replies"}`}</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <MessageList messages={data.replies} itemClassName="px-4" />
          </>
        )}
      </div>

      <Composer key={messageId} id="thread-composer" placeholder="Reply…" onSend={reply} className="px-4 pb-4" autoFocus />
    </aside>
  );
}
