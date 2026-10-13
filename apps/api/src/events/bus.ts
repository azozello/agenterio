import { Redis } from "ioredis";
import type { DomainEvent } from "@agentslack/shared";

export type EventHandler = (event: DomainEvent) => void | Promise<void>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Domain event fan-out over a Redis Stream. Every subscriber reads the whole stream
 * (no consumer group), which is what the realtime gateway needs. Supervisors will use
 * consumer groups on the same stream from M1.
 */
export class EventBus {
  private readonly pub: Redis;
  private readonly readers = new Set<Redis>();

  constructor(
    private readonly url: string,
    private readonly stream: string,
  ) {
    this.pub = new Redis(url, { maxRetriesPerRequest: 3 });
  }

  async publish(event: DomainEvent): Promise<void> {
    await this.pub.xadd(this.stream, "MAXLEN", "~", 100_000, "*", "event", JSON.stringify(event));
  }

  /** Delivers every event published after this call resolves. Returns an async unsubscribe. */
  async subscribe(handler: EventHandler): Promise<() => Promise<void>> {
    const conn = new Redis(this.url, { maxRetriesPerRequest: null });
    this.readers.add(conn);
    const newest = await conn.xrevrange(this.stream, "+", "-", "COUNT", 1);
    let lastId = newest[0]?.[0] ?? "0-0";
    let stopped = false;

    const loop = (async () => {
      while (!stopped) {
        let batch: [string, [string, string[]][]][] | null;
        try {
          batch = await conn.xread("COUNT", 100, "BLOCK", 5000, "STREAMS", this.stream, lastId);
        } catch (err) {
          if (stopped) break;
          console.error("[bus] read failed", err);
          await sleep(1000);
          continue;
        }
        for (const [, entries] of batch ?? []) {
          for (const [id, fields] of entries) {
            lastId = id;
            const raw = fields[fields.indexOf("event") + 1];
            if (!raw) continue;
            try {
              await handler(JSON.parse(raw) as DomainEvent);
            } catch (err) {
              console.error("[bus] handler failed", err);
            }
          }
        }
      }
    })();

    return async () => {
      stopped = true;
      conn.disconnect();
      this.readers.delete(conn);
      await loop;
    };
  }

  async close(): Promise<void> {
    for (const conn of this.readers) conn.disconnect();
    this.readers.clear();
    await this.pub.quit();
  }
}
