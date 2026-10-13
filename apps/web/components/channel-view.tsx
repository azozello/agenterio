"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChannelDto, MessageDto } from "@agentslack/shared";
import { api, errorMessage } from "@/lib/api";
import { mergeMessages, withReply, withTask } from "@/lib/messages";
import { getSocket, subscribeChannel } from "@/lib/socket";
import { useTaskChanged } from "@/lib/use-tasks";
import { useWorkspace } from "@/lib/workspace";
import { Composer } from "./composer";
import { MessageList } from "./message-item";

interface ChannelViewProps {
  channel: ChannelDto;
  title: React.ReactNode;
  icon: React.ReactNode;
  subtitle: string | null;
  placeholder: string;
  emptyHint: string;
}

/** Message list and composer for a channel or DM. Thread replies open in the right panel. */
export function ChannelView({ channel, title, icon, subtitle, placeholder, emptyHint }: ChannelViewProps) {
  const { openThread } = useWorkspace();
  const [messages, setMessages] = useState<MessageDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const load = useCallback(async () => {
    try {
      const list = await api.messages(channel.id);
      setMessages((current) => mergeMessages(current ?? [], list));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [channel.id]);

  useEffect(() => {
    setMessages(null);
    stickToBottom.current = true;
    void load();

    const socket = getSocket();
    // Fill any gap left while the socket was down.
    const onConnect = () => void load();
    const onMessage = (m: MessageDto) => {
      if (m.channelId !== channel.id) return;
      if (m.parentId === null) setMessages((cur) => mergeMessages(cur ?? [], [m]));
      else setMessages((cur) => (cur ? withReply(cur, m) : cur));
    };
    const release = subscribeChannel(channel.id);
    socket.on("connect", onConnect);
    socket.on("message.created", onMessage);
    return () => {
      socket.off("connect", onConnect);
      socket.off("message.created", onMessage);
      release();
    };
  }, [channel.id, load]);

  useTaskChanged((task) => setMessages((cur) => (cur ? withTask(cur, task) : cur)));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send(body: string) {
    const message = await api.postMessage(channel.id, body);
    stickToBottom.current = true;
    setMessages((cur) => mergeMessages(cur ?? [], [message]));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-5">
        {icon}
        <h1 className="font-semibold">{title}</h1>
        {subtitle && <span className="shrink-0 text-sm text-muted-foreground">{subtitle}</span>}
        {channel.topic && <span className="truncate text-sm text-muted-foreground">· {channel.topic}</span>}
      </div>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto py-4"
        aria-live="polite"
        aria-label="Messages"
      >
        {loadError && <p className="px-5 text-sm text-red-600">Couldn&apos;t load messages: {loadError}</p>}
        {messages === null && !loadError && <p className="px-5 text-sm text-muted-foreground">Loading…</p>}
        {messages?.length === 0 && <p className="px-5 pt-8 text-sm text-muted-foreground">{emptyHint}</p>}
        {messages && <MessageList messages={messages} onOpenThread={openThread} />}
      </div>

      <Composer id="composer" placeholder={placeholder} onSend={send} className="px-5 pb-5" />
    </div>
  );
}
