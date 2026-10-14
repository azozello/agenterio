import type { MemoryScope, Prisma } from "@agentslack/db";
import type { MemoryFactDto } from "@agentslack/shared";
import type { Actor } from "../auth/actor.js";
import { publishAll, type AppContext } from "../context.js";
import { recordEvent } from "../events/record.js";
import { forbidden, isUuid, notFound } from "./errors.js";

type Db = AppContext["db"];

const factInclude = { agent: true } satisfies Prisma.MemoryFactInclude;
type FactRow = Prisma.MemoryFactGetPayload<{ include: typeof factInclude }>;

const toDto = (f: FactRow): MemoryFactDto => ({
  id: f.id,
  content: f.content,
  scope: f.scope,
  source: f.source,
  agent: { id: f.agent.id, name: f.agent.name, handle: f.agent.handle },
  useCount: f.useCount,
  lastUsedAt: f.lastUsedAt?.toISOString() ?? null,
  createdAt: f.createdAt.toISOString(),
});

/** Facts an agent can see: its own, and project-wide ones from its current project. */
const visibleTo = (agent: { id: string; currentProjectId: string | null }): Prisma.MemoryFactWhereInput => ({
  OR: [{ agentId: agent.id }, ...(agent.currentProjectId ? [{ scope: "project" as const, projectId: agent.currentProjectId }] : [])],
});

/** Lowercase words for an OR full-text query; Postgres drops stop words itself. */
export function queryTerms(text: string, max = 40): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].slice(0, max);
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The facts most relevant to `query` (full-text rank), topped up with the agent's most recent
 * ones so general knowledge such as repo conventions still comes along. Marks them as used.
 */
export async function searchMemory(db: Db, agentId: string, query: string, limit = 8): Promise<MemoryFactDto[]> {
  const agent = await db.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw notFound("agent");
  const terms = queryTerms(query);
  const ranked = terms.length
    ? await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM memory_fact, to_tsquery('english', ${terms.join(" | ")}) q
        WHERE (agent_id = ${agent.id}::uuid OR (scope = 'project' AND project_id = ${agent.currentProjectId}::uuid))
          AND to_tsvector('english', content) @@ q
        ORDER BY ts_rank_cd(to_tsvector('english', content), q) DESC, created_at DESC
        LIMIT ${limit}`
    : [];
  const ids = ranked.map((r) => r.id);
  if (ids.length < limit) {
    const recent = await db.memoryFact.findMany({
      where: { AND: [visibleTo(agent), { id: { notIn: ids } }] },
      orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: limit - ids.length,
      select: { id: true },
    });
    ids.push(...recent.map((r) => r.id));
  }
  if (ids.length === 0) return [];
  await db.memoryFact.updateMany({ where: { id: { in: ids } }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() } });
  const rows = await db.memoryFact.findMany({ where: { id: { in: ids } }, include: factInclude });
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!).map(toDto);
}

export interface NewFact {
  content: string;
  scope?: MemoryScope;
}

/**
 * Saves new facts for an agent, skipping ones it (or its project) already has. `actor` is the agent
 * itself (the remember tool) or null when the model proxy extracted them.
 */
export async function addFacts(
  ctx: AppContext,
  actor: Actor | null,
  agentId: string,
  facts: NewFact[],
  source: string,
): Promise<MemoryFactDto[]> {
  const agent = await ctx.db.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw notFound("agent");
  const existing = await ctx.db.memoryFact.findMany({ where: visibleTo(agent), select: { content: true } });
  const seen = new Set(existing.map((f) => normalize(f.content)));
  const fresh: NewFact[] = [];
  for (const fact of facts.slice(0, 20)) {
    const content = fact.content.trim().slice(0, 500);
    const key = normalize(content);
    if (key.length < 3 || seen.has(key)) continue;
    seen.add(key);
    fresh.push({ content, scope: fact.scope ?? "agent" });
  }
  if (fresh.length === 0) return [];

  const { created, event } = await ctx.db.$transaction(async (tx) => {
    const created: FactRow[] = [];
    for (const f of fresh) {
      created.push(
        await tx.memoryFact.create({
          data: {
            workspaceId: agent.workspaceId,
            agentId: agent.id,
            projectId: agent.currentProjectId,
            scope: f.scope ?? "agent",
            content: f.content,
            source: source.slice(0, 200),
          },
          include: factInclude,
        }),
      );
    }
    const event = await recordEvent(tx, {
      type: "memory.saved",
      workspaceId: agent.workspaceId,
      projectId: agent.currentProjectId,
      actor,
      subjectType: "agent",
      subjectId: agent.id,
      payload: { agentId: agent.id, count: created.length, source, facts: created.map((f) => f.content) },
    });
    return { created, event };
  });
  await publishAll(ctx, [event]);
  return created.map(toDto);
}

/** What an agent remembers, newest first; for its profile. Agents see only facts visible to them. */
export async function listMemory(ctx: AppContext, actor: Actor, agentId: string): Promise<MemoryFactDto[]> {
  if (!isUuid(agentId)) throw notFound("agent");
  const agent = await ctx.db.agent.findUnique({ where: { id: agentId } });
  if (!agent || agent.workspaceId !== actor.workspaceId) throw notFound("agent");
  const where: Prisma.MemoryFactWhereInput =
    actor.kind === "human"
      ? { agentId }
      : { agentId, ...(actor.agentId === agentId ? {} : { scope: "project", projectId: actor.projectId }) };
  const rows = await ctx.db.memoryFact.findMany({ where, include: factInclude, orderBy: { createdAt: "desc" }, take: 100 });
  return rows.map(toDto);
}

/** You can delete any fact; an agent only its own. */
export async function deleteFact(ctx: AppContext, actor: Actor, factId: string): Promise<void> {
  const fact = isUuid(factId) ? await ctx.db.memoryFact.findUnique({ where: { id: factId } }) : null;
  if (!fact || fact.workspaceId !== actor.workspaceId) throw notFound("memory fact");
  if (actor.kind === "agent" && fact.agentId !== actor.agentId) throw forbidden("not your memory");
  await ctx.db.memoryFact.delete({ where: { id: fact.id } });
}
