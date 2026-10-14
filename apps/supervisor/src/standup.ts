import { TASK_STATUS_LABELS, type TaskDto } from "@agentslack/shared";

/** How long after the standup time an agent may still post it, so a late start doesn't post at night. */
const LATE_WINDOW_MS = 3 * 60 * 60_000;

/**
 * Today's standup time if it is due now, else null. `at` is "HH:MM" in the supervisor's local
 * time, or "off".
 */
export function standupDue(now: Date, at: string): Date | null {
  const m = at.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const due = new Date(now);
  due.setHours(Number(m[1]), Number(m[2]), 0, 0);
  const late = now.getTime() - due.getTime();
  return late >= 0 && late < LATE_WINDOW_MS ? due : null;
}

export interface StandupInput {
  me: { id: string; role: string | null };
  /** Every task on the project. */
  tasks: TaskDto[];
  /** Start of the period "done" covers: the previous standup. */
  since: Date;
}

const ref = (t: TaskDto) => `${t.key} ${t.title}`;
const list = (items: string[]) => (items.length ? items.join("; ") : "nothing");
const after = (iso: string | null, since: Date) => iso !== null && new Date(iso) >= since;
const reviewing = (t: TaskDto, meId: string) => t.reviewer?.id === meId && (t.status === "ready" || t.status === "in_review") && !t.approvedAt;

/**
 * Done since the last standup, doing today, blocked on: built from the board rather than by a
 * model, so it costs nothing and cannot misreport.
 */
export function composeStandup({ me, tasks, since }: StandupInput): string {
  const work = tasks.filter((t) => t.type !== "feature");
  let done: string[];
  let doing: string[];
  let blocked: string[];

  if (me.role === "Tester") {
    done = [
      ...work.filter((t) => t.approvedBy?.id === me.id && after(t.approvedAt, since)).map((t) => `approved ${ref(t)}`),
      ...work.filter((t) => t.type === "bug" && t.reporter?.id === me.id && after(t.createdAt, since)).map((t) => `filed ${ref(t)}`),
    ];
    doing = work.filter((t) => reviewing(t, me.id)).map((t) => `reviewing ${ref(t)}`);
    blocked = [];
  } else if (me.role === "PM") {
    done = tasks.filter((t) => t.type !== "bug" && t.reporter?.id === me.id && after(t.createdAt, since)).map((t) => `planned ${ref(t)}`);
    doing = tasks
      .filter((t) => t.type === "feature" && t.status !== "done")
      .map((f) => `${ref(f)} (${f.children.filter((c) => c.status === "done").length}/${f.children.length} done)`);
    blocked = [
      ...work.filter((t) => t.status === "blocked").map((t) => `${ref(t)} (${t.assignee?.name ?? "unassigned"})`),
      ...work.filter((t) => t.type === "bug" && t.status === "backlog" && !t.assignee).map((t) => `${t.key} needs an assignee`),
    ];
  } else {
    const mine = work.filter((t) => t.assignee?.id === me.id && !(t.type === "bug" && t.foundIn && t.foundIn.status !== "done"));
    done = mine.filter((t) => t.status === "done" && after(t.updatedAt, since)).map(ref);
    doing = [
      ...mine.filter((t) => t.status === "in_progress" || t.status === "ready" || t.status === "in_review").map((t) => `${ref(t)} (${TASK_STATUS_LABELS[t.status]})`),
      ...mine.filter((t) => t.status === "backlog" && t.blockedBy.length === 0).map((t) => `next: ${ref(t)}`),
    ];
    blocked = [
      ...mine.filter((t) => t.status === "blocked").map(ref),
      ...mine.filter((t) => t.status === "backlog" && t.blockedBy.length > 0).map((t) => `${ref(t)} (waiting on ${t.blockedBy.join(", ")})`),
    ];
  }

  return [`Standup`, `Done: ${list(done)}`, `Doing: ${list(doing)}`, `Blocked: ${list(blocked)}`].join("\n");
}
