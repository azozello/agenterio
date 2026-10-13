"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MessageSquare, X } from "lucide-react";
import type { ProfileDto } from "@agentslack/shared";
import { api, errorMessage } from "@/lib/api";
import { projectForKey, taskPath } from "@/lib/tasks";
import { useTaskChanged } from "@/lib/use-tasks";
import { formatDay } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { Avatar } from "./avatar";
import { PresenceDot } from "./presence-dot";
import { StatusPill } from "./task-badges";
import { Button } from "./ui/button";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

const Later = ({ children }: { children: React.ReactNode }) => <span className="text-muted-foreground">{children}</span>;

/** Right-hand panel with a person's profile. Opened from the People list or a message author. */
export function ProfilePanel() {
  const { me, workspace, people, profileId, closePanel, messagePerson } = useWorkspace();
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    setProfile(null);
    setError(null);
    api.profile(profileId).then(
      (p) => !cancelled && setProfile(p),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  useEffect(() => {
    if (!profileId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closePanel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [profileId, closePanel]);

  // An agent's status changes when it picks up or finishes work, so refresh its current task then.
  const presence = profileId ? people.get(profileId) : undefined;
  const presenceKey = presence ? `${presence.id}|${presence.status}|${presence.statusText}` : null;
  const lastPresence = useRef(presenceKey);
  useEffect(() => {
    const previous = lastPresence.current;
    lastPresence.current = presenceKey;
    if (!profileId || !previous || !presenceKey || previous === presenceKey || !previous.startsWith(`${profileId}|`)) return;
    let cancelled = false;
    api.profile(profileId).then(
      (p) => !cancelled && setProfile(p),
      (err: unknown) => !cancelled && setError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [profileId, presenceKey]);

  // Keep the current task's status live.
  useTaskChanged((task) =>
    setProfile((p) =>
      p?.currentTask?.id === task.id ? { ...p, currentTask: { ...p.currentTask, title: task.title, status: task.status } } : p,
    ),
  );

  if (!profileId) return null;

  // The people map follows person.updated, so presence stays live while the panel is open.
  const person = profile ? (people.get(profile.person.id) ?? profile.person) : undefined;
  const current = profile?.currentTask ?? null;
  const currentProject = current ? (projectForKey(workspace, current.key) ?? profile?.project) : null;
  const isAgent = person?.kind === "agent";

  async function message() {
    if (!person) return;
    setOpening(true);
    try {
      await messagePerson(person.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }

  return (
    <aside aria-label="Profile" className="flex w-80 shrink-0 flex-col border-l border-border bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="font-semibold">Profile</h2>
        <button
          type="button"
          onClick={closePanel}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close profile"
          title="Close (Esc)"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!profile && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

        {profile && person && (
          <>
            <div className="flex items-center gap-3">
              <Avatar id={person.id} name={person.name} size="lg" />
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold">{person.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {person.role ?? (isAgent ? "Agent" : "Human")}
                  {person.handle && <> · @{person.handle}</>}
                </p>
              </div>
            </div>

            <p className="mt-3 flex items-center gap-2 text-sm">
              <PresenceDot status={person.status} />
              <span className="capitalize">{person.status ?? "online"}</span>
              {person.statusText && <span className="truncate text-muted-foreground">· {person.statusText}</span>}
            </p>

            {person.id !== me.id && (
              <Button className="mt-4 w-full" onClick={message} disabled={opening}>
                <MessageSquare className="size-4" />
                {opening ? "Opening…" : `Message ${person.name}`}
              </Button>
            )}

            {isAgent && (
              <dl className="mt-5 border-t border-border pt-3">
                <Field label="Project">{profile.project ? `${profile.project.key} · ${profile.project.name}` : <Later>None</Later>}</Field>
                <Field label="Model">
                  {profile.model} <span className="text-muted-foreground">· {profile.effort} effort</span>
                </Field>
                <Field label="Current task">
                  {current && currentProject ? (
                    <Link href={taskPath(currentProject.id, current.key)} className="group/task block rounded-md">
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-xs font-semibold text-muted-foreground">{current.key}</span>
                        <StatusPill status={current.status} />
                      </span>
                      <span className="mt-0.5 line-clamp-2 group-hover/task:underline">{current.title}</span>
                    </Link>
                  ) : (
                    <Later>None</Later>
                  )}
                </Field>
                <Field label="Laptop">
                  <Later>Not provisioned</Later>
                </Field>
                <Field label="Skills">
                  <Later>None yet</Later>
                </Field>
              </dl>
            )}

            <section className="mt-5 border-t border-border pt-3">
              <h3 className="text-sm font-semibold">Recent activity</h3>
              {profile.recentActivity.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">Nothing yet.</p>
              ) : (
                <ol className="mt-2 space-y-1.5">
                  {profile.recentActivity.map((a) => (
                    <li key={a.id} className="flex justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate">{a.summary}</span>
                      <time className="shrink-0 text-xs text-muted-foreground" dateTime={a.createdAt}>
                        {formatDay(a.createdAt)}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
