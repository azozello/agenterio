"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { Layers, Rows3 } from "lucide-react";
import { TASK_STATUS_LABELS, type ProjectDto, type TaskDto, type TaskStatus } from "@agentslack/shared";
import { STATUS_ORDER, taskPath } from "@/lib/tasks";
import { useProjectTasks } from "@/lib/use-tasks";
import { cn } from "@/lib/utils";
import { Avatar } from "./avatar";
import { ProjectHeader } from "./project-header";
import { ApprovedBadge, PrBadge, PriorityBadge, STATUS_DOTS, TypeIcon, WaitingBadge } from "./task-badges";
import { TasksEmpty } from "./tasks-empty";
import { InlineError } from "./ui/alert";
import { Button } from "./ui/button";

const GRID = "grid grid-cols-[repeat(6,minmax(12.5rem,1fr))] gap-x-3";

interface Lane {
  id: string;
  name: string | null;
  tasks: TaskDto[];
}

function lanesOf(tasks: TaskDto[]): Lane[] {
  const lanes = new Map<string, Lane>();
  for (const t of tasks) {
    const id = t.assignee?.id ?? "";
    const lane = lanes.get(id) ?? { id, name: t.assignee?.name ?? null, tasks: [] };
    lane.tasks.push(t);
    lanes.set(id, lane);
  }
  // People alphabetically, unassigned last.
  return [...lanes.values()].sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name)));
}

function BoardCard({
  task,
  projectId,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  task: TaskDto;
  projectId: string;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (status: TaskStatus) => void;
}) {
  const href = taskPath(projectId, task.key);
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group relative cursor-grab rounded-md border border-border bg-background p-2.5 shadow-xs hover:border-ring/50 active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-center gap-1.5">
        <TypeIcon type={task.type} />
        <span className="shrink-0 font-mono text-xs font-semibold whitespace-nowrap text-muted-foreground">{task.key}</span>
        <PriorityBadge priority={task.priority} />
        <label className="relative z-10 ml-auto">
          <span className="sr-only">Move {task.key} to</span>
          <select
            value={task.status}
            onChange={(e) => onMove(e.target.value as TaskStatus)}
            className="h-6 max-w-24 cursor-pointer rounded border border-border bg-background px-1 text-[11px] opacity-0 group-hover:opacity-100 focus:opacity-100"
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {/* The title link covers the card so the whole card opens the task. */}
      <Link
        href={href}
        draggable={false}
        className="mt-1 line-clamp-3 text-sm leading-snug font-medium after:absolute after:inset-0 after:rounded-md hover:underline"
      >
        {task.title}
      </Link>
      {task.parent && (
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground" title={`Feature ${task.parent.key}`}>
          <Layers className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{task.parent.title}</span>
        </p>
      )}
      {task.blockedBy.length > 0 && (
        <div className="mt-1.5 flex">
          <WaitingBadge keys={task.blockedBy} />
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        {task.assignee ? (
          <>
            <Avatar id={task.assignee.id} name={task.assignee.name} size="xs" />
            <span className="min-w-0 truncate text-xs">{task.assignee.name}</span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Unassigned</span>
        )}
        {(task.approvedBy || task.prUrl) && (
          <span className="relative z-10 ml-auto flex items-center gap-2">
            {task.approvedBy && <ApprovedBadge by={task.approvedBy.name} />}
            {task.prUrl && <PrBadge url={task.prUrl} state={task.prState} />}
          </span>
        )}
      </div>
    </li>
  );
}

function ColumnHeader({ status, count }: { status: TaskStatus; count: number }) {
  return (
    <h2 className="flex items-center gap-2 px-2 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOTS[status])} aria-hidden />
      <span className="truncate">{TASK_STATUS_LABELS[status]}</span>
      <span className="ml-auto rounded-full bg-muted px-1.5 tabular-nums" aria-label={`${count} tasks`}>
        {count}
      </span>
    </h2>
  );
}

/** Kanban of a project's tasks and bugs, one column per status in lifecycle order. */
export function Board({ project }: { project: ProjectDto }) {
  const { tasks, loadError, update } = useProjectTasks(project.id);
  const [swimlanes, setSwimlanes] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCell, setOverCell] = useState<string | null>(null);

  const work = tasks?.filter((t) => t.type !== "feature") ?? [];
  const counts = new Map(STATUS_ORDER.map((s) => [s, work.filter((t) => t.status === s).length]));

  async function move(task: TaskDto, status: TaskStatus) {
    if (task.status === status) return;
    setMoveError(null);
    const error = await update(task, { status }, { status });
    if (error) setMoveError(`Couldn't move ${task.key} to ${TASK_STATUS_LABELS[status]}: ${error}`);
  }

  function cell(cellId: string, status: TaskStatus, list: TaskDto[], label: string, className?: string) {
    const over = overCell === cellId;
    return (
      <ul
        key={cellId}
        aria-label={label}
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (overCell !== cellId) setOverCell(cellId);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverCell((c) => (c === cellId ? null : c));
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOverCell(null);
          const id = e.dataTransfer.getData("text/plain") || dragId;
          const task = work.find((t) => t.id === id);
          setDragId(null);
          if (task) void move(task, status);
        }}
        className={cn(
          "flex min-h-16 flex-col gap-2 rounded-lg bg-muted/70 p-2 transition-colors",
          over && "bg-primary/10 ring-2 ring-primary/40 ring-inset",
          className,
        )}
      >
        {list.map((t) => (
          <BoardCard
            key={t.id}
            task={t}
            projectId={project.id}
            dragging={dragId === t.id}
            onDragStart={() => setDragId(t.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverCell(null);
            }}
            onMove={(s) => void move(t, s)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProjectHeader project={project} current="board">
        <Button
          variant="outline"
          size="sm"
          aria-pressed={swimlanes}
          onClick={() => setSwimlanes((v) => !v)}
          className={cn(swimlanes && "bg-muted")}
          aria-label="Swimlanes by assignee"
          title="Group by assignee"
        >
          <Rows3 className="size-4" aria-hidden />
          <span className="hidden @xl:inline">Swimlanes by assignee</span>
        </Button>
      </ProjectHeader>

      {(loadError || moveError) && (
        <div className="space-y-2 px-5 pt-3">
          {loadError && <InlineError message={`Couldn't load tasks: ${loadError}`} />}
          {moveError && <InlineError message={moveError} onDismiss={() => setMoveError(null)} />}
        </div>
      )}

      {tasks === null && !loadError && <p className="px-5 pt-4 text-sm text-muted-foreground">Loading…</p>}
      {tasks !== null && work.length === 0 && <TasksEmpty project={project} />}

      {work.length > 0 && (
        <div className="relative min-h-0 flex-1 overflow-auto">
          {swimlanes ? (
            <div className={cn(GRID, "px-4 pb-6")}>
              {STATUS_ORDER.map((s) => (
                <div key={s} className="sticky top-0 z-20 bg-background pt-3">
                  <ColumnHeader status={s} count={counts.get(s) ?? 0} />
                </div>
              ))}
              {lanesOf(work).map((lane) => (
                <Fragment key={lane.id}>
                  <div className="col-span-6 mt-3 mb-1.5">
                    <h3 className="sticky left-4 inline-flex items-center gap-2 text-sm font-semibold">
                      {lane.name ? <Avatar id={lane.id} name={lane.name} size="xs" /> : null}
                      {lane.name ?? "Unassigned"}
                      <span className="font-normal text-muted-foreground">{lane.tasks.length}</span>
                    </h3>
                  </div>
                  {STATUS_ORDER.map((s) =>
                    cell(
                      `${lane.id}:${s}`,
                      s,
                      lane.tasks.filter((t) => t.status === s),
                      `${lane.name ?? "Unassigned"}, ${TASK_STATUS_LABELS[s]}`,
                    ),
                  )}
                </Fragment>
              ))}
            </div>
          ) : (
            <div className={cn(GRID, "min-h-full px-4 pt-3 pb-6")}>
              {STATUS_ORDER.map((s) => (
                <section key={s} aria-label={TASK_STATUS_LABELS[s]} className="flex min-w-0 flex-col">
                  <ColumnHeader status={s} count={counts.get(s) ?? 0} />
                  {cell(`all:${s}`, s, work.filter((t) => t.status === s), TASK_STATUS_LABELS[s], "flex-1")}
                </section>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
