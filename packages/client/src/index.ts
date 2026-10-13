import type {
  CreateTaskRequest,
  DmDto,
  InboxItemDto,
  MeDto,
  MessageDto,
  PersonDto,
  TaskDto,
  ThreadDto,
  UpdateTaskRequest,
  WorkspaceDto,
} from "@agentslack/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The AgentSlack REST API as seen by one agent (bearer token scoped to its project). */
export class AgentSlackApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(res.status, payload?.error ?? res.statusText);
    }
    return (await res.json()) as T;
  }

  me = () => this.request<MeDto>("GET", "/me");
  workspace = () => this.request<WorkspaceDto>("GET", "/workspace");
  messages = (channelId: string, limit = 30) => this.request<MessageDto[]>("GET", `/channels/${channelId}/messages?limit=${limit}`);
  thread = (messageId: string) => this.request<ThreadDto>("GET", `/messages/${messageId}/thread`);
  post = (channelId: string, body: string, parentId?: string) =>
    this.request<MessageDto>("POST", `/channels/${channelId}/messages`, { body, parentId });
  openDm = (personId: string) => this.request<DmDto>("POST", "/dms", { personId });
  setStatus = (status: PersonDto["status"], statusText?: string) =>
    this.request<PersonDto>("PATCH", "/me/status", { status, statusText });
  tasks = (projectId: string, query: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => Boolean(e[1]))).toString();
    return this.request<TaskDto[]>("GET", `/projects/${projectId}/tasks${qs ? `?${qs}` : ""}`);
  };
  task = (ref: string) => this.request<TaskDto>("GET", `/tasks/${encodeURIComponent(ref)}`);
  taskComments = (ref: string) => this.request<MessageDto[]>("GET", `/tasks/${encodeURIComponent(ref)}/comments`);
  createTask = (projectId: string, input: CreateTaskRequest) => this.request<TaskDto>("POST", `/projects/${projectId}/tasks`, input);
  updateTask = (ref: string, input: UpdateTaskRequest) => this.request<TaskDto>("PATCH", `/tasks/${encodeURIComponent(ref)}`, input);
  comment = (ref: string, body: string) => this.request<MessageDto>("POST", `/tasks/${encodeURIComponent(ref)}/comments`, { body });
  inbox = () => this.request<InboxItemDto[]>("GET", "/inbox");
  ack = (ids: string[]) => this.request<{ acknowledged: number }>("POST", "/inbox/ack", { ids });
}

