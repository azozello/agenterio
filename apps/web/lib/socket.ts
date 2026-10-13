import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@agentslack/shared";
import { API_URL } from "./api";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;

/** Channel id → number of mounted views that need its messages. */
const subscriptions = new Map<string, number>();

const noop = () => undefined;

/** One socket per tab; authenticated by the session cookie. */
export function getSocket(): AppSocket {
  if (!socket) {
    const s: AppSocket = io(API_URL, { withCredentials: true, transports: ["websocket"] });
    // Rooms are per connection, so rejoin every channel a view still needs.
    s.on("connect", () => {
      for (const channelId of subscriptions.keys()) s.emit("channel:subscribe", channelId, noop);
    });
    socket = s;
  }
  return socket;
}

export function closeSocket() {
  socket?.close();
  socket = null;
}

/**
 * Joins a channel's room for `message.created`. Reference-counted, so the channel view, the thread
 * panel and a task page can share a channel without unsubscribing each other. Returns the release.
 */
export function subscribeChannel(channelId: string): () => void {
  const s = getSocket();
  const count = subscriptions.get(channelId) ?? 0;
  subscriptions.set(channelId, count + 1);
  if (count === 0 && s.connected) s.emit("channel:subscribe", channelId, noop);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (subscriptions.get(channelId) ?? 1) - 1;
    if (left > 0) {
      subscriptions.set(channelId, left);
      return;
    }
    subscriptions.delete(channelId);
    socket?.emit("channel:unsubscribe", channelId, noop);
  };
}
