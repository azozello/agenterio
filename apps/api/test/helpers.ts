import { io, type Socket } from "socket.io-client";
import type { Db } from "@agentslack/db";
import type { ClientToServerEvents, ServerToClientEvents } from "@agentslack/shared";
import { issueAgentToken } from "../src/auth/actor.js";
import { hashPassword } from "../src/auth/crypto.js";
import type { AppContext } from "../src/context.js";
import { createProject } from "../src/services/projects.js";

export const WEB_ORIGIN = "http://localhost:3000";
export const ADMIN = { email: "admin@test.local", password: "test-password-123" };

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export async function resetDb(db: Db) {
  // Every table hangs off workspace, so this clears them all.
  await db.$executeRawUnsafe("TRUNCATE TABLE workspace RESTART IDENTITY CASCADE");
}

/** Workspace with an admin, two projects (A, B), and one agent on A holding a token. */
export async function createFixture(ctx: AppContext) {
  const { db } = ctx;
  const workspace = await db.workspace.create({ data: { name: "Test workspace" } });
  const admin = await db.user.create({
    data: {
      workspaceId: workspace.id,
      email: ADMIN.email,
      name: "admin",
      passwordHash: await hashPassword(ADMIN.password),
      isAdmin: true,
    },
  });
  const announcements = await db.channel.create({ data: { workspaceId: workspace.id, name: "announcements" } });
  const projectA = await createProject(ctx, null, { workspaceId: workspace.id, key: "AAA", name: "A", memberUserIds: [admin.id] });
  const projectB = await createProject(ctx, null, { workspaceId: workspace.id, key: "BBB", name: "B", memberUserIds: [admin.id] });
  const channels = await db.channel.findMany({ where: { workspaceId: workspace.id } });
  const channel = (projectId: string, name: string) => channels.find((c) => c.projectId === projectId && c.name === name)!;

  const role = await db.role.create({ data: { workspaceId: workspace.id, name: "Engineer" } });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      roleId: role.id,
      name: "Mira",
      handle: "mira",
      currentProjectId: projectA.id,
      memberships: { create: { projectId: projectA.id } },
    },
  });
  const agentToken = await issueAgentToken(db, agent.id, projectA.id);
  const teammate = await db.agent.create({
    data: { workspaceId: workspace.id, roleId: role.id, name: "Theo", handle: "theo", currentProjectId: projectA.id },
  });
  const outsider = await db.agent.create({
    data: { workspaceId: workspace.id, roleId: role.id, name: "Kai", handle: "kai", currentProjectId: projectB.id },
  });
  const pmRole = await db.role.create({ data: { workspaceId: workspace.id, name: "PM", basePrompt: "You are the PM." } });
  const testerRole = await db.role.create({ data: { workspaceId: workspace.id, name: "Tester" } });
  const pm = await db.agent.create({
    data: { workspaceId: workspace.id, roleId: pmRole.id, name: "Rowan", handle: "rowan", currentProjectId: projectA.id },
  });
  const tester = await db.agent.create({
    data: { workspaceId: workspace.id, roleId: testerRole.id, name: "Juno", handle: "juno", currentProjectId: projectA.id },
  });
  const pmToken = await issueAgentToken(db, pm.id, projectA.id);
  const testerToken = await issueAgentToken(db, tester.id, projectA.id);
  const teammateToken = await issueAgentToken(db, teammate.id, projectA.id);

  return {
    workspace,
    admin,
    announcements,
    projectA,
    projectB,
    generalA: channel(projectA.id, "general"),
    generalB: channel(projectB.id, "general"),
    standupA: channel(projectA.id, "standup"),
    agent,
    agentToken,
    teammate,
    teammateToken,
    outsider,
    pm,
    pmToken,
    tester,
    testerToken,
  };
}

export async function login(base: string, email = ADMIN.email, password = ADMIN.password): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("as_session="));
  return cookie!.split(";")[0]!;
}

export function api(base: string, auth: { cookie?: string; token?: string }) {
  const headers = (extra?: Record<string, string>) => ({
    ...(auth.cookie ? { cookie: auth.cookie } : {}),
    ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
    ...extra,
  });
  return {
    get: (path: string) => fetch(`${base}${path}`, { headers: headers() }),
    post: (path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    patch: (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "PATCH",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      }),
  };
}

export function connect(base: string, opts: { cookie?: string; token?: string; origin?: string }): Promise<ClientSocket> {
  const socket: ClientSocket = io(base, {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    auth: opts.token ? { token: opts.token } : {},
    extraHeaders: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      origin: opts.origin ?? WEB_ORIGIN,
    },
  });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => {
      socket.close();
      reject(err);
    });
  });
}

export function subscribe(socket: ClientSocket, channelId: string) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => socket.emit("channel:subscribe", channelId, resolve));
}

export function nextEvent<E extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: E,
  timeoutMs = 3000,
): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    const handler = (payload: Parameters<ServerToClientEvents[E]>[0]) => {
      clearTimeout(timer);
      resolve(payload);
    };
    (socket.once as (event: string, listener: typeof handler) => void)(event, handler);
  });
}
