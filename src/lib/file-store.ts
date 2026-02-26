import { createHash } from "node:crypto";
import Corestore from "corestore";

const DEFAULT_BLOCK_SIZE = 64 * 1024; // 64KB

export interface StoredFile {
  offset: number; // starting block index
  length: number; // number of blocks
  size: number; // total bytes
  hash: string; // sha256 of content
}

export interface FileStoreOptions {
  blockSize?: number;
  name?: string;
}

export class FileStore {
  private store: InstanceType<typeof Corestore>;
  private _core: ReturnType<InstanceType<typeof Corestore>["get"]>;
  private blockSize: number;

  constructor(store: InstanceType<typeof Corestore>, options?: FileStoreOptions) {
    this.store = store;
    this.blockSize = options?.blockSize ?? DEFAULT_BLOCK_SIZE;
    this._core = store.get({ name: options?.name ?? "file-data" });
  }

  get core() {
    return this._core;
  }

  async ready(): Promise<void> {
    await this._core.ready();
  }

  async writeFile(data: Buffer): Promise<StoredFile> {
    const hash = createHash("sha256").update(data).digest("hex");

    if (data.length === 0) {
      return { offset: this._core.length, length: 0, size: 0, hash };
    }

    const chunks: Buffer[] = [];
    for (let i = 0; i < data.length; i += this.blockSize) {
      chunks.push(data.subarray(i, i + this.blockSize));
    }

    const result = await this._core.append(chunks);

    return {
      offset: result.length - chunks.length,
      length: chunks.length,
      size: data.length,
      hash,
    };
  }

  async readFile(offset: number, length: number): Promise<Buffer> {
    if (length === 0) {
      return Buffer.alloc(0);
    }

    const blocks: Buffer[] = [];
    for (let i = 0; i < length; i++) {
      const block = await this._core.get(offset + i);
      if (block === null) {
        throw new Error(`Missing block at index ${offset + i}`);
      }
      blocks.push(block);
    }

    return Buffer.concat(blocks);
  }

  async close(): Promise<void> {
    await this._core.close();
  }
}
