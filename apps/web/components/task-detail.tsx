"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Pencil, Plus, X } from "lucide-react";
import type { ProjectDto, TaskDto, TaskRefDto, UpdateTaskRequest } from "@agentslack/shared";
import { api, errorMessage } from "@/lib/api";
import { getSocket } from "@/lib/socket";
import { progress, taskPath, withChangedRef } from "@/lib/tasks";
import { useTaskChanged } from "@/lib/use-tasks";
import { ProjectHeader } from "./project-header";
import { ProgressBar, StatusPill, TypeBadge, TypeIcon, WaitingBadge } from "./task-badges";
import { TaskFields } from "./task-fields";
import { TaskThread } from "./task-thread";
import { InlineError } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/select";

type Save = (input: UpdateTaskRequest) => Promise<boolean>;

function TitleEditor({ title, save }: { title: string; save: Save }) {
  const [draft, setDraft] = useState(title);
  function commit() {
    const next = draft.trim();
    if (next && next !== title) void save({ title: next });
    else setDraft(title);
  }
  return (
    <>
      <label htmlFor="task-title" className="sr-only">
        Title
      </label>
      <input
        id="task-title"
        value={draft}
        maxLength={300}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(title);
            e.stopPropagation();
          }
        }}
        className="-mx-1.5 w-[calc(100%+0.75rem)] rounded-md bg-transparent px-1.5 py-0.5 text-xl font-semibold outline-none hover:bg-muted focus:bg-background focus:ring-2 focus:ring-ring/30"
      />
    </>
  );
}

function DescriptionEditor({ description, save }: { description: string; save: Save }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(description);
  const [saving, setSaving] = useState(false);

  async function commit() {
    setSaving(true);
    const ok = await save({ description: draft });
    setSaving(false);
    if (ok) setEditing(false);
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <label htmlFor="task-description" className="sr-only">
          Description
        </label>
        <Textarea
          id="task-description"
          rows={12}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
            if (e.key === "Escape") e.stopPropagation();
          }}
          className="font-mono text-[13px] leading-relaxed"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void commit()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft(description);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <span className="text-xs text-muted-foreground">Markdown. Ctrl+Enter to save.</span>
        </div>
      </div>
    );
  }

  return (
    <div>
      {description ? (
        <div className="text-[15px] leading-relaxed break-words whitespace-pre-wrap">{description}</div>
      ) : (
        <p className="text-sm text-muted-foreground">No description.</p>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="mt-2 h-7 px-2 text-muted-foreground"
        onClick={() => {
          setDraft(description);
          setEditing(true);
        }}
      >
        <Pencil className="size-3.5" aria-hidden />
        Edit description
      </Button>
    </div>
  );
}

function RefList({ items, projectId, onRemove }: { items: TaskRefDto[]; projectId: string; onRemove?: (ref: TaskRefDto) => void }) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {items.map((r) => (
        <li key={r.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
          <TypeIcon type={r.type} />
          <Link href={taskPath(projectId, r.key)} className="shrink-0 font-mono text-xs font-semibold text-muted-foreground hover:underline">
            {r.key}
          </Link>
          <Link href={taskPath(projectId, r.key)} className="min-w-0 flex-1 truncate hover:underline">
            {r.title}
          </Link>
          <StatusPill status={r.status} />
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(r)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Remove dependency on ${r.key}`}
              title="Remove"
            >
              <X className="size-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mt-6 mb-2 flex items-center gap-2">
      <h2 className="text-sm font-semibold">{children}</h2>
      {aside}
    </div>
  );
}

function Dependencies({ task, projectId, save }: { task: TaskDto; projectId: string; save: Save }) {
  const [draft, setDraft] = useState("");
  const keys = task.dependsOn.map((d) => d.key);

  async function add() {
    const key = draft.trim().toUpperCase();
    if (!key) return;
    if (keys.includes(key)) {
      setDraft("");
      return;
    }
    if (await save({ dependsOn: [...keys, key] })) setDraft("");
  }

  return (
    <>
      <SectionTitle aside={<WaitingBadge keys={task.blockedBy} />}>Depends on</SectionTitle>
      {task.dependsOn.length > 0 ? (
        <RefList
          items={task.dependsOn}
          projectId={projectId}
          onRemove={(r) => void save({ dependsOn: keys.filter((k) => k !== r.key) })}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Nothing. This can start any time.</p>
      )}
      <form
        className="mt-2 flex max-w-sm items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label htmlFor="add-dependency" className="sr-only">
          Add a dependency by key
        </label>
        <Input
          id="add-dependency"
          className="h-8"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Task key, e.g. ${task.key.replace(/\d+$/, "12")}`}
        />
        <Button type="submit" size="sm" variant="outline" disabled={!draft.trim()}>
          <Plus className="size-3.5" aria-hidden />
          Add
        </Button>
      </form>
    </>
  );
}

/** Full task page: editable fields, related work and the task's thread. */
export function TaskDetail({ project, taskKey }: { project: ProjectDto; taskKey: string }) {
  const [task, setTask] = useState<TaskDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTask(await api.task(taskKey));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [taskKey]);

  useEffect(() => {
    void load();
    const socket = getSocket();
    const onConnect = () => void load();
    socket.on("connect", onConnect);
    return () => {
      socket.off("connect", onConnect);
    };
  }, [load]);

  useTaskChanged((changed) => setTask((cur) => (!cur ? cur : changed.id === cur.id ? changed : withChangedRef(cur, changed))));

  const save = useCallback<Save>(
    async (input) => {
      if (!task) return false;
      setSaveError(null);
      try {
        setTask(await api.updateTask(task.id, input));
        return true;
      } catch (err) {
        setSaveError(errorMessage(err));
        return false;
      }
    },
    [task],
  );

  if (!task) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ProjectHeader project={project} current={null} />
        <div className="p-5">
          {loadError ? (
            <InlineError message={`Couldn't load ${taskKey}: ${loadError}`} />
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </div>
      </div>
    );
  }

  const isFeature = task.type === "feature";
  const kids = progress(task.children);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProjectHeader project={project} current={null} />
      <div className="@container relative min-h-0 flex-1 overflow-y-auto">
        {saveError && (
          <div className="sticky top-0 z-10 mx-auto max-w-6xl bg-background px-5 pt-3">
            <InlineError message={`Couldn't save ${task.key}: ${saveError}`} onDismiss={() => setSaveError(null)} />
          </div>
        )}
        <div className="mx-auto grid max-w-6xl gap-6 px-5 py-5 @3xl:grid-cols-[minmax(0,1fr)_17rem]">
          <article className="min-w-0">
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {task.parent && (
                <>
                  <Link href={taskPath(project.id, task.parent.key)} className="flex min-w-0 items-center gap-1 hover:underline">
                    <TypeIcon type="feature" />
                    <span className="truncate">
                      {task.parent.key} · {task.parent.title}
                    </span>
                  </Link>
                  <span aria-hidden>/</span>
                </>
              )}
              <span className="shrink-0 font-mono font-semibold" aria-current="page">
                {task.key}
              </span>
              <TypeBadge type={task.type} />
              <StatusPill status={task.status} />
            </nav>

            <div className="mt-2">
              <TitleEditor key={task.title} title={task.title} save={save} />
            </div>

            <div className="mt-4">
              <DescriptionEditor description={task.description} save={save} />
            </div>

            {isFeature && (
              <>
                <SectionTitle
                  aside={
                    <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                      {kids.done}/{kids.total} done
                      <ProgressBar done={kids.done} total={kids.total} />
                    </span>
                  }
                >
                  Tasks and bugs
                </SectionTitle>
                {task.children.length > 0 ? (
                  <RefList items={task.children} projectId={project.id} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    None yet. Ask the PM to break it down, or add one from the{" "}
                    <Link href={`/p/${project.id}/backlog`} className="text-primary hover:underline">
                      backlog
                    </Link>
                    .
                  </p>
                )}
              </>
            )}

            {!isFeature && <Dependencies task={task} projectId={project.id} save={save} />}

            {(task.bugs.length > 0 || task.type === "task") && (
              <>
                <SectionTitle>Bugs</SectionTitle>
                {task.bugs.length > 0 ? (
                  <RefList items={task.bugs} projectId={project.id} />
                ) : (
                  <p className="text-sm text-muted-foreground">None filed.</p>
                )}
              </>
            )}

            <TaskThread task={task} />
          </article>

          <aside aria-label="Task fields" className="min-w-0 @3xl:sticky @3xl:top-5 @3xl:self-start">
            <TaskFields task={task} project={project} save={save} />
          </aside>
        </div>
      </div>
    </div>
  );
}
