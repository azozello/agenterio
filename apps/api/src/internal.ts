import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { issueAgentToken } from "./auth/actor.js";
import type { AppContext } from "./context.js";
import { isUuid } from "./services/errors.js";

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

  return app;
}
