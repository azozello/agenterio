"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Search } from "lucide-react";
import type { TaskDto } from "@agentslack/shared";
import { api, errorMessage } from "@/lib/api";
import { getSocket } from "@/lib/socket";
import { needsYou } from "@/lib/tasks";
import { useTaskChanged } from "@/lib/use-tasks";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

/** Task id → project id. */
type Waiting = Map<string, string>;

function withTask(waiting: Waiting, t: TaskDto): Waiting {
  const needs = needsYou(t);
  if (needs === waiting.has(t.id)) return waiting;
  const next = new Map(waiting);
  if (needs) next.set(t.id, t.projectId);
  else next.delete(t.id);
  return next;
}

/** Tasks that wait on you (approved and ready to merge, no tester to review, or Blocked) across every project you can see. */
function useNeedsYou() {
  const { workspace } = useWorkspace();
  const [waiting, setWaiting] = useState<Waiting>(new Map());
  const [error, setError] = useState<string | null>(null);
  const projectIds = workspace.projects.map((p) => p.id).join(",");

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      Promise.all(projectIds ? projectIds.split(",").map((id) => api.tasks(id)) : []).then(
        (lists) => {
          if (cancelled) return;
          setWaiting(lists.flat().reduce(withTask, new Map() as Waiting));
          setError(null);
        },
        (err: unknown) => !cancelled && setError(errorMessage(err)),
      );
    void load();
    const socket = getSocket();
    socket.on("connect", load);
    return () => {
      cancelled = true;
      socket.off("connect", load);
    };
  }, [projectIds]);

  useTaskChanged((t) => setWaiting((cur) => withTask(cur, t)));
  return { waiting, error };
}

export function TopBar() {
  const { live, workspace } = useWorkspace();
  const router = useRouter();
  const { waiting, error } = useNeedsYou();
  const needsYou = waiting.size;

  function open() {
    // The first project with something waiting, else the first project.
    const withWork = new Set(waiting.values());
    const project = workspace.projects.find((p) => withWork.has(p.id)) ?? workspace.projects[0];
    if (project) router.push(`/p/${project.id}/board`);
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <label className="relative max-w-xl flex-1">
        <span className="sr-only">Search</span>
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          disabled
          placeholder="Search messages, tasks and specs"
          title="Search arrives with specs (M3)"
          className="h-8 w-full rounded-md border border-border bg-muted pr-3 pl-8 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
      </label>

      <div className="ml-auto flex items-center gap-2">
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
            live ? "bg-status-working/15 text-foreground" : "bg-status-blocked/20 text-foreground",
          )}
          role="status"
        >
          <span className={cn("size-1.5 rounded-full", live ? "bg-status-working" : "bg-status-blocked")} />
          {live ? "Live" : "Reconnecting…"}
        </span>
        <button
          type="button"
          onClick={open}
          disabled={workspace.projects.length === 0}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap",
            error
              ? "bg-red-500/15 text-red-700 dark:text-red-300"
              : needsYou > 0
                ? "bg-status-blocked/25 text-foreground hover:bg-status-blocked/35"
                : "bg-muted text-muted-foreground hover:text-foreground",
          )}
          title={error ? `Couldn't count tasks: ${error}` : "Approved PRs to merge, Ready tasks without a tester, and blocked tasks"}
          aria-label={error ? "Needs you: couldn't count tasks" : `Needs you: ${needsYou} tasks. Open the board`}
        >
          Needs you · {error ? "!" : needsYou}
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Notifications"
          title="Notifications"
        >
          <Bell className="size-4" />
        </button>
      </div>
    </header>
  );
}
