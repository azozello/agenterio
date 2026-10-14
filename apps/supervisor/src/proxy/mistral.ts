// Translates the Anthropic Messages API (what the Claude Agent SDK in the laptop speaks) to Mistral's
// chat completions API and back, so an agent can run on a Mistral model in the same harness.
import { createHash } from "node:crypto";
import type { EffortLevel } from "@agentslack/shared";

export type Block = { type: string; [key: string]: unknown };
export type AnthropicMessage = { role: "user" | "assistant"; content: string | Block[] };

export interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  system?: string | Block[];
  messages: AnthropicMessage[];
  tools?: { name: string; description?: string; input_schema?: Record<string, unknown>; type?: string }[];
  tool_choice?: { type: string; name?: string };
  stream?: boolean;
  [key: string]: unknown;
}

type MistralToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type MistralContent = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: string })[];
export type MistralMessage =
  | { role: "system" | "user"; content: MistralContent }
  | { role: "assistant"; content: string; tool_calls?: MistralToolCall[] }
  | { role: "tool"; tool_call_id: string; name?: string; content: string };

/** Mistral accepts tool call ids of 9 letters and digits; others are hashed into that shape, stably. */
export function mistralId(id: string): string {
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id;
  const digest = createHash("sha256").update(id).digest("base64").replace(/[^a-zA-Z0-9]/g, "");
  return digest.slice(0, 9).padEnd(9, "0");
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: Block) => (b.type === "text" ? String(b.text ?? "") : b.type === "image" ? "[image omitted]" : ""))
    .filter(Boolean)
    .join("\n");
};

const MISTRAL_EFFORT: Record<EffortLevel, string> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };

/** JSON-schema keywords Mistral does not need and may reject. */
function cleanSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) return { type: "object", properties: {} };
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

export interface MistralOptions {
  model: string;
  effort: EffortLevel | null;
  /** Mistral bills cached prompt tokens at 10%; one key per session keeps its prefix warm. */
  cacheKey?: string;
  maxTokens?: number;
}

export function toMistralRequest(req: AnthropicRequest, opts: MistralOptions) {
  const messages: MistralMessage[] = [];
  const system = textOf(req.system);
  if (system) messages.push({ role: "system", content: system });

  for (const m of req.messages) {
    if (typeof m.content === "string") {
      messages.push(m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
      const calls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: mistralId(String(b.id)), type: "function" as const, function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results answer the previous assistant turn, so they come before the user's own text.
    for (const b of m.content.filter((b) => b.type === "tool_result")) {
      const body = textOf(b.content) || "(no output)";
      messages.push({ role: "tool", tool_call_id: mistralId(String(b.tool_use_id)), content: b.is_error ? `Error: ${body}` : body });
    }
    const parts: Exclude<MistralContent, string> = [];
    for (const b of m.content) {
      if (b.type === "text" && String(b.text ?? "").trim()) parts.push({ type: "text", text: String(b.text) });
      const source = b.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined;
      if (b.type === "image" && source?.type === "base64") parts.push({ type: "image_url", image_url: `data:${source.media_type};base64,${source.data}` });
      if (b.type === "image" && source?.type === "url" && source.url) parts.push({ type: "image_url", image_url: source.url });
    }
    if (parts.length) {
      messages.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n\n") : parts });
    }
  }

  const tools = (req.tools ?? [])
    .filter((t) => t.input_schema)
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: cleanSchema(t.input_schema) } }));
  const choice = req.tool_choice;
  const tool_choice =
    !choice || !tools.length
      ? undefined
      : choice.type === "tool" && choice.name
        ? { type: "function", function: { name: choice.name } }
        : ({ auto: "auto", any: "any", none: "none" } as Record<string, string>)[choice.type];

  return {
    model: opts.model,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    max_tokens: Math.min(req.max_tokens ?? 8192, opts.maxTokens ?? 32_768),
    stream: Boolean(req.stream),
    ...(opts.effort ? { reasoning_effort: MISTRAL_EFFORT[opts.effort] } : {}),
    ...(opts.cacheKey ? { prompt_cache_key: opts.cacheKey } : {}),
  };
}

const STOP: Record<string, string> = { stop: "end_turn", tool_calls: "tool_use", length: "max_tokens", model_length: "max_tokens" };

/** Text from a Mistral content field, which is a string or a list of chunks (reasoning chunks are dropped). */
function mistralText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: { type?: string; text?: string }) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).join("");
}

export interface MistralUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** Anthropic counts cached input apart from fresh input; Mistral's prompt_tokens includes both. */
const usageOf = (u: MistralUsage | undefined) => {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max((u?.prompt_tokens ?? 0) - cached, 0),
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
  };
};

/** A non-streaming Mistral response as an Anthropic message. */
export function fromMistralResponse(res: {
  id?: string;
  choices?: { message?: { content?: unknown; tool_calls?: MistralToolCall[] }; finish_reason?: string }[];
  usage?: MistralUsage;
}, model: string) {
  const choice = res.choices?.[0];
  const content: Block[] = [];
  const text = mistralText(choice?.message?.content);
  if (text) content.push({ type: "text", text });
  for (const call of choice?.message?.tool_calls ?? []) {
    content.push({ type: "tool_use", id: call.id || mistralId(randomish()), name: call.function.name, input: parseArgs(call.function.arguments) });
  }
  return {
    id: `msg_${res.id ?? randomish()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: STOP[choice?.finish_reason ?? "stop"] ?? "end_turn",
    stop_sequence: null,
    usage: usageOf(res.usage),
  };
}

const randomish = () => Math.random().toString(36).slice(2, 11).padEnd(9, "0");

function parseArgs(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args || "{}");
  } catch {
    return { _raw: args };
  }
}

type Emit = (event: string, data: unknown) => void;

/**
 * Turns Mistral's streamed chunks into Anthropic's server-sent events: message_start, one content
 * block per text run or tool call, message_delta with the stop reason and usage, message_stop.
 */
export class MistralStream {
  private index = -1;
  private open: { kind: "text" } | { kind: "tool"; mistralIndex: number } | null = null;
  private finish = "stop";
  private usage: MistralUsage | undefined;
  readonly text: string[] = [];

  constructor(
    private readonly model: string,
    private readonly emit: Emit,
  ) {}

  start() {
    this.emit("message_start", {
      type: "message_start",
      message: {
        id: `msg_${randomish()}`,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  chunk(chunk: { choices?: { delta?: { content?: unknown; tool_calls?: (Partial<MistralToolCall> & { index?: number })[] }; finish_reason?: string | null }[]; usage?: MistralUsage }) {
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const text = mistralText(choice.delta?.content);
    if (text) {
      if (this.open?.kind !== "text") this.openBlock({ kind: "text" }, { type: "text", text: "" });
      this.emit("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text } });
      this.text.push(text);
    }
    for (const [i, call] of (choice.delta?.tool_calls ?? []).entries()) {
      const mistralIndex = call.index ?? i;
      if (!(this.open?.kind === "tool" && this.open.mistralIndex === mistralIndex)) {
        this.openBlock({ kind: "tool", mistralIndex }, { type: "tool_use", id: call.id || mistralId(randomish()), name: call.function?.name ?? "", input: {} });
      }
      const args = call.function?.arguments;
      const partial = typeof args === "string" ? args : args ? JSON.stringify(args) : "";
      if (partial) this.emit("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: partial } });
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
  }

  end() {
    this.closeBlock();
    const usage = usageOf(this.usage);
    this.emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: STOP[this.finish] ?? "end_turn", stop_sequence: null },
      usage,
    });
    this.emit("message_stop", { type: "message_stop" });
    return usage;
  }

  private openBlock(state: NonNullable<MistralStream["open"]>, block: Block) {
    this.closeBlock();
    this.index += 1;
    this.open = state;
    this.emit("content_block_start", { type: "content_block_start", index: this.index, content_block: block });
  }

  private closeBlock() {
    if (!this.open) return;
    this.emit("content_block_stop", { type: "content_block_stop", index: this.index });
    this.open = null;
  }
}

/** Splits a server-sent-event byte stream into `data:` payloads. */
export class SseParser {
  private buffer = "";

  constructor(private readonly onEvent: (event: string | null, data: string) => void) {}

  push(chunk: string) {
    this.buffer += chunk;
    let cut: number;
    while ((cut = this.buffer.search(/\r?\n\r?\n/)) !== -1) {
      const raw = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
      let event: string | null = null;
      const data: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) this.onEvent(event, data.join("\n"));
    }
  }
}
