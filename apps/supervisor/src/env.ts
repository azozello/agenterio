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
  /** "HH:MM" local time for the daily #standup post, or "off". */
  standupAt: string;
  /** Laya server for per-session model routing; unset uses each agent's own model and effort. */
  layaUrl: string | null;
  layaApiKey: string | undefined;
  layaMinConfidence: number;
  layaTimeoutMs: number;
  /** Models for hard, routine and trivial work. */
  routerModels: [string, string, string];
  /** The model proxy every laptop calls instead of a provider. */
  proxyHost: string;
  proxyPort: number;
  /** The proxy as seen from inside a laptop container. */
  laptopProxyUrl: string;
  anthropicApiUrl: string;
  mistral: { apiKey: string; url: string; reasoning: boolean } | null;
  /** Mistral prices in USD per million tokens, if you want its cost metered. */
  mistralPrice: { input: number; output: number } | null;
  /** Model that extracts memory after each session, or null for no extraction. */
  memoryModel: string | null;
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
    standupAt: process.env.STANDUP_AT?.trim() || "09:30",
    layaUrl: process.env.LAYA_URL?.trim() || null,
    layaApiKey: process.env.LAYA_API_KEY || undefined,
    layaMinConfidence: Number(process.env.LAYA_MIN_CONFIDENCE ?? 0.6),
    layaTimeoutMs: Number(process.env.LAYA_TIMEOUT_MS ?? 10_000),
    routerModels: tiers(process.env.ROUTER_MODELS ?? "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5"),
    proxyHost: process.env.PROXY_HOST ?? "127.0.0.1",
    proxyPort,
    laptopProxyUrl: process.env.LAPTOP_PROXY_URL ?? `http://host.docker.internal:${proxyPort}`,
    anthropicApiUrl: (process.env.ANTHROPIC_API_URL ?? "https://api.anthropic.com").replace(/\/+$/, ""),
    mistral: process.env.MISTRAL_API_KEY
      ? {
          apiKey: process.env.MISTRAL_API_KEY,
          url: (process.env.MISTRAL_API_URL ?? "https://api.mistral.ai").replace(/\/+$/, ""),
          reasoning: process.env.MISTRAL_REASONING !== "off",
        }
      : null,
    mistralPrice: price(process.env.MISTRAL_PRICE),
    memoryModel: process.env.MEMORY_EXTRACT_MODEL === "off" ? null : (process.env.MEMORY_EXTRACT_MODEL ?? "claude-sonnet-5-5"),
  };
}

const proxyPort = Number(process.env.PROXY_PORT ?? 4100);

function tiers(list: string): [string, string, string] {
  const models = list.split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length !== 3) throw new Error("ROUTER_MODELS needs three models: hard, routine, trivial");
  return [models[0]!, models[1]!, models[2]!];
}

/** "input,output" in USD per million tokens. */
function price(value: string | undefined): { input: number; output: number } | null {
  const [input, output] = (value ?? "").split(",").map(Number);
  return Number.isFinite(input) && Number.isFinite(output) && value ? { input: input!, output: output! } : null;
}
