"use client";

import { Fragment } from "react";
import Link from "next/link";
import { MessageSquareText } from "lucide-react";
import type { AuthorDto, MessageDto } from "@agentslack/shared";
import { continuesGroup } from "@/lib/messages";
import { projectForKey, taskPath } from "@/lib/tasks";
import { cn, formatTime, formatWhen } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { Avatar, SystemAvatar } from "./avatar";
import { StatusPill, TypeBadge, TypeIcon } from "./task-badges";

/** Text with @handle mentions highlighted. */
function MentionText({ text }: { text: string }) {
  const parts = text.split(/(@[a-z0-9][a-z0-9-]*)/gi);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="rounded bg-mention px-0.5 font-medium text-mention-foreground">
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

export function Body({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn("text-[15px] leading-relaxed break-words whitespace-pre-wrap", className)}>
      <MentionText text={text} />
    </p>
  );
}

function AuthorAvatar({ author, size }: { author: AuthorDto; size: "xs" | "sm" | "md" }) {
  const { openProfile } = useWorkspace();
  if (author.kind === "system") return <SystemAvatar size={size} />;
  return (
    <button type="button" onClick={() => openProfile(author.id)} aria-label={`Open ${author.name}'s profile`} className="rounded-md">
      <Avatar id={author.id} name={author.name} size={size} />
    </button>
  );
}

function AuthorName({ author, className }: { author: AuthorDto; className?: string }) {
  const { openProfile } = useWorkspace();
  if (author.kind === "system") return <span className={className}>{author.name}</span>;
  return (
    <button type="button" onClick={() => openProfile(author.id)} className={cn("hover:underline", className)}>
      {author.name}
    </button>
  );
}

function RepliesButton({ message, onOpen }: { message: MessageDto; onOpen: () => void }) {
  const { threadId } = useWorkspace();
  const n = message.replyCount;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={threadId === message.id}
      className={cn(
        "mt-1 flex max-w-full items-center gap-2 rounded-md border px-1.5 py-0.5 text-xs",
        threadId === message.id ? "border-border bg-background" : "border-transparent hover:border-border hover:bg-background",
      )}
    >
      <span className="font-semibold text-primary">
        {n} {n === 1 ? "reply" : "replies"}
      </span>
      {message.lastReplyAt && (
        <span className="truncate text-muted-foreground">Last reply {formatWhen(message.lastReplyAt)}</span>
      )}
    </button>
  );
}

/** The task a thread root stands for, as a card linking to the task page. */
function TaskCard({ message }: { message: MessageDto }) {
  const { workspace } = useWorkspace();
  const task = message.task!;
  const project =
    workspace.projects.find((p) => p.channels.some((c) => c.id === message.channelId)) ?? projectForKey(workspace, task.key);
  const card = (
    <>
      <span className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-xs font-semibold whitespace-nowrap text-muted-foreground">{task.key}</span>
        <TypeBadge type={task.type} />
        <StatusPill status={task.status} className="ml-auto" />
      </span>
      <span className="mt-1 block truncate font-medium">{task.title}</span>
      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
        Created by {message.author.name} · {formatWhen(message.createdAt)}
      </span>
    </>
  );
  const className = "block w-full max-w-xl rounded-lg border border-border bg-background px-3 py-2 text-left shadow-xs";
  if (!project) return <div className={className}>{card}</div>;
  return (
    <Link href={taskPath(project.id, task.key)} className={cn(className, "hover:border-ring/60 hover:bg-muted/40")}>
      {card}
    </Link>
  );
}

interface MessageItemProps {
  message: MessageDto;
  /** Continues the previous message's group: no avatar or header. */
  grouped?: boolean;
  /** Set on top-level messages to show the replies affordance and a "Reply in thread" action. */
  onOpenThread?: (message: MessageDto) => void;
  className?: string;
}

/** One chat line: a task card, a compact activity line, or a regular message. */
export function MessageItem({ message: m, grouped = false, onOpenThread, className }: MessageItemProps) {
  const { people } = useWorkspace();
  const openThread = onOpenThread ? () => onOpenThread(m) : undefined;
  const replies = openThread && m.replyCount > 0 ? <RepliesButton message={m} onOpen={openThread} /> : null;
  const replyAction = openThread && m.replyCount === 0 && (
    <button
      type="button"
      onClick={openThread}
      className="absolute top-0 right-4 -translate-y-1/3 rounded-md border border-border bg-background p-1 text-muted-foreground opacity-0 shadow-xs group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
      aria-label="Reply in thread"
      title="Reply in thread"
    >
      <MessageSquareText className="size-4" />
    </button>
  );

  if (m.task && m.parentId === null) {
    return (
      <li className={cn("group relative mt-2 flex gap-3 px-5 py-1 hover:bg-muted/60", className)}>
        <div className="flex w-9 shrink-0 justify-end pt-1">
          <TypeIcon type={m.task.type} className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <TaskCard message={m} />
          {replies}
        </div>
        {replyAction}
      </li>
    );
  }

  if (m.isActivity) {
    return (
      <li className={cn("group relative flex gap-3 px-5 py-0.5 text-[13px] text-muted-foreground hover:bg-muted/60", className)}>
        <div className="flex w-9 shrink-0 justify-end pt-px">
          <AuthorAvatar author={m.author} size="xs" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="leading-5 break-words whitespace-pre-wrap">
            <AuthorName author={m.author} className="font-medium text-foreground/80" /> <MentionText text={m.body} />{" "}
            <time className="text-[11px] whitespace-nowrap" dateTime={m.createdAt}>
              {formatTime(m.createdAt)}
            </time>
          </p>
          {replies}
        </div>
        {replyAction}
      </li>
    );
  }

  const role = people.get(m.author.id)?.role;
  return (
    <li className={cn("group relative flex gap-3 px-5 hover:bg-muted/60", grouped ? "py-0.5" : "mt-2 pt-1.5 pb-0.5", className)}>
      <div className="w-9 shrink-0">
        {grouped ? (
          <time className="hidden pt-1 text-[11px] text-muted-foreground group-hover:block" dateTime={m.createdAt}>
            {formatTime(m.createdAt)}
          </time>
        ) : (
          <AuthorAvatar author={m.author} size="md" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <AuthorName author={m.author} className="font-semibold" />
            {m.author.kind !== "human" && (
              <span className="rounded bg-muted px-1 text-[11px] font-medium text-muted-foreground">
                {m.author.kind === "system" ? "System" : (role ?? "Agent")}
              </span>
            )}
            <time className="text-xs text-muted-foreground" dateTime={m.createdAt}>
              {formatTime(m.createdAt)}
            </time>
          </div>
        )}
        <Body text={m.body} />
        {replies}
      </div>
      {replyAction}
    </li>
  );
}

/** A list of messages in chat order with author grouping. */
export function MessageList({
  messages,
  onOpenThread,
  itemClassName,
}: {
  messages: MessageDto[];
  onOpenThread?: (message: MessageDto) => void;
  itemClassName?: string;
}) {
  return (
    <ol>
      {messages.map((m, i) => (
        <MessageItem
          key={m.id}
          message={m}
          grouped={continuesGroup(messages[i - 1], m)}
          onOpenThread={onOpenThread}
          className={itemClassName}
        />
      ))}
    </ol>
  );
}
