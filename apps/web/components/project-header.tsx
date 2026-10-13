import Link from "next/link";
import { ListOrdered, SquareKanban } from "lucide-react";
import type { ProjectDto } from "@agentslack/shared";
import { cn } from "@/lib/utils";

const VIEWS = [
  { id: "board", label: "Board", icon: SquareKanban },
  { id: "backlog", label: "Backlog", icon: ListOrdered },
] as const;

/**
 * Header for a project's board, backlog and task pages: project name, view tabs, actions.
 * It is a size container: wrap action labels in `hidden @xl:inline` so they collapse to icons when
 * a side panel narrows the page.
 */
export function ProjectHeader({
  project,
  current,
  children,
}: {
  project: ProjectDto;
  current: "board" | "backlog" | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="@container flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
      <h1 className="min-w-0 truncate font-semibold">
        <span className="text-muted-foreground">{project.key}</span> {project.name}
      </h1>
      <nav aria-label="Project views" className="flex shrink-0 items-center gap-1">
        {VIEWS.map((v) => (
          <Link
            key={v.id}
            href={`/p/${project.id}/${v.id}`}
            aria-current={current === v.id ? "page" : undefined}
            aria-label={v.label}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-sm",
              current === v.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <v.icon className="size-4" aria-hidden />
            <span className="hidden @lg:inline">{v.label}</span>
          </Link>
        ))}
      </nav>
      {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** Shown when a project route points at a project you can't see. */
export function ProjectNotFound() {
  return <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Project not found.</div>;
}
