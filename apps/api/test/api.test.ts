import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DmDto, MeDto, MessageDto, ProfileDto, WorkspaceDto } from "@agentslack/shared";
import { startServer } from "../src/server.js";
import {
  ADMIN,
  api,
  connect,
  createFixture,
  login,
  nextEvent,
  resetDb,
  subscribe,
  type ClientSocket,
} from "./helpers.js";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let f: Awaited<ReturnType<typeof createFixture>>;
const sockets: ClientSocket[] = [];

const track = (s: ClientSocket) => (sockets.push(s), s);

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
});

afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
});

describe("human auth", () => {
  it("rejects a wrong password", async () => {
    const res = await api(base, {}).post("/auth/login", { email: ADMIN.email, password: "nope" });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown email", async () => {
    const res = await api(base, {}).post("/auth/login", { email: "who@test.local", password: ADMIN.password });
    expect(res.status).toBe(401);
  });

  it("logs in with a session cookie", async () => {
    const cookie = await login(base);
    const me = (await (await api(base, { cookie }).get("/me")).json()) as MeDto;
    expect(me).toMatchObject({ kind: "human", id: f.admin.id, workspaceId: f.workspace.id });
  });

  it("requires auth for everything but login and health", async () => {
    expect((await api(base, {}).get("/health")).status).toBe(200);
    expect((await api(base, {}).get("/me")).status).toBe(401);
    expect((await api(base, {}).get("/workspace")).status).toBe(401);
    expect((await api(base, { cookie: "as_session=ass_forged" }).get("/me")).status).toBe(401);
  });

  it("ends the session on logout", async () => {
    const cookie = await login(base);
    expect((await api(base, { cookie }).post("/auth/logout")).status).toBe(204);
    expect((await api(base, { cookie }).get("/me")).status).toBe(401);
  });
});

describe("chat", () => {
  it("posts a message, records the event and lists it", async () => {
    const cookie = await login(base);
    const res = await api(base, { cookie }).post(`/channels/${f.generalA.id}/messages`, { body: "hello @mira" });
    expect(res.status).toBe(201);
    const message = (await res.json()) as MessageDto;
    expect(message).toMatchObject({ channelId: f.generalA.id, body: "hello @mira", author: { kind: "human" } });

    const event = await server.ctx.db.event.findFirst({ where: { type: "message.created", subjectId: message.id } });
    expect(event).toMatchObject({ actorKind: "human", actorUserId: f.admin.id, projectId: f.projectA.id });

    const list = (await (await api(base, { cookie }).get(`/channels/${f.generalA.id}/messages`)).json()) as MessageDto[];
    expect(list.map((m) => m.id)).toEqual([message.id]);
  });

  it("rejects empty messages and unknown channels", async () => {
    const cookie = await login(base);
    expect((await api(base, { cookie }).post(`/channels/${f.generalA.id}/messages`, { body: "   " })).status).toBe(400);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await api(base, { cookie }).post(`/channels/${missing}/messages`, { body: "hi" })).status).toBe(404);
  });

  it("delivers a new message live to every client on the channel (M0 gate)", async () => {
    const cookie = await login(base);
    const tabA = track(await connect(base, { cookie }));
    const tabB = track(await connect(base, { cookie }));
    expect(await subscribe(tabA, f.generalA.id)).toEqual({ ok: true });
    expect(await subscribe(tabB, f.generalA.id)).toEqual({ ok: true });

    const receivedA = nextEvent(tabA, "message.created");
    const receivedB = nextEvent(tabB, "message.created");
    const res = await api(base, { cookie }).post(`/channels/${f.generalA.id}/messages`, { body: "live?" });
    const posted = (await res.json()) as MessageDto;

    expect(await receivedA).toEqual(posted);
    expect(await receivedB).toEqual(posted);
  });

  it("does not deliver to clients on other channels", async () => {
    const cookie = await login(base);
    const other = track(await connect(base, { cookie }));
    await subscribe(other, f.standupA.id);
    const received = nextEvent(other, "message.created", 500);
    await api(base, { cookie }).post(`/channels/${f.generalA.id}/messages`, { body: "not for standup" });
    await expect(received).rejects.toThrow(/timed out/);
  });
});

describe("agent auth", () => {
  it("lets an agent post in its project and workspace channels only", async () => {
    const agent = api(base, { token: f.agentToken });
    const own = await agent.post(`/channels/${f.generalA.id}/messages`, { body: "from mira" });
    expect(own.status).toBe(201);
    expect(((await own.json()) as MessageDto).author).toMatchObject({ kind: "agent", handle: "mira" });
    expect((await agent.post(`/channels/${f.announcements.id}/messages`, { body: "hi all" })).status).toBe(201);
    expect((await agent.post(`/channels/${f.generalB.id}/messages`, { body: "sneaky" })).status).toBe(403);
    expect((await agent.get(`/channels/${f.generalB.id}/messages`)).status).toBe(403);
  });

  it("shows an agent only its own project", async () => {
    const ws = (await (await api(base, { token: f.agentToken }).get("/workspace")).json()) as WorkspaceDto;
    expect(ws.projects.map((p) => p.key)).toEqual(["AAA"]);
    expect(ws.channels.map((c) => c.name)).toEqual(["announcements"]);
  });

  it("invalidates the token when the agent moves to another project", async () => {
    await server.ctx.db.agent.update({ where: { id: f.agent.id }, data: { currentProjectId: f.projectB.id } });
    expect((await api(base, { token: f.agentToken }).get("/me")).status).toBe(401);
  });

  it("only lets humans issue agent tokens", async () => {
    const cookie = await login(base);
    const issued = await api(base, { cookie }).post(`/agents/${f.agent.id}/tokens`);
    expect(issued.status).toBe(201);
    const { token } = (await issued.json()) as { token: string };
    expect((await api(base, { token }).get("/me")).status).toBe(200);
    expect((await api(base, { token: f.agentToken }).post(`/agents/${f.agent.id}/tokens`)).status).toBe(403);
  });

  it("lets an agent socket subscribe to its project's channels only", async () => {
    const socket = track(await connect(base, { token: f.agentToken }));
    expect(await subscribe(socket, f.generalA.id)).toEqual({ ok: true });
    expect(await subscribe(socket, f.generalB.id)).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("socket auth", () => {
  it("rejects sockets without credentials", async () => {
    await expect(connect(base, {})).rejects.toThrow(/unauthorized/);
  });

  it("rejects cookie sockets from another origin", async () => {
    const cookie = await login(base);
    await expect(connect(base, { cookie, origin: "http://localhost:6666" })).rejects.toThrow(/forbidden origin/);
  });
});

describe("profiles", () => {
  it("shows an agent's role, project and activity", async () => {
    const cookie = await login(base);
    await api(base, { token: f.agentToken }).post(`/channels/${f.generalA.id}/messages`, { body: "on it" });
    const res = await api(base, { cookie }).get(`/people/${f.agent.id}`);
    expect(res.status).toBe(200);
    const profile = (await res.json()) as ProfileDto;
    expect(profile.person).toMatchObject({ kind: "agent", name: "Mira", handle: "mira", role: "Engineer" });
    expect(profile.project).toMatchObject({ key: "AAA" });
    expect(profile.model).toBe("claude-opus-5-5");
    expect(profile.recentActivity[0]).toMatchObject({ type: "message.created", summary: "Posted in #general" });
  });

  it("returns 404 for unknown people", async () => {
    const cookie = await login(base);
    expect((await api(base, { cookie }).get("/people/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

describe("direct messages", () => {
  it("opens one DM per pair and lists it for both members", async () => {
    const cookie = await login(base);
    const first = (await (await api(base, { cookie }).post("/dms", { personId: f.agent.id })).json()) as DmDto;
    const again = (await (await api(base, { cookie }).post("/dms", { personId: f.agent.id })).json()) as DmDto;
    expect(again.channel.id).toBe(first.channel.id);
    expect(first.memberIds.sort()).toEqual([f.admin.id, f.agent.id].sort());

    const forAgent = (await (await api(base, { token: f.agentToken }).get("/workspace")).json()) as WorkspaceDto;
    expect(forAgent.dms.map((d) => d.channel.id)).toEqual([first.channel.id]);
  });

  it("carries messages between the two members", async () => {
    const cookie = await login(base);
    const dm = (await (await api(base, { cookie }).post("/dms", { personId: f.agent.id })).json()) as DmDto;
    const agentSocket = track(await connect(base, { token: f.agentToken }));
    expect(await subscribe(agentSocket, dm.channel.id)).toEqual({ ok: true });
    const received = nextEvent(agentSocket, "message.created");
    await api(base, { cookie }).post(`/channels/${dm.channel.id}/messages`, { body: "how is it going?" });
    expect((await received).body).toBe("how is it going?");
  });

  it("tells members about a new DM live", async () => {
    const cookie = await login(base);
    const agentSocket = track(await connect(base, { token: f.agentToken }));
    const announced = nextEvent(agentSocket, "dm.created");
    const dm = (await (await api(base, { cookie }).post("/dms", { personId: f.agent.id })).json()) as DmDto;
    expect(await announced).toEqual(dm);
  });

  it("keeps agents out of DMs they are not in, but not you", async () => {
    const cookie = await login(base);
    const agentToAgent = await api(base, { token: f.agentToken }).post("/dms", { personId: f.teammate.id });
    expect(agentToAgent.status).toBe(200);
    const dm = (await agentToAgent.json()) as DmDto;

    const otherToken = await issueTokenFor(cookie, f.teammate.id);
    const strangerDm = (await (await api(base, { cookie }).post("/dms", { personId: f.teammate.id })).json()) as DmDto;
    expect((await api(base, { token: f.agentToken }).get(`/channels/${strangerDm.channel.id}/messages`)).status).toBe(403);
    expect((await api(base, { token: otherToken }).get(`/channels/${dm.channel.id}/messages`)).status).toBe(200);
    // No hidden side channel: you can read agent-to-agent DMs.
    expect((await api(base, { cookie }).get(`/channels/${dm.channel.id}/messages`)).status).toBe(200);
  });

  it("stops agents from DMing agents on other projects and anyone from DMing themselves", async () => {
    expect((await api(base, { token: f.agentToken }).post("/dms", { personId: f.outsider.id })).status).toBe(403);
    expect((await api(base, { token: f.agentToken }).post("/dms", { personId: f.agent.id })).status).toBe(400);
  });
});

async function issueTokenFor(cookie: string, agentId: string) {
  const res = await api(base, { cookie }).post(`/agents/${agentId}/tokens`);
  return ((await res.json()) as { token: string }).token;
}
