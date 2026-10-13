import { Bug, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Hourglass, Layers, SquareCheck } from "lucide-react";
import { TASK_STATUS_LABELS, type TaskPriority, type TaskStatus, type TaskType } from "@agentslack/shared";
import { TYPE_LABELS } from "@/lib/tasks";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<TaskStatus, string> = {
  backlog: "bg-muted text-muted-foreground",
  in_progress: "bg-primary/15 text-primary",
  blocked: "bg-status-blocked/25 text-amber-800 dark:text-amber-200",
  ready: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  in_review: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  done: "bg-status-working/20 text-emerald-800 dark:text-emerald-200",
};

export const STATUS_DOTS: Record<TaskStatus, string> = {
  backlog: "bg-status-idle",
  in_progress: "bg-primary",
  blocked: "bg-status-blocked",
  ready: "bg-violet-500",
  in_review: "bg-sky-500",
  done: "bg-status-working",
};

export function StatusPill({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        STATUS_STYLES[status],
        className,
      )}
    >
      {TASK_STATUS_LABELS[status]}
    </span>
  );
}

const TYPE_ICONS = { feature: Layers, task: SquareCheck, bug: Bug } as const;
const TYPE_COLORS: Record<TaskType, string> = {
  feature: "text-violet-600 dark:text-violet-400",
  task: "text-primary",
  bug: "text-red-600 dark:text-red-400",
};

export function TypeIcon({ type, className }: { type: TaskType; className?: string }) {
  const Icon = TYPE_ICONS[type];
  return <Icon className={cn("size-3.5 shrink-0", TYPE_COLORS[type], className)} aria-label={TYPE_LABELS[type]} role="img" />;
}

export function TypeBadge({ type }: { type: TaskType }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-px text-[11px] font-medium text-muted-foreground">
      <TypeIcon type={type} />
      {TYPE_LABELS[type]}
    </span>
  );
}

const PRIORITY_STYLES: Record<TaskPriority, string> = {
  P0: "bg-red-600 text-white",
  P1: "bg-orange-500/20 text-orange-800 dark:text-orange-200",
  P2: "bg-muted text-muted-foreground",
  P3: "text-muted-foreground",
};

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span
      title={`Priority ${priority}`}
      className={cn("inline-flex shrink-0 rounded px-1 text-[11px] font-semibold tabular-nums", PRIORITY_STYLES[priority])}
    >
      {priority}
    </span>
  );
}

const PR_STATES: Record<string, { icon: typeof GitPullRequest; label: string; className: string }> = {
  open: { icon: GitPullRequest, label: "Open", className: "text-emerald-700 dark:text-emerald-300" },
  draft: { icon: GitPullRequestDraft, label: "Draft", className: "text-muted-foreground" },
  merged: { icon: GitMerge, label: "Merged", className: "text-violet-700 dark:text-violet-300" },
  closed: { icon: GitPullRequestClosed, label: "Closed", className: "text-red-700 dark:text-red-300" },
};

function prState(state: string | null) {
  return PR_STATES[state ?? "open"] ?? PR_STATES.open!;
}

/** PR icon and state; a link to GitHub when `url` is set. */
export function PrBadge({ url, state, compact = false }: { url: string; state: string | null; compact?: boolean }) {
  const s = prState(state);
  const Icon = s.icon;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Pull request · ${s.label}`}
      onClick={(e) => e.stopPropagation()}
      className={cn("inline-flex shrink-0 items-center gap-1 text-[11px] font-medium hover:underline", s.className)}
    >
      <Icon className="size-3.5" aria-hidden />
      {compact ? <span className="sr-only">Pull request {s.label}</span> : <span>PR {s.label.toLowerCase()}</span>}
    </a>
  );
}

export function WaitingBadge({ keys }: { keys: string[] }) {
  if (keys.length === 0) return null;
  return (
    <span
      title={`Can't start until ${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} done`}
      className="inline-flex min-w-0 items-center gap-1 rounded bg-status-blocked/20 px-1.5 py-px text-[11px] font-medium text-amber-800 dark:text-amber-200"
    >
      <Hourglass className="size-3 shrink-0" aria-hidden />
      <span className="truncate">waiting on {keys.join(", ")}</span>
    </span>
  );
}

export function ProgressBar({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={`${done} of ${total} done`}
      className={cn("inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted", className)}
    >
      <span className="block h-full rounded-full bg-status-working" style={{ width: `${pct}%` }} />
    </span>
  );
}
