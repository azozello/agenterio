import { defineConfig } from "vitest/config";

export const TEST_DATABASE_URL = "postgresql://agentslack:agentslack@localhost:5433/agentslack_test";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: "redis://localhost:6380/1",
      EVENT_STREAM: "agentslack:test-events",
      API_PORT: "0",
      WEB_ORIGIN: "http://localhost:3000",
      // Tests drive the poller directly with a stubbed GitHub.
      PR_POLL_MS: "0",
    },
    globalSetup: "./test/global-setup.ts",
    // Tests share one database.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
