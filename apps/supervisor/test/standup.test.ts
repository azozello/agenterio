import { describe, expect, it } from "vitest";
import type { TaskDto } from "@agentslack/shared";
import { composeStandup, standupDue } from "../src/standup.js";

const since = new Date("2026-10-13T09:30:00");
const person = (id: string, name: string) => ({ kind: "agent" as const, id, name, handle: name.toLowerCase() });
const MIRA = person("a-mira", "Mira");
const JUNO = person("a-juno", "Juno");
const ROWAN = person("a-rowan", "Rowan");

const t = (over: Partial<TaskDto>): TaskDto =>
  ({
    id: over.key,
    type: "task",
    status: "backlog",
    assignee: null,
    reporter: ROWAN,
    reviewer: null,
    approvedBy: null,
    approvedAt: null,
    foundIn: null,
    blockedBy: [],
    children: [],
    createdAt: "2026-10-12T10:00:00",
    updatedAt: "2026-10-12T10:00:00",
    ...over,
  }) as TaskDto;

const board = [
  t({ key: "DEMO-1", type: "feature", title: "Greeter", status: "in_progress", createdAt: "2026-10-13T12:00:00", children: [
    { id: "2", key: "DEMO-2", title: "Greet CLI", type: "task", status: "done" },
    { id: "3", key: "DEMO-3", title: "Flags", type: "task", status: "in_progress" },
  ] }),
  t({ key: "DEMO-2", title: "Greet CLI", status: "done", assignee: MIRA, reviewer: JUNO, approvedBy: JUNO, approvedAt: "2026-10-13T15:00:00", updatedAt: "2026-10-13T16:00:00" }),
  t({ key: "DEMO-3", title: "Flags", status: "ready", assignee: MIRA, reviewer: JUNO }),
  t({ key: "DEMO-4", title: "Docs", assignee: MIRA, blockedBy: ["DEMO-3"] }),
  t({ key: "DEMO-5", title: "Empty name", type: "bug", reporter: JUNO, createdAt: "2026-10-13T14:00:00" }),
];

describe("standups", () => {
  it("reports an engineer's done, doing and waiting work", () => {
    expect(composeStandup({ me: { id: "a-mira", role: "Engineer" }, tasks: board, since })).toBe(
      ["Standup", "Done: DEMO-2 Greet CLI", "Doing: DEMO-3 Flags (Ready)", "Blocked: DEMO-4 Docs (waiting on DEMO-3)"].join("\n"),
    );
  });

  it("reports a tester's approvals, bugs and reviews", () => {
    expect(composeStandup({ me: { id: "a-juno", role: "Tester" }, tasks: board, since })).toBe(
      ["Standup", "Done: approved DEMO-2 Greet CLI; filed DEMO-5 Empty name", "Doing: reviewing DEMO-3 Flags", "Blocked: nothing"].join("\n"),
    );
  });

  it("reports the PM's plans, features in flight and what needs a decision", () => {
    expect(composeStandup({ me: { id: "a-rowan", role: "PM" }, tasks: board, since })).toBe(
      ["Standup", "Done: planned DEMO-1 Greeter", "Doing: DEMO-1 Greeter (1/2 done)", "Blocked: DEMO-5 needs an assignee"].join("\n"),
    );
  });

  it("is due from the standup time for three hours, and never when off", () => {
    expect(standupDue(new Date("2026-10-14T09:00:00"), "09:30")).toBeNull();
    expect(standupDue(new Date("2026-10-14T09:31:00"), "09:30")).toEqual(new Date("2026-10-14T09:30:00"));
    expect(standupDue(new Date("2026-10-14T13:00:00"), "09:30")).toBeNull();
    expect(standupDue(new Date("2026-10-14T09:31:00"), "off")).toBeNull();
  });
});
