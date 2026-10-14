import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_DATABASE_URL } from "@agentslack/db";

// Values already in process.env (e.g. from the test runner) take precedence over the file.
const rootEnv = resolve(import.meta.dirname, "../../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export interface Env {
  databaseUrl: string;
  redisUrl: string;
  eventStream: string;
  port: number;
  webOrigin: string;
  secureCookies: boolean;
  githubToken: string | null;
  /** 0 disables the PR poller. */
  prPollMs: number;
  /** Shared with the supervisor for /internal routes; unset disables them. */
  internalSecret: string | null;
}

export function loadEnv(): Env {
  return {
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6380",
    eventStream: process.env.EVENT_STREAM ?? "agentslack:events",
    port: Number(process.env.API_PORT ?? 4000),
    webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3002",
    secureCookies: process.env.NODE_ENV === "production",
    githubToken: process.env.GITHUB_TOKEN || null,
    prPollMs: Number(process.env.PR_POLL_MS ?? 30_000),
    internalSecret: process.env.INTERNAL_SECRET || null,
  };
}
