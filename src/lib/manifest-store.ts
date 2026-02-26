import { EventEmitter } from "node:events";
import Autopass from "autopass";
import type Corestore from "corestore";

export interface FileMetadata {
  kind: "file";
  size: number;
  mtime: number;
  hash: string;
  baseHash: string | null;
  seq: number;
  writerKey: string;
  blocks: {
    offset: number;
    length: number;
  };
}

export interface TombstoneMetadata {
  kind: "tombstone";
  deleted: true;
  mtime: number;
  writerKey: string;
  baseHash: string | null;
  seq: number;
}

export interface PeerMetadata {
  kind: "peer";
  writerKey: string;
  name: string;
  updatedAt: number;
}

export interface ConfigMetadata {
  kind: "config";
  peerName?: string;
  syncFolder?: string;
  settings?: Record<string, unknown>;
}

export type UserManifestValue = FileMetadata | TombstoneMetadata;
export type ManifestValue =
  | FileMetadata
  | TombstoneMetadata
  | PeerMetadata
  | ConfigMetadata;

export function isTombstone(value: ManifestValue): value is TombstoneMetadata {
  return value.kind === "tombstone" && value.deleted === true;
}

export function isFileMetadata(value: ManifestValue): value is FileMetadata {
  return value.kind === "file";
}

export function isPeerMetadata(value: ManifestValue): value is PeerMetadata {
  return value.kind === "peer";
}

export function isConfigMetadata(value: ManifestValue): value is ConfigMetadata {
  return value.kind === "config";
}

export interface ManifestEntry {
  path: string;
  metadata: ManifestValue;
}

export interface ManifestStoreOptions {
  replicate?: boolean;
  bootstrap?: { host: string; port: number }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid manifest value: ${label} must be string`);
  return value;
}

function assertNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Invalid manifest value: ${label} must be number`);
  }
  return value;
}

function assertNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return assertString(value, label);
}

function assertPathCompatibility(path: string, metadata: ManifestValue): void {
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

function parseManifestValue(path: string, raw: unknown): ManifestValue {
  if (!isRecord(raw)) {
    throw new Error(`Invalid manifest value for ${path}: expected object`);
  }

  const kind = assertString(raw.kind, "kind");

  let value: ManifestValue;
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
        length: assertNumber(blocksRaw.length, "blocks.length"),
      },
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
      seq: assertNumber(raw.seq, "seq"),
    };
  } else if (kind === "peer") {
    value = {
      kind: "peer",
      writerKey: assertString(raw.writerKey, "writerKey"),
      name: assertString(raw.name, "name"),
      updatedAt: assertNumber(raw.updatedAt, "updatedAt"),
    };
  } else if (kind === "config") {
    let settings: Record<string, unknown> | undefined;
    if (raw.settings !== undefined) {
      if (!isRecord(raw.settings)) {
        throw new Error(`Invalid manifest value for ${path}: settings must be object`);
      }
      settings = raw.settings;
    }
    value = {
      kind: "config",
      peerName:
        raw.peerName === undefined ? undefined : assertString(raw.peerName, "peerName"),
      syncFolder:
        raw.syncFolder === undefined ? undefined : assertString(raw.syncFolder, "syncFolder"),
      settings,
    };
  } else {
    throw new Error(`Invalid manifest value for ${path}: unsupported kind ${kind}`);
  }

  assertPathCompatibility(path, value);
  return value;
}

export class ManifestStore extends EventEmitter {
  private pass: InstanceType<typeof Autopass>;

  private constructor(pass: InstanceType<typeof Autopass>) {
    super();
    this.pass = pass;
    this.pass.on("update", () => this.emit("update"));
  }

  static create(
    store: InstanceType<typeof Corestore>,
    options?: ManifestStoreOptions,
  ): ManifestStore {
    const pass = new Autopass(store, {
      replicate: options?.replicate,
      bootstrap: options?.bootstrap,
    });
    return new ManifestStore(pass);
  }

  async ready(): Promise<void> {
    await this.pass.ready();
  }

  async close(): Promise<void> {
    await this.pass.close();
  }

  async put(path: string, metadata: ManifestValue): Promise<void> {
    assertPathCompatibility(path, metadata);
    await this.pass.add(path, JSON.stringify(metadata));
  }

  async putTombstone(
    path: string,
    writerKey: string,
    opts?: {
      baseHash?: string | null;
      seq?: number;
      mtime?: number;
    },
  ): Promise<void> {
    const existing = await this.get(path);
    const baseHash =
      opts?.baseHash ??
      (existing
        ? isFileMetadata(existing)
          ? existing.hash
          : isTombstone(existing)
            ? existing.baseHash
            : null
        : null);
    const seq =
      opts?.seq ??
      (existing && (isFileMetadata(existing) || isTombstone(existing))
        ? existing.seq + 1
        : 1);

    const tombstone: TombstoneMetadata = {
      kind: "tombstone",
      deleted: true,
      mtime: opts?.mtime ?? Date.now(),
      writerKey,
      baseHash,
      seq,
    };
    await this.put(path, tombstone);
  }

  async putPeer(writerKey: string, name: string): Promise<void> {
    const metadata: PeerMetadata = {
      kind: "peer",
      writerKey,
      name,
      updatedAt: Date.now(),
    };
    await this.put(`__peer:${writerKey}`, metadata);
  }

  async putConfig(config: Omit<ConfigMetadata, "kind">): Promise<void> {
    const metadata: ConfigMetadata = {
      kind: "config",
      ...config,
    };
    await this.put("__config", metadata);
  }

  async get(path: string): Promise<ManifestValue | null> {
    const result = await this.pass.get(path);
    if (result === null) return null;
    return parseManifestValue(path, JSON.parse(result.value) as unknown);
  }

  async list(): Promise<ManifestEntry[]> {
    const records = await this.pass.list().toArray();
    return records.map((record) => ({
      path: record.key,
      metadata: parseManifestValue(record.key, JSON.parse(record.value) as unknown),
    }));
  }

  async remove(path: string): Promise<void> {
    await this.pass.remove(path);
  }

  async createInvite(): Promise<string> {
    return this.pass.createInvite();
  }

  static async pair(
    store: InstanceType<typeof Corestore>,
    invite: string,
    options?: ManifestStoreOptions,
  ): Promise<ManifestStore> {
    const pairer = Autopass.pair(store, invite, {
      bootstrap: options?.bootstrap,
    });
    const pairedPass = await pairer.finished();
    await pairedPass.ready();
    return new ManifestStore(pairedPass);
  }

  get writerKey(): string {
    return this.pass.writerKey.toString("hex");
  }

  get writable(): boolean {
    return this.pass.writable;
  }

  /** Expose underlying Autopass for assertions in tests (e.g. base.system.members) */
  get autopass(): InstanceType<typeof Autopass> {
    return this.pass;
  }
}
