import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { AgentSlackApi, ApiError } from "@agentslack/client";
import type {
  ClientToServerEvents,
  EffortLevel,
  InboxItemDto,
  MeDto,
  ProjectDto,
  ServerToClientEvents,
  TaskDto,
  WorkerRunResult,
} from "@agentslack/shared";
import type { SupervisorEnv } from "./env.js";
import type { LaptopProvider } from "./laptops.js";
import { replyPrompt, systemPrompt, taskPrompt, type Conversation } from "./prompts.js";
import { WorkerClient } from "./worker-client.js";

export interface AgentInfo {
  id: string;
  name: string;
  handle: string;
  role: string;
  projectId: string;
  projectKey: string;
}

const CONVERSATION_KINDS = new Set(["mention", "dm", "thread_reply"]);
const PRIORITY = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
/** Max replies to the same agent within the window, so two agents can't ping-pong forever. */
const AGENT_REPLY_LIMIT = 6;
const AGENT_REPLY_WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

/**
 * One agent's loop (spec: Agent runtime → The loop). Wakes on inbox pushes and on a timer;
 * runs at most one session at a time: reply to messages, or work on one task.
 */
export class AgentSupervisor {
  private readonly api: AgentSlackApi;
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private worker: WorkerClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private wakeAgain = false;
  private stopped = false;
  private me!: MeDto;
  private project!: ProjectDto;
  private readonly attempts = new Map<string, number>();
  private readonly repliesToAgents = new Map<string, number[]>();

  constructor(
    private readonly agent: AgentInfo,
    private readonly token: string,
    private readonly env: SupervisorEnv,
    private readonly laptops: LaptopProvider,
  ) {
    this.api = new AgentSlackApi(env.apiUrl, token);
  }

  private log(...args: unknown[]) {
    console.log(`[${this.agent.handle}]`, ...args);
  }

  async start() {
    this.me = await this.api.me();
    await this.refreshProject();
    await this.api.setStatus("idle", "");
    this.socket = io(this.env.apiUrl, { auth: { token: this.token }, transports: ["websocket"] });
    this.socket.on("inbox.created", () => this.wake());
    this.socket.on("task.changed", (task) => {
      if (task.assignee?.id === this.me.id) this.wake();
    });
    this.socket.on("connect", () => this.wake());
    this.timer = setInterval(() => this.wake(), this.env.tickMs);
    this.log(`online as ${this.me.role} on ${this.project.key}`);
    this.wake();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.socket?.close();
    this.worker?.close();
    await this.api.setStatus("offline", "").catch(() => undefined);
  }

  private async refreshProject() {
    const ws = await this.api.workspace();
    const project = ws.projects.find((p) => p.id === this.me.projectId);
    if (!project) throw new Error(`project ${this.me.projectId} not visible`);
    this.project = project;
    return ws;
  }

  wake() {
    if (this.stopped) return;
    if (this.busy) {
      this.wakeAgain = true;
      return;
    }
    this.busy = true;
    this.tick()
      .catch((err) => this.log("tick failed:", err instanceof Error ? err.message : err))
      .finally(() => {
        this.busy = false;
        if (this.wakeAgain) {
          this.wakeAgain = false;
          setTimeout(() => this.wake(), 500);
        }
      });
  }

  /** Spec loop: drain the inbox, reply if no task is running, otherwise start the next task. */
  private async tick() {
    const inbox = await this.api.inbox();
    const taskSignals = inbox.filter((i) => !CONVERSATION_KINDS.has(i.kind));
    if (taskSignals.length) await this.api.ack(taskSignals.map((i) => i.id));
    let conversation = inbox.filter((i) => CONVERSATION_KINDS.has(i.kind) && i.message);
    conversation = await this.dropPingPong(conversation);

    const mine = await this.api.tasks(this.project.id, { assignee: "me" });

    // A reply in the thread of my blocked task resumes the task instead of a chat reply.
    const resumable = conversation.filter((i) => i.task && mine.some((t) => t.id === i.task!.id && t.status === "blocked"));
    if (resumable.length) {
      const task = mine.find((t) => t.id === resumable[0]!.task!.id)!;
      const items = resumable.filter((i) => i.task!.id === task.id);
      await this.api.updateTask(task.key, { status: "in_progress" });
      const note = `New replies since you blocked this task:\n${items.map((i) => `- ${i.message!.author.name}: ${i.message!.body}`).join("\n")}`;
      await this.workOnTask(await this.api.task(task.key), note);
      await this.api.ack(items.map((i) => i.id));
      return;
    }

    if (conversation.length) {
      await this.handleConversation(conversation);
      return;
    }

    // Resume a task left in progress (e.g. after a restart), else start the next startable one.
    const inProgress = mine.find((t) => t.status === "in_progress" && t.type !== "feature");
    const next =
      inProgress ??
      mine
        .filter((t) => t.status === "backlog" && t.type !== "feature" && t.blockedBy.length === 0)
        .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.rank - b.rank)[0];
    if (next) {
      if (next.status === "backlog") await this.api.updateTask(next.key, { status: "in_progress" });
      await this.workOnTask(await this.api.task(next.key));
    }
  }

  /** Skips messages from an agent we have answered too often lately, to stop agent ping-pong. */
  private async dropPingPong(items: InboxItemDto[]) {
    const now = Date.now();
    const keep: InboxItemDto[] = [];
    const drop: string[] = [];
    for (const item of items) {
      const author = item.message!.author;
      if (author.kind !== "agent") {
        keep.push(item);
        continue;
      }
      const recent = (this.repliesToAgents.get(author.id) ?? []).filter((t) => now - t < AGENT_REPLY_WINDOW_MS);
      if (recent.length >= AGENT_REPLY_LIMIT) drop.push(item.id);
      else keep.push(item);
    }
    if (drop.length) {
      this.log(`skipping ${drop.length} message(s) from agents I've answered ${AGENT_REPLY_LIMIT}x in 10 min`);
      await this.api.ack(drop);
    }
    return keep;
  }

  private async handleConversation(items: InboxItemDto[]) {
    // Group by thread (or by channel for top-level messages) and load recent context for each.
    const groups = new Map<string, InboxItemDto[]>();
    for (const item of items) {
      const key = item.message!.parentId ?? item.message!.channelId;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const conversations: Conversation[] = [];
    for (const [key, group] of groups) {
      const first = group[0]!;
      const isThread = Boolean(first.message!.parentId);
      const context = isThread
        ? await this.api.thread(key).then((t) => [t.root, ...t.replies.slice(-15)])
        : (await this.api.messages(key, 15)).filter((m) => !group.some((g) => g.message!.id === m.id));
      const where = first.channel?.kind === "dm" ? "Direct message" : `#${first.channel?.name ?? "channel"}`;
      conversations.push({
        title: `${where}${isThread ? " (thread)" : ""}${first.task ? `, task ${first.task.key}` : ""}`,
        items: group,
        context,
      });
    }

    const result = await this.runSession("reply", replyPrompt(this.me, conversations), this.env.replyBudgetUsd, 40, "Replying to messages");
    const ids = items.map((i) => i.id);
    if (result || this.bumpAttempts(ids.join(","))) {
      await this.api.ack(ids);
      for (const item of items) {
        const author = item.message!.author;
        if (author.kind === "agent") this.repliesToAgents.set(author.id, [...(this.repliesToAgents.get(author.id) ?? []), Date.now()]);
      }
    }
  }

  private async workOnTask(task: TaskDto, note?: string) {
    const thread = await this.api.taskComments(task.key);
    const result = await this.runSession(
      "task",
      taskPrompt(this.me, task, thread, note),
      this.env.taskBudgetUsd,
      200,
      `Working on ${task.key}: ${task.title}`,
    );
    const after = await this.api.task(task.key);
    if (after.status === "in_progress") {
      // The session ended without finishing or asking: block it so we don't loop on it.
      const why = result ? `${result.subtype}: ${result.text.slice(0, 500)}` : "the session failed";
      await this.api.comment(task.key, `Stopped before finishing ${task.key} (${why}). Marking it blocked; reply in this thread to resume.`);
      await this.api.updateTask(task.key, { status: "blocked" });
    }
    if (after.status === "blocked" || after.status === "in_progress") await this.api.setStatus("blocked", `Waiting on ${task.key}`);
  }

  private bumpAttempts(key: string) {
    const n = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, n);
    return n >= MAX_ATTEMPTS;
  }

  private async ensureWorker(): Promise<WorkerClient> {
    if (this.worker?.open) return this.worker;
    const laptop = await this.laptops.ensure({
      handle: this.agent.handle,
      projectKey: this.project.key,
      env: {
        AGENTSLACK_API_URL: this.env.laptopApiUrl,
        ANTHROPIC_API_KEY: this.env.anthropicApiKey,
        GITHUB_TOKEN: this.env.githubToken,
        GH_TOKEN: this.env.githubToken,
        GIT_AUTHOR_NAME: `${this.agent.name} (AgentSlack)`,
        GIT_AUTHOR_EMAIL: `${this.agent.handle}@agents.agentslack.local`,
        GIT_COMMITTER_NAME: `${this.agent.name} (AgentSlack)`,
        GIT_COMMITTER_EMAIL: `${this.agent.handle}@agents.agentslack.local`,
      },
    });
    this.worker = await WorkerClient.connect(laptop.url, laptop.secret);
    return this.worker;
  }

  /** Runs one session in the laptop. Returns null if it could not run or failed. */
  private async runSession(
    kind: "reply" | "task",
    prompt: string,
    maxBudgetUsd: number,
    maxTurns: number,
    statusText: string,
  ): Promise<WorkerRunResult | null> {
    const ws = await this.refreshProject();
    this.me = await this.api.me();
    await this.api.setStatus("working", statusText);
    const runId = randomUUID();
    this.log(`${kind} session ${runId.slice(0, 8)}: ${statusText}`);
    try {
      const worker = await this.ensureWorker();
      const result = await worker.run(
        {
          type: "run",
          runId,
          kind,
          prompt,
          systemPrompt: systemPrompt(this.me, ws, this.project),
          model: this.me.model ?? "claude-opus-5-5",
          effort: (this.me.effort ?? "high") as EffortLevel,
          maxTurns,
          maxBudgetUsd,
          agentToken: this.token,
        },
        (a) => this.log(a.kind === "tool" ? `→ ${a.name} ${a.summary}` : `“${a.text.slice(0, 300)}”`),
      );
      this.log(
        `${kind} session done: ${result.subtype}, ${result.numTurns} turns, $${result.costUsd.toFixed(2)}, ${Math.round(result.durationMs / 1000)}s`,
      );
      return result;
    } catch (err) {
      this.log(`${kind} session failed:`, err instanceof Error ? err.message : err);
      if (err instanceof ApiError) throw err;
      return null;
    } finally {
      await this.api.setStatus("idle", "").catch(() => undefined);
    }
  }
}
