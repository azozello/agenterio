import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { issueAgentToken } from "./auth/actor.js";
import type { AppContext } from "./context.js";
import { isUuid } from "./services/errors.js";
import { addFacts, searchMemory } from "./services/memory.js";

function sameSecret(given: string | undefined, expected: string) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Routes for AgentSlack's own host services (the supervisor fleet), authenticated with
 * INTERNAL_SECRET. Without the secret they do not exist.
 */
export function internalRoutes(ctx: AppContext) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!ctx.env.internalSecret || !sameSecret(c.req.header("x-internal-secret"), ctx.env.internalSecret)) {
      return c.json({ error: "not_found" }, 404);
    }
    await next();
  });

  app.get("/agents", async (c) => {
    const agents = await ctx.db.agent.findMany({ include: { role: true, currentProject: true }, orderBy: { handle: "asc" } });
    return c.json(
      agents.map((a) => ({
        id: a.id,
        name: a.name,
        handle: a.handle,
        role: a.role.name,
        model: a.model,
        projectId: a.currentProjectId,
        projectKey: a.currentProject?.key ?? null,
        repos: a.currentProject?.repos ?? [],
      })),
    );
  });

  /** A fresh token for the supervisor; earlier tokens of the agent stop working. */
  app.post("/agents/:id/token", async (c) => {
    const id = c.req.param("id");
    const agent = isUuid(id) ? await ctx.db.agent.findUnique({ where: { id } }) : null;
    if (!agent) return c.json({ error: "agent not found" }, 404);
    if (!agent.currentProjectId) return c.json({ error: "agent has no current project" }, 409);
    await ctx.db.agentToken.updateMany({ where: { agentId: agent.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return c.json({ token: await issueAgentToken(ctx.db, agent.id, agent.currentProjectId), projectId: agent.currentProjectId }, 201);
  });

  /** The model proxy reads an agent's relevant facts when a session starts. */
  app.post("/agents/:id/memory/search", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "agent not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { query?: unknown; limit?: unknown };
    const query = typeof body.query === "string" ? body.query.slice(0, 8000) : "";
    const limit = typeof body.limit === "number" ? Math.min(Math.max(Math.trunc(body.limit), 1), 30) : 8;
    return c.json(await searchMemory(ctx.db, id, query, limit));
  });

  /** The model proxy saves facts it extracted from a finished session. */
  app.post("/agents/:id/memory", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "agent not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { facts?: unknown; source?: unknown };
    const facts = (Array.isArray(body.facts) ? body.facts : []).flatMap((f: unknown) => {
      const fact = f as { content?: unknown; scope?: unknown };
      return typeof fact?.content === "string"
        ? [{ content: fact.content, scope: fact.scope === "project" ? ("project" as const) : ("agent" as const) }]
        : [];
    });
    const source = typeof body.source === "string" ? body.source : "session";
    return c.json(await addFacts(ctx, null, id, facts, source), 201);
  });

  return app;
}
