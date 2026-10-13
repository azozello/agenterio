import { existsSync } from "node:fs";
import { resolve } from "node:path";

const rootEnv = resolve(import.meta.dirname, "../../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in .env`);
  return value;
}

export interface SupervisorEnv {
  apiUrl: string;
  /** The API as seen from inside a laptop container. */
  laptopApiUrl: string;
  internalSecret: string;
  anthropicApiKey: string;
  githubToken: string;
  laptopImage: string;
  replyBudgetUsd: number;
  taskBudgetUsd: number;
  tickMs: number;
}

export function loadEnv(): SupervisorEnv {
  return {
    apiUrl: process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`,
    laptopApiUrl: process.env.LAPTOP_API_URL ?? `http://host.docker.internal:${process.env.API_PORT ?? 4000}`,
    internalSecret: required("INTERNAL_SECRET"),
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    githubToken: required("GITHUB_TOKEN"),
    laptopImage: process.env.LAPTOP_IMAGE ?? "agentslack/laptop:dev",
    replyBudgetUsd: Number(process.env.REPLY_BUDGET_USD ?? 2),
    taskBudgetUsd: Number(process.env.TASK_BUDGET_USD ?? 10),
    tickMs: Number(process.env.SUPERVISOR_TICK_MS ?? 15_000),
  };
}
