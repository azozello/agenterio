import { startServer } from "./server.js";

const server = await startServer();
console.log(`[api] listening on http://localhost:${server.port}`);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await server.close();
    process.exit(0);
  });
}
