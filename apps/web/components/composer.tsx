"use client";

import { useState } from "react";
import { SendHorizontal } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ComposerProps {
  id: string;
  placeholder: string;
  /** Throws to keep the draft and show the error. */
  onSend: (body: string) => Promise<void>;
  className?: string;
  autoFocus?: boolean;
}

/** Message box: Enter sends, Shift+Enter adds a line. */
export function Composer({ id, placeholder, onSend, className, autoFocus }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body);
      setDraft("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className={cn("shrink-0", className)}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="flex items-end gap-2 rounded-lg border border-border bg-background p-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
        <label htmlFor={id} className="sr-only">
          {placeholder}
        </label>
        <textarea
          id={id}
          rows={1}
          value={draft}
          autoFocus={autoFocus}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={placeholder}
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] outline-none placeholder:text-muted-foreground"
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
          aria-label="Send message"
          title="Send (Enter)"
        >
          <SendHorizontal className="size-4" />
        </button>
      </div>
      <p className={cn("mt-1 text-xs", error ? "text-red-600" : "text-muted-foreground")} role={error ? "alert" : undefined}>
        {error ? `Not sent: ${error}` : "Enter to send, Shift+Enter for a new line"}
      </p>
    </form>
  );
}
