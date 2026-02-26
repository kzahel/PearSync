import { EventEmitter } from "node:events";
import Autopass from "autopass";
import type Corestore from "corestore";

export interface FileMetadata {
  size: number;
  mtime: number;
  hash: string;
  writerKey: string;
  blocks: {
    offset: number;
    length: number;
  };
}

export interface ManifestEntry {
  path: string;
  metadata: FileMetadata;
}

export interface ManifestStoreOptions {
  replicate?: boolean;
  bootstrap?: { host: string; port: number }[];
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

  async put(path: string, metadata: FileMetadata): Promise<void> {
    await this.pass.add(path, JSON.stringify(metadata));
  }

  async get(path: string): Promise<FileMetadata | null> {
    const result = await this.pass.get(path);
    if (result === null) return null;
    return JSON.parse(result.value) as FileMetadata;
  }

  async list(): Promise<ManifestEntry[]> {
    const records = await this.pass.list().toArray();
    return records.map((record) => ({
      path: record.key,
      metadata: JSON.parse(record.value) as FileMetadata,
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
