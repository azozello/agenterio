"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Hash, ListOrdered, LogOut, SquareKanban, type LucideIcon } from "lucide-react";
import type { ChannelDto } from "@agentslack/shared";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { PresenceDot } from "./presence-dot";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 first:mt-3">
      <h2 className="truncate px-4 pb-1 text-xs font-semibold tracking-wide text-sidebar-muted uppercase">{title}</h2>
      <ul>{children}</ul>
    </section>
  );
}

function ChannelLink({ channel, active }: { channel: ChannelDto; active: boolean }) {
  return (
    <li>
      <Link
        href={`/c/${channel.id}`}
        aria-current={active ? "page" : undefined}
        className={cn(
          "mx-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[15px]",
          active ? "bg-sidebar-active font-medium text-white" : "text-sidebar-foreground/85 hover:bg-sidebar-hover",
        )}
      >
        <Hash className="size-4 shrink-0 opacity-70" aria-hidden />
        <span className="truncate">{channel.name}</span>
      </Link>
    </li>
  );
}

function NavLink({ href, icon: Icon, label, active }: { href: string; icon: LucideIcon; label: string; active: boolean }) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "mx-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[15px]",
          active ? "bg-sidebar-active font-medium text-white" : "text-sidebar-foreground/85 hover:bg-sidebar-hover",
        )}
      >
        <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
        <span className="truncate">{label}</span>
      </Link>
    </li>
  );
}

export function Sidebar() {
  const { me, workspace, profileId, openProfile, dmPartner } = useWorkspace();
  const params = useParams<{ channelId?: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const activeId = params.channelId;

  async function logout() {
    await api.logout().catch(() => undefined);
    router.replace("/login");
  }

  return (
    <nav aria-label="Workspace" className="flex h-full w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <header className="flex h-12 items-center border-b border-sidebar-border px-4">
        <span className="truncate text-[15px] font-semibold text-white">{workspace.name}</span>
      </header>

      <div className="flex-1 overflow-y-auto pb-4">
        {workspace.channels.length > 0 && (
          <Section title="Workspace">
            {workspace.channels.map((c) => (
              <ChannelLink key={c.id} channel={c} active={c.id === activeId} />
            ))}
          </Section>
        )}

        {workspace.projects.map((p) => (
          <Section key={p.id} title={`${p.key} · ${p.name}`}>
            <NavLink href={`/p/${p.id}/board`} icon={SquareKanban} label="Board" active={pathname === `/p/${p.id}/board`} />
            <NavLink href={`/p/${p.id}/backlog`} icon={ListOrdered} label="Backlog" active={pathname === `/p/${p.id}/backlog`} />
            {p.channels.map((c) => (
              <ChannelLink key={c.id} channel={c} active={c.id === activeId} />
            ))}
          </Section>
        ))}

        <Section title="Direct messages">
          {workspace.dms.length === 0 && (
            <li className="px-4 py-1 text-sm text-sidebar-muted">Click a person below to start one</li>
          )}
          {workspace.dms.map((dm) => {
            const partner = dmPartner(dm);
            const active = dm.channel.id === activeId;
            return (
              <li key={dm.channel.id}>
                <Link
                  href={`/c/${dm.channel.id}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "mx-2 flex items-center gap-2 rounded-md px-2 py-1 text-[15px]",
                    active ? "bg-sidebar-active font-medium text-white" : "text-sidebar-foreground/85 hover:bg-sidebar-hover",
                  )}
                >
                  <PresenceDot status={partner?.status ?? null} />
                  <span className="truncate">{partner?.name ?? "Direct message"}</span>
                </Link>
              </li>
            );
          })}
        </Section>

        <Section title="People">
          {workspace.people.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => openProfile(p.id)}
                aria-pressed={profileId === p.id}
                className={cn(
                  "mx-2 flex w-[calc(100%-1rem)] items-start gap-2 rounded-md px-2 py-1 text-left",
                  profileId === p.id ? "bg-sidebar-hover" : "hover:bg-sidebar-hover",
                )}
              >
                <PresenceDot status={p.status} className="mt-1.5" />
                <div className="min-w-0">
                  <div className="truncate text-sm">
                    {p.name}
                    {p.id === me.id && <span className="ml-1 text-sidebar-muted">(you)</span>}
                    {p.role && <span className="ml-1.5 text-xs text-sidebar-muted">{p.role}</span>}
                  </div>
                  {p.statusText && <div className="truncate text-xs text-sidebar-muted">{p.statusText}</div>}
                </div>
              </button>
            </li>
          ))}
        </Section>
      </div>

      <footer className="flex items-center justify-between border-t border-sidebar-border px-4 py-2.5">
        <span className="truncate text-sm">{me.name}</span>
        <button
          type="button"
          onClick={logout}
          className="rounded-md p-1.5 text-sidebar-muted hover:bg-sidebar-hover hover:text-white"
          title="Log out"
          aria-label="Log out"
        >
          <LogOut className="size-4" />
        </button>
      </footer>
    </nav>
  );
}
