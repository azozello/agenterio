import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryFactDto, TaskDto } from "@agentslack/shared";
import type { MemoryClient } from "../src/proxy/memory.js";
import { ANTHROPIC_PRICES, ModelProxy, type ProxyAgent } from "../src/proxy/server.js";
import type { RouteRequest, TaskRouter } from "../src/router.js";

const servers: Server[] = [];
const proxies: ModelProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.close()));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A fake provider that records requests and answers with `reply(body, path)`. */
async function upstream(reply: (body: Record<string, unknown>, path: string) => { type: string; body: string }) {
  const seen: { path: string; headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
      seen.push({ path: req.url!, headers: req.headers, body });
      const out = reply(body, req.url!);
      res.writeHead(200, { "content-type": out.type }).end(out.body);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

const anthropicStream = sse([
  ["message_start", { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done: PR is ready." } }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 300 } }],
  ["message_stop", { type: "message_stop" }],
]);

const fact = (content: string): MemoryFactDto => ({
  id: content,
  content,
  scope: "project",
  source: "DEMO-1 task session",
  agent: { id: "a-theo", name: "Theo", handle: "theo" },
  useCount: 1,
  lastUsedAt: null,
  createdAt: "2026-10-14T10:00:00Z",
});

function setup(opts: { mistralUrl?: string; anthropicUrl: string }) {
  const routed: RouteRequest[] = [];
  const router: TaskRouter = {
    async route(req) {
      routed.push(req);
      return req.pinnedModel
        ? { model: req.pinnedModel, effort: "low", router: "laya", confidence: 0.8 }
        : { model: "claude-sonnet-5-5", effort: "medium", router: "laya", confidence: 0.71 };
    },
  };
  const saved: unknown[] = [];
  const memory = {
    search: async () => [fact("The sandbox repo tests with node --test.")],
    save: async (_id: string, facts: unknown[]) => (saved.push(...facts), []),
  } as unknown as MemoryClient;
  const proxy = new ModelProxy({
    host: "127.0.0.1",
    port: 0,
    keySecret: "secret",
    anthropic: { apiKey: "sk-real", url: opts.anthropicUrl },
    mistral: opts.mistralUrl ? { apiKey: "mk-real", url: opts.mistralUrl, reasoning: true } : null,
    router,
    memory,
    extractor: null,
    prices: ANTHROPIC_PRICES,
    log: () => undefined,
  });
  proxies.push(proxy);
  return { proxy, routed, saved };
}

const mira: ProxyAgent = { id: "a-mira", handle: "mira", name: "Mira", role: "Engineer", model: "claude-opus-5-5", effort: "high" };
const margaux: ProxyAgent = { id: "a-margaux", handle: "margaux", name: "Margaux", role: "Junior Engineer", model: "mistral-large-4", effort: "high" };
const task = { key: "DEMO-2", type: "task", priority: "P2", estimate: "S", title: "Greet CLI", description: "Print Hello", bugs: [] } as unknown as TaskDto;

async function call(port: number, key: string, body: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "some-beta" },
    body: JSON.stringify(body),
  });
}

describe("model proxy", () => {
  it("routes a session's calls to the model Laya picked, adds memory, and meters usage", async () => {
    const anthropic = await upstream(() => ({ type: "text/event-stream", body: anthropicStream }));
    const { proxy, routed } = setup({ anthropicUrl: anthropic.url });
    const port = await proxy.listen();
    const key = proxy.keyFor(mira);

    const started = await proxy.startRun(mira, { kind: "task", task, prompt: "Work on DEMO-2" });
    expect(started).toMatchObject({ provider: "anthropic", workerModel: "claude-sonnet-5-5", facts: 1, route: { model: "claude-sonnet-5-5", effort: "medium" } });
    expect(routed[0]).toMatchObject({ kind: "task", role: "Engineer", fallback: { model: "claude-opus-5-5", effort: "high" } });
    expect(routed[0]!.text).toContain("DEMO-2 (task, P2, S): Greet CLI");

    const res = await call(port, key, {
      model: "claude-sonnet-5-5",
      max_tokens: 32000,
      stream: true,
      system: [{ type: "text", text: "Claude Code prompt", cache_control: { type: "ephemeral" } }],
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "Work on DEMO-2" }],
    });
    expect(await res.text()).toBe(anthropicStream);

    const sent = anthropic.seen[0]!;
    expect(sent.path).toBe("/v1/messages?beta=true");
    expect(sent.headers["x-api-key"]).toBe("sk-real");
    expect(sent.headers["anthropic-beta"]).toBe("some-beta");
    expect(sent.body).toMatchObject({ model: "claude-sonnet-5-5", output_config: { effort: "medium" } });
    const system = sent.body.system as { text: string; cache_control?: unknown }[];
    expect(system[0]).toEqual({ type: "text", text: "Claude Code prompt", cache_control: { type: "ephemeral" } });
    expect(system[1]!.text).toContain("- The sandbox repo tests with node --test. (team fact from Theo)");

    // The harness's small-model calls pass through as they are.
    await (await call(port, key, { model: "claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user", content: "title?" }] })).text();
    expect(anthropic.seen[1]!.body).toEqual({ model: "claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user", content: "title?" }] });

    const usage = proxy.endRun(mira.id)!;
    expect(usage).toMatchObject({ calls: 2, inputTokens: 200, cacheReadTokens: 18000, cacheWriteTokens: 1000, outputTokens: 600 });
    // Sonnet: 100 in, 9000 cached, 500 written, 300 out; Haiku the same counts.
    const sonnet = (100 * 2 + 300 * 10 + 9000 * 0.2 + 500 * 2.5) / 1e6;
    const haiku = (100 * 0.1 + 300 * 0.5 + 9000 * 0.01 + 500 * 0.125) / 1e6;
    expect(usage.costUsd).toBeCloseTo(sonnet + haiku, 8);
  });

  it("refuses unknown keys", async () => {
    const anthropic = await upstream(() => ({ type: "application/json", body: "{}" }));
    const { proxy } = setup({ anthropicUrl: anthropic.url });
    const port = await proxy.listen();
    expect((await call(port, "sk-ant-guess", { model: "claude-opus-5-5", messages: [] })).status).toBe(401);
    expect(anthropic.seen).toHaveLength(0);
  });

  it("runs an agent on Mistral behind the same Anthropic interface", async () => {
    const anthropic = await upstream(() => ({ type: "application/json", body: "{}" }));
    const mistral = await upstream(() => ({
      type: "text/event-stream",
      body: 'data: {"choices":[{"delta":{"content":"Bonjour."},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
    }));
    const { proxy, routed } = setup({ anthropicUrl: anthropic.url, mistralUrl: mistral.url });
    const port = await proxy.listen();
    const key = proxy.keyFor(margaux);

    const started = await proxy.startRun(margaux, { kind: "reply", prompt: "Say hi in #general" });
    expect(started).toMatchObject({ provider: "mistral", workerModel: "claude-opus-5-5", route: { model: "mistral-large-4", effort: "low" } });
    expect(routed[0]).toMatchObject({ pinnedModel: "mistral-large-4", fallback: { model: "mistral-large-4", effort: "high" } });

    const res = await call(port, key, { model: "claude-opus-5-5", max_tokens: 1000, stream: true, messages: [{ role: "user", content: "Say hi" }] });
    const text = await res.text();
    expect(text).toContain('"text_delta","text":"Bonjour."');
    expect(text).toContain('"stop_reason":"end_turn"');

    const sent = mistral.seen[0]!;
    expect(sent.path).toBe("/v1/chat/completions");
    expect(sent.headers.authorization).toBe("Bearer mk-real");
    expect(sent.body).toMatchObject({ model: "mistral-large-4", reasoning_effort: "low", prompt_cache_key: started.runId, stream: true });
    expect(anthropic.seen).toHaveLength(0);
    expect(proxy.endRun(margaux.id)).toMatchObject({ calls: 1, inputTokens: 50, outputTokens: 3, costUsd: null });
  });
});
