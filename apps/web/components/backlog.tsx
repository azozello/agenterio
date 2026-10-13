"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronRight, GripVertical, Plus } from "lucide-react";
import type { ProjectDto, TaskDto } from "@agentslack/shared";
import { rankBetween, taskPath } from "@/lib/tasks";
import { useProjectTasks } from "@/lib/use-tasks";
import { cn } from "@/lib/utils";
import { Avatar } from "./avatar";
import { NewTaskDialog, type NewTaskIntent } from "./new-task-dialog";
import { ProjectHeader } from "./project-header";
import { PrBadge, PriorityBadge, ProgressBar, StatusPill, TypeIcon, WaitingBadge } from "./task-badges";
import { TasksEmpty } from "./tasks-empty";
import { InlineError } from "./ui/alert";
import { Button } from "./ui/button";

type Drop = { id: string; after: boolean };

function MoveButtons({ label, canUp, canDown, onMove }: { label: string; canUp: boolean; canDown: boolean; onMove: (delta: -1 | 1) => void }) {
  const btn = "rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-30";
  return (
    <span className="flex shrink-0 items-center">
      <button type="button" className={btn} disabled={!canUp} onClick={() => onMove(-1)} aria-label={`Move ${label} up`} title="Move up">
        <ArrowUp className="size-3.5" />
      </button>
      <button type="button" className={btn} disabled={!canDown} onClick={() => onMove(1)} aria-label={`Move ${label} down`} title="Move down">
        <ArrowDown className="size-3.5" />
      </button>
    </span>
  );
}

/** Ordered list of features, each a collapsible group of its tasks and bugs. */
export function Backlog({ project }: { project: ProjectDto }) {
  const { tasks, loadError, update, add } = useProjectTasks(project.id);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<NewTaskIntent | null>(null);
  const [drag, setDrag] = useState<{ id: string; group: string } | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);

  const features = tasks?.filter((t) => t.type === "feature") ?? [];
  const featureIds = new Set(features.map((f) => f.id));
  const childrenOf = (featureId: string) => tasks?.filter((t) => t.parent?.id === featureId) ?? [];
  const orphans = tasks?.filter((t) => t.type !== "feature" && !(t.parent && featureIds.has(t.parent.id))) ?? [];

  /** Moves `task` to position `index` among `siblings` (indexes counted without the task itself). */
  async function reorder(siblings: TaskDto[], task: TaskDto, index: number) {
    const others = siblings.filter((t) => t.id !== task.id);
    if (index === siblings.indexOf(task) || index < 0 || index > others.length) return;
    const rank = rankBetween(others[index - 1]?.rank, others[index]?.rank);
    setError(null);
    const err = await update(task, { rank }, { rank });
    if (err) setError(`Couldn't reorder ${task.key}: ${err}`);
  }

  function toggle(id: string) {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function row(task: TaskDto, siblings: TaskDto[], group: string) {
    const i = siblings.indexOf(task);
    const indicator = drop?.id === task.id ? (drop.after ? "shadow-[inset_0_-2px_0_0_var(--primary)]" : "shadow-[inset_0_2px_0_0_var(--primary)]") : "";
    return (
      <li
        key={task.id}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", task.id);
          e.dataTransfer.effectAllowed = "move";
          setDrag({ id: task.id, group });
        }}
        onDragEnd={() => {
          setDrag(null);
          setDrop(null);
        }}
        onDragOver={(e) => {
          // Ranking only reorders within a feature.
          if (!drag || drag.group !== group) return;
          e.preventDefault();
          const box = e.currentTarget.getBoundingClientRect();
          const after = e.clientY > box.top + box.height / 2;
          if (drop?.id !== task.id || drop.after !== after) setDrop({ id: task.id, after });
        }}
        onDrop={(e) => {
          e.preventDefault();
          const dragged = siblings.find((t) => t.id === drag?.id);
          const target = drop;
          setDrag(null);
          setDrop(null);
          if (!dragged || !target || dragged.id === target.id) return;
          const others = siblings.filter((t) => t.id !== dragged.id);
          const at = others.findIndex((t) => t.id === target.id);
          void reorder(siblings, dragged, at + (target.after ? 1 : 0));
        }}
        className={cn(
          "group flex items-center gap-2 border-t border-border py-1.5 pr-2 pl-3 hover:bg-muted/50",
          drag?.id === task.id && "opacity-40",
          indicator,
        )}
      >
        <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground opacity-40 group-hover:opacity-100" aria-hidden />
        <TypeIcon type={task.type} />
        <Link
          href={taskPath(project.id, task.key)}
          draggable={false}
          className="w-16 shrink-0 font-mono text-xs font-semibold whitespace-nowrap text-muted-foreground hover:underline"
        >
          {task.key}
        </Link>
        <Link href={taskPath(project.id, task.key)} draggable={false} className="min-w-0 flex-1 truncate text-sm hover:underline">
          {task.title}
        </Link>
        <span className="hidden max-w-40 @2xl:flex">
          <WaitingBadge keys={task.blockedBy} />
        </span>
        {task.prUrl && <PrBadge url={task.prUrl} state={task.prState} compact />}
        <PriorityBadge priority={task.priority} />
        <span className="flex w-6 shrink-0 items-center gap-1.5 @2xl:w-32" title={task.assignee?.name ?? "Unassigned"}>
          {task.assignee ? (
            <>
              <Avatar id={task.assignee.id} name={task.assignee.name} size="xs" />
              <span className="hidden truncate text-xs @2xl:inline">{task.assignee.name}</span>
            </>
          ) : (
            <span className="hidden text-xs text-muted-foreground @2xl:inline">Unassigned</span>
          )}
        </span>
        <span className="flex w-22 shrink-0 justify-end">
          <StatusPill status={task.status} />
        </span>
        <MoveButtons
          label={task.key}
          canUp={i > 0}
          canDown={i < siblings.length - 1}
          onMove={(d) => void reorder(siblings, task, i + d)}
        />
      </li>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProjectHeader project={project} current="backlog">
        <Button variant="outline" size="sm" onClick={() => setIntent({ type: "feature" })} aria-label="New feature">
          <Plus className="size-4" aria-hidden />
          <span className="hidden @xl:inline">New feature</span>
        </Button>
        <Button
          size="sm"
          onClick={() => setIntent({ type: "task" })}
          disabled={features.length === 0}
          title={features.length === 0 ? "Create a feature first: every task belongs to one" : undefined}
          aria-label="New task"
        >
          <Plus className="size-4" aria-hidden />
          <span className="hidden @xl:inline">New task</span>
        </Button>
      </ProjectHeader>

      {(loadError || error) && (
        <div className="space-y-2 px-5 pt-3">
          {loadError && <InlineError message={`Couldn't load the backlog: ${loadError}`} />}
          {error && <InlineError message={error} onDismiss={() => setError(null)} />}
        </div>
      )}

      {tasks === null && !loadError && <p className="px-5 pt-4 text-sm text-muted-foreground">Loading…</p>}
      {tasks?.length === 0 && <TasksEmpty project={project} onNewFeature={() => setIntent({ type: "feature" })} />}

      {tasks && tasks.length > 0 && (
        <div className="@container min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mx-auto max-w-5xl space-y-3">
            {features.map((f, fi) => {
              const children = childrenOf(f.id);
              const done = children.filter((c) => c.status === "done").length;
              const open = !collapsed.has(f.id);
              const listId = `feature-${f.id}`;
              return (
                <section key={f.id} aria-label={`${f.key} ${f.title}`} className="overflow-hidden rounded-lg border border-border">
                  <div className="flex items-center gap-2 bg-muted/60 py-2 pr-2 pl-1.5">
                    <button
                      type="button"
                      onClick={() => toggle(f.id)}
                      aria-expanded={open}
                      aria-controls={listId}
                      aria-label={`${open ? "Collapse" : "Expand"} ${f.key}`}
                      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
                    </button>
                    <TypeIcon type="feature" />
                    <Link href={taskPath(project.id, f.key)} className="shrink-0 font-mono text-xs font-semibold text-muted-foreground hover:underline">
                      {f.key}
                    </Link>
                    <Link href={taskPath(project.id, f.key)} className="min-w-0 truncate font-semibold hover:underline">
                      {f.title}
                    </Link>
                    <StatusPill status={f.status} />
                    <span className="ml-auto hidden shrink-0 items-center gap-2 text-xs text-muted-foreground @xl:flex">
                      {done}/{children.length} done
                      <ProgressBar done={done} total={children.length} />
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-7 shrink-0 px-2 @xl:ml-0"
                      onClick={() => setIntent({ type: "task", featureId: f.id })}
                      aria-label={`New task in ${f.key}`}
                    >
                      <Plus className="size-3.5" aria-hidden />
                      Task
                    </Button>
                    <MoveButtons
                      label={f.key}
                      canUp={fi > 0}
                      canDown={fi < features.length - 1}
                      onMove={(d) => void reorder(features, f, fi + d)}
                    />
                  </div>
                  {open && (
                    <ul id={listId} aria-label={`Tasks in ${f.key}`}>
                      {children.length === 0 ? (
                        <li className="border-t border-border px-4 py-2.5 text-sm text-muted-foreground">
                          No tasks yet. Ask the PM to break it down, or add one.
                        </li>
                      ) : (
                        children.map((t) => row(t, children, f.id))
                      )}
                    </ul>
                  )}
                </section>
              );
            })}

            {orphans.length > 0 && (
              <section aria-label="Without a feature" className="overflow-hidden rounded-lg border border-border">
                <h2 className="bg-muted/60 px-3 py-2 text-sm font-semibold">Without a feature</h2>
                <ul>{orphans.map((t) => row(t, orphans, ""))}</ul>
              </section>
            )}
          </div>
        </div>
      )}

      {intent && (
        <NewTaskDialog project={project} features={features} intent={intent} onClose={() => setIntent(null)} onCreated={add} />
      )}
    </div>
  );
}
