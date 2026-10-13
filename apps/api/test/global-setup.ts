import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { TEST_DATABASE_URL } from "../vitest.config.js";

/** Brings the test database up to the latest migration. Needs `pnpm infra:up`. */
export default function setup() {
  execSync("pnpm exec prisma migrate deploy", {
    cwd: resolve(import.meta.dirname, "../../../packages/db"),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}
