import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import Localdrive from "localdrive";
import watch from "watch-drive";
import { FileStore } from "./file-store";
import { LocalStateStore } from "./local-state-store";
import {
  ManifestStore,
  isFileMetadata,
  isPeerMetadata,
  isTombstone
} from "./manifest-store";
const require2 = createRequire(import.meta.url);
const mutableFs = require2("node:fs");
function buildConflictPath(originalPath, peerName) {
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const lastDot = originalPath.lastIndexOf(".");
  const lastSlash = originalPath.lastIndexOf("/");
  if (lastDot > lastSlash + 1) {
    const stem = originalPath.slice(0, lastDot);
    const ext = originalPath.slice(lastDot);
    return `${stem}.conflict-${date}-${peerName}${ext}`;
  }
  return `${originalPath}.conflict-${date}-${peerName}`;
}
class SyncEngine extends EventEmitter {
  store;
  syncFolder;
  drive = null;
  fileStore = null;
  manifest = null;
  ownsManifest;
  watcher = null;
  localChangeQueue = Promise.resolve();
  remoteUpdateQueue = Promise.resolve();
  options;
  localState;
  startupReconciliationActive = false;
  startupPolicyAffectedPaths = 0;
  /** Tracks which paths we're currently writing to disk, to suppress watcher feedback */
  suppressedPaths = /* @__PURE__ */ new Set();
  constructor(store, syncFolder, options) {
    super();
    this.store = store;
    this.syncFolder = syncFolder;
    this.options = options ?? {};
    this.localState = new LocalStateStore(syncFolder);
    if (options?.manifest) {
      this.manifest = options.manifest;
      this.ownsManifest = false;
    } else {
      this.ownsManifest = true;
    }
  }
  async ready() {
    this.drive = new Localdrive(this.syncFolder);
    this.fileStore = new FileStore(this.store);
    await this.fileStore.ready();
    await this.localState.load();
    if (!this.manifest) {
      this.manifest = ManifestStore.create(this.store, {
        replicate: this.options.bootstrap !== void 0,
        bootstrap: this.options.bootstrap
      });
    }
    await this.manifest.ready();
    const writerKey = this.manifest.writerKey;
    const peerName = writerKey.slice(0, 8);
    await this.manifest.putPeer(writerKey, peerName);
  }
  async start() {
    if (!this.drive || !this.fileStore || !this.manifest) {
      throw new Error("SyncEngine not ready \u2014 call ready() first");
    }
    await this.initialSync();
    this.ensureFsWatchPatched();
    this.watcher = watch(this.drive, "");
    this.applyLocalwatchDestroyWorkaround(this.watcher);
    this.watcher.on("data", (batch) => {
      for (const diff of batch.diff) {
        this.localChangeQueue = this.localChangeQueue.then(async () => {
          try {
            await this.handleLocalChange(diff.type, diff.key);
          } catch (err) {
            this.emit("error", err);
          }
        });
      }
    });
    this.watcher.on("error", (err) => this.emit("error", err));
    this.manifest.on("update", this._onRemoteUpdate);
  }
  _onRemoteUpdate = () => {
    this.remoteUpdateQueue = this.remoteUpdateQueue.then(async () => {
      try {
        await this.handleRemoteChanges();
      } catch (err) {
        this.emit("error", err);
      }
    });
  };
  async stop() {
    if (this.watcher) {
      this.watcher.destroy();
      this.watcher = null;
    }
    if (this.manifest) {
      this.manifest.removeListener("update", this._onRemoteUpdate);
    }
    await this.localChangeQueue;
    await this.remoteUpdateQueue;
  }
  async close() {
    await this.stop();
    if (this.fileStore) {
      await this.fileStore.close();
      this.fileStore = null;
    }
    if (this.manifest && this.ownsManifest) {
      await this.manifest.close();
    }
    this.manifest = null;
    if (this.drive) {
      await this.drive.close();
      this.drive = null;
    }
  }
  async getPeerName(writerKey) {
    const entry = await this.manifest.get(`__peer:${writerKey}`);
    if (entry && isPeerMetadata(entry)) return entry.name;
    return writerKey.slice(0, 8);
  }
  async handleLocalChange(type, key) {
    if (key.startsWith("/.pearsync/")) return;
    if (this.suppressedPaths.has(key)) {
      this.suppressedPaths.delete(key);
      return;
    }
    const drive = this.drive;
    const fileStore = this.fileStore;
    const manifest = this.manifest;
    if (type === "update") {
      const data = await drive.get(key);
      if (data === null) return;
      const entry = await drive.entry(key);
      const mtime = entry?.mtime ?? Date.now();
      const hash = createHash("sha256").update(data).digest("hex");
      const manifestValue = await manifest.get(key);
      if (manifestValue && isFileMetadata(manifestValue) && manifestValue.hash === hash) return;
      const stored = await fileStore.writeFile(data);
      const baseHash = manifestValue ? isFileMetadata(manifestValue) ? manifestValue.hash : isTombstone(manifestValue) ? manifestValue.baseHash : null : null;
      const seq = manifestValue && (isFileMetadata(manifestValue) || isTombstone(manifestValue)) ? manifestValue.seq + 1 : 1;
      const metadata = {
        kind: "file",
        size: stored.size,
        mtime,
        hash: stored.hash,
        baseHash,
        seq,
        writerKey: fileStore.core.key.toString("hex"),
        blocks: { offset: stored.offset, length: stored.length }
      };
      await manifest.put(key, metadata);
      await this.localState.set(key, {
        lastSyncedHash: hash,
        lastSyncedMtime: mtime,
        lastManifestHash: hash,
        lastManifestWriterKey: metadata.writerKey
      });
      this.emit("sync", {
        direction: "local-to-remote",
        type: "update",
        path: key
      });
    } else if (type === "delete") {
      const manifestValue = await manifest.get(key);
      if (manifestValue && isFileMetadata(manifestValue)) {
        await manifest.putTombstone(key, fileStore.core.key.toString("hex"), {
          baseHash: manifestValue.hash,
          seq: manifestValue.seq + 1
        });
        await this.localState.remove(key);
        this.emit("sync", {
          direction: "local-to-remote",
          type: "delete",
          path: key
        });
      }
    }
  }
  async handleRemoteChanges() {
    const entries = await this.manifest.list();
    const myWriterKey = this.fileStore.core.key.toString("hex");
    for (const { path, metadata } of entries) {
      if (path.startsWith("__")) continue;
      if (isTombstone(metadata)) {
        await this.handleRemoteDeletion(path, metadata);
        continue;
      }
      if (!isFileMetadata(metadata)) continue;
      if (metadata.writerKey === myWriterKey) continue;
      await this.handleRemoteUpdate(path, metadata);
    }
  }
  async handleRemoteUpdate(path, remote) {
    const tracked = this.localState.get(path);
    const localData = await this.drive.get(path);
    if (!localData) {
      await this.downloadFile(path, remote);
      this.emit("sync", {
        direction: "remote-to-local",
        type: "update",
        path
      });
      return;
    }
    const localHash = createHash("sha256").update(localData).digest("hex");
    if (localHash === remote.hash) {
      await this.localState.set(path, {
        lastSyncedHash: localHash,
        lastSyncedMtime: remote.mtime,
        lastManifestHash: remote.hash,
        lastManifestWriterKey: remote.writerKey
      });
      return;
    }
    if (!tracked) {
      if (this.startupReconciliationActive) {
        const policy = this.options.startupConflictPolicy ?? "remote-wins";
        this.startupPolicyAffectedPaths += 1;
        if (policy === "local-wins") {
          await this.handleLocalChange("update", path);
          return;
        }
        if (policy === "keep-both") {
          await this.handleConflict(path, remote, localData);
          return;
        }
      }
      await this.downloadFile(path, remote);
      this.emit("sync", {
        direction: "remote-to-local",
        type: "update",
        path
      });
      return;
    }
    const remoteChanged = remote.hash !== tracked.lastManifestHash;
    if (!remoteChanged) return;
    const localChanged = localHash !== tracked.lastSyncedHash;
    if (!localChanged) {
      await this.downloadFile(path, remote);
      this.emit("sync", {
        direction: "remote-to-local",
        type: "update",
        path
      });
      return;
    }
    if (remote.baseHash !== null && remote.baseHash === localHash) {
      await this.downloadFile(path, remote);
      this.emit("sync", {
        direction: "remote-to-local",
        type: "update",
        path
      });
      return;
    }
    await this.handleConflict(path, remote, localData);
  }
  async handleConflict(path, remote, localData) {
    const loserWriterKey = this.fileStore.core.key.toString("hex");
    const peerName = await this.getPeerName(loserWriterKey);
    const conflictPath = buildConflictPath(path, peerName);
    this.suppressedPaths.add(conflictPath);
    await this.drive.put(conflictPath, localData);
    await this.downloadFile(path, remote);
    this.emit("sync", {
      direction: "remote-to-local",
      type: "conflict",
      path,
      conflictPath
    });
  }
  async handleRemoteDeletion(path, tombstone) {
    const myWriterKey = this.fileStore.core.key.toString("hex");
    if (tombstone.writerKey === myWriterKey) return;
    const tracked = this.localState.get(path);
    if (!tracked) {
      if (this.startupReconciliationActive) {
        const policy = this.options.startupConflictPolicy ?? "remote-wins";
        if (policy === "local-wins" || policy === "keep-both") {
          const localData2 = await this.drive.get(path);
          if (localData2) {
            this.startupPolicyAffectedPaths += 1;
            const localWriterKey = this.fileStore.core.key.toString("hex");
            const peerName = await this.getPeerName(localWriterKey);
            const conflictPath = buildConflictPath(path, `${peerName}-tombstone`);
            this.suppressedPaths.add(conflictPath);
            await this.drive.put(conflictPath, localData2);
            this.suppressedPaths.add(path);
            await this.drive.del(path);
            this.emit("sync", {
              direction: "remote-to-local",
              type: "conflict",
              path,
              conflictPath
            });
          }
        }
      }
      return;
    }
    if (tombstone.baseHash !== tracked.lastSyncedHash) return;
    const localData = await this.drive.get(path);
    if (localData) {
      const localHash = createHash("sha256").update(localData).digest("hex");
      if (localHash !== tracked.lastSyncedHash) {
        return;
      }
    }
    if (localData) {
      this.suppressedPaths.add(path);
      await this.drive.del(path);
    }
    await this.localState.remove(path);
    this.emit("sync", {
      direction: "remote-to-local",
      type: "delete",
      path
    });
  }
  async downloadFile(path, metadata) {
    const data = await this.fetchRemoteFile(metadata);
    this.suppressedPaths.add(path);
    await this.drive.put(path, data);
    const hash = createHash("sha256").update(data).digest("hex");
    await this.localState.set(path, {
      lastSyncedHash: hash,
      lastSyncedMtime: metadata.mtime,
      lastManifestHash: metadata.hash,
      lastManifestWriterKey: metadata.writerKey
    });
  }
  async fetchRemoteFile(metadata) {
    const remoteCore = this.store.get({ key: Buffer.from(metadata.writerKey, "hex") });
    try {
      await remoteCore.ready();
      const blocks = [];
      for (let i = 0; i < metadata.blocks.length; i++) {
        const block = await remoteCore.get(metadata.blocks.offset + i);
        if (!block)
          throw new Error(
            `Missing block ${metadata.blocks.offset + i} from ${metadata.writerKey}`
          );
        blocks.push(block);
      }
      return Buffer.concat(blocks);
    } finally {
      await remoteCore.close();
    }
  }
  ensureFsWatchPatched() {
    if (mutableFs.__pearsyncWatchPatched) return;
    const originalWatch = mutableFs.watch.bind(mutableFs);
    const patchedWatch = ((filename, optionsOrListener, maybeListener) => {
      let options;
      let listener;
      if (typeof optionsOrListener === "function") {
        listener = optionsOrListener;
      } else {
        options = optionsOrListener;
        listener = maybeListener;
      }
      const normalizedOptions = options?.recursive ? { ...options, recursive: false } : options;
      const watcher = listener ? originalWatch(filename, normalizedOptions, listener) : originalWatch(filename, normalizedOptions);
      watcher.on("error", (err) => {
        if (err.code === "EMFILE") return;
        throw err;
      });
      return watcher;
    });
    mutableFs.watch = patchedWatch;
    mutableFs.__pearsyncWatchPatched = true;
  }
  applyLocalwatchDestroyWorkaround(stream) {
    const tree = stream._tree;
    if (tree && tree.entries === null) {
      tree.entries = /* @__PURE__ */ new Map();
    }
  }
  async initialSync() {
    const drive = this.drive;
    const fileStore = this.fileStore;
    const manifest = this.manifest;
    this.startupReconciliationActive = true;
    this.startupPolicyAffectedPaths = 0;
    try {
      await this.handleRemoteChanges();
    } finally {
      this.startupReconciliationActive = false;
    }
    if (this.options.startupConflictPolicy && this.startupPolicyAffectedPaths > 0) {
      this.emit("audit", {
        policy: this.options.startupConflictPolicy,
        affectedPaths: this.startupPolicyAffectedPaths
      });
    }
    for await (const entry of drive.list("/")) {
      if (entry.key.startsWith("/.pearsync/")) continue;
      const data = await drive.get(entry.key);
      if (!data) continue;
      const hash = createHash("sha256").update(data).digest("hex");
      const existing = await manifest.get(entry.key);
      if (existing && isFileMetadata(existing) && existing.hash === hash) {
        await this.localState.set(entry.key, {
          lastSyncedHash: hash,
          lastSyncedMtime: entry.mtime,
          lastManifestHash: existing.hash,
          lastManifestWriterKey: existing.writerKey
        });
        continue;
      }
      const stored = await fileStore.writeFile(data);
      const metadata = {
        kind: "file",
        size: stored.size,
        mtime: entry.mtime,
        hash: stored.hash,
        baseHash: existing ? isFileMetadata(existing) ? existing.hash : isTombstone(existing) ? existing.baseHash : null : null,
        seq: existing && (isFileMetadata(existing) || isTombstone(existing)) ? existing.seq + 1 : 1,
        writerKey: fileStore.core.key.toString("hex"),
        blocks: { offset: stored.offset, length: stored.length }
      };
      await manifest.put(entry.key, metadata);
      await this.localState.set(entry.key, {
        lastSyncedHash: hash,
        lastSyncedMtime: entry.mtime,
        lastManifestHash: hash,
        lastManifestWriterKey: metadata.writerKey
      });
      this.emit("sync", {
        direction: "local-to-remote",
        type: "update",
        path: entry.key
      });
    }
  }
  getManifest() {
    if (!this.manifest) throw new Error("SyncEngine not ready");
    return this.manifest;
  }
  getFileStore() {
    if (!this.fileStore) throw new Error("SyncEngine not ready");
    return this.fileStore;
  }
}
export {
  SyncEngine,
  buildConflictPath
};
//# sourceMappingURL=sync-engine.js.map
