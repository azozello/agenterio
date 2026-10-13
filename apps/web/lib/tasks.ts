import type { PersonDto, ProjectDto, TaskDto, TaskPriority, TaskRefDto, TaskStatus, TaskType, WorkspaceDto } from "@agentslack/shared";

/** Lifecycle order: the board's columns, left to right. */
export const STATUS_ORDER: TaskStatus[] = ["backlog", "in_progress", "blocked", "ready", "in_review", "done"];

export const PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3"];

export const TYPE_LABELS: Record<TaskType, string> = { feature: "Feature", task: "Task", bug: "Bug" };

/** Statuses that wait on you: a PR to review or merge, or a blocked task. */
export const NEEDS_YOU: ReadonlySet<TaskStatus> = new Set(["ready", "blocked"]);

export function byRank(a: TaskDto, b: TaskDto) {
  return a.rank - b.rank || a.number - b.number;
}

/** Inserts or replaces a task, keeping backlog order. */
export function upsertTask(list: TaskDto[], task: TaskDto): TaskDto[] {
  const i = list.findIndex((t) => t.id === task.id);
  const next = i === -1 ? [...list, task] : list.map((t) => (t.id === task.id ? task : t));
  return next.sort(byRank);
}

function patchRefs(refs: TaskRefDto[], changed: TaskDto): TaskRefDto[] {
  if (!refs.some((r) => r.id === changed.id)) return refs;
  return refs.map((r) => (r.id === changed.id ? { ...r, title: changed.title, status: changed.status } : r));
}

/** Refreshes the status and title of `changed` wherever `task` refers to it (deps, children, bugs, parent). */
export function withChangedRef(task: TaskDto, changed: TaskDto): TaskDto {
  const dependsOn = patchRefs(task.dependsOn, changed);
  const children = patchRefs(task.children, changed);
  const bugs = patchRefs(task.bugs, changed);
  const parent =
    task.parent?.id === changed.id ? { ...task.parent, title: changed.title, status: changed.status } : task.parent;
  if (dependsOn === task.dependsOn && children === task.children && bugs === task.bugs && parent === task.parent) return task;
  const blockedBy = dependsOn === task.dependsOn ? task.blockedBy : dependsOn.filter((d) => d.status !== "done").map((d) => d.key);
  return { ...task, dependsOn, children, bugs, parent, blockedBy };
}

/** Applies a `task.changed` to a project's list: the task itself and every reference to it. */
export function applyTaskChange(list: TaskDto[], changed: TaskDto): TaskDto[] {
  return upsertTask(
    list.map((t) => (t.id === changed.id ? t : withChangedRef(t, changed))),
    changed,
  );
}

/**
 * A rank strictly between two neighbours. Ranks are floats, so halving keeps working for a long
 * time; the ends step by one.
 */
export function rankBetween(before: number | undefined, after: number | undefined): number {
  if (before !== undefined && after !== undefined) return (before + after) / 2;
  if (before !== undefined) return before + 1;
  if (after !== undefined) return after - 1;
  return 0;
}

export function progress(children: TaskRefDto[]) {
  return { done: children.filter((c) => c.status === "done").length, total: children.length };
}

export function taskPath(projectId: string, key: string) {
  return `/p/${projectId}/t/${encodeURIComponent(key)}`;
}

/** The project a key such as "DEMO-3" belongs to. */
export function projectForKey(workspace: WorkspaceDto, key: string): ProjectDto | undefined {
  const prefix = key.slice(0, key.lastIndexOf("-"));
  return workspace.projects.find((p) => p.key === prefix);
}

/** People who can own a task on a project: its agents and every human. */
export function assignablePeople(people: PersonDto[], projectId: string): PersonDto[] {
  return people
    .filter((p) => p.kind === "human" || p.projectId === projectId)
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "agent" ? -1 : 1));
}

/** Parses a comma separated label list. */
export function parseLabels(text: string): string[] {
  return [...new Set(text.split(",").map((l) => l.trim()).filter(Boolean))];
}
