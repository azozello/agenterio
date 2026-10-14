"use client";

import { useState } from "react";
import Link from "next/link";
import { GitBranch } from "lucide-react";
import {
  TASK_STATUS_LABELS,
  type Estimate,
  type ProjectDto,
  type TaskDto,
  type TaskPriority,
  type TaskStatus,
  type UpdateTaskRequest,
} from "@agentslack/shared";
import { PRIORITIES, STATUS_ORDER, assignablePeople, isReviewBug, parseLabels, taskPath } from "@/lib/tasks";
import { formatWhen } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { ApprovedBadge, PrBadge, StatusPill } from "./task-badges";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-2 py-1.5 text-sm">
      <dt className="pt-1.5 text-muted-foreground">{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}</dt>
      <dd className="min-w-0 pt-px">{children}</dd>
    </div>
  );
}

const plain = "pt-1.5 block";

/** Labels as a comma separated input, saved on blur or Enter. */
function LabelsInput({ task, save }: { task: TaskDto; save: (input: UpdateTaskRequest) => Promise<boolean> }) {
  const initial = task.labels.join(", ");
  const [draft, setDraft] = useState(initial);
  function commit() {
    const labels = parseLabels(draft);
    if (labels.join(", ") !== initial) void save({ labels });
    else setDraft(initial);
  }
  return (
    <Input
      id="tf-labels"
      className="h-8"
      value={draft}
      placeholder="None"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(initial);
      }}
    />
  );
}

/** The editable field list beside a task. */
export function TaskFields({
  task,
  project,
  save,
}: {
  task: TaskDto;
  project: ProjectDto;
  save: (input: UpdateTaskRequest) => Promise<boolean>;
}) {
  const { workspace } = useWorkspace();
  const isFeature = task.type === "feature";
  const people = assignablePeople(workspace.people, project.id);
  const assigneeKnown = !task.assignee || people.some((p) => p.id === task.assignee!.id);

  return (
    <dl className="divide-y divide-border/60 rounded-lg border border-border px-3 py-1">
      <Row label="Status" htmlFor={isFeature ? undefined : "tf-status"}>
        {isFeature ? (
          <span className="block pt-1">
            <StatusPill status={task.status} />
            <span className="mt-1 block text-xs text-muted-foreground">Follows its tasks and bugs: done when all of them are.</span>
          </span>
        ) : (
          <Select
            id="tf-status"
            className="h-8"
            value={task.status}
            onChange={(e) => void save({ status: e.target.value as TaskStatus })}
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        )}
        {!isFeature && task.blockedBy.length > 0 && task.status === "backlog" && (
          <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">
            Can&apos;t start until {task.blockedBy.join(", ")} {task.blockedBy.length === 1 ? "is" : "are"} done.
          </span>
        )}
      </Row>

      {!isFeature && (
        <Row label="Assignee" htmlFor="tf-assignee">
          <Select
            id="tf-assignee"
            className="h-8"
            value={task.assignee?.id ?? ""}
            onChange={(e) => void save({ assigneeId: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {!assigneeKnown && task.assignee && <option value={task.assignee.id}>{task.assignee.name}</option>}
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.role ? ` (${p.role})` : p.kind === "human" ? " (human)" : ""}
              </option>
            ))}
          </Select>
        </Row>
      )}

      {!isFeature && (task.reviewer || task.status === "ready" || task.status === "in_review") && (
        <Row label="Reviewer">
          <span className={plain}>
            {task.reviewer ? task.reviewer.name : <span className="text-muted-foreground">No tester on {project.key}</span>}
            {task.approvedBy && task.approvedAt && (
              <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <ApprovedBadge by={task.approvedBy.name} />
                {task.approvedBy.id !== task.reviewer?.id && <span>by {task.approvedBy.name}</span>}
                <span>· {formatWhen(task.approvedAt)}</span>
              </span>
            )}
          </span>
        </Row>
      )}

      {task.foundIn && (
        <Row label="Found in">
          <Link href={taskPath(project.id, task.foundIn.key)} className={`${plain} truncate hover:underline`}>
            <span className="font-mono text-xs font-semibold text-muted-foreground">{task.foundIn.key}</span> {task.foundIn.title}
          </Link>
          {isReviewBug(task) && (
            <span className="mt-1 block text-xs text-muted-foreground">
              Fixed on {task.foundIn.key}&apos;s branch; follows its assignee and status and closes when it merges.
            </span>
          )}
        </Row>
      )}

      <Row label="Priority" htmlFor="tf-priority">
        <Select id="tf-priority" className="h-8" value={task.priority} onChange={(e) => void save({ priority: e.target.value as TaskPriority })}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
      </Row>

      <Row label="Estimate" htmlFor="tf-estimate">
        <Select
          id="tf-estimate"
          className="h-8"
          value={task.estimate ?? ""}
          onChange={(e) => void save({ estimate: (e.target.value || null) as Estimate | null })}
        >
          <option value="">None</option>
          <option value="S">S</option>
          <option value="M">M</option>
          <option value="L">L</option>
        </Select>
      </Row>

      <Row label="Labels" htmlFor="tf-labels">
        <LabelsInput key={task.labels.join(",")} task={task} save={save} />
      </Row>

      {task.parent && (
        <Row label="Feature">
          <Link href={taskPath(project.id, task.parent.key)} className={`${plain} truncate hover:underline`}>
            <span className="font-mono text-xs font-semibold text-muted-foreground">{task.parent.key}</span> {task.parent.title}
          </Link>
        </Row>
      )}

      {!isFeature && (
        <Row label="Pull request">
          {task.prUrl ? (
            <span className={plain}>
              <PrBadge url={task.prUrl} state={task.prState} />
              <a href={task.prUrl} target="_blank" rel="noreferrer" className="mt-0.5 block truncate text-xs text-muted-foreground hover:underline">
                {task.prUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
              </a>
            </span>
          ) : (
            <span className={`${plain} text-muted-foreground`}>None yet</span>
          )}
          {task.branch && (
            <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <GitBranch className="size-3.5 shrink-0" aria-hidden />
              <code className="truncate">{task.branch}</code>
            </span>
          )}
        </Row>
      )}

      <Row label="Reporter">
        <span className={plain}>{task.reporter?.name ?? <span className="text-muted-foreground">AgentSlack</span>}</span>
      </Row>
      <Row label="Created">
        <span className={plain}>{formatWhen(task.createdAt)}</span>
      </Row>
      <Row label="Updated">
        <span className={plain}>{formatWhen(task.updatedAt)}</span>
      </Row>
    </dl>
  );
}
