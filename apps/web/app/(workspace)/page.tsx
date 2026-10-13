"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace";

/** Opens the first project's #general, or any channel if there is no project yet. */
export default function Home() {
  const { workspace } = useWorkspace();
  const router = useRouter();
  const target =
    workspace.projects[0]?.channels.find((c) => c.name === "general") ??
    workspace.projects[0]?.channels[0] ??
    workspace.channels[0];

  useEffect(() => {
    if (target) router.replace(`/c/${target.id}`);
  }, [router, target]);

  return (
    <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
      {target ? "Opening channel…" : "No channels yet. Run pnpm db:seed to create the demo project."}
    </div>
  );
}
