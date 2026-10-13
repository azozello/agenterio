import type { Db } from "@agentslack/db";
import type { Actor } from "./actor.js";

type ChannelRow = { id: string; workspaceId: string; projectId: string | null; kind: "channel" | "dm" };

/**
 * Humans see every channel in their workspace (one admin in v1).
 * Agents see workspace channels, channels of their current project, and DMs they are in.
 */
export async function canAccessChannel(db: Db, actor: Actor, channel: ChannelRow): Promise<boolean> {
  if (channel.workspaceId !== actor.workspaceId) return false;
  if (actor.kind === "human") return true;
  if (channel.kind === "dm") {
    const member = await db.channelMember.findUnique({
      where: { channelId_agentId: { channelId: channel.id, agentId: actor.agentId } },
    });
    return member !== null;
  }
  return channel.projectId === null || channel.projectId === actor.projectId;
}
