import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { AgentSlackApi, ApiError } from "@agentslack/client";
import type {
  ClientToServerEvents,
  EffortLevel,
  InboxItemDto,
  MeDto,
  PersonDto,
  ProjectDto,
  ServerToClientEvents,
  TaskDto,
  WorkerRunResult,
} from "@agentslack/shared";
import type { SupervisorEnv } from "./env.js";
import type { LaptopProvider } from "./laptops.js";
import { pausedReply, replyPrompt, reviewPrompt, systemPrompt, taskPrompt, type Conversation } from "./prompts.js";
import type { ModelProxy, ProxyAgent } from "./proxy/server.js";
import { FALLBACK } from "./router.js";
import { composeStandup, standupDue } from "./standup.js";
import { WorkerClient } from "./worker-client.js";

export interface AgentInfo {
  id: string;
  name: string;
  handle: string;
  role: string;
  projectId: string;
  projectKey: string;
}

const CONVERSATION_KINDS = new Set(["mention", "dm", "thread_reply", "bug_filed"]);
const PRIORITY = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
/** Max replies to the same agent within the window, so two agents can't ping-pong forever. */
const AGENT_REPLY_LIMIT = 6;
const AGENT_REPLY_WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60_000;

/** A bug found in a task that is still open: it is fixed through that task, never started on its own. */
const isReviewBug = (t: TaskDto) => t.type === "bug" && t.foundIn !== null && t.foundIn.status !== "done";

/**
 * One agent's loop (spec: Agent runtime → The loop). Wakes on inbox pushes and on a timer;
 * runs at most one session at a time: reply to messages, work on one task, or review one.
 */
export class AgentSupervisor {
  private readonly api: AgentSlackApi;
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private worker: WorkerClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private wakeAgain = false;
  private stopped = false;
  private paused = false;
  private suspended = false;
  /** The session running in the laptop, so /pause can abort it. */
  private runId: string | null = null;
  private me!: MeDto;
  private project!: ProjectDto;
  private readonly attempts = new Map<string, number>();
  private readonly repliesToAgents = new Map<string, number[]>();
  /** Reviews that ended without a verdict, per task, while the task stayed unchanged. */
  private readonly reviewTries = new Map<string, { updatedAt: string; n: number }>();
  /** DMs already answered with "I'm paused"; they stay in the inbox for after /resume. */
  private readonly pausedAnswered = new Set<string>();
  /** Day of the last standup posted or found, so the channel is read once a day. */
  private lastStandup: string | null = null;

  constructor(
    private readonly agent: AgentInfo,
    private readonly token: string,
    private readonly env: SupervisorEnv,
    private readonly laptops: LaptopProvider,
    private readonly proxy: ModelProxy,
  ) {
    this.api = new AgentSlackApi(env.apiUrl, token);
  }

  private log(...args: unknown[]) {
    console.log(`[${this.agent.handle}]`, ...args);
  }

  async start() {
    this.me = await this.api.me();
    this.paused = this.me.paused;
    const ws = await this.refreshProject();
    // A paused agent keeps its last status so people can see what it was doing.
    const last = ws.people.find((p) => p.id === this.me.id)?.statusText ?? "";
    await this.api.setStatus("idle", this.paused ? last : "");
    this.socket = io(this.env.apiUrl, { auth: { token: this.token }, transports: ["websocket"] });
    this.socket.on("inbox.created", () => this.wake());
    this.socket.on("task.changed", (task) => {
      if (task.assignee?.id === this.me.id || task.reviewer?.id === this.me.id) this.wake();
    });
    this.socket.on("person.updated", (person) => this.onPersonUpdated(person));
    this.socket.on("connect", () => this.wake());
    this.timer = setInterval(() => this.wake(), this.env.tickMs);
    this.log(`online as ${this.me.role} on ${this.project.key}${this.paused ? " (paused)" : ""}`);
    if (this.paused) await this.suspend();
    this.wake();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.socket?.close();
    this.worker?.close();
    await this.api.setStatus("offline", "").catch(() => undefined);
  }

  private onPersonUpdated(person: PersonDto) {
    if (person.id !== this.me.id || person.paused === this.paused) return;
    this.paused = person.paused;
    if (this.paused) {
      this.log("paused: stopping the current run and the laptop");
      if (this.runId) this.worker?.abort(this.runId);
      if (!this.busy) void this.suspend();
    } else {
      this.log("resumed");
      this.wake();
    }
  }

  /** Stops the laptop while paused; the next session starts it again. */
  private async suspend() {
    if (this.suspended) return;
    this.suspended = true;
    this.worker?.close();
    this.worker = null;
    await this.laptops.suspend(this.agent.handle).catch((err: unknown) => this.log("suspending the laptop failed:", err instanceof Error ? err.message : err));
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
        if (this.paused) void this.suspend();
        if (this.wakeAgain) {
          this.wakeAgain = false;
          setTimeout(() => this.wake(), 500);
        }
      });
  }

  /** Spec loop: drain the inbox, reply if no task is running, otherwise work on or review the next task. */
  private async tick() {
    const inbox = await this.api.inbox();
    if (this.paused) return this.answerWhilePaused(inbox);
    await this.maybeStandup().catch((err) => this.log("standup failed:", err instanceof Error ? err.message : err));

    const taskSignals = inbox.filter((i) => !CONVERSATION_KINDS.has(i.kind));
    if (taskSignals.length) await this.api.ack(taskSignals.map((i) => i.id));
    let conversation = inbox.filter((i) => CONVERSATION_KINDS.has(i.kind) && i.message);
    conversation = await this.dropPingPong(conversation);

    const mine = await this.api.tasks(this.project.id, { assignee: "me" });
    const work = mine.filter((t) => t.type !== "feature" && !isReviewBug(t));
    // Messages about a review bug count as messages about the task it is fixed in.
    const viaBug = new Map(mine.filter(isReviewBug).map((b) => [b.id, b.foundIn!.id]));
    const taskOf = (i: InboxItemDto) => (i.task ? (viaBug.get(i.task.id) ?? i.task.id) : null);

    // A reply in the thread of my blocked task resumes the task instead of a chat reply.
    const resumable = conversation.filter((i) => work.some((t) => t.id === taskOf(i) && t.status === "blocked"));
    if (resumable.length) {
      const task = work.find((t) => t.id === taskOf(resumable[0]!))!;
      const items = resumable.filter((i) => taskOf(i) === task.id);
      await this.api.updateTask(task.key, { status: "in_progress" });
      const note = `New replies since you blocked this task:\n${items.map((i) => `- ${i.message!.author.name}: ${i.message!.body}`).join("\n")}`;
      await this.workOnTask(await this.api.task(task.key), note);
      if (!this.paused) await this.api.ack(items.map((i) => i.id));
      return;
    }

    if (conversation.length) {
      await this.handleConversation(conversation);
      return;
    }

    // Resume a task left in progress (e.g. after a restart or /resume), else start the next startable one.
    const inProgress = work.find((t) => t.status === "in_progress");
    const next =
      inProgress ??
      work
        .filter((t) => t.status === "backlog" && t.blockedBy.length === 0)
        .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.rank - b.rank)[0];
    if (next) {
      if (next.status === "backlog") await this.api.updateTask(next.key, { status: "in_progress" });
      await this.workOnTask(await this.api.task(next.key));
      return;
    }

    if (this.me.role === "Tester") {
      const review = await this.nextReview();
      if (review) await this.reviewTask(review);
    }
  }

  /** While paused no model runs; a human's DM gets the agent's last status, once. */
  private async answerWhilePaused(inbox: InboxItemDto[]) {
    const fresh = inbox.filter((i) => i.kind === "dm" && i.message?.author.kind === "human" && !this.pausedAnswered.has(i.id));
    if (fresh.length === 0) return;
    const ws = await this.api.workspace();
    const statusText = ws.people.find((p) => p.id === this.me.id)?.statusText ?? "";
    const current = (await this.api.tasks(this.project.id, { assignee: "me" })).find((t) => t.status === "in_progress" || t.status === "blocked");
    for (const channelId of new Set(fresh.map((i) => i.message!.channelId))) {
      await this.api.post(channelId, pausedReply(statusText, current?.key ?? null));
    }
    for (const item of fresh) this.pausedAnswered.add(item.id);
  }

  /** Posts the daily standup in #standup once it is due, unless it is already there today. */
  private async maybeStandup() {
    const now = new Date();
    const due = standupDue(now, this.env.standupAt);
    if (!due || this.lastStandup === due.toDateString()) return;
    const channel = this.project.channels.find((c) => c.name === "standup");
    if (channel) {
      const recent = await this.api.messages(channel.id, 50);
      if (!recent.some((m) => m.author.id === this.me.id && new Date(m.createdAt) >= due)) {
        const tasks = await this.api.tasks(this.project.id);
        await this.api.post(channel.id, composeStandup({ me: { id: this.me.id, role: this.me.role }, tasks, since: new Date(due.getTime() - DAY_MS) }));
        this.log("posted the standup");
      }
    }
    this.lastStandup = due.toDateString();
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
    // Paused mid-reply: keep the messages for after /resume.
    if (this.paused) return;
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
      task,
    );
    // Paused: leave the task In progress; it continues after /resume.
    if (this.paused) return;
    const after = await this.api.task(task.key);
    if (after.status === "in_progress") {
      // The session ended without finishing or asking: block it so we don't loop on it.
      const why = result ? `${result.subtype}: ${result.text.slice(0, 500)}` : "the session failed";
      await this.api.comment(task.key, `Stopped before finishing ${task.key} (${why}). Marking it blocked; reply in this thread to resume.`);
      await this.api.updateTask(task.key, { status: "blocked" });
    }
    if (after.status === "blocked" || after.status === "in_progress") await this.api.setStatus("blocked", `Waiting on ${task.key}`);
  }

  /** The tester's next review: one already In review first, then Ready ones by priority. */
  private async nextReview(): Promise<TaskDto | undefined> {
    const reviews = await this.api.tasks(this.project.id, { reviewer: "me" });
    return reviews
      .filter((t) => (t.status === "ready" || t.status === "in_review") && !t.approvedAt)
      .filter((t) => {
        const tries = this.reviewTries.get(t.id);
        return !tries || tries.updatedAt !== t.updatedAt || tries.n < MAX_ATTEMPTS;
      })
      .sort(
        (a, b) =>
          Number(b.status === "in_review") - Number(a.status === "in_review") || PRIORITY[a.priority] - PRIORITY[b.priority] || a.rank - b.rank,
      )[0];
  }

  private async reviewTask(task: TaskDto) {
    const t = task.status === "ready" ? await this.api.updateTask(task.key, { status: "in_review" }) : task;
    const thread = await this.api.taskComments(t.key);
    const result = await this.runSession(
      "review",
      reviewPrompt(this.me, t, thread),
      this.env.taskBudgetUsd,
      150,
      `Reviewing ${t.key}: ${t.title}`,
      t,
    );
    if (this.paused) return;
    const after = await this.api.task(t.key);
    if (after.status !== "in_review" || after.approvedAt) return;
    // No verdict: try again later, but not forever on an unchanged task.
    const prev = this.reviewTries.get(t.id);
    const n = prev && prev.updatedAt === after.updatedAt ? prev.n + 1 : 1;
    this.reviewTries.set(t.id, { updatedAt: after.updatedAt, n });
    const why = result ? `${result.subtype}: ${result.text.slice(0, 300)}` : "the session failed";
    await this.api.comment(
      t.key,
      n >= MAX_ATTEMPTS
        ? `I stopped reviewing ${t.key} without a verdict ${n} times (${why}). Leaving it for a human to look at.`
        : `Stopped before finishing the review of ${t.key} (${why}). I'll pick it up again.`,
    );
  }

  /** How the proxy sees this agent. */
  private proxyAgent(): ProxyAgent {
    return {
      id: this.me.id,
      handle: this.agent.handle,
      name: this.me.name,
      role: this.me.role ?? this.agent.role,
      model: this.me.model ?? FALLBACK.model,
      effort: (this.me.effort ?? FALLBACK.effort) as EffortLevel,
    };
  }

  private bumpAttempts(key: string) {
    const n = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, n);
    return n >= MAX_ATTEMPTS;
  }

  private async ensureWorker(): Promise<WorkerClient> {
    if (this.worker?.open) return this.worker;
    this.suspended = false;
    const laptop = await this.laptops.ensure({
      handle: this.agent.handle,
      projectKey: this.project.key,
      env: {
        AGENTSLACK_API_URL: this.env.laptopApiUrl,
        // Every model call goes through the model proxy; the laptop never holds a provider key.
        ANTHROPIC_BASE_URL: this.env.laptopProxyUrl,
        ANTHROPIC_API_KEY: this.proxy.keyFor(this.proxyAgent()),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
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

  /**
   * Runs one session in the laptop. The model proxy picks its model and effort (Laya) and adds
   * memory; task and review sessions record that choice in the task thread. Returns null if the
   * session could not run, failed, or was stopped by /pause.
   */
  private async runSession(
    kind: "reply" | "task" | "review",
    prompt: string,
    maxBudgetUsd: number,
    maxTurns: number,
    statusText: string,
    task?: TaskDto,
  ): Promise<WorkerRunResult | null> {
    const ws = await this.refreshProject();
    this.me = await this.api.me();
    this.paused = this.me.paused;
    if (this.paused) return null;
    await this.api.setStatus("working", statusText);
    const runId = randomUUID();
    const started = await this.proxy.startRun(this.proxyAgent(), { kind, task, prompt });
    const { route } = started;
    const confidence = route.confidence === null ? "" : `, confidence ${route.confidence.toFixed(2)}`;
    this.log(
      `${kind} session ${runId.slice(0, 8)}: ${statusText} → ${route.model} at ${route.effort} (${route.router}${confidence}${route.reason ? `: ${route.reason}` : ""}), ${started.facts} memory fact(s)`,
    );
    if (task) {
      await this.api
        .recordRun(task.key, {
          kind: kind === "review" ? "review" : "task",
          model: route.model,
          effort: route.effort,
          router: route.router,
          confidence: route.confidence,
          reason: route.reason,
          memory: started.facts,
        })
        .catch((err: unknown) => this.log("recording the run failed:", err instanceof Error ? err.message : err));
    }
    let result: WorkerRunResult | null = null;
    try {
      const worker = await this.ensureWorker();
      this.runId = runId;
      result = await worker.run(
        {
          type: "run",
          runId,
          kind,
          prompt,
          systemPrompt: systemPrompt(this.me, ws, this.project),
          model: started.workerModel,
          effort: route.effort,
          maxTurns,
          maxBudgetUsd,
          agentToken: this.token,
        },
        (a) => this.log(a.kind === "tool" ? `→ ${a.name} ${a.summary}` : `“${a.text.slice(0, 300)}”`),
      );
      return this.paused ? null : result;
    } catch (err) {
      this.log(`${kind} session ${this.paused ? "stopped by /pause" : "failed"}:`, err instanceof Error ? err.message : err);
      if (err instanceof ApiError) throw err;
      return null;
    } finally {
      this.runId = null;
      // The proxy's meter is the real cost; the harness prices every call as the model it asked for.
      const usage = this.proxy.endRun(this.me.id, result?.text);
      if (usage) {
        const cost = usage.costUsd === null ? "cost unknown" : `$${usage.costUsd.toFixed(2)}`;
        this.log(
          `${kind} session ${result ? result.subtype : "ended"}: ${result?.numTurns ?? "?"} turns, ${usage.calls} model calls, ${cost} (${usage.inputTokens} in, ${usage.cacheReadTokens} cached, ${usage.outputTokens} out)${result ? `, ${Math.round(result.durationMs / 1000)}s` : ""}`,
        );
      }
      // A paused agent shows what it was doing when it stopped.
      await this.api.setStatus("idle", this.paused ? statusText : "").catch(() => undefined);
    }
  }
}
