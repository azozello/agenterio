import { HTTPException } from "hono/http-exception";
import type { Actor } from "../auth/actor.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export const notFound = (what: string) => new HTTPException(404, { message: `${what} not found` });
export const forbidden = (why = "forbidden") => new HTTPException(403, { message: why });

export function requireHuman(actor: Actor): asserts actor is Extract<Actor, { kind: "human" }> {
  if (actor.kind !== "human") throw forbidden("only a human can do this");
}
