import type { EffortLevel, RouteSource } from "@agentslack/shared";

/** The model and effort a session runs on, and how they were chosen. */
export interface Route {
  model: string;
  effort: EffortLevel;
  router: RouteSource;
  confidence: number | null;
  reason?: string;
}

/** What a session is about, as the router sees it. */
export interface RouteRequest {
  kind: "reply" | "task" | "review";
  role: string;
  /** Task title and description, or the messages a reply session answers. */
  text: string;
  /** Pinned model (e.g. the junior dev's Mistral model): only the effort is routed. */
  pinnedModel?: string;
  /** Used when the router is unsure or unreachable. */
  fallback: { model: string; effort: EffortLevel };
}

export interface TaskRouter {
  route(req: RouteRequest, agentDefault: { model: string; effort: EffortLevel }): Promise<Route>;
}

/** Spec: below the confidence threshold, or without an answer, a task runs on Opus 5.5 at high effort. */
export const FALLBACK = { model: "claude-opus-5-5", effort: "high" } as const satisfies { model: string; effort: EffortLevel };

export type Difficulty = "hard" | "routine" | "trivial";

/** Laya's `choice` criteria. One question decides far more sharply than asking for model and effort separately. */
const DIFFICULTY_CRITERIA: Record<Difficulty, string> = {
  trivial: "A minute of work: typo, rename, one-line config or copy change, or a short acknowledgement.",
  routine: "A small, well-specified feature, fix or review in a few files with clear acceptance criteria.",
  hard: "Open-ended or risky: design decisions, many files, security, concurrency or tricky debugging.",
};

const EFFORT: Record<Difficulty, EffortLevel> = { hard: "high", routine: "medium", trivial: "low" };

/** Routing never changes who works on a task; it only picks the model and effort. */
export class AgentDefaultRouter implements TaskRouter {
  async route(req: RouteRequest, agentDefault: { model: string; effort: EffortLevel }): Promise<Route> {
    return { model: req.pinnedModel ?? agentDefault.model, effort: agentDefault.effort, router: "agent", confidence: null };
  }
}

export interface LayaOptions {
  url: string;
  apiKey?: string;
  minConfidence: number;
  timeoutMs: number;
  /** Models for hard, routine and trivial work, in that order. */
  tiers: [string, string, string];
  fetch?: typeof fetch;
}

interface LayaAnswer {
  choice?: unknown;
  confidence?: unknown;
  /** Calibrated probability of the reported answer; preferred over `confidence`. */
  answer_confidence?: unknown;
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Asks a self-hosted Laya server (`laya-serve`, the `/v1/systemone` protocol) how hard a session's
 * work is and maps that to a model tier and effort level.
 */
export class LayaRouter implements TaskRouter {
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: LayaOptions) {
    this.fetch = opts.fetch ?? fetch;
  }

  async route(req: RouteRequest): Promise<Route> {
    let answer: { difficulty: Difficulty; confidence: number };
    try {
      answer = await this.ask(req);
    } catch (err) {
      return { ...req.fallback, router: "fallback", confidence: null, reason: `Laya unavailable (${err instanceof Error ? err.message : String(err)})` };
    }
    const min = this.opts.minConfidence;
    if (answer.confidence < min) {
      return {
        ...req.fallback,
        router: "fallback",
        confidence: answer.confidence,
        reason: `Laya confidence ${answer.confidence.toFixed(2)} < ${min.toFixed(2)} (leaning ${answer.difficulty})`,
      };
    }
    const [hard, routine, trivial] = this.opts.tiers;
    return {
      model: req.pinnedModel ?? { hard, routine, trivial }[answer.difficulty],
      effort: EFFORT[answer.difficulty],
      router: "laya",
      confidence: answer.confidence,
      reason: `${answer.difficulty} work`,
    };
  }

  /** The request body, exposed for tests. */
  body(req: RouteRequest) {
    const what = { reply: "Answer chat messages as", task: "Implement a task and open a pull request as", review: "Review and test a pull request as" }[req.kind];
    return {
      state: { task: `${what} the team's ${req.role}.\n\n${truncate(req.text, 4000)}` },
      questions: {
        difficulty: {
          type: "choice",
          instructions: "How hard is this software task for an expert engineer?",
          criteria: DIFFICULTY_CRITERIA,
        },
      },
    };
  }

  private async ask(req: RouteRequest) {
    const res = await this.fetch(`${this.opts.url.replace(/\/+$/, "")}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify(this.body(req)),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const answer = ((await res.json()) as { answers?: Record<string, LayaAnswer> }).answers?.difficulty;
    const choice = answer?.choice;
    if (typeof choice !== "string" || !(choice in DIFFICULTY_CRITERIA)) throw new Error("no valid difficulty in the answer");
    const raw = typeof answer!.answer_confidence === "number" ? answer!.answer_confidence : answer!.confidence;
    const confidence = typeof raw === "number" && Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0;
    return { difficulty: choice as Difficulty, confidence };
  }
}
