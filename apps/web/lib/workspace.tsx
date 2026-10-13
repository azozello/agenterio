"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { DmDto, MeDto, MessageDto, PersonDto, WorkspaceDto } from "@agentslack/shared";
import { ApiError, api } from "./api";
import { closeSocket, getSocket } from "./socket";

/** What the right-hand panel shows; only one panel is open at a time. */
export type RightPanel =
  | { kind: "profile"; personId: string }
  | { kind: "thread"; messageId: string; channelId: string }
  | null;

interface WorkspaceState {
  me: MeDto;
  workspace: WorkspaceDto;
  people: Map<string, PersonDto>;
  live: boolean;
  panel: RightPanel;
  /** Person whose profile is open in the side panel. */
  profileId: string | null;
  /** Thread root open in the side panel. */
  threadId: string | null;
  openProfile: (personId: string) => void;
  openThread: (root: Pick<MessageDto, "id" | "channelId">) => void;
  closePanel: () => void;
  /** Opens (or creates) the DM with a person and navigates to it. */
  messagePerson: (personId: string) => Promise<void>;
  /** The other member of a 1:1 DM. */
  dmPartner: (dm: DmDto) => PersonDto | undefined;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return value;
}

function withDm(workspace: WorkspaceDto, dm: DmDto): WorkspaceDto {
  if (workspace.dms.some((d) => d.channel.id === dm.channel.id)) return workspace;
  return { ...workspace, dms: [...workspace.dms, dm] };
}

function withPerson(workspace: WorkspaceDto, person: PersonDto): WorkspaceDto {
  const known = workspace.people.some((p) => p.id === person.id);
  return {
    ...workspace,
    people: known ? workspace.people.map((p) => (p.id === person.id ? person : p)) : [...workspace.people, person],
  };
}

/** Loads the caller and the sidebar tree; sends you to /login when the session is missing. */
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<MeDto | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [panel, setPanel] = useState<RightPanel>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.me(), api.workspace()])
      .then(([me, workspace]) => {
        if (cancelled) return;
        setMe(me);
        setWorkspace(workspace);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
        else setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const loaded = me !== null;
  useEffect(() => {
    if (!loaded) return;
    const socket = getSocket();
    const onConnect = () => setLive(true);
    const onDisconnect = () => setLive(false);
    const onDm = (dm: DmDto) => setWorkspace((ws) => (ws ? withDm(ws, dm) : ws));
    const onPerson = (person: PersonDto) => setWorkspace((ws) => (ws ? withPerson(ws, person) : ws));
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("dm.created", onDm);
    socket.on("person.updated", onPerson);
    setLive(socket.connected);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("dm.created", onDm);
      socket.off("person.updated", onPerson);
      closeSocket();
    };
  }, [loaded]);

  const people = useMemo(() => new Map((workspace?.people ?? []).map((p) => [p.id, p])), [workspace?.people]);

  const messagePerson = useCallback(
    async (personId: string) => {
      const dm = await api.openDm(personId);
      setWorkspace((ws) => (ws ? withDm(ws, dm) : ws));
      router.push(`/c/${dm.channel.id}`);
    },
    [router],
  );

  const openProfile = useCallback((personId: string) => setPanel({ kind: "profile", personId }), []);
  const openThread = useCallback(
    (root: Pick<MessageDto, "id" | "channelId">) => setPanel({ kind: "thread", messageId: root.id, channelId: root.channelId }),
    [],
  );
  const closePanel = useCallback(() => setPanel(null), []);

  const dmPartner = useCallback(
    (dm: DmDto) => people.get(dm.memberIds.find((id) => id !== me?.id) ?? dm.memberIds[0] ?? ""),
    [people, me?.id],
  );

  if (error) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="font-medium">Can&apos;t reach the AgentSlack API</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }
  if (!me || !workspace) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">Loading workspace…</div>;
  }

  return (
    <WorkspaceContext.Provider
      value={{
        me,
        workspace,
        people,
        live,
        panel,
        profileId: panel?.kind === "profile" ? panel.personId : null,
        threadId: panel?.kind === "thread" ? panel.messageId : null,
        openProfile,
        openThread,
        closePanel,
        messagePerson,
        dmPartner,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}
