import { describe, expect, it } from "vitest";
import { MistralStream, SseParser, fromMistralResponse, mistralId, toMistralRequest, type AnthropicRequest } from "../src/proxy/mistral.js";

const request: AnthropicRequest = {
  model: "claude-opus-5-5",
  max_tokens: 64_000,
  stream: true,
  system: [{ type: "text", text: "You are Margaux." }, { type: "text", text: "<agentslack_memory>- use npm test</agentslack_memory>" }],
  tools: [
    { name: "Bash", description: "Run a command", input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { command: { type: "string" } } } },
    { name: "web_search", type: "web_search_20260209" },
  ],
  tool_choice: { type: "auto" },
  messages: [
    { role: "user", content: "Fix the greeting" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "x" },
        { type: "text", text: "Running the tests." },
        { type: "tool_use", id: "toolu_01ABCdef", name: "Bash", input: { command: "npm test" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01ABCdef", content: [{ type: "text", text: "1 failing" }], is_error: true },
        { type: "text", text: "Keep going" },
      ],
    },
  ],
};

describe("Anthropic → Mistral", () => {
  it("maps system, turns, tool calls, tool results and tools", () => {
    const body = toMistralRequest(request, { model: "mistral-large-4", effort: "xhigh", cacheKey: "run-1" });
    const id = mistralId("toolu_01ABCdef");
    expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(body).toMatchObject({
      model: "mistral-large-4",
      max_tokens: 32_768,
      stream: true,
      reasoning_effort: "xhigh",
      prompt_cache_key: "run-1",
      tool_choice: "auto",
    });
    expect(body.messages).toEqual([
      { role: "system", content: "You are Margaux.\n<agentslack_memory>- use npm test</agentslack_memory>" },
      { role: "user", content: "Fix the greeting" },
      {
        role: "assistant",
        content: "Running the tests.",
        tool_calls: [{ id, type: "function", function: { name: "Bash", arguments: '{"command":"npm test"}' } }],
      },
      { role: "tool", tool_call_id: id, content: "Error: 1 failing" },
      { role: "user", content: "Keep going" },
    ]);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "Bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } } },
    ]);
  });

  it("keeps Mistral's own call ids so tool results find their call", () => {
    expect(mistralId("aB3dE6gH9")).toBe("aB3dE6gH9");
    expect(mistralId("toolu_x")).toBe(mistralId("toolu_x"));
  });
});

describe("Mistral → Anthropic", () => {
  it("streams text and tool calls as Anthropic events with usage", () => {
    const events: [string, unknown][] = [];
    const stream = new MistralStream("claude-opus-5-5", (event, data) => events.push([event, data]));
    const sse = new SseParser((_e, data) => data !== "[DONE]" && stream.chunk(JSON.parse(data)));
    stream.start();
    sse.push('data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":[]},{"type":"text","text":"Let me "}]}}]}\n\n');
    sse.push('data: {"choices":[{"delta":{"content":"check."}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"id":"aB3dE6gH9","index":0,"function":{"name":"Bash","arguments":"{\\"command\\":"}}]}}]}\n\n');
    sse.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1200,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":1000}}}\n\ndata: [DONE]\n\n');
    const usage = stream.end();

    expect(events.map(([e]) => e)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[5]![1]).toMatchObject({ index: 1, content_block: { type: "tool_use", id: "aB3dE6gH9", name: "Bash", input: {} } });
    const json = events.filter(([, d]) => (d as { delta?: { type?: string } }).delta?.type === "input_json_delta");
    expect(json.map(([, d]) => (d as { delta: { partial_json: string } }).delta.partial_json).join("")).toBe('{"command":"ls"}');
    expect(events[9]![1]).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 40 } });
    expect(usage.output_tokens).toBe(40);
    expect(stream.text.join("")).toBe("Let me check.");
  });

  it("converts a non-streaming answer", () => {
    expect(
      fromMistralResponse(
        {
          id: "abc",
          choices: [{ message: { content: "Done.", tool_calls: [{ id: "aB3dE6gH9", type: "function", function: { name: "Bash", arguments: '{"command":"npm test"}' } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        "claude-opus-5-5",
      ),
    ).toMatchObject({
      model: "claude-opus-5-5",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Done." },
        { type: "tool_use", id: "aB3dE6gH9", name: "Bash", input: { command: "npm test" } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });
});
