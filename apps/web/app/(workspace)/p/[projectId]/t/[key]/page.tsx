"use client";

import { useParams } from "next/navigation";
import { ProjectNotFound } from "@/components/project-header";
import { TaskDetail } from "@/components/task-detail";
import { useWorkspace } from "@/lib/workspace";

export default function TaskPage() {
  const params = useParams<{ projectId: string; key: string }>();
  const { workspace } = useWorkspace();
  const project = workspace.projects.find((p) => p.id === params.projectId);
  if (!project) return <ProjectNotFound />;
  const key = decodeURIComponent(params.key);
  return <TaskDetail key={key} project={project} taskKey={key} />;
}
