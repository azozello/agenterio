// Starts a supervisor for every agent that has a project (or only those named in --only / SUPERVISOR_AGENTS).
//   pnpm supervisor                 all agents
//   pnpm supervisor --only rowan,mira
import { AgentSupervisor, type AgentInfo } from "./agent.js";
import { loadEnv } from "./env.js";
import { DockerLaptops } from "./laptops.js";

const env = loadEnv();

async function internal<T>(method: string, path: string): Promise<T> {
  const res = await fetch(`${env.apiUrl}/internal${path}`, { method, headers: { "x-internal-secret": env.internalSecret } });
  if (!res.ok) throw new Error(`internal ${method} ${path}: ${res.status} (is the API running with the same INTERNAL_SECRET?)`);
  return (await res.json()) as T;
}

const onlyArg = process.argv.indexOf("--only");
const only = (onlyArg >= 0 ? process.argv[onlyArg + 1] : process.env.SUPERVISOR_AGENTS)
  ?.split(",")
  .map((h) => h.trim().replace(/^@/, ""))
  .filter(Boolean);

const agents = (await internal<Array<AgentInfo & { projectId: string | null; projectKey: string | null }>>("GET", "/agents")).filter(
  (a): a is AgentInfo => Boolean(a.projectId) && (!only || only.includes(a.handle)),
);
if (agents.length === 0) {
  console.error("No agents to supervise. Seed the workspace (pnpm db:seed) or check --only.");
  process.exit(1);
}

const laptops = new DockerLaptops(env.laptopImage);
const supervisors: AgentSupervisor[] = [];
for (const agent of agents) {
  const { token } = await internal<{ token: string }>("POST", `/agents/${agent.id}/token`);
  const supervisor = new AgentSupervisor(agent, token, env, laptops);
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
    process.exit(0);
  });
}
