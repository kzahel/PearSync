import { EventEmitter } from "bare-events";
import Autopass from "autopass";
function isTombstone(value) {
  return value.kind === "tombstone" && value.deleted === true;
}
function isFileMetadata(value) {
  return value.kind === "file";
}
function isPeerMetadata(value) {
  return value.kind === "peer";
}
function isConfigMetadata(value) {
  return value.kind === "config";
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function assertString(value, label) {
  if (typeof value !== "string") throw new Error(`Invalid manifest value: ${label} must be string`);
  return value;
}
function assertNumber(value, label) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Invalid manifest value: ${label} must be number`);
  }
  return value;
}
function assertNullableString(value, label) {
  if (value === null) return null;
  return assertString(value, label);
}
function assertPathCompatibility(path, metadata) {
  if (path.startsWith("__peer:")) {
    if (!isPeerMetadata(metadata)) {
      throw new Error(`Invalid manifest path/type pair: ${path} requires peer metadata`);
    }
    const expectedPath = `__peer:${metadata.writerKey}`;
    if (path !== expectedPath) {
      throw new Error(`Invalid peer metadata key: expected ${expectedPath}, got ${path}`);
    }
    return;
  }
  if (path === "__config") {
    if (!isConfigMetadata(metadata)) {
      throw new Error("Invalid manifest path/type pair: __config requires config metadata");
    }
    return;
  }
  if (path.startsWith("__")) {
    throw new Error(`Unsupported system key: ${path}`);
  }
  if (!path.startsWith("/")) {
    throw new Error(`Invalid manifest key: ${path}. User files must start with '/'`);
  }
  if (!isFileMetadata(metadata) && !isTombstone(metadata)) {
    throw new Error(`Invalid manifest path/type pair: user path ${path} requires file/tombstone`);
  }
}
function parseManifestValue(path, raw) {
  if (!isRecord(raw)) {
    throw new Error(`Invalid manifest value for ${path}: expected object`);
  }
  const kind = assertString(raw.kind, "kind");
  let value;
  if (kind === "file") {
    const blocksRaw = raw.blocks;
    if (!isRecord(blocksRaw)) {
      throw new Error(`Invalid manifest value for ${path}: blocks must be object`);
    }
    value = {
      kind: "file",
      size: assertNumber(raw.size, "size"),
      mtime: assertNumber(raw.mtime, "mtime"),
      hash: assertString(raw.hash, "hash"),
      baseHash: assertNullableString(raw.baseHash, "baseHash"),
      seq: assertNumber(raw.seq, "seq"),
      writerKey: assertString(raw.writerKey, "writerKey"),
      blocks: {
        offset: assertNumber(blocksRaw.offset, "blocks.offset"),
        length: assertNumber(blocksRaw.length, "blocks.length")
      }
    };
  } else if (kind === "tombstone") {
    if (raw.deleted !== true) {
      throw new Error(`Invalid manifest value for ${path}: tombstone.deleted must be true`);
    }
    value = {
      kind: "tombstone",
      deleted: true,
      mtime: assertNumber(raw.mtime, "mtime"),
      writerKey: assertString(raw.writerKey, "writerKey"),
      baseHash: assertNullableString(raw.baseHash, "baseHash"),
      seq: assertNumber(raw.seq, "seq")
    };
  } else if (kind === "peer") {
    value = {
      kind: "peer",
      writerKey: assertString(raw.writerKey, "writerKey"),
      name: assertString(raw.name, "name"),
      updatedAt: assertNumber(raw.updatedAt, "updatedAt")
    };
  } else if (kind === "config") {
    let settings;
    if (raw.settings !== void 0) {
      if (!isRecord(raw.settings)) {
        throw new Error(`Invalid manifest value for ${path}: settings must be object`);
      }
      settings = raw.settings;
    }
    value = {
      kind: "config",
      peerName: raw.peerName === void 0 ? void 0 : assertString(raw.peerName, "peerName"),
      syncFolder: raw.syncFolder === void 0 ? void 0 : assertString(raw.syncFolder, "syncFolder"),
      settings
    };
  } else {
    throw new Error(`Invalid manifest value for ${path}: unsupported kind ${kind}`);
  }
  assertPathCompatibility(path, value);
  return value;
}
class ManifestStore extends EventEmitter {
  pass;
  constructor(pass) {
    super();
    this.pass = pass;
    this.pass.on("update", () => this.emit("update"));
  }
  static create(store, options) {
    const pass = new Autopass(store, {
      replicate: options?.replicate,
      bootstrap: options?.bootstrap
    });
    return new ManifestStore(pass);
  }
  async ready() {
    await this.pass.ready();
  }
  async close() {
    await this.pass.close();
  }
  async put(path, metadata) {
    assertPathCompatibility(path, metadata);
    await this.pass.add(path, JSON.stringify(metadata));
  }
  async putTombstone(path, writerKey, opts) {
    const existing = await this.get(path);
    const baseHash = opts?.baseHash ?? (existing ? isFileMetadata(existing) ? existing.hash : isTombstone(existing) ? existing.baseHash : null : null);
    const seq = opts?.seq ?? (existing && (isFileMetadata(existing) || isTombstone(existing)) ? existing.seq + 1 : 1);
    const tombstone = {
      kind: "tombstone",
      deleted: true,
      mtime: opts?.mtime ?? Date.now(),
      writerKey,
      baseHash,
      seq
    };
    await this.put(path, tombstone);
  }
  async putPeer(writerKey, name) {
    const metadata = {
      kind: "peer",
      writerKey,
      name,
      updatedAt: Date.now()
    };
    await this.put(`__peer:${writerKey}`, metadata);
  }
  async putConfig(config) {
    const metadata = {
      kind: "config",
      ...config
    };
    await this.put("__config", metadata);
  }
  async get(path) {
    const result = await this.pass.get(path);
    if (result === null) return null;
    return parseManifestValue(path, JSON.parse(result.value));
  }
  async list() {
    const records = await this.pass.list().toArray();
    return records.map((record) => ({
      path: record.key,
      metadata: parseManifestValue(record.key, JSON.parse(record.value))
    }));
  }
  async remove(path) {
    await this.pass.remove(path);
  }
  async createInvite() {
    return this.pass.createInvite();
  }
  static async pair(store, invite, options) {
    const pairer = Autopass.pair(store, invite, {
      bootstrap: options?.bootstrap
    });
    const pairedPass = await pairer.finished();
    await pairedPass.ready();
    return new ManifestStore(pairedPass);
  }
  get writerKey() {
    return this.pass.writerKey.toString("hex");
  }
  get writable() {
    return this.pass.writable;
  }
  /** Expose underlying Autopass for assertions in tests (e.g. base.system.members) */
  get autopass() {
    return this.pass;
  }
}
export {
  ManifestStore,
  isConfigMetadata,
  isFileMetadata,
  isPeerMetadata,
  isTombstone
};
//# sourceMappingURL=manifest-store.js.map
