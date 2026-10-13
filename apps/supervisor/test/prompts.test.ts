import { describe, expect, it } from "vitest";
import type { InboxItemDto, MeDto, MessageDto, ProjectDto, TaskDto, WorkspaceDto } from "@agentslack/shared";
import { replyPrompt, systemPrompt, taskPrompt } from "../src/prompts.js";

const me: MeDto = {
  kind: "agent",
  id: "a-rowan",
  name: "Rowan",
  workspaceId: "w",
  projectId: "p",
  handle: "rowan",
  role: "PM",
  model: "claude-opus-5-5",
  effort: "high",
  systemPrompt: "",
  rolePrompt: "## Your role: PM",
};

const project: ProjectDto = {
  id: "p",
  key: "DEMO",
  name: "Demo project",
  repos: ["acme/app"],
  channels: [{ id: "c-general", name: "general", projectId: "p", kind: "channel", topic: "" }],
};

const ws: WorkspaceDto = {
  id: "w",
  name: "AgentSlack",
  channels: [{ id: "c-ann", name: "announcements", projectId: null, kind: "channel", topic: "" }],
  projects: [project],
  people: [
    { kind: "human", id: "u", name: "Denys", handle: null, role: "Admin", status: null, statusText: "", projectId: null },
    { kind: "agent", id: "a-rowan", name: "Rowan", handle: "rowan", role: "PM", status: "idle", statusText: "", projectId: "p" },
    { kind: "agent", id: "a-mira", name: "Mira", handle: "mira", role: "Engineer", status: "idle", statusText: "", projectId: "p" },
    { kind: "agent", id: "a-kai", name: "Kai", handle: "kai", role: "Tester", status: "idle", statusText: "", projectId: "other" },
  ],
  dms: [],
};

const message = (over: Partial<MessageDto>): MessageDto => ({
  id: "m1",
  channelId: "c-dm",
  parentId: null,
  body: "Let's build a greeter",
  createdAt: "2026-10-14T10:00:00.000Z",
  author: { kind: "human", id: "u", name: "Denys", handle: null },
  isActivity: false,
  task: null,
  replyCount: 0,
  lastReplyAt: null,
  ...over,
});

describe("prompts", () => {
  it("tells the agent who it is, its project and only its own teammates", () => {
    const prompt = systemPrompt(me, ws, project);
    expect(prompt).toContain("You are Rowan (@rowan), the PM");
    expect(prompt).toContain("Repositories: acme/app");
    expect(prompt).toContain("- Mira (@mira), Engineer");
    expect(prompt).not.toContain("@kai");
    expect(prompt).not.toContain("- Rowan (@rowan)");
    expect(prompt).toContain("## Your role: PM");
  });

  it("lists new messages with where to answer them and the earlier conversation", () => {
    const item: InboxItemDto = {
      id: "i1",
      kind: "dm",
      createdAt: "",
      message: message({}),
      channel: { id: "c-dm", name: "dm:u:a-rowan", projectId: null, kind: "dm", topic: "" },
      task: null,
    };
    const earlier = message({ id: "m0", body: "Hi", author: { kind: "agent", id: "a-rowan", name: "Rowan", handle: "rowan" } });
    const prompt = replyPrompt(me, [{ title: "Direct message", items: [item], context: [earlier] }]);
    expect(prompt).toContain("(dm) message m1 in channel id c-dm from Denys (human): Let's build a greeter");
    expect(prompt).toContain("Rowan (you): Hi");
  });

  it("gives an engineer the task, its thread and a note", () => {
    const task = {
      key: "DEMO-2",
      type: "task",
      priority: "P2",
      estimate: "S",
      title: "Greet CLI",
      parent: { key: "DEMO-1", title: "Greeter" },
      dependsOn: [],
      bugs: [],
      branch: null,
      prUrl: null,
      prState: null,
      description: "Build it",
    } as unknown as TaskDto;
    const prompt = taskPrompt(me, task, [message({ body: "Token fixed" })], "New replies: token fixed");
    expect(prompt).toContain("DEMO-2 (task, P2, S): Greet CLI");
    expect(prompt).toContain("Feature: DEMO-1 Greeter");
    expect(prompt).toContain("Denys (human): Token fixed");
    expect(prompt).toContain("New replies: token fixed");
  });
});
