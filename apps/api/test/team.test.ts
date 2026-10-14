// M2: tester review, bugs found in review, approval, runs, /pause, presence.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { InboxItemDto, MemoryFactDto, MessageDto, PersonDto, TaskDto } from "@agentslack/shared";
import { startServer } from "../src/server.js";
import { addFacts, searchMemory } from "../src/services/memory.js";
import { pollPullRequests } from "../src/services/github.js";
import { issueAgentToken } from "../src/auth/actor.js";
import { api, connect, createFixture, login, nextEvent, resetDb, type ClientSocket } from "./helpers.js";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let f: Awaited<ReturnType<typeof createFixture>>;
let cookie: string;
const sockets: ClientSocket[] = [];
const track = (s: ClientSocket) => (sockets.push(s), s);

type Who = "human" | "pm" | "mira" | "theo" | "juno";
const as = (who: Who) =>
  api(base, who === "human" ? { cookie } : { token: { pm: f.pmToken, mira: f.agentToken, theo: f.teammateToken, juno: f.testerToken }[who] });

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const payload = await r.json();
  expect(r.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const inboxOf = (who: Exclude<Who, "human">) => json<InboxItemDto[]>(as(who).get("/inbox"));
const task = (key: string) => json<TaskDto>(as("human").get(`/tasks/${key}`));
const thread = async (key: string) => (await json<MessageDto[]>(as("human").get(`/tasks/${key}/comments`))).map((m) => m.body);
const PR = "https://github.com/acme/app/pull/7";

/** Feature plus a task Mira has taken to Ready with a PR. */
async function readyTask() {
  const feature = await json<TaskDto>(as("pm").post(`/projects/${f.projectA.id}/tasks`, { type: "feature", title: "Login" }), 201);
  const created = await json<TaskDto>(
    as("pm").post(`/projects/${f.projectA.id}/tasks`, { type: "task", title: "Login form", parentId: feature.key, assigneeId: f.agent.id }),
    201,
  );
  await json(as("mira").patch(`/tasks/${created.key}`, { status: "in_progress" }));
  const ready = await json<TaskDto>(as("mira").patch(`/tasks/${created.key}`, { status: "ready", prUrl: PR }));
  return { feature, task: ready };
}

async function reviewsChannelMessages() {
  const reviews = await server.ctx.db.channel.findFirstOrThrow({ where: { projectId: f.projectA.id, name: "reviews" } });
  return (await json<MessageDto[]>(as("human").get(`/channels/${reviews.id}/messages`))).map((m) => m.body);
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

describe("review", () => {
  it("asks a tester to review when a task reaches Ready", async () => {
    const { task: ready } = await readyTask();
    expect(ready.reviewer).toMatchObject({ handle: "juno" });
    expect((await inboxOf("juno")).map((i) => [i.kind, i.task?.key])).toEqual([["review_requested", ready.key]]);
    expect((await thread(ready.key)).slice(-1)).toEqual(["Ready for review by Juno"]);
    expect(await reviewsChannelMessages()).toEqual([`${ready.key} Login form is ready for review by Juno: ${PR}`]);
    expect((await json<TaskDto[]>(as("juno").get(`/projects/${f.projectA.id}/tasks?reviewer=me`))).map((t) => t.key)).toEqual([ready.key]);
  });

  it("spreads reviews across testers and keeps a task with its reviewer", async () => {
    const role = await server.ctx.db.role.findFirstOrThrow({ where: { name: "Tester" } });
    const ana = await server.ctx.db.agent.create({
      data: { workspaceId: f.workspace.id, roleId: role.id, name: "Ana", handle: "ana", currentProjectId: f.projectA.id },
    });
    const { feature, task: first } = await readyTask();
    expect(first.reviewer?.handle).toBe("ana");
    const second = await json<TaskDto>(
      as("pm").post(`/projects/${f.projectA.id}/tasks`, { type: "task", title: "Logout", parentId: feature.key, assigneeId: f.teammate.id }),
      201,
    );
    await json(as("theo").patch(`/tasks/${second.key}`, { status: "in_progress" }));
    expect((await json<TaskDto>(as("theo").patch(`/tasks/${second.key}`, { status: "ready", prUrl: `${PR}0` }))).reviewer?.handle).toBe("juno");

    // Only the reviewer moves or approves it.
    const anaToken = await issueAgentToken(server.ctx.db, ana.id, f.projectA.id);
    expect((await as("juno").patch(`/tasks/${first.key}`, { status: "in_review" })).status).toBe(403);
    await json(api(base, { token: anaToken }).patch(`/tasks/${first.key}`, { status: "in_review" }));
    expect((await as("juno").post(`/tasks/${first.key}/approve`, {})).status).toBe(403);
  });

  it("records the reviewer's approval and drops it when the task leaves In review", async () => {
    const { task: ready } = await readyTask();
    expect((await as("juno").post(`/tasks/${ready.key}/approve`, {})).status).toBe(400);
    expect((await as("mira").post(`/tasks/${ready.key}/approve`, {})).status).toBe(403);
    await json(as("juno").patch(`/tasks/${ready.key}`, { status: "in_review" }));
    const approved = await json<TaskDto>(as("juno").post(`/tasks/${ready.key}/approve`, { summary: "Tests pass; tried empty and long passwords." }));
    expect(approved).toMatchObject({ status: "in_review", approvedBy: { handle: "juno" } });
    expect(approved.approvedAt).not.toBeNull();
    expect((await thread(ready.key)).slice(-2)).toEqual(["Tests pass; tried empty and long passwords.", "Approved by Juno: ready to merge"]);
    expect((await reviewsChannelMessages()).slice(-1)).toEqual([`${ready.key} Login form approved by Juno, ready to merge: ${PR}`]);

    const handedBack = await json<TaskDto>(as("juno").patch(`/tasks/${ready.key}`, { status: "ready" }));
    expect(handedBack).toMatchObject({ approvedBy: null, approvedAt: null });
    // Handing a review back does not ask for a new one.
    expect((await inboxOf("juno")).map((i) => i.kind)).toEqual(["review_requested"]);
  });
});

describe("bugs found in review", () => {
  it("runs the M2 gate: bug, PM assigns, dev fixes on the same task, tester approves, merge closes both", async () => {
    const { feature, task: t } = await readyTask();
    await json(as("juno").patch(`/tasks/${t.key}`, { status: "in_review" }));
    const bug = await json<TaskDto>(
      as("juno").post(`/projects/${f.projectA.id}/tasks`, { type: "bug", title: "Empty password accepted", parentId: feature.key, foundIn: t.key }),
      201,
    );
    expect(bug).toMatchObject({ foundIn: { key: t.key }, assignee: null, status: "backlog" });
    expect(await task(t.key)).toMatchObject({ status: "backlog", assignee: null, reviewer: { handle: "juno" }, bugs: [{ key: bug.key }] });
    expect((await inboxOf("pm")).map((i) => [i.kind, i.task?.key])).toEqual([["bug_filed", bug.key]]);

    // The PM assigns the bug; the task it was found in comes along, and only the task is delivered.
    await json(as("pm").patch(`/tasks/${bug.key}`, { assigneeId: f.agent.id }));
    expect(await task(t.key)).toMatchObject({ assignee: { handle: "mira" } });
    expect(await task(bug.key)).toMatchObject({ assignee: { handle: "mira" } });
    expect((await inboxOf("mira")).map((i) => [i.kind, i.task?.key])).toEqual([
      ["task_assigned", t.key],
      ["task_assigned", t.key],
    ]);

    // The bug follows the task; the dev cannot move it on its own.
    expect((await as("mira").patch(`/tasks/${bug.key}`, { status: "in_progress" })).status).toBe(400);
    await json(as("mira").patch(`/tasks/${t.key}`, { status: "in_progress" }));
    expect((await task(bug.key)).status).toBe("in_progress");
    const again = await json<TaskDto>(as("mira").patch(`/tasks/${t.key}`, { status: "ready" }));
    expect(again.reviewer?.handle).toBe("juno");
    expect((await task(bug.key)).status).toBe("ready");
    expect((await inboxOf("juno")).filter((i) => i.kind === "review_requested")).toHaveLength(2);

    await json(as("juno").patch(`/tasks/${t.key}`, { status: "in_review" }));
    await json(as("juno").post(`/tasks/${t.key}/approve`, {}));
    await pollPullRequests(server.ctx, async () => ({ state: "closed", merged: true, draft: false }));
    expect(await task(t.key)).toMatchObject({ status: "done", prState: "merged" });
    expect(await task(bug.key)).toMatchObject({ status: "done" });
    expect((await task(feature.key)).status).toBe("done");
    expect((await thread(bug.key)).slice(-1)).toEqual([`Moved ${bug.key}: In review → Done (follows ${t.key})`]);
  });

  it("leaves bugs found after a merge to their own lifecycle", async () => {
    const { feature, task: t } = await readyTask();
    await json(as("human").patch(`/tasks/${t.key}`, { status: "done" }));
    const bug = await json<TaskDto>(
      as("juno").post(`/projects/${f.projectA.id}/tasks`, {
        type: "bug",
        title: "Crash on submit",
        parentId: feature.key,
        foundIn: t.key,
        assigneeId: undefined,
      }),
      201,
    );
    expect((await task(t.key)).status).toBe("done");
    await json(as("pm").patch(`/tasks/${bug.key}`, { assigneeId: f.teammate.id }));
    expect((await task(t.key)).assignee?.handle).toBe("mira");
    expect((await json<TaskDto>(as("theo").patch(`/tasks/${bug.key}`, { status: "in_progress" }))).status).toBe("in_progress");
  });
});

describe("runs", () => {
  it("records the model and effort a session runs on in the task thread", async () => {
    const { task: t } = await readyTask();
    await json(as("mira").post(`/tasks/${t.key}/runs`, { kind: "task", model: "claude-sonnet-5-5", effort: "medium", router: "laya", confidence: 0.86 }), 201);
    await json(as("juno").post(`/tasks/${t.key}/runs`, { kind: "review", model: "claude-opus-5-5", effort: "high", router: "fallback", reason: "Laya confidence 0.41 < 0.60" }), 201);
    expect((await thread(t.key)).slice(-2)).toEqual([
      "Started a work session on claude-sonnet-5-5 at medium effort (routed by Laya, confidence 0.86)",
      "Started a review on claude-opus-5-5 at high effort (fallback: Laya confidence 0.41 < 0.60)",
    ]);
    expect((await as("theo").post(`/tasks/${t.key}/runs`, { kind: "task", model: "x", effort: "low", router: "agent" })).status).toBe(403);
  });
});

describe("memory", () => {
  it("keeps what an agent remembers, skips duplicates, and finds the relevant facts first", async () => {
    await json(as("mira").post("/memory", { content: "The sandbox repo runs tests with node --test, not jest." }), 201);
    await json(as("mira").post("/memory", { content: "Denys prefers small PRs with one commit per step." }), 201);
    expect(await json<unknown[]>(as("mira").post("/memory", { content: "The sandbox repo runs tests with node --test, not JEST" }), 201)).toEqual([]);
    await json(as("theo").post("/memory", { content: "Theo's private note about jest snapshots." }), 201);

    const hits = await json<MemoryFactDto[]>(as("mira").get(`/memory?q=${encodeURIComponent("write tests for the greeter")}&limit=5`));
    expect(hits.map((h) => h.content)).toEqual([
      "The sandbox repo runs tests with node --test, not jest.",
      "Denys prefers small PRs with one commit per step.",
    ]);
    expect(hits[0]!.useCount).toBe(1);
  });

  it("shares project facts with the team, keeps agent facts private, and shows them to you", async () => {
    await json(as("mira").post("/memory", { content: "CI needs Node 22 for the sandbox repo.", scope: "project" }), 201);
    await json(as("mira").post("/memory", { content: "I keep forgetting to run the linter.", scope: "agent" }), 201);
    expect((await json<MemoryFactDto[]>(as("theo").get("/memory?q=node"))).map((h) => h.content)).toEqual(["CI needs Node 22 for the sandbox repo."]);

    const all = await json<MemoryFactDto[]>(as("human").get(`/people/${f.agent.id}/memory`));
    expect(all.map((h) => h.scope).sort()).toEqual(["agent", "project"]);
    expect((await json<MemoryFactDto[]>(as("theo").get(`/people/${f.agent.id}/memory`))).map((h) => h.scope)).toEqual(["project"]);

    expect((await as("theo").delete(`/memory/${all[0]!.id}`)).status).toBe(403);
    expect((await as("human").delete(`/memory/${all[0]!.id}`)).status).toBe(204);
    expect(await json<MemoryFactDto[]>(as("human").get(`/people/${f.agent.id}/memory`))).toHaveLength(1);
  });

  it("lets the model proxy save extracted facts for an agent", async () => {
    const saved = await addFacts(server.ctx, null, f.agent.id, [{ content: "Use gh pr checkout to test PRs." }, { content: "Use gh pr checkout to test PRs!" }], "AAA-2 task session");
    expect(saved.map((s) => [s.content, s.source])).toEqual([["Use gh pr checkout to test PRs.", "AAA-2 task session"]]);
    expect((await searchMemory(server.ctx.db, f.agent.id, "review a pull request checkout")).map((s) => s.content)).toEqual([
      "Use gh pr checkout to test PRs.",
    ]);
  });
});

describe("pause and presence", () => {
  it("lets a human pause and resume one agent or all of them", async () => {
    expect((await as("pm").post(`/agents/${f.agent.id}/pause`)).status).toBe(403);
    const browser = track(await connect(base, { cookie }));
    const updated = nextEvent(browser, "person.updated");
    expect(await json<PersonDto>(as("human").post(`/agents/${f.agent.id}/pause`))).toMatchObject({ handle: "mira", paused: true });
    expect(await updated).toMatchObject({ handle: "mira", paused: true });
    expect((await json<{ paused: boolean }>(as("mira").get("/me"))).paused).toBe(true);

    const all = await json<PersonDto[]>(as("human").post("/agents/pause-all"));
    expect(all.map((p) => p.handle).sort()).toEqual(["juno", "kai", "rowan", "theo"]);
    const resumed = await json<PersonDto[]>(as("human").post("/agents/resume-all"));
    expect(resumed).toHaveLength(5);
    expect(resumed.every((p) => !p.paused)).toBe(true);
  });

  it("shows an agent offline once its supervisor's socket is gone", async () => {
    await json(as("mira").patch("/me/status", { status: "working", statusText: "Implementing AAA-2" }));
    const agent = await connect(base, { token: f.agentToken });
    const browser = track(await connect(base, { cookie }));
    const offline = new Promise<PersonDto>((resolve) => {
      browser.on("person.updated", (p) => p.handle === "mira" && p.status === "offline" && resolve(p));
    });
    agent.close();
    expect(await offline).toMatchObject({ status: "offline", statusText: "Implementing AAA-2" });
  }, 20_000);
});
