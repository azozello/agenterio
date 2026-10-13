"use client";

import { useCallback, useEffect, useState } from "react";
import { MessagesSquare } from "lucide-react";
import type { MessageDto, TaskDto } from "@agentslack/shared";
import { api, errorMessage } from "@/lib/api";
import { mergeMessages } from "@/lib/messages";
import { getSocket, subscribeChannel } from "@/lib/socket";
import { useWorkspace } from "@/lib/workspace";
import { Composer } from "./composer";
import { MessageList } from "./message-item";

/** The task's thread in #general: activity lines and comments, with a comment box. */
export function TaskThread({ task }: { task: TaskDto }) {
  const { openThread } = useWorkspace();
  const [comments, setComments] = useState<MessageDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { id, threadMessageId, threadChannelId } = task;

  const load = useCallback(async () => {
    try {
      const list = await api.taskComments(id);
      setComments((cur) => mergeMessages(cur ?? [], list));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    setComments(null);
    void load();
    if (!threadMessageId || !threadChannelId) return;
    const socket = getSocket();
    const onMessage = (m: MessageDto) => {
      if (m.parentId === threadMessageId) setComments((cur) => mergeMessages(cur ?? [], [m]));
    };
    const onConnect = () => void load();
    const release = subscribeChannel(threadChannelId);
    socket.on("message.created", onMessage);
    socket.on("connect", onConnect);
    return () => {
      socket.off("message.created", onMessage);
      socket.off("connect", onConnect);
      release();
    };
  }, [load, threadMessageId, threadChannelId]);

  async function comment(body: string) {
    const message = await api.commentOnTask(id, body);
    setComments((cur) => mergeMessages(cur ?? [], [message]));
  }

  return (
    <section aria-labelledby="task-thread" className="mt-8 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <h2 id="task-thread" className="text-sm font-semibold">
          Activity and comments
        </h2>
        {threadMessageId && threadChannelId && (
          <button
            type="button"
            onClick={() => openThread({ id: threadMessageId, channelId: threadChannelId })}
            className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            <MessagesSquare className="size-3.5" aria-hidden />
            Open thread in #general
          </button>
        )}
      </div>

      <div className="-mx-5 mt-2" aria-live="polite">
        {error && <p className="px-5 text-sm text-red-600">Couldn&apos;t load comments: {error}</p>}
        {comments === null && !error && <p className="px-5 text-sm text-muted-foreground">Loading…</p>}
        {comments?.length === 0 && <p className="px-5 text-sm text-muted-foreground">No activity yet.</p>}
        {comments && <MessageList messages={comments} />}
      </div>

      {threadMessageId ? (
        <Composer id="task-comment" placeholder={`Comment on ${task.key}`} onSend={comment} className="mt-3" />
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">This task has no thread, so it can&apos;t take comments.</p>
      )}
    </section>
  );
}
