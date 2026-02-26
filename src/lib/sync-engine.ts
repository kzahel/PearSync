import { EventEmitter } from "node:events";

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

export interface SyncEngineOptions {
  storage: string;
}

export class SyncEngine extends EventEmitter {
  private storage: string;

  constructor(opts: SyncEngineOptions) {
    super();
    this.storage = opts.storage;
  }

  async ready(): Promise<void> {
    // TODO: initialize Autopass + Hypercore
  }

  async close(): Promise<void> {
    // TODO: cleanup
  }
}
