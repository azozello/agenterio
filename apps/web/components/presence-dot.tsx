import type { AgentStatus } from "@agentslack/shared";
import { cn } from "@/lib/utils";

const STYLES: Record<AgentStatus, string> = {
  working: "bg-status-working",
  idle: "bg-status-idle",
  blocked: "bg-status-blocked",
  offline: "border-[1.5px] border-status-offline bg-transparent",
};

/** Presence of a person; a paused agent shows a pause sign instead of its status. */
export function PresenceDot({ status, paused = false, className }: { status: AgentStatus | null; paused?: boolean; className?: string }) {
  if (paused) {
    return (
      <span
        role="img"
        aria-label="paused"
        title="paused"
        className={cn("inline-block size-2 shrink-0 border-x-[2.5px] border-status-offline", className)}
      />
    );
  }
  // Humans have no agent status; show them as present.
  const s = status ?? "working";
  return (
    <span
      role="img"
      aria-label={status ?? "online"}
      title={status ?? "online"}
      className={cn("inline-block size-2 shrink-0 rounded-full", STYLES[s], className)}
    />
  );
}
