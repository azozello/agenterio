import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { InboxItemDto, MeDto, MessageDto, TaskDto, ThreadDto } from "@agentslack/shared";
import { startServer } from "../src/server.js";
import { pollPullRequests, type PullRequestInfo } from "../src/services/github.js";
import { api, connect, createFixture, login, nextEvent, resetDb, subscribe, type ClientSocket } from "./helpers.js";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let f: Awaited<ReturnType<typeof createFixture>>;
let cookie: string;
const sockets: ClientSocket[] = [];
const track = (s: ClientSocket) => (sockets.push(s), s);

const as = (who: "human" | "pm" | "mira" | "theo" | "juno") =>
  api(base, who === "human" ? { cookie } : { token: { pm: f.pmToken, mira: f.agentToken, theo: f.teammateToken, juno: f.testerToken }[who] });

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const payload = await r.json();
  expect(r.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const inboxOf = (who: "pm" | "mira" | "theo" | "juno") => json<InboxItemDto[]>(as(who).get("/inbox"));

/** Feature plus one task assigned to Mira, created by the PM. */
async function featureWithTask(extra: Record<string, unknown> = {}) {
  const feature = await json<TaskDto>(as("pm").post(`/projects/${f.projectA.id}/tasks`, { type: "feature", title: "Login" }), 201);
  const task = await json<TaskDto>(
    as("pm").post(`/projects/${f.projectA.id}/tasks`, {
      type: "task",
      title: "Login form",
      parentId: feature.key,
      assigneeId: f.agent.id,
      ...extra,
    }),
    201,
  );
  return { feature, task };
}

beforeAll(async () => {
  server = await startServer();
  base = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server?.close();
});

beforeEach(async () => {
  await resetDb(server.ctx.db);
  f = await createFixture(server.ctx);
  cookie = await login(base);
});

afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
});

describe("creating tasks", () => {
  it("lets the PM create a feature and an assigned task with a thread in #general", async () => {
    const { feature, task } = await featureWithTask();
    expect(feature).toMatchObject({ key: "AAA-1", type: "feature", status: "backlog" });
    expect(task).toMatchObject({
      key: "AAA-2",
      type: "task",
      status: "backlog",
      parent: { key: "AAA-1" },
      assignee: { kind: "agent", handle: "mira" },
      reporter: { kind: "agent", handle: "rowan" },
      threadChannelId: f.generalA.id,
    });

    const thread = await json<ThreadDto>(as("human").get(`/messages/${task.threadMessageId}/thread`));
    expect(thread.root).toMatchObject({ isActivity: true, task: { key: "AAA-2" }, author: { handle: "rowan" } });
    expect(thread.replies.map((r) => r.body)).toEqual(["Assigned AAA-2 to Mira"]);

    const inbox = await inboxOf("mira");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: "task_assigned", task: { key: "AAA-2" } });
  });

  it("enforces who creates what", async () => {
    const feature = await json<TaskDto>(as("pm").post(`/projects/${f.projectA.id}/tasks`, { type: "feature", title: "F" }), 201);
    expect((await as("mira").post(`/projects/${f.projectA.id}/tasks`, { type: "task", title: "x", parentId: feature.id })).status).toBe(403);
    expect((await as("juno").post(`/projects/${f.projectA.id}/tasks`, { type: "task", title: "x", parentId: feature.id })).status).toBe(403);
    expect((await as("juno").post(`/projects/${f.projectA.id}/tasks`, { type: "bug", title: "x", parentId: feature.id })).status).toBe(201);
    expect((await as("pm").post(`/projects/${f.projectA.id}/tasks`, { type: "task", title: "orphan" })).status).toBe(400);
    expect((await as("pm").post(`/projects/${f.projectB.id}/tasks`, { type: "feature", title: "elsewhere" })).status).toBe(403);
  });

  it("only lets the PM assign work, and only to people on the project", async () => {
    const { task } = await featureWithTask();
    expect((await as("mira").patch(`/tasks/${task.key}`, { assigneeId: f.teammate.id })).status).toBe(403);
    expect((await as("pm").patch(`/tasks/${task.key}`, { assigneeId: f.outsider.id })).status).toBe(400);
    const reassigned = await json<TaskDto>(as("pm").patch(`/tasks/${task.key}`, { assigneeId: f.teammate.id }));
    expect(reassigned.assignee?.handle).toBe("theo");
    expect((await inboxOf("theo")).map((i) => i.kind)).toEqual(["task_assigned"]);
  });

  it("finds tasks by key and hides them from other projects", async () => {
    const { task } = await featureWithTask();
    expect((await json<TaskDto>(as("mira").get("/tasks/aaa-2"))).id).toBe(task.id);
    const kaiToken = ((await json<{ token: string }>(as("human").post(`/agents/${f.outsider.id}/tokens`), 201)).token);
    expect((await api(base, { token: kaiToken }).get(`/tasks/${task.key}`)).status).toBe(403);
  });
});

describe("lifecycle", () => {
  it("walks a task from Backlog to Ready and keeps the feature status in step", async () => {
    const { feature, task } = await featureWithTask();
    expect((await as("theo").patch(`/tasks/${task.key}`, { status: "in_progress" })).status).toBe(403);
    await json(as("mira").patch(`/tasks/${task.key}`, { status: "in_progress", branch: "agent/mira/AAA-2-login-form" }));
    expect((await json<TaskDto>(as("human").get(`/tasks/${feature.key}`))).status).toBe("in_progress");

    expect((await as("mira").patch(`/tasks/${task.key}`, { status: "ready" })).status).toBe(400);
    const ready = await json<TaskDto>(
      as("mira").patch(`/tasks/${task.key}`, { status: "ready", prUrl: "https://github.com/acme/app/pull/7" }),
    );
    expect(ready).toMatchObject({ status: "ready", prUrl: "https://github.com/acme/app/pull/7", prState: "open" });
    expect((await as("mira").patch(`/tasks/${task.key}`, { status: "done" })).status).toBe(403);

    const comments = await json<MessageDto[]>(as("human").get(`/tasks/${task.key}/comments`));
    expect(comments.map((c) => c.body)).toEqual([
      "Assigned AAA-2 to Mira",
      "Moved AAA-2: Backlog → In progress",
      "Linked PR https://github.com/acme/app/pull/7",
      "Moved AAA-2: In progress → Ready",
      "Ready for review by Juno",
    ]);
    // Activity lines never land in inboxes.
    expect((await inboxOf("mira")).map((i) => i.kind)).toEqual(["task_assigned"]);
  });

  it("holds a task until its dependencies are done, then tells the assignee", async () => {
    const { feature, task: first } = await featureWithTask();
    const second = await json<TaskDto>(
      as("pm").post(`/projects/${f.projectA.id}/tasks`, {
        type: "task",
        title: "Session cookie",
        parentId: feature.id,
        dependsOn: [first.key],
        assigneeId: f.teammate.id,
      }),
      201,
    );
    expect(second.blockedBy).toEqual(["AAA-2"]);
    expect((await as("theo").patch(`/tasks/${second.key}`, { status: "in_progress" })).status).toBe(400);

    await json(as("human").patch(`/tasks/${first.key}`, { status: "done" }));
    const theoInbox = await inboxOf("theo");
    expect(theoInbox.map((i) => i.kind)).toEqual(["task_assigned", "task_unblocked"]);
    expect((await json<TaskDto>(as("theo").patch(`/tasks/${second.key}`, { status: "in_progress" }))).status).toBe("in_progress");
  });

  it("rejects dependency cycles", async () => {
    const { feature, task: a } = await featureWithTask();
    const b = await json<TaskDto>(
      as("pm").post(`/projects/${f.projectA.id}/tasks`, { type: "task", title: "B", parentId: feature.id, dependsOn: [a.key] }),
      201,
    );
    expect((await as("pm").patch(`/tasks/${a.key}`, { dependsOn: [b.key] })).status).toBe(400);
  });

  it("lets a tester review and send a task back with a bug", async () => {
    const { feature, task } = await featureWithTask();
    await json(as("mira").patch(`/tasks/${task.key}`, { status: "in_progress" }));
    await json(as("mira").patch(`/tasks/${task.key}`, { status: "ready", prUrl: "https://github.com/acme/app/pull/7" }));
    await json(as("juno").patch(`/tasks/${task.key}`, { status: "in_review" }));

    const bug = await json<TaskDto>(
      as("juno").post(`/projects/${f.projectA.id}/tasks`, {
        type: "bug",
        title: "Empty password accepted",
        parentId: feature.id,
        foundIn: task.key,
      }),
      201,
    );
    const back = await json<TaskDto>(as("human").get(`/tasks/${task.key}`));
    expect(back).toMatchObject({ status: "backlog", assignee: null, bugs: [{ key: bug.key }], prUrl: "https://github.com/acme/app/pull/7" });
  });

  it("moves a task to Done when its PR is merged", async () => {
    const { task } = await featureWithTask();
    await json(as("mira").patch(`/tasks/${task.key}`, { status: "in_progress" }));
    await json(as("mira").patch(`/tasks/${task.key}`, { status: "ready", prUrl: "https://github.com/acme/app/pull/7" }));

    const prs: Record<string, PullRequestInfo> = { "acme/app#7": { state: "open", merged: false, draft: false } };
    const fetchPr = async (repo: string, n: number) => prs[`${repo}#${n}`] ?? null;
    await pollPullRequests(server.ctx, fetchPr);
    expect((await json<TaskDto>(as("human").get(`/tasks/${task.key}`))).status).toBe("ready");

    prs["acme/app#7"] = { state: "closed", merged: true, draft: false };
    await pollPullRequests(server.ctx, fetchPr);
    const done = await json<TaskDto>(as("human").get(`/tasks/${task.key}`));
    expect(done).toMatchObject({ status: "done", prState: "merged", parent: { status: "done" } });
    const comments = await json<MessageDto[]>(as("human").get(`/tasks/${task.key}/comments`));
    expect(comments.slice(-2).map((c) => [c.author.kind, c.body])).toEqual([
      ["system", "PR merged: https://github.com/acme/app/pull/7"],
      ["system", "Moved AAA-2: Ready → Done"],
    ]);
  });
});

describe("inbox", () => {
  it("delivers mentions, DMs and replies in an agent's threads, but not chatter", async () => {
    await json(as("human").post(`/channels/${f.generalA.id}/messages`, { body: "just chatting" }), 201);
    await json(as("human").post(`/channels/${f.generalA.id}/messages`, { body: "@mira can you look?" }), 201);
    const dm = await json<{ channel: { id: string } }>(as("human").post("/dms", { personId: f.pm.id }));
    await json(as("human").post(`/channels/${dm.channel.id}/messages`, { body: "let's plan a feature" }), 201);

    const miraInbox = await inboxOf("mira");
    expect(miraInbox.map((i) => [i.kind, i.message?.body])).toEqual([["mention", "@mira can you look?"]]);
    const pmInbox = await inboxOf("pm");
    expect(pmInbox.map((i) => [i.kind, i.channel?.kind])).toEqual([["dm", "dm"]]);

    // The PM replies in the DM; its own message is not delivered back to it.
    await json(as("pm").post(`/channels/${dm.channel.id}/messages`, { body: "Sure, what's the goal?" }), 201);
    expect(await json(as("pm").post("/inbox/ack", { ids: pmInbox.map((i) => i.id) }))).toEqual({ acknowledged: 1 });
    expect(await inboxOf("pm")).toEqual([]);
  });

  it("delivers task comments to the assignee", async () => {
    const { task } = await featureWithTask();
    await json(as("human").post(`/tasks/${task.key}/comments`, { body: "Please add a remember-me checkbox" }), 201);
    const inbox = await inboxOf("mira");
    expect(inbox.map((i) => [i.kind, i.task?.key])).toEqual([
      ["task_assigned", "AAA-2"],
      ["thread_reply", "AAA-2"],
    ]);
  });

  it("delivers an agent's thread reply only to the agents it mentions", async () => {
    const { task } = await featureWithTask();
    await json(as("pm").post(`/tasks/${task.key}/comments`, { body: "Thanks, noted." }), 201);
    expect((await inboxOf("mira")).map((i) => i.kind)).toEqual(["task_assigned"]);
    await json(as("pm").post(`/tasks/${task.key}/comments`, { body: "@mira can you also handle the empty case?" }), 201);
    expect((await inboxOf("mira")).map((i) => i.kind)).toEqual(["task_assigned", "mention"]);
  });

  it("pushes inbox items to the agent's socket", async () => {
    const socket = track(await connect(base, { token: f.agentToken }));
    const pushed = nextEvent(socket, "inbox.created");
    await json(as("human").post(`/channels/${f.generalA.id}/messages`, { body: "@mira ping" }), 201);
    expect((await pushed).kind).toBe("mention");
  });
});

describe("agents and live updates", () => {
  it("gives an agent its role and prompts on /me", async () => {
    const me = await json<MeDto>(as("pm").get("/me"));
    expect(me).toMatchObject({ kind: "agent", handle: "rowan", role: "PM", rolePrompt: "You are the PM.", model: "claude-opus-5-5" });
  });

  it("broadcasts task changes and agent status to the browser", async () => {
    const browser = track(await connect(base, { cookie }));
    await subscribe(browser, f.generalA.id);
    const taskChanged = nextEvent(browser, "task.changed");
    await json(as("pm").post(`/projects/${f.projectA.id}/tasks`, { type: "feature", title: "Live" }), 201);
    expect((await taskChanged).title).toBe("Live");

    const personUpdated = nextEvent(browser, "person.updated");
    await json(as("mira").patch("/me/status", { status: "working", statusText: "Implementing AAA-2" }));
    expect(await personUpdated).toMatchObject({ handle: "mira", status: "working", statusText: "Implementing AAA-2" });
  });
});
