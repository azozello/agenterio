import { HTTPException } from "hono/http-exception";
import type { Prisma, Project, TaskStatus } from "@agentslack/db";
import {
  TASK_STATUS_LABELS,
  type ApproveTaskRequest,
  type CreateTaskRequest,
  type DomainEvent,
  type MessageDto,
  type RecordRunRequest,
  type TaskDto,
  type UpdateTaskRequest,
} from "@agentslack/shared";
import { actorId, type Actor } from "../auth/actor.js";
import { publishAll, type AppContext } from "../context.js";
import { recordEvent } from "../events/record.js";
import { agentRef, humanRef, taskKey, toChannelDto, toTaskRef } from "./dto.js";
import { forbidden, isUuid, notFound } from "./errors.js";
import { deliver } from "./inbox.js";
import { messageInclude, toMessageDto } from "./message-dto.js";
import { createMessage } from "./messages.js";

type Tx = Prisma.TransactionClient;
/** Who is changing a task; null is AgentSlack itself (e.g. the PR poller). */
export type Doer = Actor | null;

const badRequest = (message: string) => new HTTPException(400, { message });
const KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

const taskInclude = {
  project: true,
  parent: { include: { project: true } },
  children: { include: { project: true }, orderBy: { number: "asc" } },
  assigneeUser: true,
  assigneeAgent: true,
  reviewer: true,
  approvedByAgent: true,
  approvedByUser: true,
  dependsOn: { include: { dependsOn: { include: { project: true } } } },
  links: { include: { bugTask: { include: { project: true } } } },
  linkedFrom: { where: { kind: "bug" }, include: { task: { include: { project: true } } } },
} satisfies Prisma.TaskInclude;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

// ---- Reading

async function toTaskDtos(db: Tx, rows: TaskRow[]): Promise<TaskDto[]> {
  const userIds = rows.flatMap((r) => (r.reporterUserId ? [r.reporterUserId] : []));
  const agentIds = rows.flatMap((r) => (r.reporterAgentId ? [r.reporterAgentId] : []));
  const threadIds = rows.flatMap((r) => (r.threadMessageId ? [r.threadMessageId] : []));
  const [users, agents, roots] = await Promise.all([
    db.user.findMany({ where: { id: { in: userIds } } }),
    db.agent.findMany({ where: { id: { in: agentIds } } }),
    db.message.findMany({ where: { id: { in: threadIds } }, select: { id: true, targetId: true } }),
  ]);
  const reporters = new Map([...users.map((u) => [u.id, humanRef(u)] as const), ...agents.map((a) => [a.id, agentRef(a)] as const)]);
  const threadChannels = new Map(roots.map((m) => [m.id, m.targetId]));

  return rows.map((r) => {
    const pr = r.links.find((l) => l.kind === "pr");
    return {
      id: r.id,
      key: taskKey(r),
      projectId: r.projectId,
      number: r.number,
      type: r.type,
      title: r.title,
      description: r.description,
      status: r.status,
      priority: r.priority,
      estimate: r.estimate,
      labels: r.labels,
      rank: r.rank,
      parent: r.parent ? toTaskRef(r.parent) : null,
      assignee: r.assigneeAgent ? agentRef(r.assigneeAgent) : r.assigneeUser ? humanRef(r.assigneeUser) : null,
      reporter: reporters.get(r.reporterAgentId ?? r.reporterUserId ?? "") ?? null,
      dependsOn: r.dependsOn.map((d) => toTaskRef(d.dependsOn)),
      blockedBy: r.dependsOn.filter((d) => d.dependsOn.status !== "done").map((d) => taskKey(d.dependsOn)),
      children: r.children.map(toTaskRef),
      bugs: r.links.flatMap((l) => (l.kind === "bug" && l.bugTask ? [toTaskRef(l.bugTask)] : [])),
      foundIn: r.linkedFrom[0] ? toTaskRef(r.linkedFrom[0].task) : null,
      reviewer: r.reviewer ? agentRef(r.reviewer) : null,
      approvedBy: r.approvedByAgent ? agentRef(r.approvedByAgent) : r.approvedByUser ? humanRef(r.approvedByUser) : null,
      approvedAt: r.approvedAt?.toISOString() ?? null,
      prUrl: pr?.url ?? null,
      prState: pr?.state ?? null,
      branch: r.branch,
      threadMessageId: r.threadMessageId,
      threadChannelId: r.threadMessageId ? (threadChannels.get(r.threadMessageId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

export async function loadTaskDto(db: Tx, id: string): Promise<TaskDto> {
  const row = await db.task.findUniqueOrThrow({ where: { id }, include: taskInclude });
  return (await toTaskDtos(db, [row]))[0]!;
}

async function accessibleProject(ctx: AppContext, actor: Actor, projectId: string): Promise<Project> {
  if (!isUuid(projectId)) throw notFound("project");
  const project = await ctx.db.project.findUnique({ where: { id: projectId } });
  if (!project || project.workspaceId !== actor.workspaceId) throw notFound("project");
  if (actor.kind === "agent" && project.id !== actor.projectId) throw forbidden("project is not yours");
  return project;
}

/** By id or key (e.g. "DEMO-3"), within one project. */
async function resolveInProject(tx: Tx, project: Project, ref: string) {
  const m = ref.match(KEY);
  const task = isUuid(ref)
    ? await tx.task.findUnique({ where: { id: ref }, include: { project: true } })
    : m && m[1]!.toUpperCase() === project.key
      ? await tx.task.findUnique({ where: { projectId_number: { projectId: project.id, number: Number(m[2]) } }, include: { project: true } })
      : null;
  if (!task || task.projectId !== project.id) throw badRequest(`no task ${ref} in project ${project.key}`);
  return task;
}

/** By id or key, checking the actor may see it. */
export async function findTask(ctx: AppContext, actor: Actor, ref: string) {
  const m = ref.match(KEY);
  const task = isUuid(ref)
    ? await ctx.db.task.findUnique({ where: { id: ref }, include: { project: true } })
    : m
      ? await ctx.db.task.findFirst({
          where: { number: Number(m[2]), project: { key: m[1]!.toUpperCase(), workspaceId: actor.workspaceId } },
          include: { project: true },
        })
      : null;
  if (!task || task.project.workspaceId !== actor.workspaceId) throw notFound("task");
  if (actor.kind === "agent" && task.projectId !== actor.projectId) throw forbidden("task is on another project");
  return task;
}

export interface TaskFilter {
  type?: TaskDto["type"];
  status?: TaskStatus;
  /** "me" or a person id. */
  assignee?: string;
  /** "me" or an agent id: tasks this tester reviews. */
  reviewer?: string;
}

export async function listTasks(ctx: AppContext, actor: Actor, projectId: string, f: TaskFilter): Promise<TaskDto[]> {
  await accessibleProject(ctx, actor, projectId);
  const assigneeId = f.assignee === "me" ? actorId(actor) : f.assignee;
  const reviewerId = f.reviewer === "me" ? actorId(actor) : f.reviewer;
  const rows = await ctx.db.task.findMany({
    where: {
      projectId,
      type: f.type,
      status: f.status,
      ...(assigneeId ? { OR: [{ assigneeAgentId: assigneeId }, { assigneeUserId: assigneeId }] } : {}),
      ...(reviewerId ? { reviewerAgentId: reviewerId } : {}),
    },
    include: taskInclude,
    orderBy: [{ rank: "asc" }, { number: "asc" }],
  });
  return toTaskDtos(ctx.db, rows);
}

export async function getTask(ctx: AppContext, actor: Actor, ref: string): Promise<TaskDto> {
  return loadTaskDto(ctx.db, (await findTask(ctx, actor, ref)).id);
}

/** Replies in the task's #general thread, oldest first: activity lines and comments. */
export async function listTaskComments(ctx: AppContext, actor: Actor, ref: string): Promise<MessageDto[]> {
  const task = await findTask(ctx, actor, ref);
  if (!task.threadMessageId) return [];
  const rows = await ctx.db.message.findMany({
    where: { parentId: task.threadMessageId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: messageInclude,
  });
  return rows.map(toMessageDto);
}

// ---- Writing

async function roleOf(db: Tx, doer: Doer): Promise<string> {
  if (!doer) return "system";
  if (doer.kind === "human") return "human";
  const agent = await db.agent.findUniqueOrThrow({ where: { id: doer.agentId }, include: { role: true } });
  return agent.role.name;
}

const isPrivileged = (role: string) => role === "human" || role === "system";

/** Collects events during a transaction; task events are emitted last so they carry final state. */
class Changes {
  readonly events: DomainEvent[] = [];
  private readonly tasks = new Map<string, "task.created" | "task.updated">();

  constructor(
    readonly workspaceId: string,
    readonly doer: Doer,
  ) {}

  touch(taskId: string, type: "task.created" | "task.updated" = "task.updated") {
    if (this.tasks.get(taskId) !== "task.created") this.tasks.set(taskId, type);
  }

  async flushTaskEvents(tx: Tx) {
    for (const [taskId, type] of this.tasks) {
      const task = await loadTaskDto(tx, taskId);
      this.events.push(
        await recordEvent(tx, {
          type,
          workspaceId: this.workspaceId,
          projectId: task.projectId,
          actor: this.doer,
          subjectType: "task",
          subjectId: taskId,
          payload: { task },
        }),
      );
    }
  }
}

const generalChannel = (tx: Tx, projectId: string) =>
  tx.channel.findFirstOrThrow({ where: { projectId, name: "general", kind: "channel" } });

/** Posts a status line into the task's thread. */
async function activity(tx: Tx, task: { projectId: string; threadMessageId: string | null }, c: Changes, body: string) {
  if (!task.threadMessageId) return;
  const channel = await generalChannel(tx, task.projectId);
  const { events } = await createMessage(tx, { channel, author: c.doer, body, parentId: task.threadMessageId, isActivity: true });
  c.events.push(...events);
}

const reviewsChannel = (tx: Tx, projectId: string) =>
  tx.channel.findFirst({ where: { projectId, name: "reviews", kind: "channel" } });

/** An activity line in #reviews, so review requests and approvals are visible in one place. */
async function reviewsNote(tx: Tx, projectId: string, c: Changes, body: string) {
  const channel = await reviewsChannel(tx, projectId);
  if (!channel) return;
  const { events } = await createMessage(tx, { channel, author: c.doer, body, isActivity: true });
  c.events.push(...events);
}

/**
 * The task a bug was found in, while that task is still open. Such a bug is fixed on the task's
 * branch and PR: it follows the task's assignee and status and closes when the task merges.
 */
async function openFoundIn(tx: Tx, bugId: string) {
  const link = await tx.taskLink.findFirst({ where: { kind: "bug", bugTaskId: bugId }, include: { task: { include: { project: true } } } });
  return link && link.task.status !== "done" ? link.task : null;
}

/** Bugs found in this task that are not Done yet. */
async function openReviewBugs(tx: Tx, taskId: string) {
  const links = await tx.taskLink.findMany({
    where: { taskId, kind: "bug", bugTask: { status: { not: "done" } } },
    include: { bugTask: { include: { project: true } } },
  });
  return links.flatMap((l) => (l.bugTask ? [l.bugTask] : []));
}

/**
 * The tester who reviews a task: its earlier reviewer if still a tester on the project, else the
 * unpaused tester with the fewest open reviews. Null when the project has no tester.
 */
async function pickReviewer(tx: Tx, projectId: string, currentId: string | null) {
  const testers = await tx.agent.findMany({
    where: { currentProjectId: projectId, role: { name: "Tester" } },
    orderBy: { handle: "asc" },
  });
  const current = testers.find((t) => t.id === currentId);
  if (current) return current;
  const candidates = testers.filter((t) => t.pausedAt === null);
  if (candidates.length === 0) return testers[0] ?? null;
  const open = await tx.task.groupBy({
    by: ["reviewerAgentId"],
    where: { reviewerAgentId: { in: candidates.map((t) => t.id) }, status: { in: ["ready", "in_review"] }, approvedAt: null },
    _count: true,
  });
  const load = new Map(open.map((o) => [o.reviewerAgentId, o._count]));
  return candidates.reduce((best, t) => ((load.get(t.id) ?? 0) < (load.get(best.id) ?? 0) ? t : best));
}

/** PMs on the project hear about every new bug so one of them decides who fixes it. */
async function notifyPms(tx: Tx, task: Prisma.TaskGetPayload<{ include: { project: true } }>, c: Changes) {
  const pms = await tx.agent.findMany({ where: { currentProjectId: task.projectId, role: { name: "PM" } } });
  const root = task.threadMessageId
    ? await tx.message.findUnique({ where: { id: task.threadMessageId }, include: messageInclude })
    : null;
  const channel = root ? await tx.channel.findUnique({ where: { id: root.targetId } }) : null;
  for (const pm of pms) {
    if (c.doer?.kind === "agent" && c.doer.agentId === pm.id) continue;
    c.events.push(
      await deliver(tx, c.workspaceId, {
        agentId: pm.id,
        kind: "bug_filed",
        task: toTaskRef(task),
        message: root ? toMessageDto(root) : null,
        channel: channel ? toChannelDto(channel) : null,
      }),
    );
  }
}

async function resolveAssignee(tx: Tx, project: Project, personId: string) {
  const agent = await tx.agent.findUnique({ where: { id: personId } });
  if (agent && agent.workspaceId === project.workspaceId) {
    if (agent.currentProjectId !== project.id) throw badRequest(`${agent.name} is not on project ${project.key}`);
    return { agentId: agent.id, userId: null, name: agent.name, handle: agent.handle };
  }
  const user = await tx.user.findUnique({ where: { id: personId } });
  if (user && user.workspaceId === project.workspaceId) return { agentId: null, userId: user.id, name: user.name, handle: null };
  throw badRequest("assignee not found");
}

async function resolveDependencies(tx: Tx, project: Project, refs: string[], selfId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const ref of refs) {
    const dep = await resolveInProject(tx, project, ref);
    if (dep.id === selfId) throw badRequest("a task can't depend on itself");
    if (dep.type === "feature") throw badRequest("depend on tasks, not features");
    if (!ids.includes(dep.id)) ids.push(dep.id);
  }
  // Reject cycles: walk from the new dependencies and make sure we never come back.
  const edges = await tx.taskDependency.findMany({ where: { task: { projectId: project.id }, NOT: { taskId: selfId } } });
  const graph = new Map<string, string[]>();
  for (const e of edges) graph.set(e.taskId, [...(graph.get(e.taskId) ?? []), e.dependsOnId]);
  const stack = [...ids];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next === selfId) throw badRequest("that dependency would create a cycle");
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return ids;
}

function deriveFeatureStatus(statuses: TaskStatus[]): TaskStatus {
  if (statuses.length === 0) return "backlog";
  if (statuses.every((s) => s === "done")) return "done";
  return statuses.some((s) => s !== "backlog") ? "in_progress" : "backlog";
}

async function recomputeFeature(tx: Tx, featureId: string, c: Changes) {
  const children = await tx.task.findMany({ where: { parentId: featureId }, select: { status: true } });
  await tx.task.update({ where: { id: featureId }, data: { status: deriveFeatureStatus(children.map((ch) => ch.status)) } });
  c.touch(featureId);
}

/** Tells assignees of tasks that were waiting on `taskId` that they can start. */
async function notifyUnblocked(tx: Tx, taskId: string, c: Changes) {
  const dependents = await tx.taskDependency.findMany({
    where: { dependsOnId: taskId },
    include: { task: { include: { project: true, dependsOn: { include: { dependsOn: true } } } } },
  });
  for (const { task } of dependents) {
    c.touch(task.id);
    const ready = task.dependsOn.every((d) => d.dependsOn.status === "done");
    if (ready && task.status === "backlog" && task.assigneeAgentId) {
      c.events.push(await deliver(tx, c.workspaceId, { agentId: task.assigneeAgentId, kind: "task_unblocked", task: toTaskRef(task) }));
    }
  }
}

type Assignee = { agentId: string | null; userId: string | null; name: string };

async function currentAssignee(tx: Tx, task: { assigneeAgentId: string | null; assigneeUserId: string | null }): Promise<Assignee | null> {
  if (task.assigneeAgentId) {
    const a = await tx.agent.findUniqueOrThrow({ where: { id: task.assigneeAgentId } });
    return { agentId: a.id, userId: null, name: a.name };
  }
  if (task.assigneeUserId) {
    const u = await tx.user.findUniqueOrThrow({ where: { id: task.assigneeUserId } });
    return { agentId: null, userId: u.id, name: u.name };
  }
  return null;
}

/** Keeps the open bugs found in a task on that task's assignee and status (they are fixed on its branch). */
async function syncReviewBugs(
  tx: Tx,
  task: { id: string; number: number; project: { key: string } },
  c: Changes,
  change: { status?: TaskStatus; assignee?: Assignee | null },
) {
  for (const bug of await openReviewBugs(tx, task.id)) {
    const bugKey = taskKey(bug);
    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (change.status && bug.status !== change.status) {
      data.status = change.status;
      await activity(tx, bug, c, `Moved ${bugKey}: ${TASK_STATUS_LABELS[bug.status]} → ${TASK_STATUS_LABELS[change.status]} (follows ${taskKey(task)})`);
    }
    if (change.assignee !== undefined) {
      const agentId = change.assignee?.agentId ?? null;
      const userId = change.assignee?.userId ?? null;
      if (bug.assigneeAgentId !== agentId || bug.assigneeUserId !== userId) {
        data.assigneeAgentId = agentId;
        data.assigneeUserId = userId;
        await activity(tx, bug, c, change.assignee ? `Assigned ${bugKey} to ${change.assignee.name} (fixed in ${taskKey(task)})` : `Unassigned ${bugKey}`);
      }
    }
    if (Object.keys(data).length === 0) continue;
    await tx.task.update({ where: { id: bug.id }, data });
    c.touch(bug.id);
    if (data.status) {
      if (bug.parentId) await recomputeFeature(tx, bug.parentId, c);
      if (data.status === "done") await notifyUnblocked(tx, bug.id, c);
    }
  }
}

/** Assigns a task together with its review bugs, and tells an agent assignee to start. */
async function assignWithBugs(tx: Tx, task: Prisma.TaskGetPayload<{ include: { project: true } }>, assignee: Assignee | null, c: Changes) {
  const key = taskKey(task);
  const updated = await tx.task.update({
    where: { id: task.id },
    data: { assigneeAgentId: assignee?.agentId ?? null, assigneeUserId: assignee?.userId ?? null },
    include: { project: true },
  });
  c.touch(task.id);
  await activity(tx, task, c, assignee ? `Assigned ${key} to ${assignee.name}` : `Unassigned ${key}`);
  if (assignee?.agentId) c.events.push(await deliver(tx, c.workspaceId, { agentId: assignee.agentId, kind: "task_assigned", task: toTaskRef(updated) }));
  await syncReviewBugs(tx, task, c, { assignee });
}

const TYPE_LABEL = { feature: "feature", task: "task", bug: "bug" } as const;

export async function createTask(ctx: AppContext, actor: Actor, projectId: string, input: CreateTaskRequest): Promise<TaskDto> {
  const project = await accessibleProject(ctx, actor, projectId);
  const role = await roleOf(ctx.db, actor);
  const creators = { feature: ["human", "PM"], task: ["human", "PM"], bug: ["human", "PM", "Tester"] }[input.type];
  if (!creators.includes(role)) throw forbidden(`a ${role} can't create a ${input.type}`);
  if (input.type === "feature" && (input.parentId || input.foundIn || input.dependsOn?.length)) {
    throw badRequest("features have no parent, dependencies or found-in task");
  }
  if (input.type !== "feature" && !input.parentId) throw badRequest("tasks and bugs belong to a feature: set parentId");
  if (input.type !== "bug" && input.foundIn) throw badRequest("only bugs have a found-in task");
  if (input.assigneeId && !isPrivileged(role) && role !== "PM") throw forbidden("only the PM assigns work");

  const c = new Changes(project.workspaceId, actor);
  const taskId = await ctx.db.$transaction(async (tx) => {
    const parent = input.parentId ? await resolveInProject(tx, project, input.parentId) : null;
    if (parent && parent.type !== "feature") throw badRequest("parent must be a feature");
    const assignee = input.assigneeId ? await resolveAssignee(tx, project, input.assigneeId) : null;
    const found = input.foundIn ? await resolveInProject(tx, project, input.foundIn) : null;
    if (found?.type === "feature") throw badRequest("bugs are found in tasks, not features");
    // Found in an open task: the bug is fixed on that task's branch, so it is assigned through it.
    const reviewBug = found !== null && found.status !== "done";

    const { taskCounter } = await tx.project.update({ where: { id: project.id }, data: { taskCounter: { increment: 1 } } });
    const maxRank = await tx.task.aggregate({ where: { projectId }, _max: { rank: true } });
    const task = await tx.task.create({
      data: {
        projectId,
        number: taskCounter,
        type: input.type,
        title: input.title,
        description: input.description ?? "",
        priority: input.priority ?? "P2",
        estimate: input.estimate ?? null,
        labels: input.labels ?? [],
        rank: (maxRank._max.rank ?? 0) + 1,
        parentId: parent?.id ?? null,
        assigneeAgentId: reviewBug ? null : (assignee?.agentId ?? null),
        assigneeUserId: reviewBug ? null : (assignee?.userId ?? null),
        reporterUserId: actor.kind === "human" ? actor.userId : null,
        reporterAgentId: actor.kind === "agent" ? actor.agentId : null,
      },
      include: { project: true },
    });
    c.touch(task.id, "task.created");
    const key = taskKey(task);

    if (input.dependsOn?.length) {
      const deps = await resolveDependencies(tx, project, input.dependsOn, task.id);
      await tx.taskDependency.createMany({ data: deps.map((dependsOnId) => ({ taskId: task.id, dependsOnId })) });
    }

    const channel = await generalChannel(tx, projectId);
    const root = await createMessage(tx, {
      channel,
      author: actor,
      body: `Created ${TYPE_LABEL[input.type]} ${key}: ${input.title}`,
      isActivity: true,
      taskId: task.id,
    });
    c.events.push(...root.events);
    const threaded = await tx.task.update({ where: { id: task.id }, data: { threadMessageId: root.dto.id }, include: { project: true } });

    if (assignee && !reviewBug) {
      await activity(tx, threaded, c, `Assigned ${key} to ${assignee.name}`);
      if (assignee.agentId) {
        c.events.push(await deliver(tx, project.workspaceId, { agentId: assignee.agentId, kind: "task_assigned", task: toTaskRef(threaded) }));
      }
    }

    if (found) {
      await tx.taskLink.create({ data: { taskId: found.id, kind: "bug", bugTaskId: task.id } });
      c.touch(found.id);
      if (reviewBug) {
        const foundKey = taskKey(found);
        if (found.status !== "backlog") {
          // Back to Backlog and unassigned: the PM decides who fixes it.
          await tx.task.update({
            where: { id: found.id },
            data: { status: "backlog", assigneeAgentId: null, assigneeUserId: null, approvedAt: null, approvedByAgentId: null, approvedByUserId: null },
          });
          await activity(tx, found, c, `Bug ${key} found in ${foundKey}. Moved ${foundKey} back to Backlog`);
          if (found.parentId) await recomputeFeature(tx, found.parentId, c);
        } else {
          await activity(tx, found, c, `Bug ${key} found in ${foundKey}`);
        }
        const foundNow = await tx.task.findUniqueOrThrow({ where: { id: found.id }, include: { project: true } });
        await syncReviewBugs(tx, foundNow, c, { status: "backlog", assignee: await currentAssignee(tx, foundNow) });
        if (assignee) await assignWithBugs(tx, foundNow, assignee, c);
      }
    }

    if (input.type === "bug") await notifyPms(tx, threaded, c);
    if (parent) await recomputeFeature(tx, parent.id, c);
    await c.flushTaskEvents(tx);
    return task.id;
  });

  await publishAll(ctx, c.events);
  return loadTaskDto(ctx.db, taskId);
}

interface TransitionContext {
  role: string;
  isAssignee: boolean;
  /** The doer is the task's reviewer, or the task has none yet. */
  mayReview: boolean;
  blockedBy: string[];
  hasPr: boolean;
}

/** Who may move a task between which statuses. Humans and AgentSlack itself may do anything. */
function checkTransition(from: TaskStatus, to: TaskStatus, t: TransitionContext) {
  if (isPrivileged(t.role)) return;
  const move = `${from}->${to}`;
  if (t.role === "Tester" && ["ready->in_review", "in_review->ready", "in_review->backlog"].includes(move)) {
    if (!t.mayReview) throw forbidden("another tester is reviewing this task");
    return;
  }
  if (!t.isAssignee) throw forbidden(`only the assignee or a human can move a task from ${from} to ${to}`);
  switch (move) {
    case "backlog->in_progress":
      if (t.blockedBy.length > 0) throw badRequest(`waiting on ${t.blockedBy.join(", ")}`);
      return;
    case "in_progress->ready":
      if (!t.hasPr) throw badRequest("link the PR (prUrl) before moving to Ready");
      return;
    case "in_progress->blocked":
    case "blocked->in_progress":
    case "ready->in_progress":
      return;
    default:
      throw forbidden(`can't move a task from ${from} to ${to}`);
  }
}

export async function updateTask(ctx: AppContext, actor: Actor, ref: string, input: UpdateTaskRequest): Promise<TaskDto> {
  const task = await findTask(ctx, actor, ref);
  return applyTaskUpdate(ctx, actor, task.id, input);
}

/** Shared by the API and AgentSlack's own automation (doer null). */
export async function applyTaskUpdate(
  ctx: AppContext,
  doer: Doer,
  taskId: string,
  input: UpdateTaskRequest,
  note?: string,
): Promise<TaskDto> {
  const task = await ctx.db.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { project: true, links: true, dependsOn: { include: { dependsOn: { include: { project: true } } } } },
  });
  const role = await roleOf(ctx.db, doer);
  const doerAgentId = doer?.kind === "agent" ? doer.agentId : null;
  const isAssignee = doerAgentId !== null && task.assigneeAgentId === doerAgentId;
  const isReporter = doerAgentId !== null && task.reporterAgentId === doerAgentId;
  const key = taskKey(task);
  const foundIn = task.type === "bug" ? await openFoundIn(ctx.db, task.id) : null;

  const editsFields = (["title", "description", "priority", "estimate", "labels", "dependsOn", "rank"] as const).some(
    (k) => input[k] !== undefined,
  );
  if (editsFields && !(isPrivileged(role) || role === "PM" || isReporter)) throw forbidden("only the PM or the reporter can edit this task");
  if (input.assigneeId !== undefined && !(isPrivileged(role) || role === "PM")) throw forbidden("only the PM assigns work");
  if ((input.prUrl !== undefined || input.branch !== undefined) && !(isPrivileged(role) || isAssignee)) {
    throw forbidden("only the assignee links a PR or branch");
  }
  if (input.dependsOn !== undefined && task.type === "feature") throw badRequest("features have no dependencies");

  const statusChange = input.status !== undefined && input.status !== task.status ? input.status : null;
  if (statusChange) {
    if (task.type === "feature") throw badRequest("a feature's status follows its tasks");
    if (foundIn && !isPrivileged(role)) {
      throw badRequest(`${key} is fixed on ${taskKey(foundIn)}'s branch and follows its status: move ${taskKey(foundIn)} instead`);
    }
    checkTransition(task.status, statusChange, {
      role,
      isAssignee,
      mayReview: task.reviewerAgentId === null || task.reviewerAgentId === doerAgentId,
      blockedBy: task.dependsOn.filter((d) => d.dependsOn.status !== "done").map((d) => taskKey(d.dependsOn)),
      hasPr: Boolean(input.prUrl ?? task.links.find((l) => l.kind === "pr")?.url),
    });
  }

  const c = new Changes(task.project.workspaceId, doer);
  await ctx.db.$transaction(async (tx) => {
    c.touch(task.id);
    if (note) await activity(tx, task, c, note);

    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.estimate !== undefined) data.estimate = input.estimate;
    if (input.labels !== undefined) data.labels = input.labels;
    if (input.rank !== undefined) data.rank = input.rank;
    if (input.branch !== undefined) data.branch = input.branch;
    if (statusChange) data.status = statusChange;
    // An approval covers one review round.
    if (statusChange && statusChange !== "done" && task.approvedAt) {
      data.approvedAt = null;
      data.approvedByAgentId = null;
      data.approvedByUserId = null;
    }
    // Reaching Ready (not a tester handing a review back) asks a tester to review it.
    const requestReview = statusChange === "ready" && task.status !== "in_review" && !foundIn;
    const reviewer = requestReview ? await pickReviewer(tx, task.projectId, task.reviewerAgentId) : null;
    if (reviewer) data.reviewerAgentId = reviewer.id;

    let newAssignee: Awaited<ReturnType<typeof resolveAssignee>> | null = null;
    const assigneeChanged =
      input.assigneeId !== undefined && input.assigneeId !== (task.assigneeAgentId ?? task.assigneeUserId ?? null);
    if (assigneeChanged) {
      newAssignee = input.assigneeId ? await resolveAssignee(tx, task.project, input.assigneeId) : null;
      // A review bug is assigned through the task it was found in, which assigns this bug too.
      if (!foundIn) {
        data.assigneeAgentId = newAssignee?.agentId ?? null;
        data.assigneeUserId = newAssignee?.userId ?? null;
      }
    }

    if (input.dependsOn !== undefined) {
      const deps = await resolveDependencies(tx, task.project, input.dependsOn, task.id);
      await tx.taskDependency.deleteMany({ where: { taskId: task.id } });
      await tx.taskDependency.createMany({ data: deps.map((dependsOnId) => ({ taskId: task.id, dependsOnId })) });
    }

    if (input.prUrl !== undefined) {
      const existing = task.links.find((l) => l.kind === "pr");
      if (existing?.url !== input.prUrl) {
        if (existing) await tx.taskLink.update({ where: { id: existing.id }, data: { url: input.prUrl, state: "open" } });
        else await tx.taskLink.create({ data: { taskId: task.id, kind: "pr", url: input.prUrl, state: "open" } });
        await activity(tx, task, c, `Linked PR ${input.prUrl}`);
      }
    }

    const updated = await tx.task.update({ where: { id: task.id }, data, include: { project: true } });

    if (assigneeChanged && foundIn) {
      await assignWithBugs(tx, foundIn, newAssignee, c);
    } else if (assigneeChanged) {
      await activity(tx, task, c, newAssignee ? `Assigned ${key} to ${newAssignee.name}` : `Unassigned ${key}`);
      if (newAssignee?.agentId) {
        c.events.push(await deliver(tx, c.workspaceId, { agentId: newAssignee.agentId, kind: "task_assigned", task: toTaskRef(updated) }));
      }
      if (task.status !== "done") await syncReviewBugs(tx, task, c, { assignee: newAssignee });
    }
    if (statusChange) {
      await activity(tx, task, c, `Moved ${key}: ${TASK_STATUS_LABELS[task.status]} → ${TASK_STATUS_LABELS[statusChange]}`);
      if (task.parentId) await recomputeFeature(tx, task.parentId, c);
      if (statusChange === "done" || task.status === "done") await notifyUnblocked(tx, task.id, c);
      if (task.status !== "done") await syncReviewBugs(tx, task, c, { status: statusChange });
    }
    if (requestReview) {
      const pr = input.prUrl ?? task.links.find((l) => l.kind === "pr")?.url;
      if (reviewer) {
        await activity(tx, task, c, `Ready for review by ${reviewer.name}`);
        c.events.push(await deliver(tx, c.workspaceId, { agentId: reviewer.id, kind: "review_requested", task: toTaskRef(updated) }));
        await reviewsNote(tx, task.projectId, c, `${key} ${task.title} is ready for review by ${reviewer.name}${pr ? `: ${pr}` : ""}`);
      } else {
        await activity(tx, task, c, `Ready for review, but ${task.project.key} has no tester`);
        await reviewsNote(tx, task.projectId, c, `${key} ${task.title} is ready for review, but ${task.project.key} has no tester${pr ? `: ${pr}` : ""}`);
      }
    }
    await c.flushTaskEvents(tx);
  });

  await publishAll(ctx, c.events);
  return loadTaskDto(ctx.db, task.id);
}

/** A comment is a reply in the task's #general thread, so chat and the board never disagree. */
export async function commentOnTask(ctx: AppContext, actor: Actor, ref: string, body: string): Promise<MessageDto> {
  const task = await findTask(ctx, actor, ref);
  if (!task.threadMessageId) throw badRequest("this task has no thread");
  const { dto, events } = await ctx.db.$transaction(async (tx) =>
    createMessage(tx, { channel: await generalChannel(tx, task.projectId), author: actor, body, parentId: task.threadMessageId }),
  );
  await publishAll(ctx, events);
  return dto;
}

/**
 * The reviewer's verdict that the PR works. It is recorded here because GitHub does not let the
 * shared token approve PRs it opened, and it puts the task in front of you to merge.
 */
export async function approveTask(ctx: AppContext, actor: Actor, ref: string, input: ApproveTaskRequest): Promise<TaskDto> {
  const found = await findTask(ctx, actor, ref);
  const task = await ctx.db.task.findUniqueOrThrow({ where: { id: found.id }, include: { project: true, links: true } });
  const key = taskKey(task);
  if (task.type === "feature") throw badRequest("approve tasks and bugs, not features");
  if (actor.kind === "agent") {
    if ((await roleOf(ctx.db, actor)) !== "Tester") throw forbidden("only testers and humans approve");
    if (task.reviewerAgentId && task.reviewerAgentId !== actor.agentId) throw forbidden(`another tester is reviewing ${key}`);
    if (task.status !== "in_review") throw badRequest(`move ${key} to in_review before approving it`);
  } else if (task.status !== "ready" && task.status !== "in_review") {
    throw badRequest("only tasks in Ready or In review can be approved");
  }
  if (task.approvedAt) return loadTaskDto(ctx.db, task.id);

  const c = new Changes(task.project.workspaceId, actor);
  await ctx.db.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: task.id },
      data: {
        approvedAt: new Date(),
        approvedByAgentId: actor.kind === "agent" ? actor.agentId : null,
        approvedByUserId: actor.kind === "human" ? actor.userId : null,
        reviewerAgentId: task.reviewerAgentId ?? (actor.kind === "agent" ? actor.agentId : null),
      },
    });
    c.touch(task.id);
    if (input.summary && task.threadMessageId) {
      const channel = await generalChannel(tx, task.projectId);
      const { events } = await createMessage(tx, { channel, author: actor, body: input.summary, parentId: task.threadMessageId });
      c.events.push(...events);
    }
    await activity(tx, task, c, `Approved by ${actor.name}: ready to merge`);
    const pr = task.links.find((l) => l.kind === "pr")?.url;
    await reviewsNote(tx, task.projectId, c, `${key} ${task.title} approved by ${actor.name}, ready to merge${pr ? `: ${pr}` : ""}`);
    await c.flushTaskEvents(tx);
  });
  await publishAll(ctx, c.events);
  return loadTaskDto(ctx.db, task.id);
}

/** Records a work or review session the supervisor starts: which model and effort, and why. */
export async function recordRun(ctx: AppContext, actor: Actor, ref: string, input: RecordRunRequest): Promise<void> {
  if (actor.kind !== "agent") throw forbidden("only agents record runs");
  const found = await findTask(ctx, actor, ref);
  const task = await ctx.db.task.findUniqueOrThrow({ where: { id: found.id }, include: { project: true } });
  const mine = input.kind === "review" ? task.reviewerAgentId === actor.agentId : task.assigneeAgentId === actor.agentId;
  if (!mine) throw forbidden(input.kind === "review" ? "you are not reviewing this task" : "this task is not assigned to you");

  const confidence = input.confidence == null ? "" : `, confidence ${input.confidence.toFixed(2)}`;
  const route =
    input.router === "laya"
      ? `routed by Laya${confidence}`
      : input.router === "fallback"
        ? `fallback${input.reason ? `: ${input.reason}` : ""}`
        : "agent's default";
  const memory = input.memory ? `, ${input.memory} fact${input.memory === 1 ? "" : "s"} from memory` : "";
  const c = new Changes(task.project.workspaceId, actor);
  await ctx.db.$transaction(async (tx) => {
    const what = input.kind === "review" ? "Started a review" : "Started a work session";
    await activity(tx, task, c, `${what} on ${input.model} at ${input.effort} effort (${route}${memory})`);
    c.events.push(
      await recordEvent(tx, {
        type: "task.run_started",
        workspaceId: task.project.workspaceId,
        projectId: task.projectId,
        actor,
        subjectType: "task",
        subjectId: task.id,
        payload: { key: taskKey(task), ...input, confidence: input.confidence ?? null },
      }),
    );
  });
  await publishAll(ctx, c.events);
}

