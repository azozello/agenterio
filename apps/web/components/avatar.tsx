import { Cog } from "lucide-react";
import { avatarHue, cn, initials } from "@/lib/utils";

const SIZES = { xs: "size-5 text-[9px]", sm: "size-6 text-[10px]", md: "size-9 text-sm", lg: "size-14 text-lg" } as const;
const ICON_SIZES = { xs: "size-3", sm: "size-3.5", md: "size-5", lg: "size-7" } as const;

export function Avatar({ id, name, size = "md" }: { id: string; name: string; size?: keyof typeof SIZES }) {
  return (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center rounded-md font-semibold text-white select-none", SIZES[size])}
      style={{ background: `oklch(0.58 0.13 ${avatarHue(id)})` }}
    >
      {initials(name)}
    </span>
  );
}

/** AgentSlack itself, for system-authored messages. */
export function SystemAvatar({ size = "md" }: { size?: keyof typeof SIZES }) {
  return (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center rounded-md border border-border bg-muted text-muted-foreground", SIZES[size])}
    >
      <Cog className={ICON_SIZES[size]} />
    </span>
  );
}
