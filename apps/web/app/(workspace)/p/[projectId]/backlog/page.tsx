"use client";

import { useParams } from "next/navigation";
import { Backlog } from "@/components/backlog";
import { ProjectNotFound } from "@/components/project-header";
import { useWorkspace } from "@/lib/workspace";

export default function BacklogPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { workspace } = useWorkspace();
  const project = workspace.projects.find((p) => p.id === projectId);
  if (!project) return <ProjectNotFound />;
  return <Backlog key={project.id} project={project} />;
}
