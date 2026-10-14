"use client";

import { useState } from "react";
import { SendHorizontal } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { parseCommand, runCommand } from "@/lib/commands";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

interface ComposerProps {
  id: string;
  placeholder: string;
  /** Throws to keep the draft and show the error. */
  onSend: (body: string) => Promise<void>;
  className?: string;
  autoFocus?: boolean;
}

type Feedback = { kind: "error" | "notice"; text: string } | null;

const HINT = "Enter to send, Shift+Enter for a new line, /pause @agent to stop one";

/** Message box: Enter sends, Shift+Enter adds a line. A leading / runs a slash command instead of posting. */
export function Composer({ id, placeholder, onSend, className, autoFocus }: ComposerProps) {
  const { workspace } = useWorkspace();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    const command = parseCommand(body, workspace.people);
    if (command && "error" in command) return setFeedback({ kind: "error", text: command.error });
    setSending(true);
    setFeedback(null);
    try {
      if (command) setFeedback({ kind: "notice", text: await runCommand(command) });
      else await onSend(body);
      setDraft("");
    } catch (err) {
      setFeedback({ kind: "error", text: command ? errorMessage(err) : `Not sent: ${errorMessage(err)}` });
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
      <p
        className={cn("mt-1 truncate text-xs", feedback?.kind === "error" ? "text-red-600" : feedback ? "text-foreground" : "text-muted-foreground")}
        role={feedback?.kind === "error" ? "alert" : feedback ? "status" : undefined}
      >
        {feedback?.text ?? HINT}
      </p>
    </form>
  );
}
