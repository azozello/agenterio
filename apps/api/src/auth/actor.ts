import { SESSION_COOKIE } from "@agentslack/shared";
import type { Db } from "@agentslack/db";
import { generateToken, hashToken } from "./crypto.js";

/** Who is making a request: you in the browser, or an agent with its project-scoped token. */
export type Actor =
  | { kind: "human"; userId: string; workspaceId: string; name: string }
  | { kind: "agent"; agentId: string; workspaceId: string; projectId: string; name: string; handle: string };

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The user or agent id behind an actor; people ids are unique across both tables. */
export const actorId = (actor: Actor) => (actor.kind === "human" ? actor.userId : actor.agentId);

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken("ass");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt } });
  return { token, expiresAt };
}

export async function issueAgentToken(db: Db, agentId: string, projectId: string): Promise<string> {
  const token = generateToken("ast");
  await db.agentToken.create({ data: { agentId, projectId, tokenHash: hashToken(token) } });
  return token;
}

async function humanFromSession(db: Db, token: string): Promise<Actor | null> {
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;
  return { kind: "human", userId: session.user.id, workspaceId: session.user.workspaceId, name: session.user.name };
}

async function agentFromToken(db: Db, token: string): Promise<Actor | null> {
  const row = await db.agentToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { agent: true },
  });
  if (!row || row.revokedAt) return null;
  // A token only works while the agent is still on the project it was issued for.
  if (row.agent.currentProjectId !== row.projectId) return null;
  return {
    kind: "agent",
    agentId: row.agent.id,
    workspaceId: row.agent.workspaceId,
    projectId: row.projectId,
    name: row.agent.name,
    handle: row.agent.handle,
  };
}

/** Bearer agent tokens take precedence over the session cookie. */
export async function resolveActor(
  db: Db,
  headers: { cookie?: string; authorization?: string },
): Promise<{ actor: Actor; via: "cookie" | "bearer" } | null> {
  const bearer = headers.authorization?.match(/^Bearer\s+(ast_\S+)$/i)?.[1];
  if (bearer) {
    const actor = await agentFromToken(db, bearer);
    return actor ? { actor, via: "bearer" } : null;
  }
  const session = readCookie(headers.cookie, SESSION_COOKIE);
  if (session) {
    const actor = await humanFromSession(db, session);
    return actor ? { actor, via: "cookie" } : null;
  }
  return null;
}
