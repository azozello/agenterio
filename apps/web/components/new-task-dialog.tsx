"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Estimate, ProjectDto, TaskDto, TaskPriority, TaskType } from "@agentslack/shared";
import { api, errorMessage } from "@/lib/api";
import { PRIORITIES, assignablePeople, parseLabels } from "@/lib/tasks";
import { useWorkspace } from "@/lib/workspace";
import { InlineError } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, Textarea } from "./ui/select";

export type NewTaskIntent = { type: "feature" } | { type: "task"; featureId?: string };

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Modal form for a new feature, or a task or bug under a feature. */
export function NewTaskDialog({
  project,
  features,
  intent,
  onClose,
  onCreated,
}: {
  project: ProjectDto;
  features: TaskDto[];
  intent: NewTaskIntent;
  onClose: () => void;
  onCreated: (task: TaskDto) => void;
}) {
  const { workspace } = useWorkspace();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const isFeature = intent.type === "feature";
  const [type, setType] = useState<TaskType>(isFeature ? "feature" : "task");
  const [featureId, setFeatureId] = useState(intent.type === "task" ? (intent.featureId ?? features[0]?.id ?? "") : "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("P2");
  const [estimate, setEstimate] = useState<Estimate | "">("");
  const [labels, setLabels] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    // showModal focuses the first control; the title is what you type first.
    titleInput.current?.focus();
    return () => el?.close();
  }, []);

  const people = assignablePeople(workspace.people, project.id);

  async function submit() {
    if (!title.trim() || saving) return;
    if (!isFeature && !featureId) {
      setError("Pick the feature this belongs to.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const task = await api.createTask(project.id, {
        type,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        estimate: estimate || undefined,
        labels: labels.trim() ? parseLabels(labels) : undefined,
        parentId: isFeature ? undefined : featureId,
        assigneeId: assigneeId || undefined,
      });
      onCreated(task);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const heading = isFeature ? "New feature" : type === "bug" ? "New bug" : "New task";

  return (
    <dialog
      ref={dialog}
      aria-labelledby="new-task-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // Esc closes this dialog, not the side panel behind it.
      onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/40"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex max-h-[85vh] flex-col"
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 id="new-task-title" className="font-semibold">
            {heading} <span className="font-normal text-muted-foreground">in {project.key}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {!isFeature && (
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field label="Feature" htmlFor="nt-feature">
                <Select id="nt-feature" value={featureId} onChange={(e) => setFeatureId(e.target.value)} required>
                  {features.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.key} · {f.title}
                    </option>
                  ))}
                </Select>
              </Field>
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">Type</legend>
                <div className="flex h-9 items-center gap-3 text-sm">
                  {(["task", "bug"] as const).map((t) => (
                    <label key={t} className="flex items-center gap-1.5">
                      <input type="radio" name="nt-type" value={t} checked={type === t} onChange={() => setType(t)} />
                      {t === "task" ? "Task" : "Bug"}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          )}

          <Field label="Title" htmlFor="nt-title">
            <Input ref={titleInput} id="nt-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} />
          </Field>

          <Field label="Description" htmlFor="nt-description">
            <Textarea
              id="nt-description"
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={isFeature ? "What we're building and why. Markdown is fine." : "What to do, and how we'll know it's done."}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Priority" htmlFor="nt-priority">
              <Select id="nt-priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Estimate" htmlFor="nt-estimate">
              <Select id="nt-estimate" value={estimate} onChange={(e) => setEstimate(e.target.value as Estimate | "")}>
                <option value="">None</option>
                <option value="S">S</option>
                <option value="M">M</option>
                <option value="L">L</option>
              </Select>
            </Field>
            {!isFeature && (
              <Field label="Assignee" htmlFor="nt-assignee">
                <Select id="nt-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                  <option value="">Unassigned</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.role ? ` (${p.role})` : p.kind === "human" ? " (human)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>

          <Field label="Labels" htmlFor="nt-labels">
            <Input id="nt-labels" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="Comma separated, e.g. api, auth" />
          </Field>

          {error && <InlineError message={error} />}
        </div>

        <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!title.trim() || saving}>
            {saving ? "Creating…" : `Create ${isFeature ? "feature" : type}`}
          </Button>
        </footer>
      </form>
    </dialog>
  );
}
