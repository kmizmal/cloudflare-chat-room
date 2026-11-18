import type { ChatRoom } from "./chatRoom";

export interface Env {
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  AI: Ai;
}

export type RoomUser = {
  uid: string;
  name: string;
  joinedAt: number;
};

// State attached to each server-side WebSocket. Survives DO hibernation.
export type ConnectionState = RoomUser & {
  recentTs: number[]; // message timestamps for rate limiting
  lastRename: number;
};

export type MessageRecord = {
  id: number;
  uid: string;
  name: string;
  text: string;
  ts: number; // Unix seconds
  namecolor: string;
  msgcolor: string;
};

export type ClientEvent =
  | { type: "message"; text: string; namecolor?: string; msgcolor?: string }
  | { type: "rename"; name: string }
  | { type: "leave" };

export type ServerEvent =
  | { type: "init"; you: RoomUser; users: RoomUser[]; recent: MessageRecord[]; roomId: string; title: string }
  | { type: "sys"; text: string; ts: number }
  | { type: "online"; users: RoomUser[] }
  | { type: "msg"; message: MessageRecord }
  | { type: "rename"; uid: string; name: string }
  | { type: "error"; text: string };

export function serverSend(ws: WebSocket, event: ServerEvent): void {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // Socket may already be closing; ignore.
  }
}
