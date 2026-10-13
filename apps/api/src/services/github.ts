import type { AppContext } from "../context.js";
import { applyTaskUpdate } from "./tasks.js";

export interface PullRequestInfo {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
}

/** Looks up a PR; null when it does not exist or is not visible to the token. */
export type FetchPullRequest = (repo: string, number: number) => Promise<PullRequestInfo | null>;

export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

export function githubPullRequests(token: string): FetchPullRequest {
  return async (repo, number) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${repo}#${number}`);
    const pr = (await res.json()) as { state: "open" | "closed"; merged: boolean; draft: boolean };
    return { state: pr.state, merged: pr.merged, draft: pr.draft };
  };
}

const stateOf = (pr: PullRequestInfo) => (pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open");

/**
 * One pass over PRs linked to open tasks. A merge moves the task to Done; a close without merge
 * is noted in the task thread. GitHub can't reach a local machine, so this replaces webhooks in the PoC.
 */
export async function pollPullRequests(ctx: AppContext, fetchPr: FetchPullRequest): Promise<void> {
  const links = await ctx.db.taskLink.findMany({
    where: { kind: "pr", url: { not: null }, task: { status: { in: ["in_progress", "blocked", "ready", "in_review"] } } },
    include: { task: true },
  });
  for (const link of links) {
    const ref = parsePrUrl(link.url!);
    if (!ref) continue;
    let pr: PullRequestInfo | null;
    try {
      pr = await fetchPr(ref.repo, ref.number);
    } catch (err) {
      console.error("[github] poll failed", err);
      continue;
    }
    if (!pr) continue;
    const state = stateOf(pr);
    if (state === link.state) continue;
    await ctx.db.taskLink.update({ where: { id: link.id }, data: { state } });
    if (state === "merged") {
      await applyTaskUpdate(ctx, null, link.taskId, { status: "done" }, `PR merged: ${link.url}`);
    } else if (state === "closed") {
      await applyTaskUpdate(ctx, null, link.taskId, {}, `PR closed without merging: ${link.url}`);
    }
  }
}

export function startPrPoller(ctx: AppContext, fetchPr: FetchPullRequest, intervalMs = 30_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await pollPullRequests(ctx, fetchPr);
    } catch (err) {
      console.error("[github] poller error", err);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
