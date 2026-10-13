"use client";

import { useParams } from "next/navigation";
import { Board } from "@/components/board";
import { ProjectNotFound } from "@/components/project-header";
import { useWorkspace } from "@/lib/workspace";

export default function BoardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { workspace } = useWorkspace();
  const project = workspace.projects.find((p) => p.id === projectId);
  if (!project) return <ProjectNotFound />;
  return <Board key={project.id} project={project} />;
}
