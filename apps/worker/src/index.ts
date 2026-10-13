// The worker inside an agent's laptop. It runs one Claude Agent SDK session at a time on behalf of
// the agent's supervisor, which connects over a WebSocket and authenticates with WORKER_SECRET.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { WebSocketServer, type WebSocket } from "ws";
import type { WorkerCommand, WorkerEvent, WorkerRunCommand, WorkerRunResult } from "@agentslack/shared";
import { AgentSlackApi } from "@agentslack/client";
import { agentslackServer } from "./tools.js";

const VERSION = "0.1.0";
const PORT = Number(process.env.WORKER_PORT ?? 7070);
const SECRET = required("WORKER_SECRET");
const API_URL = required("AGENTSLACK_API_URL");
const WORK_DIR = process.env.WORK_DIR ?? `${process.env.HOME ?? "/home/agent"}/work`;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[worker] ${name} is not set`);
    process.exit(1);
  }
  return value;
}

/** git commits as the agent; pushes and `gh` use GITHUB_TOKEN. Never prints the token. */
function configureGit() {
  const git = (...args: string[]) => execFileSync("git", ["config", "--global", ...args]);
  if (process.env.GIT_AUTHOR_NAME) git("user.name", process.env.GIT_AUTHOR_NAME);
  if (process.env.GIT_AUTHOR_EMAIL) git("user.email", process.env.GIT_AUTHOR_EMAIL);
  git("init.defaultBranch", "main");
  git("credential.https://github.com.helper", '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f');
}

let current: { runId: string; abort: AbortController } | null = null;

function summarizeInput(input: unknown): string {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

async function run(cmd: WorkerRunCommand, send: (e: WorkerEvent) => void): Promise<void> {
  const abort = new AbortController();
  current = { runId: cmd.runId, abort };
  const started = Date.now();
  try {
    const me = await new AgentSlackApi(API_URL, cmd.agentToken).me();
    if (!me.projectId) throw new Error("agent has no project");
    const session = query({
      prompt: cmd.prompt,
      options: {
        model: cmd.model,
        effort: cmd.effort,
        thinking: { type: "adaptive" },
        systemPrompt: { type: "preset", preset: "claude_code", append: cmd.systemPrompt },
        // The laptop is the sandbox: an isolated container with only this agent's credentials.
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        cwd: WORK_DIR,
        mcpServers: { agentslack: agentslackServer(API_URL, cmd.agentToken, me.projectId) },
        maxTurns: cmd.maxTurns,
        maxBudgetUsd: cmd.maxBudgetUsd,
        abortController: abort,
        stderr: (line) => console.error(`[claude] ${line.trimEnd()}`),
      },
    });

    let result: WorkerRunResult | null = null;
    for await (const m of session) {
      if (m.type === "assistant") {
        for (const block of m.message.content) {
          if (block.type === "text" && block.text.trim()) {
            send({ type: "activity", runId: cmd.runId, activity: { kind: "text", text: block.text.slice(0, 2000) } });
          } else if (block.type === "tool_use") {
            send({ type: "activity", runId: cmd.runId, activity: { kind: "tool", name: block.name, summary: summarizeInput(block.input) } });
          }
        }
      } else if (m.type === "result") {
        result = {
          ok: m.subtype === "success" && !m.is_error,
          subtype: m.subtype,
          text: m.subtype === "success" ? m.result : m.errors.join("; "),
          costUsd: m.total_cost_usd,
          numTurns: m.num_turns,
          durationMs: m.duration_ms,
          inputTokens: m.usage.input_tokens + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0),
          outputTokens: m.usage.output_tokens,
        };
      }
    }
    send({
      type: "done",
      runId: cmd.runId,
      result: result ?? {
        ok: false,
        subtype: "no_result",
        text: "session ended without a result",
        costUsd: 0,
        numTurns: 0,
        durationMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
      },
    });
  } catch (err) {
    send({ type: "error", runId: cmd.runId, message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (current?.runId === cmd.runId) current = null;
  }
}

function handle(socket: WebSocket) {
  const send = (e: WorkerEvent) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(e));
  send({ type: "hello", version: VERSION, busy: current !== null });
  socket.on("message", (raw) => {
    let cmd: WorkerCommand;
    try {
      cmd = JSON.parse(String(raw)) as WorkerCommand;
    } catch {
      return;
    }
    if (cmd.type === "run") {
      if (current) return send({ type: "error", runId: cmd.runId, message: `busy with run ${current.runId}` });
      void run(cmd, send);
    } else if (cmd.type === "abort" && current?.runId === cmd.runId) {
      current.abort.abort();
    }
  });
}

configureGit();
mkdirSync(WORK_DIR, { recursive: true });

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, busy: current !== null }));
  } else {
    res.writeHead(404).end();
  }
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.headers.authorization !== `Bearer ${SECRET}`) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, handle);
});
server.listen(PORT, () => console.log(`[worker] listening on :${PORT}, work dir ${WORK_DIR}`));
