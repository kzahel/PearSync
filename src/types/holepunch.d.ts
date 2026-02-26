declare module "corestore" {
  import type { Duplex } from "node:stream";

  interface CorestoreGetOptions {
    name?: string;
    key?: Buffer;
  }

  export interface Hypercore {
    key: Buffer;
    length: number;
    byteLength: number;
    ready(): Promise<void>;
    append(data: Buffer | Buffer[]): Promise<{ length: number; byteLength: number }>;
    get(index: number, options?: { wait?: boolean }): Promise<Buffer | null>;
    has(index: number): Promise<boolean>;
    close(): Promise<void>;
  }

  class Corestore {
    constructor(storage: string);
    primaryKey: Buffer;
    get(options: CorestoreGetOptions | Buffer): Hypercore;
    replicate(isInitiator: boolean): Duplex;
    ready(): Promise<void>;
    close(): Promise<void>;
  }

  export = Corestore;
}
