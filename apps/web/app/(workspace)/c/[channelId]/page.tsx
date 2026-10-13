"use client";

import { useParams } from "next/navigation";
import { Hash } from "lucide-react";
import { ChannelView } from "@/components/channel-view";
import { PresenceDot } from "@/components/presence-dot";
import { useWorkspace } from "@/lib/workspace";

export default function ChannelPage() {
  const { channelId } = useParams<{ channelId: string }>();
  const { workspace, dmPartner, openProfile } = useWorkspace();

  const dm = workspace.dms.find((d) => d.channel.id === channelId);
  if (dm) {
    const partner = dmPartner(dm);
    const name = partner?.name ?? "Direct message";
    return (
      <ChannelView
        key={dm.channel.id}
        channel={dm.channel}
        title={
          <button type="button" className="hover:underline" onClick={() => partner && openProfile(partner.id)}>
            {name}
          </button>
        }
        icon={<PresenceDot status={partner?.status ?? null} />}
        subtitle={partner?.role ?? null}
        placeholder={`Message ${name}`}
        emptyHint={`This is the start of your conversation with ${name}.`}
      />
    );
  }

  const project = workspace.projects.find((p) => p.channels.some((c) => c.id === channelId));
  const channel = project?.channels.find((c) => c.id === channelId) ?? workspace.channels.find((c) => c.id === channelId);
  if (!channel) {
    return <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Channel not found.</div>;
  }
  return (
    <ChannelView
      key={channel.id}
      channel={channel}
      title={channel.name}
      icon={<Hash className="size-4 text-muted-foreground" aria-hidden />}
      subtitle={project ? project.name : "Workspace"}
      placeholder={`Message #${channel.name}`}
      emptyHint={`This is the start of #${channel.name}. Mention an agent with @name to get its attention.`}
    />
  );
}
