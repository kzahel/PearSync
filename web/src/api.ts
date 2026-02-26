export interface StatusInfo {
  state: "idle" | "syncing" | "watching" | "setup";
  folder: string | null;
}

export interface FileInfo {
  path: string;
  size: number;
  hash: string;
  mtime: number;
  writerKey: string;
  peerName: string;
  syncState: "synced" | "syncing" | "conflict" | "local-only";
}

export interface PeerInfo {
  writerKey: string;
  name: string;
  isLocal: boolean;
  isConnected: boolean;
}

export interface AppEvent {
  id: number;
  timestamp: number;
  type: "upload" | "download" | "delete" | "conflict" | "peer-join" | "peer-leave" | "error";
  path?: string;
  detail: string;
}

export async function getStatus(): Promise<StatusInfo> {
  const res = await fetch("/api/status");
  return res.json();
}

export async function setup(body: {
  folder: string;
  mode: "create" | "join";
  inviteCode?: string;
}): Promise<{ ok: boolean; writerKey: string }> {
  const res = await fetch("/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function createInvite(): Promise<{ inviteCode: string }> {
  const res = await fetch("/api/invite", { method: "POST" });
  return res.json();
}

export async function getFiles(): Promise<FileInfo[]> {
  const res = await fetch("/api/files");
  return res.json();
}

export async function getPeers(): Promise<PeerInfo[]> {
  const res = await fetch("/api/peers");
  return res.json();
}

export async function getEvents(limit = 100, offset = 0): Promise<AppEvent[]> {
  const res = await fetch(`/api/events?limit=${limit}&offset=${offset}`);
  return res.json();
}

export async function shutdown(): Promise<void> {
  await fetch("/api/shutdown", { method: "POST" });
}
