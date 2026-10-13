import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Inline error with an optional dismiss button. */
export function InlineError({ message, onDismiss, className }: { message: string; onDismiss?: () => void; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200",
        className,
      )}
    >
      <p className="min-w-0 flex-1 break-words">{message}</p>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="-m-1 rounded p-1 hover:bg-red-100 dark:hover:bg-red-900/50" aria-label="Dismiss">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
