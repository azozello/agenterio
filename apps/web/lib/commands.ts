import type { PersonDto } from "@agentslack/shared";
import { api } from "./api";

/** Slash commands typed in any composer. M2 has the kill switch; /assign, /move and /status follow. */
export type SlashCommand = { name: "pause" | "resume"; target: "all" | PersonDto };

const USAGE = "Try /pause @agent, /pause all, /resume @agent or /resume all.";

/** Null when `body` is a normal message; an error when it is a command that can't run. */
export function parseCommand(body: string, people: PersonDto[]): SlashCommand | { error: string } | null {
  const text = body.trim();
  if (!text.startsWith("/")) return null;
  const [command = "", arg, ...rest] = text.split(/\s+/);
  const name = command.slice(1).toLowerCase();
  if (name !== "pause" && name !== "resume") return { error: `Unknown command ${command}. ${USAGE}` };
  if (!arg || rest.length > 0) return { error: `Usage: /${name} @agent, or /${name} all` };
  if (arg.toLowerCase() === "all") return { name, target: "all" };
  const handle = arg.replace(/^@/, "").toLowerCase();
  const agent = people.find((p) => p.kind === "agent" && p.handle === handle);
  return agent ? { name, target: agent } : { error: `No agent @${handle}` };
}

/** Runs a command and says what changed. */
export async function runCommand({ name, target }: SlashCommand): Promise<string> {
  const verb = name === "pause" ? "Paused" : "Resumed";
  if (target === "all") {
    const changed = await (name === "pause" ? api.pauseAll() : api.resumeAll());
    if (changed.length === 0) return name === "pause" ? "Every agent was already paused." : "No agent was paused.";
    return `${verb} ${changed.map((p) => p.name).join(", ")}.`;
  }
  if ((name === "pause") === target.paused) return `${target.name} is already ${name === "pause" ? "paused" : "running"}.`;
  const person = await (name === "pause" ? api.pauseAgent(target.id) : api.resumeAgent(target.id));
  return `${verb} ${person.name}.`;
}
