import type WebSocket from "ws";
import type { AppEvent, FileInfo, PeerInfo, StatusInfo, WsMessage } from "./api-types.js";
import { isFileMetadata, isPeerMetadata } from "./lib/manifest-store.js";
import type { SyncEngine, SyncEvent } from "./lib/sync-engine.js";
import { RingBuffer } from "./ring-buffer.js";

export class EngineBridge {
  private engine: SyncEngine;
  private folder: string;
  private events: RingBuffer<AppEvent>;
  private wsClients: Set<WebSocket> = new Set();
  private nextEventId = 1;
  private startTime: number;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(engine: SyncEngine, folder: string) {
    this.engine = engine;
    this.folder = folder;
    this.events = new RingBuffer<AppEvent>(1000);
    this.startTime = Date.now();
  }

  attach(): void {
    this.engine.on("sync", this.onSync);
    this.engine.on("error", this.onError);
    this.statsInterval = setInterval(() => {
      this.broadcast({
        type: "stats",
        payload: this.getStatsPayload(),
        timestamp: Date.now(),
      });
    }, 2000);
  }

  detach(): void {
    this.engine.removeListener("sync", this.onSync);
    this.engine.removeListener("error", this.onError);
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  addWsClient(ws: WebSocket): void {
    this.wsClients.add(ws);
  }

  removeWsClient(ws: WebSocket): void {
    this.wsClients.delete(ws);
  }

  broadcast(msg: WsMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.wsClients) {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(data);
      }
    }
  }

  getEvents(offset: number, limit: number): AppEvent[] {
    return this.events.slice(offset, limit);
  }

  async getFiles(): Promise<FileInfo[]> {
    const manifest = this.engine.getManifest();
    const entries = await manifest.list();
    const files: FileInfo[] = [];

    for (const { path, metadata } of entries) {
      if (path.startsWith("__")) continue;
      if (!isFileMetadata(metadata)) continue;

      const peerName = await this.engine.getPeerName(metadata.writerKey);
      const isConflict = path.includes(".conflict-");
      files.push({
        path,
        size: metadata.size,
        hash: metadata.hash,
        mtime: metadata.mtime,
        writerKey: metadata.writerKey,
        peerName,
        syncState: isConflict ? "conflict" : "synced",
      });
    }

    return files;
  }

  async getPeers(): Promise<PeerInfo[]> {
    const manifest = this.engine.getManifest();
    const myWriterKey = manifest.writerKey;
    const entries = await manifest.list();
    const peers: PeerInfo[] = [];

    for (const { path, metadata } of entries) {
      if (!path.startsWith("__peer:")) continue;
      if (!isPeerMetadata(metadata)) continue;
      peers.push({
        writerKey: metadata.writerKey,
        name: metadata.name,
        isLocal: metadata.writerKey === myWriterKey,
        isConnected: true,
      });
    }

    return peers;
  }

  getStatus(): StatusInfo {
    return {
      state: "watching",
      folder: this.folder,
    };
  }

  private getStatsPayload() {
    return {
      uptime: Date.now() - this.startTime,
    };
  }

  private pushEvent(event: AppEvent): void {
    this.events.push(event);
  }

  private onSync = (syncEvent: SyncEvent) => {
    let type: AppEvent["type"];
    if (syncEvent.type === "conflict") {
      type = "conflict";
    } else if (syncEvent.type === "delete") {
      type = "delete";
    } else if (syncEvent.direction === "local-to-remote") {
      type = "upload";
    } else {
      type = "download";
    }

    let detail: string;
    if (type === "upload") {
      detail = `Uploaded ${syncEvent.path}`;
    } else if (type === "download") {
      detail = `Downloaded ${syncEvent.path}`;
    } else if (type === "delete") {
      const dir = syncEvent.direction === "local-to-remote" ? "locally" : "remotely";
      detail = `Deleted ${syncEvent.path} (${dir})`;
    } else {
      detail = `Conflict: ${syncEvent.path} → ${syncEvent.conflictPath}`;
    }

    const event: AppEvent = {
      id: this.nextEventId++,
      timestamp: Date.now(),
      type,
      path: syncEvent.path,
      detail,
    };

    this.pushEvent(event);
    this.broadcast({
      type: "sync",
      payload: {
        direction: syncEvent.direction === "local-to-remote" ? "up" : "down",
        action: syncEvent.type,
        path: syncEvent.path,
        conflictPath: syncEvent.conflictPath,
      },
      timestamp: Date.now(),
    });
  };

  private onError = (err: Error) => {
    const event: AppEvent = {
      id: this.nextEventId++,
      timestamp: Date.now(),
      type: "error",
      detail: err.message,
    };

    this.pushEvent(event);
    this.broadcast({
      type: "error",
      payload: { message: err.message },
      timestamp: Date.now(),
    });
  };
}
