# Layer 4: Folder Watcher + Sync Engine

## Context

You are working on PearSync, a P2P folder sync tool built on the Holepunch stack. Read `PLAN.md` for the full architecture. Read `CLAUDE.md` for development guidelines.

This is Layer 4. Previous layers are complete:

- **Layer 1** — FileStore: chunked file storage on Hypercores
- **Layer 2** — ManifestStore: Autopass-backed file metadata CRUD + pairing
- **Layer 3** — Integration tests proving file bytes replicate through Autopass networking

Now we need a **SyncEngine** that watches a local folder for changes, chunks new/modified files into the FileStore, updates the ManifestStore, and — on the receiving side — materializes remote file changes to disk.

## What Already Exists

### FileStore (`src/lib/file-store.ts`)

Chunks files into a named Hypercore and reads them back.

```typescript
import { FileStore, StoredFile } from "./file-store";

const fileStore = new FileStore(store);
await fileStore.ready();

const stored: StoredFile = await fileStore.writeFile(Buffer.from("hello"));
// { offset: 0, length: 1, size: 5, hash: "2cf24d..." }

const data: Buffer = await fileStore.readFile(stored.offset, stored.length);

fileStore.core.key  // Buffer, 32 bytes — the Hypercore public key
await fileStore.close();
```

### ManifestStore (`src/lib/manifest-store.ts`)

Wraps Autopass as a typed key-value store for file metadata.

```typescript
import { ManifestStore, FileMetadata, ManifestEntry } from "./manifest-store";

const manifest = ManifestStore.create(store, { bootstrap });
await manifest.ready();

await manifest.put("/path/to/file.txt", metadata);
const meta: FileMetadata | null = await manifest.get("/path/to/file.txt");
const all: ManifestEntry[] = await manifest.list();
await manifest.remove("/path/to/file.txt");

manifest.writerKey   // string, hex-encoded
manifest.on('update', () => { /* manifest changed */ });
await manifest.close();
```

### FileMetadata shape

```typescript
interface FileMetadata {
  size: number;
  mtime: number;
  hash: string;
  writerKey: string;    // hex of Hypercore key holding file bytes
  blocks: {
    offset: number;
    length: number;
  };
}
```

### Holepunch packages (already installed)

| Package | Version | Purpose |
|---------|---------|---------|
| `localdrive` | ^2.2.0 | Maps a local folder to a drive API |
| `watch-drive` | ^2.0.3 | Watches a drive for changes |
| `mirror-drive` | ^1.13.0 | Syncs between two drives (available but may not be needed) |

### Reference source code

Cloned source for the above packages is in `reference/`:

- `reference/localdrive/index.js` — Localdrive implementation
- `reference/watch-drive/index.js` — watch-drive implementation
- `reference/mirror-drive/index.js` — MirrorDrive implementation

Read these when you need to understand exact API behavior.

## Key APIs to Understand

### Localdrive

```typescript
import Localdrive from "localdrive";

const drive = new Localdrive("/path/to/folder");

// Read a file
const buf: Buffer | null = await drive.get("/relative/file.txt");

// Write a file
await drive.put("/relative/file.txt", buffer);

// Delete a file
await drive.del("/relative/file.txt");

// Get entry metadata (null if not found)
const entry = await drive.entry("/relative/file.txt");
// entry = { key: "/relative/file.txt", value: { blob: { byteLength }, ... }, mtime: number }

// List all files (async iterable)
for await (const entry of drive.list("/")) {
  console.log(entry.key, entry.value.blob?.byteLength, entry.mtime);
}
```

**Path format**: always Unix-style with leading `/`. Localdrive converts to/from the OS path internally.

### watch-drive

```typescript
import watch from "watch-drive";

const watcher = watch(drive, "/");

// watcher is a Readable stream AND async iterable
for await (const batch of watcher) {
  // batch = { key: Buffer|null, length: number, fork: number, diff: WatchDiff[] }
  for (const { type, key } of batch.diff) {
    // type: "update" (file created/modified) or "delete" (file removed)
    // key: "/relative/path/to/file.txt"
    console.log(type, key);
  }
}

// Or event-based:
watcher.on("data", (batch) => { ... });

// Stop watching:
watcher.destroy();
```

**Batching**: Multiple rapid changes arrive in a single batch. Each batch has a `diff` array.

## What to Build

### 1. Type declarations

Add type declarations for `localdrive` and `watch-drive` to `src/types/holepunch.d.ts`.

#### localdrive

```typescript
declare module "localdrive" {
  interface LocaldriveEntry {
    key: string;
    value: {
      executable: boolean;
      linkname: string | null;
      blob: {
        byteOffset: number;
        blockOffset: number;
        blockLength: number;
        byteLength: number;
      } | null;
      metadata: unknown;
    };
    mtime: number;
  }

  interface LocaldriveOptions {
    metadata?: unknown;
    followLinks?: boolean;
    atomic?: boolean;
  }

  class Localdrive {
    root: string;
    constructor(root: string, opts?: LocaldriveOptions);
    ready(): Promise<void>;
    close(): Promise<void>;
    entry(key: string, opts?: { follow?: boolean }): Promise<LocaldriveEntry | null>;
    get(key: string): Promise<Buffer | null>;
    put(key: string, buffer: Buffer, opts?: { executable?: boolean }): Promise<void>;
    del(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    list(folder?: string): AsyncIterable<LocaldriveEntry>;
    toPath(key: string): string;
    compare(a: LocaldriveEntry, b: LocaldriveEntry): number;
  }

  export = Localdrive;
}
```

#### watch-drive

```typescript
declare module "watch-drive" {
  import type { Readable } from "node:stream";
  import type Localdrive from "localdrive";

  interface WatchDiff {
    type: "update" | "delete";
    key: string;
  }

  interface WatchBatch {
    key: Buffer | null;
    length: number;
    fork: number;
    diff: WatchDiff[];
  }

  interface WatchOptions {
    eagerOpen?: boolean;
  }

  function watch(
    drive: Localdrive,
    key?: string,
    opts?: WatchOptions,
  ): Readable & AsyncIterable<WatchBatch>;

  export = watch;
}
```

### 2. SyncEngine class (`src/lib/sync-engine.ts`)

The SyncEngine ties everything together. It owns:

- A **Localdrive** pointed at the user's sync folder
- A **watch-drive** watcher on that drive
- A **FileStore** for chunked file content
- A **ManifestStore** for file metadata (with Autopass networking)

It handles two directions:

1. **Local → Remote**: watch detects local file change → read file → chunk into FileStore → update ManifestStore
2. **Remote → Local**: ManifestStore `update` event → diff manifest against local state → read remote blocks → write file to disk

#### Class skeleton

```typescript
import { EventEmitter } from "node:events";
import Localdrive from "localdrive";
import watch from "watch-drive";
import type Corestore from "corestore";
import { FileStore } from "./file-store";
import { ManifestStore, FileMetadata } from "./manifest-store";

export interface SyncEngineOptions {
  /** Autopass bootstrap nodes (required for networking) */
  bootstrap?: { host: string; port: number }[];
}

export class SyncEngine extends EventEmitter {
  private store: InstanceType<typeof Corestore>;
  private drive: InstanceType<typeof Localdrive>;
  private fileStore: FileStore;
  private manifest: ManifestStore;
  private watcher: ReturnType<typeof watch> | null = null;

  /** Tracks which paths we're currently writing to disk, to suppress watcher feedback */
  private suppressedPaths: Set<string> = new Set();

  constructor(
    store: InstanceType<typeof Corestore>,
    syncFolder: string,
    options?: SyncEngineOptions,
  ) { ... }

  async ready(): Promise<void> { ... }
  async close(): Promise<void> { ... }

  /** Start watching the local folder and listening for remote changes */
  async start(): Promise<void> { ... }

  /** Stop watching (but don't close stores) */
  async stop(): Promise<void> { ... }
}
```

#### `ready()`

1. Initialize the Localdrive: `new Localdrive(syncFolder)`
2. Initialize the FileStore: `new FileStore(store)`, then `await fileStore.ready()`
3. Initialize the ManifestStore: `ManifestStore.create(store, { bootstrap })`, then `await manifest.ready()`

#### `start()`

1. Start the watcher: `watch(this.drive, "/")`
2. Listen for watcher data events → call `handleLocalChanges(batch.diff)`
3. Listen for manifest `update` events → call `handleRemoteChanges()`
4. Do an initial full sync: compare local files against manifest to catch anything missed while offline

#### `stop()`

1. Destroy the watcher
2. Remove manifest update listener

#### `close()`

1. Call `stop()` if running
2. Close fileStore, manifest, and drive (in that order)

#### Local change handler

```typescript
private async handleLocalChange(type: "update" | "delete", key: string): Promise<void> {
  // Skip if this path is in suppressedPaths (we wrote it ourselves)
  if (this.suppressedPaths.has(key)) {
    this.suppressedPaths.delete(key);
    return;
  }

  if (type === "update") {
    // Read file from drive
    const data = await this.drive.get(key);
    if (data === null) return; // might be a directory or gone already

    // Get mtime from entry
    const entry = await this.drive.entry(key);
    const mtime = entry?.mtime ?? Date.now();

    // Check if file is unchanged (same hash as manifest)
    const existing = await this.manifest.get(key);
    const hash = createHash("sha256").update(data).digest("hex");
    if (existing && existing.hash === hash) return; // no change

    // Write to FileStore
    const stored = await this.fileStore.writeFile(data);

    // Update manifest
    const metadata: FileMetadata = {
      size: stored.size,
      mtime,
      hash: stored.hash,
      writerKey: this.fileStore.core.key.toString("hex"),
      blocks: { offset: stored.offset, length: stored.length },
    };
    await this.manifest.put(key, metadata);

    this.emit("sync", { direction: "local-to-remote", type: "update", path: key });
  } else if (type === "delete") {
    // Only remove from manifest if we have an entry
    const existing = await this.manifest.get(key);
    if (existing) {
      await this.manifest.remove(key);
      this.emit("sync", { direction: "local-to-remote", type: "delete", path: key });
    }
  }
}
```

#### Remote change handler

```typescript
private async handleRemoteChanges(): Promise<void> {
  const entries = await this.manifest.list();
  const manifestPaths = new Set<string>();

  for (const { path, metadata } of entries) {
    manifestPaths.add(path);

    // Skip files we wrote (our own writerKey)
    if (metadata.writerKey === this.fileStore.core.key.toString("hex")) continue;

    // Check if local file matches
    const localEntry = await this.drive.entry(path);
    if (localEntry) {
      const localData = await this.drive.get(path);
      if (localData) {
        const localHash = createHash("sha256").update(localData).digest("hex");
        if (localHash === metadata.hash) continue; // already up to date
      }
    }

    // Fetch remote file blocks
    const remoteCore = this.store.get({ key: Buffer.from(metadata.writerKey, "hex") });
    await remoteCore.ready();

    const blocks: Buffer[] = [];
    for (let i = 0; i < metadata.blocks.length; i++) {
      const block = await remoteCore.get(metadata.blocks.offset + i);
      if (!block) throw new Error(`Missing block ${metadata.blocks.offset + i} from ${metadata.writerKey}`);
      blocks.push(block);
    }
    const fileData = Buffer.concat(blocks);

    // Write to local drive, suppressing watcher feedback
    this.suppressedPaths.add(path);
    await this.drive.put(path, fileData);

    this.emit("sync", { direction: "remote-to-local", type: "update", path });
  }

  // Handle deletions: files in local that are NOT in manifest
  // (Only for files from other writers — don't delete our own local-only files)
  // This is deferred to Layer 5 / conflict resolution. For now, skip deletion propagation.
}
```

#### Events emitted

```typescript
interface SyncEvent {
  direction: "local-to-remote" | "remote-to-local";
  type: "update" | "delete";
  path: string;
}

// engine.on("sync", (event: SyncEvent) => { ... })
// engine.on("error", (err: Error) => { ... })
```

### 3. Tests (`src/lib/sync-engine.test.ts`)

#### Test 1: Local file change is detected and stored

1. Create a SyncEngine with a temp folder and `replicate: false` ManifestStore
2. Write a file to the sync folder using `fs.writeFile` (bypassing the drive API)
3. Wait for `sync` event with `direction: "local-to-remote"`
4. Verify the manifest has an entry for the file
5. Verify the FileStore has the file's blocks

#### Test 2: Local file deletion is detected

1. Create a SyncEngine, write a file, wait for sync
2. Delete the file using `fs.unlink`
3. Wait for `sync` event with `type: "delete"`
4. Verify the manifest entry is removed

#### Test 3: Local file modification is detected

1. Create a SyncEngine, write a file, wait for sync
2. Overwrite the file with different content
3. Wait for a second `sync` event
4. Verify the manifest entry has the new hash and new blocks

#### Test 4: Remote manifest update materializes file to disk

1. Create a SyncEngine
2. Manually write file blocks to a separate Hypercore (simulating a remote peer's FileStore)
3. Manually put a manifest entry pointing to those blocks (with the remote core's key as writerKey)
4. Trigger manifest update
5. Verify the file appears on disk with correct content

#### Test 5: End-to-end with two SyncEngines (testnet)

This is the crown jewel test. Two SyncEngines paired via testnet:

1. Create two SyncEngines with separate Corestores and temp folders, paired via testnet
2. Engine A: write a file to folder A
3. Wait for file to appear in folder B
4. Verify content matches
5. Engine B: write a different file to folder B
6. Wait for file to appear in folder A
7. Verify content matches

**Note**: This test requires pairing. Create the ManifestStore externally with pairing, then pass it into the SyncEngine (or add a static factory method). Design the constructor to accept a pre-created ManifestStore for testability.

#### Test 6: Watcher suppression prevents feedback loops

1. Create a SyncEngine
2. Simulate a remote update that writes a file to disk
3. Verify the watcher does NOT re-upload the file we just wrote
4. (Check that `suppressedPaths` works correctly)

#### Test 7: Unchanged files are skipped

1. Create a SyncEngine, write a file, wait for sync
2. Touch the file (update mtime but same content)
3. Verify NO new manifest entry is created (same hash → skip)

### 4. Constructor flexibility

The SyncEngine needs to work in two modes:

1. **Standalone** (creates its own ManifestStore) — for production use
2. **Injected** (accepts a pre-created ManifestStore) — for testing with paired instances

Support this with an overloaded constructor or a static factory:

```typescript
// Option A: accept ManifestStore in options
interface SyncEngineOptions {
  bootstrap?: { host: string; port: number }[];
  manifest?: ManifestStore;  // if provided, use this instead of creating one
}

// Option B: static factory for paired engines (used in tests)
static fromManifest(
  store: InstanceType<typeof Corestore>,
  syncFolder: string,
  manifest: ManifestStore,
): SyncEngine;
```

Either approach is fine. The key requirement is that the end-to-end test can create two engines that share a paired ManifestStore.

## Important Technical Notes

### Watcher suppression

When the SyncEngine writes a file to disk (materializing a remote change), the watcher will detect that write and fire an "update" event. Without suppression, this would trigger the engine to re-upload the file it just downloaded — an infinite loop.

The `suppressedPaths` Set prevents this. Before writing to disk, add the path. When the watcher fires, check if the path is suppressed and skip it.

**Edge case**: The watcher may batch the suppressed event with other real events. Handle each diff entry independently.

### Hash-based deduplication

Always compute the sha256 hash of file content before uploading. If the manifest already has an entry with the same hash, skip the upload. This prevents:

- Re-uploading on touch/mtime-only changes
- Re-uploading when watcher suppression fails to catch a feedback event

### Handling the watcher stream

watch-drive returns a Readable stream. You can consume it with `on("data")` or `for await`. Using `on("data")` is simpler for a long-running engine:

```typescript
this.watcher = watch(this.drive, "/");
this.watcher.on("data", (batch) => {
  for (const diff of batch.diff) {
    this.handleLocalChange(diff.type, diff.key).catch((err) => this.emit("error", err));
  }
});
```

**Important**: `handleLocalChange` is async. Don't `await` it inside the data handler (that would pause the stream). Fire-and-forget with error propagation. If you need serialization (to prevent concurrent uploads of the same file), use a queue or mutex internally.

### Initial sync on start

When `start()` is called, there may be files on disk that changed while the engine was stopped. Do a full diff:

1. List all local files via `drive.list("/")`
2. For each local file, compare hash with manifest entry
3. Upload any that are new or changed
4. List all manifest entries
5. For each remote entry (not our writerKey), check if local file matches
6. Download any that are new or changed

This ensures convergence after restarts.

### What NOT to build in this layer

- **Conflict resolution** — if both peers modify the same file, last-write-wins for now. Conflict files (`.conflict-*`) are a Layer 5 concern.
- **Remote deletion propagation** — don't delete local files based on missing manifest entries yet. This needs careful handling (what if the user created a new local file that isn't in the manifest yet?). Defer to Layer 5.
- **Ignore patterns** — no `.gitignore`-style filtering yet.
- **File permissions / symlinks** — ignore executable bits and symlinks for now.

## Development Workflow

1. Read `CLAUDE.md` for project conventions
2. Read `src/lib/file-store.ts` and `src/lib/manifest-store.ts` to understand the APIs
3. Read `reference/localdrive/index.js` and `reference/watch-drive/index.js` for drive/watcher API details
4. Add type declarations to `src/types/holepunch.d.ts`
5. Write `src/lib/sync-engine.ts`
6. Write `src/lib/sync-engine.test.ts`
7. Run `npx tsc --noEmit && npx biome check --write . && npx vitest run` — everything must pass
8. Commit the work

## Success Criteria

- Type declarations for `localdrive` and `watch-drive` added to `src/types/holepunch.d.ts`
- `SyncEngine` class in `src/lib/sync-engine.ts` with `ready()`, `start()`, `stop()`, `close()`
- Local file create/modify → detected by watcher → stored in FileStore → manifest updated
- Remote manifest update → file materialized to disk
- Watcher suppression prevents feedback loops
- Hash-based skip prevents redundant uploads
- End-to-end test: two paired SyncEngines, file written in folder A appears in folder B
- All tests pass (`npx tsc --noEmit && npx biome check --write . && npx vitest run`)
- Existing tests still pass (file-store, manifest-store, replication)
