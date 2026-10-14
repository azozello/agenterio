import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type {
  ClientToServerEvents,
  DmDto,
  InboxItemDto,
  MessageDto,
  PersonDto,
  ServerToClientEvents,
  TaskDto,
} from "@agentslack/shared";
import { canAccessChannel } from "./auth/access.js";
import { actorId, resolveActor, type Actor } from "./auth/actor.js";
import type { AppContext } from "./context.js";
import { markAgentOffline } from "./services/agents.js";
import { isUuid } from "./services/errors.js";

type SocketData = { actor: Actor };

/** How long an agent may be without a socket (e.g. a supervisor restart) before it shows as offline. */
const OFFLINE_GRACE_MS = 10_000;

/**
 * Socket.IO gateway. Browsers authenticate with the session cookie, agents with
 * `auth: { token }`. Sockets join their workspace, person and project rooms on connect and
 * channel rooms on request; the gateway relays bus events to the matching rooms.
 */
export async function attachRealtime(httpServer: HttpServer, ctx: AppContext) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    cors: { origin: ctx.env.webOrigin, credentials: true },
    serveClient: false,
  });

  io.use(async (socket, next) => {
    try {
      const token: unknown = socket.handshake.auth?.token;
      const resolved = await resolveActor(ctx.db, {
        cookie: socket.handshake.headers.cookie,
        authorization: typeof token === "string" ? `Bearer ${token}` : socket.handshake.headers.authorization,
      });
      if (!resolved) return next(new Error("unauthorized"));
      // WebSocket upgrades skip CORS, so check the origin of cookie-authenticated sockets here.
      if (resolved.via === "cookie" && socket.handshake.headers.origin !== ctx.env.webOrigin) {
        return next(new Error("forbidden origin"));
      }
      socket.data.actor = resolved.actor;
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error(String(err)));
    }
  });

  // Presence: an agent is online while its supervisor holds a socket.
  const agentSockets = new Map<string, number>();
  const offlineTimers = new Map<string, NodeJS.Timeout>();

  io.on("connection", (socket) => {
    const actor = socket.data.actor;
    void socket.join([`workspace:${actor.workspaceId}`, `person:${actorId(actor)}`]);
    if (actor.kind === "agent") {
      const id = actor.agentId;
      agentSockets.set(id, (agentSockets.get(id) ?? 0) + 1);
      clearTimeout(offlineTimers.get(id));
      offlineTimers.delete(id);
      socket.on("disconnect", () => {
        const left = (agentSockets.get(id) ?? 1) - 1;
        if (left > 0) return void agentSockets.set(id, left);
        agentSockets.delete(id);
        offlineTimers.set(
          id,
          setTimeout(() => {
            offlineTimers.delete(id);
            markAgentOffline(ctx, id).catch((err: unknown) => console.error("[realtime] marking offline failed", err));
          }, OFFLINE_GRACE_MS),
        );
      });
    }
    const projects =
      actor.kind === "agent"
        ? Promise.resolve([actor.projectId])
        : ctx.db.project.findMany({ where: { workspaceId: actor.workspaceId }, select: { id: true } }).then((ps) => ps.map((p) => p.id));
    projects
      .then((ids) => socket.join(ids.map((id) => `project:${id}`)))
      .catch((err: unknown) => console.error("[realtime] joining project rooms failed", err));

    socket.on("channel:subscribe", async (channelId, ack) => {
      if (typeof ack !== "function") return;
      try {
        const channel = isUuid(channelId) ? await ctx.db.channel.findUnique({ where: { id: channelId } }) : null;
        if (!channel || !(await canAccessChannel(ctx.db, actor, channel))) return ack({ ok: false, error: "forbidden" });
        await socket.join(`channel:${channel.id}`);
        ack({ ok: true });
      } catch (err) {
        console.error("[realtime] subscribe failed", err);
        ack({ ok: false, error: "internal_error" });
      }
    });

    socket.on("channel:unsubscribe", async (channelId, ack) => {
      await socket.leave(`channel:${channelId}`);
      if (typeof ack === "function") ack({ ok: true });
    });
  });

  const unsubscribe = await ctx.bus.subscribe((event) => {
    switch (event.type) {
      case "message.created": {
        const message = event.payload as MessageDto;
        io.to(`channel:${message.channelId}`).emit("message.created", message);
        break;
      }
      case "channel.created": {
        const payload = event.payload as { kind?: string; dm?: DmDto };
        if (payload.kind === "dm" && payload.dm) {
          io.to(payload.dm.memberIds.map((id) => `person:${id}`)).emit("dm.created", payload.dm);
        }
        break;
      }
      case "task.created":
      case "task.updated": {
        const { task } = event.payload as { task: TaskDto };
        io.to(`project:${task.projectId}`).emit("task.changed", task);
        break;
      }
      case "agent.updated": {
        const { person } = event.payload as { person: PersonDto };
        io.to(`workspace:${event.workspaceId}`).emit("person.updated", person);
        break;
      }
      case "inbox.created": {
        const { agentId, item } = event.payload as { agentId: string; item: InboxItemDto };
        io.to(`person:${agentId}`).emit("inbox.created", item);
        break;
      }
    }
  });

  return {
    io,
    /** Also closes the HTTP server. */
    close: async () => {
      for (const timer of offlineTimers.values()) clearTimeout(timer);
      offlineTimers.clear();
      await unsubscribe();
      await io.close();
    },
  };
}
