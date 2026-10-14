// Starts the model proxy and a supervisor for every agent that has a project (or only those named
// in --only / SUPERVISOR_AGENTS).
//   pnpm supervisor                 all agents
//   pnpm supervisor --only rowan,mira
import Anthropic from "@anthropic-ai/sdk";
import { AgentSupervisor, type AgentInfo } from "./agent.js";
import { loadEnv } from "./env.js";
import { DockerLaptops } from "./laptops.js";
import { MemoryClient, MemoryExtractor } from "./proxy/memory.js";
import { ANTHROPIC_PRICES, ModelProxy } from "./proxy/server.js";
import { AgentDefaultRouter, LayaRouter } from "./router.js";

const env = loadEnv();

async function internal<T>(method: string, path: string): Promise<T> {
  const res = await fetch(`${env.apiUrl}/internal${path}`, { method, headers: { "x-internal-secret": env.internalSecret } });
  if (!res.ok) throw new Error(`internal ${method} ${path}: ${res.status} (is the API running with the same INTERNAL_SECRET?)`);
  return (await res.json()) as T;
}

/** Whether the Mistral key works, so agents on a Mistral model aren't started into failing calls. */
async function mistralReachable(): Promise<string | null> {
  if (!env.mistral) return "MISTRAL_API_KEY is not set";
  const res = await fetch(`${env.mistral.url}/v1/models`, { headers: { authorization: `Bearer ${env.mistral.apiKey}` } }).catch((err: unknown) => err as Error);
  if (res instanceof Error) return `Mistral unreachable (${res.message})`;
  return res.ok ? null : `Mistral answered HTTP ${res.status} for MISTRAL_API_KEY`;
}

const onlyArg = process.argv.indexOf("--only");
const only = (onlyArg >= 0 ? process.argv[onlyArg + 1] : process.env.SUPERVISOR_AGENTS)
  ?.split(",")
  .map((h) => h.trim().replace(/^@/, ""))
  .filter(Boolean);

type Listed = AgentInfo & { model: string; projectId: string | null; projectKey: string | null };
let agents = (await internal<Listed[]>("GET", "/agents")).filter(
  (a): a is Listed & AgentInfo => Boolean(a.projectId) && (!only || only.includes(a.handle)),
);

const mistralProblem = agents.some((a) => !a.model.startsWith("claude-")) ? await mistralReachable() : null;
if (mistralProblem) {
  const skipped = agents.filter((a) => !a.model.startsWith("claude-"));
  console.warn(`[fleet] not starting ${skipped.map((a) => `@${a.handle} (${a.model})`).join(", ")}: ${mistralProblem}`);
  agents = agents.filter((a) => a.model.startsWith("claude-"));
}
if (agents.length === 0) {
  console.error("No agents to supervise. Seed the workspace (pnpm db:seed) or check --only.");
  process.exit(1);
}

const router = env.layaUrl
  ? new LayaRouter({
      url: env.layaUrl,
      apiKey: env.layaApiKey,
      minConfidence: env.layaMinConfidence,
      timeoutMs: env.layaTimeoutMs,
      tiers: env.routerModels,
    })
  : new AgentDefaultRouter();
const memory = new MemoryClient(env.apiUrl, env.internalSecret);
const prices = {
  ...ANTHROPIC_PRICES,
  ...Object.fromEntries(
    agents.filter((a) => !a.model.startsWith("claude-") && env.mistralPrice).map((a) => [a.model, { ...env.mistralPrice!, cacheRead: env.mistralPrice!.input / 10 }]),
  ),
};
const proxy = new ModelProxy({
  host: env.proxyHost,
  port: env.proxyPort,
  keySecret: env.internalSecret,
  anthropic: { apiKey: env.anthropicApiKey, url: env.anthropicApiUrl },
  mistral: mistralProblem ? null : env.mistral,
  router,
  memory,
  extractor: env.memoryModel ? new MemoryExtractor(new Anthropic({ apiKey: env.anthropicApiKey }), env.memoryModel) : null,
  prices,
  log: (...args) => console.log(...args),
});
const port = await proxy.listen();
console.log(
  [
    `[fleet] model proxy on ${env.proxyHost}:${port} (laptops call ${env.laptopProxyUrl})`,
    env.layaUrl
      ? `routing with Laya at ${env.layaUrl} (min confidence ${env.layaMinConfidence}; hard/routine/trivial → ${env.routerModels.join(", ")})`
      : "LAYA_URL not set: sessions run on each agent's own model and effort",
    env.memoryModel ? `memory extraction on ${env.memoryModel}` : "memory extraction off",
  ].join("; "),
);

const laptops = new DockerLaptops(env.laptopImage);
const supervisors: AgentSupervisor[] = [];
for (const agent of agents) {
  const { token } = await internal<{ token: string }>("POST", `/agents/${agent.id}/token`);
  const supervisor = new AgentSupervisor(agent, token, env, laptops, proxy);
  supervisors.push(supervisor);
  await supervisor.start();
}
console.log(`[fleet] supervising ${agents.map((a) => `@${a.handle}`).join(", ")}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log("[fleet] stopping; laptops keep running");
    await Promise.all(supervisors.map((s) => s.stop()));
    await proxy.close();
    process.exit(0);
  });
}
