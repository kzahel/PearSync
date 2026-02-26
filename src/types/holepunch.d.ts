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
    createKeyPair(name: string): Promise<{ publicKey: Buffer; secretKey: Buffer }>;
    ready(): Promise<void>;
    close(): Promise<void>;
  }

  export = Corestore;
}

declare module "autopass" {
  import type { EventEmitter } from "node:events";
  import type Corestore from "corestore";

  interface AutopassOptions {
    replicate?: boolean;
    bootstrap?: { host: string; port: number }[];
    swarm?: unknown;
    key?: Buffer;
    wakeup?: unknown;
    encryptionKey?: Buffer;
    blindEncryption?: unknown;
    relayThrough?: unknown;
  }

  interface AutopassRecord {
    key: string;
    value: string;
    file: Buffer | null;
  }

  interface AutopassGetResult {
    value: string;
    file: Buffer | null;
  }

  interface AutobaseSystem {
    members: number;
  }

  interface Autobase {
    writable: boolean;
    key: Buffer;
    discoveryKey: Buffer;
    encryptionKey: Buffer;
    local: { key: Buffer };
    system: AutobaseSystem;
    replicate(connection: unknown): void;
    ready(): Promise<void>;
    close(): Promise<void>;
  }

  interface AutopassListStream {
    toArray(): Promise<AutopassRecord[]>;
    on(event: "data", listener: (entry: AutopassRecord) => void): this;
    on(event: "end", listener: () => void): this;
    [Symbol.asyncIterator](): AsyncIterableIterator<AutopassRecord>;
  }

  interface AutopassPairer {
    finished(): Promise<Autopass>;
    close(): Promise<void>;
  }

  class Autopass extends EventEmitter {
    constructor(store: Corestore, opts?: AutopassOptions);

    store: Corestore;
    base: Autobase;

    ready(): Promise<void>;
    close(): Promise<void>;

    get writerKey(): Buffer;
    get writable(): boolean;
    get key(): Buffer;

    add(key: string, value: string, file?: Buffer): Promise<void>;
    get(key: string): Promise<AutopassGetResult | null>;
    list(): AutopassListStream;
    remove(key: string): Promise<void>;

    createInvite(opts?: { readOnly?: boolean }): Promise<string>;
    deleteInvite(): Promise<void>;

    static pair(store: Corestore, invite: string, opts?: AutopassOptions): AutopassPairer;
  }

  export = Autopass;
}

declare module "hyperdht/testnet" {
  interface TestnetResult {
    bootstrap: { host: string; port: number }[];
    nodes: { destroy(): Promise<void> }[];
  }
  function testnet(size: number): Promise<TestnetResult>;
  export = testnet;
}
