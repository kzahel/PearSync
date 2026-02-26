import { transport } from "./transport";

export type StartupConflictPolicy = "remote-wins" | "local-wins" | "keep-both";

export interface StatusInfo {
  state: "idle" | "syncing" | "watching" | "setup";
  folder: string | null;
  startupConflictPolicy: StartupConflictPolicy | null;
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
  type:
    | "upload"
    | "download"
    | "delete"
    | "conflict"
    | "peer-join"
    | "peer-leave"
    | "error"
    | "audit";
  path?: string;
  detail: string;
}

export interface SetupPreviewResponse {
  counts: {
    localFiles: number;
    remoteFiles: number;
    remoteTombstones: number;
    matchingFiles: number;
    localOnlyFiles: number;
    remoteOnlyFiles: number;
    fileConflicts: number;
    tombstoneConflicts: number;
  };
  policyImpact: {
    remoteWins: { overwrite: number; delete: number; totalAffected: number };
    localWins: { upload: number; conflictCopy: number; totalAffected: number };
    keepBoth: { conflictCopy: number; totalAffected: number };
  };
  samples: {
    fileConflicts: string[];
    tombstoneConflicts: string[];
    localOnly: string[];
    remoteOnly: string[];
  };
}

export function getStatus(): Promise<StatusInfo> {
  return transport.get("/api/status");
}

export function setup(body: {
  folder: string;
  mode: "create" | "join";
  inviteCode?: string;
  startupConflictPolicy?: StartupConflictPolicy;
}): Promise<{ ok: boolean; writerKey: string }> {
  return transport.post("/api/setup", body);
}

export function previewSetup(body: {
  folder: string;
  mode: "join";
  inviteCode: string;
}): Promise<SetupPreviewResponse> {
  return transport.post("/api/setup/preview", body);
}

export function createInvite(): Promise<{ inviteCode: string }> {
  return transport.post("/api/invite");
}

export function getFiles(): Promise<FileInfo[]> {
  return transport.get("/api/files");
}

export function getPeers(): Promise<PeerInfo[]> {
  return transport.get("/api/peers");
}

export function getEvents(limit = 100, offset = 0): Promise<AppEvent[]> {
  return transport.get("/api/events", {
    limit: String(limit),
    offset: String(offset),
  });
}

export function pickFolder(): Promise<{ folder: string }> {
  return transport.get("/api/pick-folder");
}

export function shutdown(): Promise<void> {
  return transport.post("/api/shutdown");
}
