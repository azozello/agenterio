import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { createMiddleware } from "hono/factory";
import {
  CommentRequest,
  CreateTaskRequest,
  DmDto,
  InboxItemDto,
  LoginRequest,
  MeDto,
  MessageDto,
  OpenDmRequest,
  PersonDto,
  PostMessageRequest,
  ProfileDto,
  SESSION_COOKIE,
  SetStatusRequest,
  TaskDto,
  TaskStatus,
  TaskType,
  ThreadDto,
  UpdateTaskRequest,
  WorkspaceDto,
} from "@agentslack/shared";
import { createSession, issueAgentToken, resolveActor, type Actor } from "./auth/actor.js";
import { hashPassword, hashToken, verifyPassword } from "./auth/crypto.js";
import type { AppContext } from "./context.js";
import { internalRoutes } from "./internal.js";
import { setAgentStatus } from "./services/agents.js";
import { openDm } from "./services/dms.js";
import { loadMe, toHumanMe } from "./services/dto.js";
import { isUuid, notFound, requireHuman } from "./services/errors.js";
import { ackInbox, listInbox } from "./services/inbox.js";
import { getThread, listChannelMessages, postChannelMessage } from "./services/messages.js";
import { getProfile } from "./services/people.js";
import { commentOnTask, createTask, getTask, listTaskComments, listTasks, updateTask } from "./services/tasks.js";
import { getWorkspace } from "./services/workspace.js";

type Vars = { Variables: { actor: Actor } };

const ErrorDto = z.object({ error: z.string() });
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const body = <T extends z.ZodType>(schema: T, description: string) => ({ ...json(schema, description), required: true });
const ChannelParams = z.object({ channelId: z.string().uuid() });
const TaskParams = z.object({ ref: z.string().describe("Task id or key, e.g. DEMO-3") });

// A wrong email still pays for one hash so response time does not reveal which emails exist.
let dummyHash: Promise<string> | undefined;

export function createApp(ctx: AppContext) {
  const app = new OpenAPIHono<Vars>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: "invalid_request", issues: result.error.issues }, 400);
    },
  });

  app.use("*", cors({ origin: ctx.env.webOrigin, credentials: true }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error("[api] unhandled", err);
    return c.json({ error: "internal_error" }, 500);
  });

  // ---- Public routes. Registered before the auth middleware, so it never runs for them.

  app.get("/health", (c) => c.json({ ok: true }));

  app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "AgentSlack API", version: "0.2.0" } });

  app.openapi(
    createRoute({
      method: "post",
      path: "/auth/login",
      tags: ["auth"],
      request: { body: body(LoginRequest, "Email and password") },
      responses: {
        200: json(MeDto, "Logged in; sets the session cookie"),
        401: json(ErrorDto, "Wrong email or password"),
      },
    }),
    async (c) => {
      const { email, password } = c.req.valid("json");
      const user = await ctx.db.user.findUnique({ where: { email: email.toLowerCase() } });
      const ok = user
        ? await verifyPassword(password, user.passwordHash)
        : await verifyPassword(password, await (dummyHash ??= hashPassword("dummy"))).then(() => false);
      if (!user || !ok) return c.json({ error: "invalid_credentials" }, 401);

      const { token, expiresAt } = await createSession(ctx.db, user.id);
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "Lax",
        secure: ctx.env.secureCookies,
        path: "/",
        expires: expiresAt,
      });
      return c.json(toHumanMe(user), 200);
    },
  );

  app.route("/internal", internalRoutes(ctx));

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await ctx.db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  // ---- Everything below needs a human session or an agent token.

  app.use(
    "*",
    createMiddleware<Vars>(async (c, next) => {
      const resolved = await resolveActor(ctx.db, {
        cookie: c.req.header("cookie"),
        authorization: c.req.header("authorization"),
      });
      if (!resolved) return c.json({ error: "unauthorized" }, 401);
      c.set("actor", resolved.actor);
      await next();
    }),
  );

  // ---- Me and workspace

  app.openapi(
    createRoute({ method: "get", path: "/me", tags: ["me"], responses: { 200: json(MeDto, "The calling human or agent") } }),
    async (c) => c.json(await loadMe(ctx, c.get("actor")), 200),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/me/status",
      tags: ["me"],
      description: "Agents set their presence and one-line status.",
      request: { body: body(SetStatusRequest, "New status") },
      responses: { 200: json(PersonDto, "The agent as others see it") },
    }),
    async (c) => c.json(await setAgentStatus(ctx, c.get("actor"), c.req.valid("json")), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/workspace",
      tags: ["workspace"],
      responses: { 200: json(WorkspaceDto, "Channels, projects and people visible to the caller") },
    }),
    async (c) => c.json(await getWorkspace(ctx, c.get("actor")), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/people/{personId}",
      tags: ["workspace"],
      request: { params: z.object({ personId: z.string().uuid() }) },
      responses: { 200: json(ProfileDto, "Profile and recent activity of a human or agent") },
    }),
    async (c) => c.json(await getProfile(ctx, c.get("actor"), c.req.valid("param").personId), 200),
  );

  // ---- Chat

  app.openapi(
    createRoute({
      method: "post",
      path: "/dms",
      tags: ["chat"],
      description: "Returns the 1:1 DM with a person, creating it on first use.",
      request: { body: body(OpenDmRequest, "Who to message") },
      responses: { 200: json(DmDto, "The DM channel") },
    }),
    async (c) => c.json(await openDm(ctx, c.get("actor"), c.req.valid("json").personId), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/channels/{channelId}/messages",
      tags: ["chat"],
      request: {
        params: ChannelParams,
        query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }),
      },
      responses: { 200: json(z.array(MessageDto), "Latest top-level messages, oldest first") },
    }),
    async (c) => {
      const { channelId } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      return c.json(await listChannelMessages(ctx, c.get("actor"), channelId, limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/channels/{channelId}/messages",
      tags: ["chat"],
      description: "Posts a message, or a thread reply when parentId is set. @handles deliver to agents' inboxes.",
      request: { params: ChannelParams, body: body(PostMessageRequest, "Message") },
      responses: { 201: json(MessageDto, "The created message") },
    }),
    async (c) => {
      const { channelId } = c.req.valid("param");
      return c.json(await postChannelMessage(ctx, c.get("actor"), channelId, c.req.valid("json")), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/messages/{messageId}/thread",
      tags: ["chat"],
      request: { params: z.object({ messageId: z.string().uuid() }) },
      responses: { 200: json(ThreadDto, "Thread root and its replies, oldest first") },
    }),
    async (c) => c.json(await getThread(ctx, c.get("actor"), c.req.valid("param").messageId), 200),
  );

  // ---- Tasks

  app.openapi(
    createRoute({
      method: "get",
      path: "/projects/{projectId}/tasks",
      tags: ["tasks"],
      request: {
        params: z.object({ projectId: z.string().uuid() }),
        query: z.object({
          type: TaskType.optional(),
          status: TaskStatus.optional(),
          assignee: z.string().optional().describe('"me" or a person id'),
        }),
      },
      responses: { 200: json(z.array(TaskDto), "Tasks in backlog order") },
    }),
    async (c) => c.json(await listTasks(ctx, c.get("actor"), c.req.valid("param").projectId, c.req.valid("query")), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/projects/{projectId}/tasks",
      tags: ["tasks"],
      description: "PM creates features and tasks; testers create bugs. Each task gets a thread in #general.",
      request: { params: z.object({ projectId: z.string().uuid() }), body: body(CreateTaskRequest, "New task") },
      responses: { 201: json(TaskDto, "The created task") },
    }),
    async (c) => c.json(await createTask(ctx, c.get("actor"), c.req.valid("param").projectId, c.req.valid("json")), 201),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/tasks/{ref}",
      tags: ["tasks"],
      request: { params: TaskParams },
      responses: { 200: json(TaskDto, "The task") },
    }),
    async (c) => c.json(await getTask(ctx, c.get("actor"), c.req.valid("param").ref), 200),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/tasks/{ref}",
      tags: ["tasks"],
      description: "Edit fields, assign (PM), move status (rules depend on role), link a PR (assignee).",
      request: { params: TaskParams, body: body(UpdateTaskRequest, "Changes") },
      responses: { 200: json(TaskDto, "The updated task") },
    }),
    async (c) => c.json(await updateTask(ctx, c.get("actor"), c.req.valid("param").ref, c.req.valid("json")), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/tasks/{ref}/comments",
      tags: ["tasks"],
      request: { params: TaskParams },
      responses: { 200: json(z.array(MessageDto), "The task thread: activity and comments, oldest first") },
    }),
    async (c) => c.json(await listTaskComments(ctx, c.get("actor"), c.req.valid("param").ref), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/tasks/{ref}/comments",
      tags: ["tasks"],
      request: { params: TaskParams, body: body(CommentRequest, "Comment") },
      responses: { 201: json(MessageDto, "The comment, posted as a reply in the task thread") },
    }),
    async (c) => c.json(await commentOnTask(ctx, c.get("actor"), c.req.valid("param").ref, c.req.valid("json").body), 201),
  );

  // ---- Agents

  app.openapi(
    createRoute({
      method: "get",
      path: "/inbox",
      tags: ["agents"],
      description: "Unhandled inbox items of the calling agent, oldest first.",
      responses: { 200: json(z.array(InboxItemDto), "Inbox") },
    }),
    async (c) => c.json(await listInbox(ctx, c.get("actor")), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/inbox/ack",
      tags: ["agents"],
      request: { body: body(z.object({ ids: z.array(z.string().uuid()).min(1) }), "Items handled") },
      responses: { 200: json(z.object({ acknowledged: z.number() }), "How many were marked handled") },
    }),
    async (c) => c.json({ acknowledged: await ackInbox(ctx, c.get("actor"), c.req.valid("json").ids) }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/tokens",
      tags: ["agents"],
      description: "Issues an API token scoped to the agent's current project. Shown once.",
      request: { params: z.object({ agentId: z.string().uuid() }) },
      responses: { 201: json(z.object({ token: z.string(), projectId: z.string() }), "The new token") },
    }),
    async (c) => {
      const actor = c.get("actor");
      requireHuman(actor);
      const { agentId } = c.req.valid("param");
      const agent = isUuid(agentId) ? await ctx.db.agent.findUnique({ where: { id: agentId } }) : null;
      if (!agent || agent.workspaceId !== actor.workspaceId) throw notFound("agent");
      if (!agent.currentProjectId) throw new HTTPException(409, { message: "agent has no current project" });
      const token = await issueAgentToken(ctx.db, agent.id, agent.currentProjectId);
      return c.json({ token, projectId: agent.currentProjectId }, 201);
    },
  );

  return app;
}
