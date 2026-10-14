// The model proxy: every LLM call from a laptop goes through here. For each session it adds the
// agent's relevant memory, uses the model and effort Laya picked, calls the real provider
// (Anthropic, or Mistral for agents on a Mistral model), meters usage, and extracts new memory
// when the session ends. Laptops hold only a per-agent proxy key, never a provider key.
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { EffortLevel, MemoryFactDto, TaskDto } from "@agentslack/shared";
import { FALLBACK, type Route, type TaskRouter } from "../router.js";
import { memoryBlock, transcript, type MemoryClient, type MemoryExtractor } from "./memory.js";
import { MistralStream, SseParser, fromMistralResponse, toMistralRequest, type AnthropicMessage, type AnthropicRequest, type Block } from "./mistral.js";

export interface ProxyAgent {
  id: string;
  handle: string;
  name: string;
  role: string;
  /** The agent's configured model: a Claude id, or a Mistral id for the junior dev. */
  model: string;
  effort: EffortLevel;
}

export interface RunContext {
  kind: "reply" | "task" | "review";
  task?: TaskDto;
  /** The prompt the session starts with; what a reply session is about. */
  prompt: string;
}

export type Provider = "anthropic" | "mistral";

export interface StartedRun {
  runId: string;
  route: Route;
  provider: Provider;
  /** The model id the laptop's harness asks for; the proxy maps it to the routed model. */
  workerModel: string;
  facts: number;
}

export interface RunUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when a model's price is unknown. */
  costUsd: number | null;
}

interface RunState extends StartedRun {
  agent: ProxyAgent;
  ctx: RunContext;
  memory: string | null;
  lastMessages: AnthropicMessage[];
  lastText: string;
  usage: RunUsage;
  /** Cleared if Mistral rejects reasoning_effort for this model. */
  mistralReasoning: boolean;
}

/** USD per million tokens. Cache writes cost 1.25x input. */
export type PriceTable = Record<string, { input: number; output: number; cacheRead: number }>;

export const ANTHROPIC_PRICES: PriceTable = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export interface ProxyOptions {
  host: string;
  port: number;
  /** Signs per-agent proxy keys, so they stay the same across restarts. */
  keySecret: string;
  anthropic: { apiKey: string; url: string };
  mistral: { apiKey: string; url: string; reasoning: boolean } | null;
  router: TaskRouter;
  memory: MemoryClient | null;
  extractor: MemoryExtractor | null;
  prices: PriceTable;
  log: (...args: unknown[]) => void;
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

const taskText = (t: TaskDto) =>
  [`${t.key} (${t.type}, ${t.priority}${t.estimate ? `, ${t.estimate}` : ""}): ${t.title}`, t.description, ...t.bugs.filter((b) => b.status !== "done").map((b) => `Open bug ${b.key}: ${b.title}`)]
    .filter(Boolean)
    .join("\n\n");

function withMemory(system: AnthropicRequest["system"], block: string): Block[] {
  const extra = { type: "text", text: block };
  if (system === undefined) return [extra];
  if (typeof system === "string") return [{ type: "text", text: system }, extra];
  return [...system, extra];
}

function anthropicError(status: number, message: string) {
  const type = status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : status >= 500 ? "api_error" : "invalid_request_error";
  return { type: "error", error: { type, message } };
}

const FORWARD_REQUEST = new Set(["anthropic-version", "anthropic-beta", "content-type", "accept", "user-agent", "x-app"]);
const FORWARD_RESPONSE = (k: string) => k === "content-type" || k === "request-id" || k === "retry-after" || k === "x-should-retry" || k.startsWith("anthropic-");

export class ModelProxy {
  private server: Server | null = null;
  private readonly agentsByKey = new Map<string, ProxyAgent>();
  private readonly runs = new Map<string, RunState>();

  constructor(private readonly opts: ProxyOptions) {}

  /** The key an agent's laptop uses as its ANTHROPIC_API_KEY. */
  keyFor(agent: ProxyAgent): string {
    const key = `asp-${createHmac("sha256", this.opts.keySecret).update(`proxy:${agent.handle}`).digest("hex").slice(0, 40)}`;
    this.agentsByKey.set(key, agent);
    return key;
  }

  providerFor(model: string): Provider {
    return model.startsWith("claude-") || !this.opts.mistral ? "anthropic" : "mistral";
  }

  async listen(): Promise<number> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.opts.log("[proxy] request failed:", err instanceof Error ? err.message : err);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify(anthropicError(502, "model proxy error")));
        else res.end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port, this.opts.host, resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async close() {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Picks model and effort with the router and loads relevant memory; every call of the session then uses both. */
  async startRun(agent: ProxyAgent, ctx: RunContext): Promise<StartedRun> {
    this.keyFor(agent);
    const wantsMistral = !agent.model.startsWith("claude-");
    const provider = this.providerFor(agent.model);
    const text = ctx.task ? taskText(ctx.task) : ctx.prompt;
    const fallback = provider === "mistral" ? { model: agent.model, effort: "high" as const } : FALLBACK;
    let route = await this.opts.router
      .route({ kind: ctx.kind, role: agent.role, text, pinnedModel: provider === "mistral" ? agent.model : undefined, fallback }, { model: agent.model, effort: agent.effort })
      .catch((err: unknown) => ({ ...fallback, router: "fallback" as const, confidence: null, reason: `router error (${err instanceof Error ? err.message : String(err)})` }));
    if (wantsMistral && provider === "anthropic") {
      route = { ...FALLBACK, router: "fallback", confidence: null, reason: `${agent.model} needs MISTRAL_API_KEY` };
    }
    const facts: MemoryFactDto[] = this.opts.memory
      ? await this.opts.memory.search(agent.id, text, 8).catch((err: unknown) => {
          this.opts.log(`[proxy] memory search for @${agent.handle} failed:`, err instanceof Error ? err.message : err);
          return [];
        })
      : [];
    const run: RunState = {
      runId: randomUUID(),
      route,
      provider,
      workerModel: provider === "anthropic" ? route.model : FALLBACK.model,
      facts: facts.length,
      agent,
      ctx,
      memory: memoryBlock(facts),
      lastMessages: [],
      lastText: "",
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      mistralReasoning: this.opts.mistral?.reasoning ?? false,
    };
    this.runs.set(agent.id, run);
    return { runId: run.runId, route, provider, workerModel: run.workerModel, facts: run.facts };
  }

  /** Ends the session: returns what it used and extracts new memory in the background. */
  endRun(agentId: string, finalText = ""): RunUsage | null {
    const run = this.runs.get(agentId);
    if (!run) return null;
    this.runs.delete(agentId);
    if (this.opts.extractor && this.opts.memory && run.lastMessages.length) {
      void this.extract(run, finalText || run.lastText).catch((err: unknown) =>
        this.opts.log(`[proxy] memory extraction for @${run.agent.handle} failed:`, err instanceof Error ? err.message : err),
      );
    }
    return run.usage;
  }

  private async extract(run: RunState, finalText: string) {
    const text = transcript(run.lastMessages, finalText);
    if (text.length < 1500) return;
    const memory = this.opts.memory!;
    const extractor = this.opts.extractor!;
    const known = await memory.search(run.agent.id, run.ctx.task ? taskText(run.ctx.task) : run.ctx.prompt, 30);
    const facts = await extractor.extract({
      agent: { name: run.agent.name, role: run.agent.role },
      kind: run.ctx.kind,
      taskKey: run.ctx.task?.key ?? null,
      transcript: text,
      known,
    });
    if (facts.length === 0) return;
    const source = `${run.ctx.task?.key ? `${run.ctx.task.key} ` : ""}${run.ctx.kind} session`;
    const saved = await memory.save(run.agent.id, facts, source);
    this.opts.log(`[proxy] @${run.agent.handle} learned ${saved.length} fact(s) from its ${source}`);
  }

  private authenticate(req: IncomingMessage): ProxyAgent | null {
    const key = (req.headers["x-api-key"] as string | undefined) ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
    return key ? (this.agentsByKey.get(key) ?? null) : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const agent = this.authenticate(req);
    if (!agent) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify(anthropicError(401, "unknown proxy key")));
    const url = new URL(req.url ?? "/", "http://proxy");
    const body = await readBody(req);
    const run = this.runs.get(agent.id) ?? null;

    if (req.method === "POST" && url.pathname === "/v1/messages") return this.messages(req, res, url, body, run);
    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens" && run?.provider === "mistral") {
      // Mistral has no token counter; about four characters per token is close enough for the harness.
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: Math.ceil(body.length / 4) }));
    }
    return this.forwardAnthropic(req, res, url, body, null, null);
  }

  private async messages(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, run: RunState | null) {
    const body = JSON.parse(raw.toString("utf8")) as AnthropicRequest;
    // Calls for the session's own model are the agent's turns; others (e.g. the harness's small
    // model naming things) pass through untouched.
    if (!run || body.model !== run.workerModel) return this.forwardAnthropic(req, res, url, raw, run, body.model);
    run.lastMessages = body.messages;
    if (run.memory) body.system = withMemory(body.system, run.memory);
    if (run.provider === "mistral") return this.mistral(res, body, run);
    body.model = run.route.model;
    body.output_config = { ...((body.output_config as Record<string, unknown> | undefined) ?? {}), effort: run.route.effort };
    return this.forwardAnthropic(req, res, url, Buffer.from(JSON.stringify(body)), run, body.model, true);
  }

  private async forwardAnthropic(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    body: Buffer,
    run: RunState | null,
    model: string | null,
    main = false,
  ) {
    const headers: Record<string, string> = { "x-api-key": this.opts.anthropic.apiKey };
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && (FORWARD_REQUEST.has(k) || k.startsWith("x-stainless"))) headers[k] = v;
    const abort = new AbortController();
    res.on("close", () => !res.writableFinished && abort.abort());
    const upstream = await fetch(`${this.opts.anthropic.url}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      signal: abort.signal,
    });
    const out: Record<string, string> = {};
    upstream.headers.forEach((v, k) => FORWARD_RESPONSE(k) && (out[k] = v));
    res.writeHead(upstream.status, out);
    if (!upstream.body) return void res.end();

    const streaming = upstream.headers.get("content-type")?.includes("event-stream") ?? false;
    const decoder = new TextDecoder();
    const text: string[] = [];
    const usage: Usage = {};
    const json: string[] = [];
    const parser = new SseParser((_event, data) => {
      const e = JSON.parse(data) as { type?: string; message?: { usage?: Usage }; usage?: Usage; delta?: { type?: string; text?: string } };
      if (e.type === "message_start") Object.assign(usage, e.message?.usage);
      else if (e.type === "message_delta") Object.assign(usage, e.usage);
      else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) text.push(e.delta.text);
    });
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      res.write(chunk);
      if (!run || upstream.status !== 200) continue;
      const s = decoder.decode(chunk, { stream: true });
      if (streaming) parser.push(s);
      else json.push(s);
    }
    res.end();
    if (!run || upstream.status !== 200) return;
    if (!streaming && json.length) {
      const msg = JSON.parse(json.join("")) as { usage?: Usage; content?: Block[] };
      Object.assign(usage, msg.usage);
      for (const b of msg.content ?? []) if (b.type === "text") text.push(String(b.text));
    }
    this.tally(run, model ?? run.route.model, usage);
    if (main) run.lastText = text.join("");
  }

  private async mistral(res: ServerResponse, body: AnthropicRequest, run: RunState) {
    const send = (effort: EffortLevel | null) =>
      fetch(`${this.opts.mistral!.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.mistral!.apiKey}` },
        body: JSON.stringify(toMistralRequest(body, { model: run.route.model, effort, cacheKey: run.runId })),
      });
    let upstream = await send(run.mistralReasoning ? run.route.effort : null);
    if (!upstream.ok && (upstream.status === 400 || upstream.status === 422) && run.mistralReasoning) {
      const detail = await upstream.text();
      if (!/reasoning/i.test(detail)) return this.mistralError(res, upstream.status, detail);
      this.opts.log(`[proxy] ${run.route.model} rejects reasoning_effort; sending without it`);
      run.mistralReasoning = false;
      upstream = await send(null);
    }
    if (!upstream.ok) return this.mistralError(res, upstream.status, await upstream.text());

    if (!body.stream) {
      const message = fromMistralResponse((await upstream.json()) as Parameters<typeof fromMistralResponse>[0], body.model);
      this.tally(run, run.route.model, message.usage);
      run.lastText = message.content.filter((b) => b.type === "text").map((b) => String(b.text)).join("");
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const stream = new MistralStream(body.model, (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    stream.start();
    const parser = new SseParser((_event, data) => data !== "[DONE]" && stream.chunk(JSON.parse(data)));
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) parser.push(decoder.decode(chunk, { stream: true }));
    const usage = stream.end();
    res.end();
    this.tally(run, run.route.model, usage);
    run.lastText = stream.text.join("");
  }

  private mistralError(res: ServerResponse, status: number, detail: string) {
    this.opts.log(`[proxy] Mistral ${status}: ${detail.slice(0, 300)}`);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(anthropicError(status, `Mistral: ${detail.slice(0, 500)}`)));
  }

  private tally(run: RunState, model: string, u: Usage) {
    const usage = run.usage;
    usage.calls += 1;
    usage.inputTokens += u.input_tokens ?? 0;
    usage.outputTokens += u.output_tokens ?? 0;
    usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
    const price = this.opts.prices[model];
    if (!price || usage.costUsd === null) {
      usage.costUsd = null;
      return;
    }
    usage.costUsd +=
      ((u.input_tokens ?? 0) * price.input +
        (u.output_tokens ?? 0) * price.output +
        (u.cache_read_input_tokens ?? 0) * price.cacheRead +
        (u.cache_creation_input_tokens ?? 0) * price.input * 1.25) /
      1_000_000;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
