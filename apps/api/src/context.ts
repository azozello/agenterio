import type { Db } from "@agentslack/db";
import type { DomainEvent } from "@agentslack/shared";
import type { Env } from "./env.js";
import type { EventBus } from "./events/bus.js";

export interface AppContext {
  db: Db;
  bus: EventBus;
  env: Env;
}

/**
 * Publishes events after their transaction has committed. A failed publish is logged, not
 * thrown: the write already happened and the event row is in the audit table.
 */
export async function publishAll(ctx: AppContext, events: DomainEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await ctx.bus.publish(event);
    } catch (err) {
      console.error(`[bus] publish failed for event ${event.id} (${event.type})`, err);
    }
  }
}
