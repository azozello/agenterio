import { describe, expect, it } from "vitest";
import { AgentDefaultRouter, FALLBACK, LayaRouter, type RouteRequest } from "../src/router.js";

const TIERS: [string, string, string] = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

const request = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  kind: "task",
  role: "Engineer",
  text: "DEMO-2 (task, P2, S): Greet CLI\n\nPrint Hello, <name>!",
  fallback: FALLBACK,
  ...over,
});

/** A fake laya-serve that records the request and answers with `difficulty`. */
function laya(difficulty: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ answers: { difficulty }, usage: { input_tokens: 120, output_tokens: 0 } }), { status });
  }) as unknown as typeof globalThis.fetch;
  const router = new LayaRouter({ url: "http://laya:8100/", apiKey: "k", minConfidence: 0.6, timeoutMs: 1000, tiers: TIERS, fetch });
  return { router, calls };
}

describe("Laya router", () => {
  it("asks /v1/systemone one difficulty question and maps the answer to a model tier and effort", async () => {
    const { router, calls } = laya({ choice: "routine", confidence: 0.2, answer_confidence: 0.71 });
    expect(await router.route(request())).toEqual({
      model: "claude-sonnet-5-5",
      effort: "medium",
      router: "laya",
      confidence: 0.71,
      reason: "routine work",
    });
    expect(calls[0]!.url).toBe("http://laya:8100/v1/systemone");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.state.task).toContain("Implement a task and open a pull request as the team's Engineer.");
    expect(body.state.task).toContain("Greet CLI");
    expect(body.questions.difficulty.type).toBe("choice");
    expect(Object.keys(body.questions.difficulty.criteria)).toEqual(["trivial", "routine", "hard"]);

    expect((await laya({ choice: "trivial", answer_confidence: 0.65 }).router.route(request())).model).toBe("claude-haiku-5-5");
    expect(await laya({ choice: "hard", answer_confidence: 0.68 }).router.route(request())).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
  });

  it("keeps a pinned model and routes only its effort", async () => {
    const route = await laya({ choice: "trivial", answer_confidence: 0.8 }).router.route(
      request({ pinnedModel: "mistral-large-4", fallback: { model: "mistral-large-4", effort: "high" } }),
    );
    expect(route).toMatchObject({ model: "mistral-large-4", effort: "low", router: "laya" });
  });

  it("falls back below the confidence threshold, saying which way Laya leaned", async () => {
    expect(await laya({ choice: "hard", answer_confidence: 0.43 }).router.route(request())).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
      router: "fallback",
      confidence: 0.43,
      reason: "Laya confidence 0.43 < 0.60 (leaning hard)",
    });
  });

  it("falls back when Laya errors or answers with something it was not offered", async () => {
    expect((await laya({}, 503).router.route(request())).reason).toBe("Laya unavailable (HTTP 503)");
    expect(await laya({ choice: "impossible", answer_confidence: 1 }).router.route(request())).toMatchObject({
      ...FALLBACK,
      router: "fallback",
      reason: "Laya unavailable (no valid difficulty in the answer)",
    });
  });

  it("uses the agent's own model and effort when no router is configured", async () => {
    expect(await new AgentDefaultRouter().route(request(), { model: "claude-sonnet-5-5", effort: "medium" })).toEqual({
      model: "claude-sonnet-5-5",
      effort: "medium",
      router: "agent",
      confidence: null,
    });
  });
});
