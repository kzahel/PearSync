export type StartupConflictPolicy = "remote-wins" | "local-wins" | "keep-both";

/** Event stored in the ring buffer and returned by GET /api/events */
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

/** File entry returned by GET /api/files */
export interface FileInfo {
  path: string;
  size: number;
  hash: string;
  mtime: number;
  writerKey: string;
  peerName: string;
  syncState: "synced" | "syncing" | "conflict" | "local-only";
}

/** Peer entry returned by GET /api/peers */
export interface PeerInfo {
  writerKey: string;
  name: string;
  isLocal: boolean;
  isConnected: boolean;
}

/** Overall status returned by GET /api/status */
export interface StatusInfo {
  state: "idle" | "syncing" | "watching" | "setup";
  folder: string | null;
  startupConflictPolicy: StartupConflictPolicy | null;
}

/** WebSocket message envelope */
export interface WsMessage {
  type: "sync" | "status" | "peer" | "error" | "stats";
  payload: unknown;
  timestamp: number;
}

/** POST /api/setup response */
export interface SetupResponse {
  ok: true;
  writerKey: string;
}

/** POST /api/setup/preview response */
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

/** POST /api/invite response */
export interface InviteResponse {
  inviteCode: string;
}

/** POST /api/shutdown response */
export interface ShutdownResponse {
  ok: true;
}
