import { mkdir, readFile, rename, writeFile } from "bare-fs/promises";
import { dirname, join } from "bare-path";
let persistCounter = 0;
class LocalStateStore {
  state = /* @__PURE__ */ new Map();
  filePath;
  backupPath;
  writeQueue = Promise.resolve();
  constructor(syncFolder) {
    this.filePath = join(syncFolder, ".pearsync", "state.json");
    this.backupPath = join(syncFolder, ".pearsync", "state.json.bak");
  }
  /** Load state from disk. Creates the file if it doesn't exist. */
  async load() {
    const primary = await this.tryLoadFromPath(this.filePath);
    if (primary) {
      this.state = primary;
      return;
    }
    const backup = await this.tryLoadFromPath(this.backupPath);
    if (backup) {
      this.state = backup;
      await this.persist();
      return;
    }
    this.state = /* @__PURE__ */ new Map();
    await this.persist();
  }
  /** Get the tracked state for a file path. */
  get(path) {
    return this.state.get(path);
  }
  /** Update state for a file path and persist to disk. */
  async set(path, state) {
    this.state.set(path, state);
    await this.persist();
  }
  /** Remove state for a file path and persist to disk. */
  async remove(path) {
    this.state.delete(path);
    await this.persist();
  }
  /** Check if a path is tracked. */
  has(path) {
    return this.state.has(path);
  }
  /** Get all tracked paths. */
  paths() {
    return [...this.state.keys()];
  }
  /** Atomic write: write to uniquely-named .tmp, then rename over the real file. Serialized via queue. */
  persist() {
    this.writeQueue = this.writeQueue.then(() => this.doPersist());
    return this.writeQueue;
  }
  async doPersist() {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const serialized = JSON.stringify(this.toObject(), null, 2);
    const id = ++persistCounter;
    const tmpPath = `${this.filePath}.${id}.tmp`;
    await writeFile(tmpPath, serialized);
    await rename(tmpPath, this.filePath);
    const tmpBackupPath = `${this.backupPath}.${id}.tmp`;
    await writeFile(tmpBackupPath, serialized);
    await rename(tmpBackupPath, this.backupPath);
  }
  async tryLoadFromPath(path) {
    try {
      const data = await readFile(path, "utf-8");
      return this.parseState(data);
    } catch (err) {
      if (this.isRecoverableLoadError(err)) return null;
      throw err;
    }
  }
  isRecoverableLoadError(err) {
    if (err instanceof SyntaxError) return true;
    if (err instanceof Error && err.name === "StateFormatError") return true;
    return err.code === "ENOENT";
  }
  parseState(data) {
    const parsed = JSON.parse(data);
    if (!this.isObject(parsed)) {
      throw this.stateFormatError("State file root must be an object");
    }
    const next = /* @__PURE__ */ new Map();
    for (const [path, value] of Object.entries(parsed)) {
      if (!this.isObject(value)) {
        throw this.stateFormatError(`Invalid state object for path ${path}`);
      }
      if (typeof value.lastSyncedHash !== "string" || typeof value.lastSyncedMtime !== "number" || typeof value.lastManifestHash !== "string" || typeof value.lastManifestWriterKey !== "string") {
        throw this.stateFormatError(`Invalid state fields for path ${path}`);
      }
      next.set(path, {
        lastSyncedHash: value.lastSyncedHash,
        lastSyncedMtime: value.lastSyncedMtime,
        lastManifestHash: value.lastManifestHash,
        lastManifestWriterKey: value.lastManifestWriterKey
      });
    }
    return next;
  }
  isObject(value) {
    return typeof value === "object" && value !== null;
  }
  toObject() {
    const obj = {};
    for (const [k, v] of this.state) obj[k] = v;
    return obj;
  }
  stateFormatError(message) {
    const err = new Error(message);
    err.name = "StateFormatError";
    return err;
  }
}
export {
  LocalStateStore
};
//# sourceMappingURL=local-state-store.js.map
