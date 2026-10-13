import Link from "next/link";
import { SquareKanban } from "lucide-react";
import type { ProjectDto } from "@agentslack/shared";

/** Empty board or backlog: points at the PM in #general and the backlog's "New feature". */
export function TasksEmpty({ project, onNewFeature }: { project: ProjectDto; onNewFeature?: () => void }) {
  const general = project.channels.find((c) => c.name === "general");
  return (
    <div className="grid flex-1 place-items-center p-6 text-center">
      <div className="max-w-sm">
        <SquareKanban className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <p className="mt-3 font-medium">No tasks yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask the PM in{" "}
          {general ? (
            <Link href={`/c/${general.id}`} className="font-medium text-primary hover:underline">
              #general
            </Link>
          ) : (
            "#general"
          )}{" "}
          or{" "}
          {onNewFeature ? (
            <button type="button" onClick={onNewFeature} className="font-medium text-primary hover:underline">
              create a feature
            </button>
          ) : (
            <Link href={`/p/${project.id}/backlog`} className="font-medium text-primary hover:underline">
              create a feature
            </Link>
          )}
          .
        </p>
      </div>
    </div>
  );
}
