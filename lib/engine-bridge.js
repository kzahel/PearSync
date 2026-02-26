import { isFileMetadata, isPeerMetadata } from "./manifest-store.js";
import { RingBuffer } from "./ring-buffer.js";
class EngineBridge {
  engine;
  folder;
  events;
  wsClients = /* @__PURE__ */ new Set();
  pushListeners = /* @__PURE__ */ new Set();
  nextEventId = 1;
  startTime;
  statsInterval = null;
  startupConflictPolicy;
  constructor(engine, folder, startupConflictPolicy) {
    this.engine = engine;
    this.folder = folder;
    this.startupConflictPolicy = startupConflictPolicy;
    this.events = new RingBuffer(1e3);
    this.startTime = Date.now();
  }
  attach() {
    this.engine.on("sync", this.onSync);
    this.engine.on("audit", this.onAudit);
    this.engine.on("error", this.onError);
    this.statsInterval = setInterval(() => {
      this.broadcast({
        type: "stats",
        payload: this.getStatsPayload(),
        timestamp: Date.now()
      });
    }, 2e3);
  }
  detach() {
    this.engine.removeListener("sync", this.onSync);
    this.engine.removeListener("audit", this.onAudit);
    this.engine.removeListener("error", this.onError);
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }
  addWsClient(ws) {
    this.wsClients.add(ws);
  }
  removeWsClient(ws) {
    this.wsClients.delete(ws);
  }
  addPushListener(fn) {
    this.pushListeners.add(fn);
    return () => this.pushListeners.delete(fn);
  }
  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
    for (const fn of this.pushListeners) {
      fn(msg);
    }
  }
  getEvents(offset, limit) {
    return this.events.slice(offset, limit);
  }
  async getFiles() {
    const manifest = this.engine.getManifest();
    const entries = await manifest.list();
    const files = [];
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
        syncState: isConflict ? "conflict" : "synced"
      });
    }
    return files;
  }
  async getPeers() {
    const manifest = this.engine.getManifest();
    const myWriterKey = manifest.writerKey;
    const entries = await manifest.list();
    const peers = [];
    for (const { path, metadata } of entries) {
      if (!path.startsWith("__peer:")) continue;
      if (!isPeerMetadata(metadata)) continue;
      peers.push({
        writerKey: metadata.writerKey,
        name: metadata.name,
        isLocal: metadata.writerKey === myWriterKey,
        isConnected: true
      });
    }
    return peers;
  }
  getStatus() {
    return {
      state: "watching",
      folder: this.folder,
      startupConflictPolicy: this.startupConflictPolicy
    };
  }
  getStatsPayload() {
    return {
      uptime: Date.now() - this.startTime
    };
  }
  pushEvent(event) {
    this.events.push(event);
  }
  onSync = (syncEvent) => {
    let type;
    if (syncEvent.type === "conflict") {
      type = "conflict";
    } else if (syncEvent.type === "delete") {
      type = "delete";
    } else if (syncEvent.direction === "local-to-remote") {
      type = "upload";
    } else {
      type = "download";
    }
    let detail;
    if (type === "upload") {
      detail = `Uploaded ${syncEvent.path}`;
    } else if (type === "download") {
      detail = `Downloaded ${syncEvent.path}`;
    } else if (type === "delete") {
      const dir = syncEvent.direction === "local-to-remote" ? "locally" : "remotely";
      detail = `Deleted ${syncEvent.path} (${dir})`;
    } else {
      detail = `Conflict: ${syncEvent.path} \u2192 ${syncEvent.conflictPath}`;
    }
    const event = {
      id: this.nextEventId++,
      timestamp: Date.now(),
      type,
      path: syncEvent.path,
      detail
    };
    this.pushEvent(event);
    this.broadcast({
      type: "sync",
      payload: {
        direction: syncEvent.direction === "local-to-remote" ? "up" : "down",
        action: syncEvent.type,
        path: syncEvent.path,
        conflictPath: syncEvent.conflictPath
      },
      timestamp: Date.now()
    });
  };
  onError = (err) => {
    const event = {
      id: this.nextEventId++,
      timestamp: Date.now(),
      type: "error",
      detail: err.message
    };
    this.pushEvent(event);
    this.broadcast({
      type: "error",
      payload: { message: err.message },
      timestamp: Date.now()
    });
  };
  onAudit = (audit) => {
    const detail = `Startup policy ${audit.policy} affected ${audit.affectedPaths} path(s)`;
    const event = {
      id: this.nextEventId++,
      timestamp: Date.now(),
      type: "audit",
      detail
    };
    this.pushEvent(event);
    this.broadcast({
      type: "status",
      payload: {
        eventType: "audit",
        detail,
        policy: audit.policy,
        affectedPaths: audit.affectedPaths
      },
      timestamp: Date.now()
    });
  };
}
export {
  EngineBridge
};
//# sourceMappingURL=engine-bridge.js.map
