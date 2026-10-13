import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export * from "./generated/prisma/client.js";

export const DEFAULT_DATABASE_URL = "postgresql://agentslack:agentslack@localhost:5433/agentslack";

export function createPrisma(connectionString: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export type Db = ReturnType<typeof createPrisma>;
