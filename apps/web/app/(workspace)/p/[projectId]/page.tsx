"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

/** A bare project link opens its board. */
export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/p/${projectId}/board`);
  }, [router, projectId]);
  return <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Opening board…</div>;
}
