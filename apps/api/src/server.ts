import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { createPrisma } from "@agentslack/db";
import { createApp } from "./app.js";
import type { AppContext } from "./context.js";
import { loadEnv, type Env } from "./env.js";
import { EventBus } from "./events/bus.js";
import { attachRealtime } from "./realtime.js";
import { githubPullRequests, startPrPoller } from "./services/github.js";

export async function startServer(env: Env = loadEnv()) {
  const ctx: AppContext = {
    db: createPrisma(env.databaseUrl),
    bus: new EventBus(env.redisUrl, env.eventStream),
    env,
  };
  const server = createAdaptorServer({ fetch: createApp(ctx).fetch }) as HttpServer;
  const realtime = await attachRealtime(server, ctx);
  await new Promise<void>((resolve) => server.listen(env.port, resolve));
  const stopPoller =
    env.githubToken && env.prPollMs > 0 ? startPrPoller(ctx, githubPullRequests(env.githubToken), env.prPollMs) : () => {};

  return {
    ctx,
    port: (server.address() as AddressInfo).port,
    close: async () => {
      stopPoller();
      await realtime.close();
      await ctx.bus.close();
      await ctx.db.$disconnect();
    },
  };
}
