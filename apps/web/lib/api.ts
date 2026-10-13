import type {
  CreateTaskRequest,
  DmDto,
  MeDto,
  MessageDto,
  ProfileDto,
  TaskDto,
  TaskStatus,
  TaskType,
  ThreadDto,
  UpdateTaskRequest,
  WorkspaceDto,
} from "@agentslack/shared";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    credentials: "include",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    throw new ApiError(res.status, (error as { error?: string } | null)?.error ?? res.statusText);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export interface TaskFilter {
  type?: TaskType;
  status?: TaskStatus;
  /** "me" or a person id. */
  assignee?: string;
}

function query(params: object) {
  const entries = Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "");
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : "";
}

const enc = encodeURIComponent;

export const api = {
  login: (email: string, password: string) => request<MeDto>("/auth/login", { method: "POST", body: { email, password } }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  me: () => request<MeDto>("/me"),
  workspace: () => request<WorkspaceDto>("/workspace"),
  profile: (personId: string) => request<ProfileDto>(`/people/${personId}`),
  openDm: (personId: string) => request<DmDto>("/dms", { method: "POST", body: { personId } }),
  messages: (channelId: string) => request<MessageDto[]>(`/channels/${channelId}/messages`),
  /** `parentId` makes it a thread reply. */
  postMessage: (channelId: string, body: string, parentId?: string) =>
    request<MessageDto>(`/channels/${channelId}/messages`, { method: "POST", body: { body, parentId } }),
  thread: (messageId: string) => request<ThreadDto>(`/messages/${messageId}/thread`),

  tasks: (projectId: string, filter: TaskFilter = {}) => request<TaskDto[]>(`/projects/${projectId}/tasks${query(filter)}`),
  createTask: (projectId: string, input: CreateTaskRequest) =>
    request<TaskDto>(`/projects/${projectId}/tasks`, { method: "POST", body: input }),
  /** `ref` is a task id or key such as DEMO-3. */
  task: (ref: string) => request<TaskDto>(`/tasks/${enc(ref)}`),
  updateTask: (ref: string, input: UpdateTaskRequest) => request<TaskDto>(`/tasks/${enc(ref)}`, { method: "PATCH", body: input }),
  taskComments: (ref: string) => request<MessageDto[]>(`/tasks/${enc(ref)}/comments`),
  commentOnTask: (ref: string, body: string) =>
    request<MessageDto>(`/tasks/${enc(ref)}/comments`, { method: "POST", body: { body } }),
};

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
