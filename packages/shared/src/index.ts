// Wire types shared by the API, the web app, the supervisor and the agentslack MCP tools.
// Kept in one file so Next.js can transpile it without extension mapping.
import { z } from "zod";

export const AgentStatus = z.enum(["idle", "working", "blocked", "offline"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AuthorDto = z.object({
  /** "system" for messages AgentSlack writes itself (e.g. "PR merged"). */
  kind: z.enum(["human", "agent", "system"]),
  id: z.string(),
  name: z.string(),
  handle: z.string().nullable(),
});
export type AuthorDto = z.infer<typeof AuthorDto>;

// ---- Tasks

export const TaskType = z.enum(["feature", "task", "bug"]);
export type TaskType = z.infer<typeof TaskType>;

export const TaskStatus = z.enum(["backlog", "in_progress", "blocked", "ready", "in_review", "done"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  in_progress: "In progress",
  blocked: "Blocked",
  ready: "Ready",
  in_review: "In review",
  done: "Done",
};

export const TaskPriority = z.enum(["P0", "P1", "P2", "P3"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const Estimate = z.enum(["S", "M", "L"]);
export type Estimate = z.infer<typeof Estimate>;

/** Compact task reference, e.g. for dependencies and message cards. */
export const TaskRefDto = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  type: TaskType,
  status: TaskStatus,
});
export type TaskRefDto = z.infer<typeof TaskRefDto>;

export const PersonRefDto = z.object({
  kind: z.enum(["human", "agent"]),
  id: z.string(),
  name: z.string(),
  handle: z.string().nullable(),
});
export type PersonRefDto = z.infer<typeof PersonRefDto>;

export const TaskDto = z.object({
  id: z.string(),
  /** e.g. "DEMO-3" */
  key: z.string(),
  projectId: z.string(),
  number: z.number(),
  type: TaskType,
  title: z.string(),
  description: z.string(),
  /** For features this is derived from their children. */
  status: TaskStatus,
  priority: TaskPriority,
  estimate: Estimate.nullable(),
  labels: z.array(z.string()),
  rank: z.number(),
  parent: TaskRefDto.nullable(),
  assignee: PersonRefDto.nullable(),
  reporter: PersonRefDto.nullable(),
  dependsOn: z.array(TaskRefDto),
  /** Keys of dependencies that are not Done yet; empty means the task can start. */
  blockedBy: z.array(z.string()),
  /** Tasks and bugs under a feature; empty for tasks and bugs. */
  children: z.array(TaskRefDto),
  /** Bugs filed against this task. */
  bugs: z.array(TaskRefDto),
  prUrl: z.string().nullable(),
  prState: z.string().nullable(),
  branch: z.string().nullable(),
  /** Thread root in the project's #general; status changes and comments are its replies. */
  threadMessageId: z.string().nullable(),
  threadChannelId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskDto = z.infer<typeof TaskDto>;

export const CreateTaskRequest = z.object({
  type: TaskType,
  title: z.string().trim().min(1).max(300),
  description: z.string().max(40_000).optional(),
  priority: TaskPriority.optional(),
  estimate: Estimate.optional(),
  labels: z.array(z.string()).optional(),
  /** Feature the task or bug belongs to. Required for tasks and bugs. */
  parentId: z.string().optional(),
  /** Task ids or keys that must be Done before this one can start. */
  dependsOn: z.array(z.string()).optional(),
  assigneeId: z.string().uuid().optional(),
  /** For bugs: the task the bug was found in. That task goes back to Backlog. */
  foundIn: z.string().optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const UpdateTaskRequest = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(40_000).optional(),
  priority: TaskPriority.optional(),
  estimate: Estimate.nullable().optional(),
  labels: z.array(z.string()).optional(),
  status: TaskStatus.optional(),
  /** null unassigns. */
  assigneeId: z.string().uuid().nullable().optional(),
  dependsOn: z.array(z.string()).optional(),
  prUrl: z.string().url().optional(),
  branch: z.string().max(200).optional(),
  rank: z.number().optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequest>;

export const CommentRequest = z.object({
  body: z.string().trim().min(1).max(40_000),
});
export type CommentRequest = z.infer<typeof CommentRequest>;

// ---- Chat

export const MessageDto = z.object({
  id: z.string(),
  channelId: z.string(),
  parentId: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  author: AuthorDto,
  /** Auto-generated status line. */
  isActivity: z.boolean(),
  /** Set when this message is the thread root of a task. */
  task: TaskRefDto.nullable(),
  replyCount: z.number(),
  lastReplyAt: z.string().nullable(),
});
export type MessageDto = z.infer<typeof MessageDto>;

export const ThreadDto = z.object({
  root: MessageDto,
  replies: z.array(MessageDto),
});
export type ThreadDto = z.infer<typeof ThreadDto>;

export const ChannelDto = z.object({
  id: z.string(),
  name: z.string(),
  projectId: z.string().nullable(),
  kind: z.enum(["channel", "dm"]),
  topic: z.string(),
});
export type ChannelDto = z.infer<typeof ChannelDto>;

export const ProjectDto = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  repos: z.array(z.string()),
  channels: z.array(ChannelDto),
});
export type ProjectDto = z.infer<typeof ProjectDto>;

export const PersonDto = z.object({
  kind: z.enum(["human", "agent"]),
  id: z.string(),
  name: z.string(),
  handle: z.string().nullable(),
  role: z.string().nullable(),
  status: AgentStatus.nullable(),
  statusText: z.string(),
  projectId: z.string().nullable(),
});
export type PersonDto = z.infer<typeof PersonDto>;

/** A direct-message channel and the people in it. */
export const DmDto = z.object({
  channel: ChannelDto,
  memberIds: z.array(z.string()),
});
export type DmDto = z.infer<typeof DmDto>;

export const WorkspaceDto = z.object({
  id: z.string(),
  name: z.string(),
  channels: z.array(ChannelDto),
  projects: z.array(ProjectDto),
  people: z.array(PersonDto),
  /** DMs the caller is a member of. */
  dms: z.array(DmDto),
});
export type WorkspaceDto = z.infer<typeof WorkspaceDto>;

export const ActivityDto = z.object({
  id: z.string(),
  type: z.string(),
  summary: z.string(),
  createdAt: z.string(),
});
export type ActivityDto = z.infer<typeof ActivityDto>;

export const ProfileDto = z.object({
  person: PersonDto,
  project: z.object({ id: z.string(), key: z.string(), name: z.string() }).nullable(),
  /** Agents only. */
  model: z.string().nullable(),
  effort: z.string().nullable(),
  currentTask: TaskRefDto.nullable(),
  recentActivity: z.array(ActivityDto),
});
export type ProfileDto = z.infer<typeof ProfileDto>;

export const OpenDmRequest = z.object({
  personId: z.string().uuid(),
});
export type OpenDmRequest = z.infer<typeof OpenDmRequest>;

export const MeDto = z.object({
  kind: z.enum(["human", "agent"]),
  id: z.string(),
  name: z.string(),
  workspaceId: z.string(),
  projectId: z.string().nullable(),
  /** Agents only. */
  handle: z.string().nullable(),
  role: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  rolePrompt: z.string().nullable(),
});
export type MeDto = z.infer<typeof MeDto>;

export const SetStatusRequest = z.object({
  status: AgentStatus,
  statusText: z.string().max(200).optional(),
});
export type SetStatusRequest = z.infer<typeof SetStatusRequest>;

export const LoginRequest = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const PostMessageRequest = z.object({
  body: z.string().trim().min(1).max(40_000),
  parentId: z.string().uuid().optional(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

// ---- Inbox

export const InboxKind = z.enum(["mention", "dm", "thread_reply", "task_assigned", "task_unblocked"]);
export type InboxKind = z.infer<typeof InboxKind>;

export const InboxItemDto = z.object({
  id: z.string(),
  kind: InboxKind,
  createdAt: z.string(),
  message: MessageDto.nullable(),
  channel: ChannelDto.nullable(),
  task: TaskRefDto.nullable(),
});
export type InboxItemDto = z.infer<typeof InboxItemDto>;

// ---- Events

/** Domain event as published on the bus and stored in the `event` table. */
export interface DomainEvent<P = unknown> {
  id: string;
  type: string;
  workspaceId: string;
  projectId: string | null;
  actor: { kind: "human" | "agent" | "system"; id: string | null };
  subjectType: string;
  subjectId: string;
  payload: P;
  createdAt: string;
}

/** Socket.IO event map, server to client. */
export interface ServerToClientEvents {
  /** Top-level messages and thread replies in channels the socket subscribed to. */
  "message.created": (message: MessageDto) => void;
  /** Sent to each member when a DM they are in is created. */
  "dm.created": (dm: DmDto) => void;
  /** Task created or changed, sent to everyone who can see its project. */
  "task.changed": (task: TaskDto) => void;
  /** An agent's status changed; sent to the whole workspace. */
  "person.updated": (person: PersonDto) => void;
  /** New inbox item for the connected agent. */
  "inbox.created": (item: InboxItemDto) => void;
}

export type Ack = (result: { ok: true } | { ok: false; error: string }) => void;

/** Socket.IO event map, client to server. */
export interface ClientToServerEvents {
  "channel:subscribe": (channelId: string, ack: Ack) => void;
  "channel:unsubscribe": (channelId: string, ack: Ack) => void;
}

export const SESSION_COOKIE = "as_session";

/** Agent handles in a message body, e.g. "hi @mira" → ["mira"]. */
export function parseMentions(body: string): string[] {
  return [...new Set([...body.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9-]*)/gi)].map((m) => m[1]!.toLowerCase()))];
}

// ---- Worker protocol: supervisor ↔ the worker inside an agent's laptop, over WebSocket

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkerRunCommand {
  type: "run";
  runId: string;
  kind: "reply" | "task";
  prompt: string;
  /** Appended to Claude Code's own system prompt. */
  systemPrompt: string;
  model: string;
  effort: EffortLevel;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Agent API token for the agentslack tools. Sent per run because it rotates when the supervisor restarts. */
  agentToken: string;
}

export interface WorkerAbortCommand {
  type: "abort";
  runId: string;
}

export type WorkerCommand = WorkerRunCommand | WorkerAbortCommand;

export type WorkerActivity = { kind: "text"; text: string } | { kind: "tool"; name: string; summary: string };

export interface WorkerRunResult {
  ok: boolean;
  /** "success", or the SDK's error subtype such as "error_max_turns". */
  subtype: string;
  /** Final assistant text, or the errors. */
  text: string;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export type WorkerEvent =
  | { type: "hello"; version: string; busy: boolean }
  | { type: "activity"; runId: string; activity: WorkerActivity }
  | { type: "done"; runId: string; result: WorkerRunResult }
  | { type: "error"; runId: string; message: string };
