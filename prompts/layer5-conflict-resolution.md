# Layer 5: Conflict Resolution, Tombstones, and Deletion Propagation

## Context

You are working on PearSync, a P2P folder sync tool built on the Holepunch stack. Read `PLAN.md` for the full architecture. Read `CLAUDE.md` for development guidelines.

This is Layer 5. Previous layers are complete:

- **Layer 1** — FileStore: chunked file storage on Hypercores
- **Layer 2** — ManifestStore: Autopass-backed file metadata CRUD + pairing
- **Layer 3** — Integration tests proving file bytes replicate through Autopass networking
- **Layer 4** — SyncEngine: folder watching, local↔remote file sync, watcher suppression

Layer 4 explicitly deferred three things:

1. **Conflict resolution** — when both peers modify the same file, Layer 4 does last-write-wins silently. We need to detect conflicts and create `.conflict-*` copies.
2. **Remote deletion propagation** — Layer 4 never deletes local files based on manifest state. We need tombstones and safe deletion.
3. **Peer naming** — conflict filenames need a human-readable peer name, which doesn't exist yet.

This layer adds all three.

## Why This Is Hard: Autobase Linearization

The manifest is built on Autopass, which uses Autobase to linearize all writers' operations into a single deterministic view backed by HyperDB. When two peers both `manifest.put("/file.txt", ...)`, Autobase picks a deterministic winner — `manifest.get("/file.txt")` returns one value. **The loser's metadata is gone from the manifest view.** HyperDB keeps the last-applied value per key (by Autobase's linearization order, not by wall-clock time).

This means we **cannot** detect conflicts by reading the manifest alone. We need local state tracking.

## Design Decisions

### Conflict detection via local state tracking

Each SyncEngine maintains a **LocalStateStore** — a JSON file persisted to disk — that tracks per-file sync state. On every successful sync (upload or download), we record what we synced. On the next remote update, we compare:

```
manifestHash ≠ lastManifestHash   → remote changed the file
localHash ≠ lastSyncedHash        → local changed the file
both true && localHash ≠ manifestHash → CONFLICT
```

If only remote changed → fast-forward download. If only local changed → our upload will propagate. If both changed with the same resulting hash → no conflict (same content).

### Tombstones instead of manifest.remove()

`manifest.remove()` makes the key vanish — indistinguishable from "never synced." Instead, deletions write a tombstone entry:

```typescript
{ deleted: true, mtime: number, writerKey: string }
```

The local state tracker tells us whether a missing-from-manifest file is new-local or deleted-remote.

### Peer names from `__peer:` entries

Each peer writes a `__peer:<writerKeyHex>` manifest entry on startup containing its name. The peer name is auto-generated from the writer key (first 8 hex chars) by default. The conflict filename format is `file.conflict-YYYY-MM-DD-peerName.ext`.

### Winner selection

Per PLAN.md: highest `mtime` wins. This is a **content-level** decision made by our app code, independent of Autobase's linearization order. When a conflict is detected, the SyncEngine compares mtimes and keeps the winner on disk at the original path, saving the loser as a conflict copy.

## What Already Exists

### SyncEngine (`src/lib/sync-engine.ts`)

The Layer 4 SyncEngine handles:

- Watching a local folder via Localdrive + watch-drive
- Local change → hash → chunk into FileStore → update manifest
- Remote manifest update → download blocks → write to disk
- Watcher suppression to prevent feedback loops
- Hash-based deduplication (skip if same hash)
- Initial full sync on start

```typescript
import { SyncEngine, SyncEvent } from "./sync-engine";

const engine = new SyncEngine(store, syncFolder, { bootstrap, manifest });
await engine.ready();
await engine.start();

engine.on("sync", (event: SyncEvent) => { ... });
engine.on("error", (err: Error) => { ... });

engine.getManifest();   // ManifestStore
engine.getFileStore();  // FileStore

await engine.stop();
await engine.close();
```

### ManifestStore (`src/lib/manifest-store.ts`)

```typescript
import { ManifestStore, FileMetadata } from "./manifest-store";

await manifest.put(path, metadata);
const meta: FileMetadata | null = await manifest.get(path);
const all: ManifestEntry[] = await manifest.list();
await manifest.remove(path);

manifest.writerKey;  // string, hex
manifest.on("update", () => { ... });
```

### FileMetadata shape

```typescript
interface FileMetadata {
  size: number;
  mtime: number;
  hash: string;
  writerKey: string;
  blocks: { offset: number; length: number };
}
```

### FileStore (`src/lib/file-store.ts`)

```typescript
const stored = await fileStore.writeFile(data);
// { offset, length, size, hash }
const data = await fileStore.readFile(offset, length);
fileStore.core.key;  // Buffer
```

## What to Build

### 1. LocalStateStore (`src/lib/local-state-store.ts`)

A simple JSON-file-backed store that tracks per-file sync state. Persisted to `<syncFolder>/.pearsync/state.json`.

```typescript
export interface FileState {
  /** Hash of the file content when we last completed a sync (upload or download) */
  lastSyncedHash: string;
  /** Mtime when we last completed a sync */
  lastSyncedMtime: number;
  /** Hash from the manifest entry we last processed */
  lastManifestHash: string;
  /** Writer key from the manifest entry we last processed */
  lastManifestWriterKey: string;
}

export class LocalStateStore {
  private state: Map<string, FileState>;
  private filePath: string;

  constructor(syncFolder: string);

  /** Load state from disk. Creates the file if it doesn't exist. */
  async load(): Promise<void>;

  /** Get the tracked state for a file path. */
  get(path: string): FileState | undefined;

  /** Update state for a file path and persist to disk. */
  async set(path: string, state: FileState): Promise<void>;

  /** Remove state for a file path and persist to disk. */
  async remove(path: string): Promise<void>;

  /** Check if a path is tracked. */
  has(path: string): boolean;

  /** Get all tracked paths. */
  paths(): string[];
}
```

Implementation notes:

- Store the JSON file at `<syncFolder>/.pearsync/state.json`
- Create the `.pearsync/` directory if it doesn't exist
- Write atomically (write to `.tmp`, rename over) to avoid corruption on crash
- The SyncEngine's watcher should **ignore** paths under `/.pearsync/` — these are internal metadata, not user files
- Keep the implementation simple. No caching beyond the in-memory Map. Load once on startup, write on every `set()`/`remove()`.

### 2. Tombstone support

#### Extend FileMetadata with a union type

Add a tombstone variant to the manifest value types:

```typescript
export interface TombstoneMetadata {
  deleted: true;
  mtime: number;
  writerKey: string;
}

export type ManifestValue = FileMetadata | TombstoneMetadata;

export function isTombstone(value: ManifestValue): value is TombstoneMetadata {
  return "deleted" in value && value.deleted === true;
}
```

#### Update ManifestStore

- `put()` accepts `ManifestValue` (either `FileMetadata` or `TombstoneMetadata`)
- `get()` returns `ManifestValue | null`
- `list()` returns entries with `ManifestValue`
- Add a `putTombstone(path: string, writerKey: string)` convenience method that creates a `TombstoneMetadata` with `mtime: Date.now()`
- Keep `remove()` for backwards compatibility but it should NOT be used for file deletions in the SyncEngine anymore

#### Update ManifestEntry

```typescript
export interface ManifestEntry {
  path: string;
  metadata: ManifestValue;
}
```

### 3. Peer name registration

#### On SyncEngine startup

After `manifest.ready()`, write a `__peer:<writerKeyHex>` entry to the manifest:

```typescript
const peerName = writerKey.slice(0, 8);  // first 8 hex chars
await manifest.put(`__peer:${writerKey}`, {
  name: peerName,
  // Store as a JSON string value via Autopass
});
```

This is a manifest entry like any other — it replicates to all peers automatically.

#### Peer name lookup

Add a helper to SyncEngine (or ManifestStore):

```typescript
async getPeerName(writerKey: string): Promise<string> {
  const entry = await this.manifest.get(`__peer:${writerKey}`);
  if (entry && "name" in entry) return (entry as { name: string }).name;
  return writerKey.slice(0, 8);  // fallback
}
```

**Important**: `__peer:` and `__config` entries should be **filtered out** of `list()` results when enumerating user files (or the SyncEngine should skip keys starting with `__`).

### 4. Update SyncEngine

This is the main body of work. Modify the existing SyncEngine to integrate LocalStateStore, conflict detection, tombstone handling, and deletion propagation.

#### Constructor and ready()

- Accept the sync folder and create a `LocalStateStore` for it
- In `ready()`, call `localState.load()`
- After manifest is ready, register the peer name via `__peer:` entry

#### Ignore `.pearsync/` paths

In `handleLocalChange()`, skip any path starting with `/.pearsync/`:

```typescript
if (key.startsWith("/.pearsync/")) return;
```

#### Skip `__` manifest keys

In `handleRemoteChanges()` and `initialSync()`, skip manifest entries whose path starts with `__`:

```typescript
if (path.startsWith("__")) continue;
```

#### Updated local change handler (upload)

```typescript
private async handleLocalChange(type: "update" | "delete", key: string): Promise<void> {
  if (key.startsWith("/.pearsync/")) return;
  if (this.suppressedPaths.has(key)) { this.suppressedPaths.delete(key); return; }

  if (type === "update") {
    const data = await this.drive.get(key);
    if (!data) return;

    const entry = await this.drive.entry(key);
    const mtime = entry?.mtime ?? Date.now();
    const hash = createHash("sha256").update(data).digest("hex");

    const manifestValue = await this.manifest.get(key);

    // Skip if manifest already has this exact hash (and it's not a tombstone)
    if (manifestValue && !isTombstone(manifestValue) && manifestValue.hash === hash) return;

    // Write to FileStore and update manifest
    const stored = await this.fileStore.writeFile(data);
    const metadata: FileMetadata = {
      size: stored.size, mtime, hash: stored.hash,
      writerKey: this.fileStore.core.key.toString("hex"),
      blocks: { offset: stored.offset, length: stored.length },
    };
    await this.manifest.put(key, metadata);

    // Update local state tracker
    await this.localState.set(key, {
      lastSyncedHash: hash,
      lastSyncedMtime: mtime,
      lastManifestHash: hash,
      lastManifestWriterKey: metadata.writerKey,
    });

    this.emit("sync", { direction: "local-to-remote", type: "update", path: key });

  } else if (type === "delete") {
    const manifestValue = await this.manifest.get(key);
    if (manifestValue && !isTombstone(manifestValue)) {
      // Write tombstone instead of remove()
      await this.manifest.putTombstone(key, this.fileStore.core.key.toString("hex"));
      await this.localState.remove(key);
      this.emit("sync", { direction: "local-to-remote", type: "delete", path: key });
    }
  }
}
```

#### Updated remote change handler (download + conflict detection + deletion)

This is the most complex part. The handler must:

1. Iterate manifest entries, skip `__` keys
2. For each live (non-tombstone) remote entry, check for conflicts
3. For each tombstone, propagate deletion if appropriate
4. Update local state after each action

```typescript
private async handleRemoteChanges(): Promise<void> {
  const entries = await this.manifest.list();
  const myWriterKey = this.fileStore.core.key.toString("hex");

  for (const { path, metadata } of entries) {
    if (path.startsWith("__")) continue;

    if (isTombstone(metadata)) {
      await this.handleRemoteDeletion(path, metadata);
      continue;
    }

    // Skip our own writes
    if (metadata.writerKey === myWriterKey) continue;

    await this.handleRemoteUpdate(path, metadata);
  }
}
```

##### handleRemoteUpdate (conflict detection logic)

```typescript
private async handleRemoteUpdate(path: string, remote: FileMetadata): Promise<void> {
  const tracked = this.localState.get(path);
  const localData = await this.drive.get(path);

  // Case 1: File doesn't exist locally → just download
  if (!localData) {
    await this.downloadFile(path, remote);
    return;
  }

  const localHash = createHash("sha256").update(localData).digest("hex");

  // Case 2: Local file matches remote → already in sync
  if (localHash === remote.hash) {
    await this.localState.set(path, {
      lastSyncedHash: localHash,
      lastSyncedMtime: remote.mtime,
      lastManifestHash: remote.hash,
      lastManifestWriterKey: remote.writerKey,
    });
    return;
  }

  // Case 3: No tracking state → first sync, treat remote as authoritative
  if (!tracked) {
    await this.downloadFile(path, remote);
    return;
  }

  // Case 4: Check if this is a new remote version
  const remoteChanged = remote.hash !== tracked.lastManifestHash;
  const localChanged = localHash !== tracked.lastSyncedHash;

  if (remoteChanged && localChanged) {
    // CONFLICT: both sides changed
    await this.handleConflict(path, remote, localData);
  } else if (remoteChanged) {
    // Only remote changed → download
    await this.downloadFile(path, remote);
  }
  // If only local changed (or neither), do nothing — local upload will handle it
}
```

##### handleConflict

```typescript
private async handleConflict(
  path: string,
  remote: FileMetadata,
  localData: Buffer,
): Promise<void> {
  const localEntry = await this.drive.entry(path);
  const localMtime = localEntry?.mtime ?? 0;

  // Winner = highest mtime. Tie-break: remote wins (it's already in the manifest).
  const remoteWins = remote.mtime >= localMtime;

  // Build conflict copy filename
  const loserWriterKey = remoteWins
    ? this.fileStore.core.key.toString("hex")
    : remote.writerKey;
  const peerName = await this.getPeerName(loserWriterKey);
  const conflictPath = buildConflictPath(path, peerName);

  if (remoteWins) {
    // Save local version as conflict copy
    this.suppressedPaths.add(conflictPath);
    await this.drive.put(conflictPath, localData);

    // Download remote version to original path
    await this.downloadFile(path, remote);
  } else {
    // Local wins — download remote version as conflict copy
    const remoteData = await this.fetchRemoteFile(remote);
    this.suppressedPaths.add(conflictPath);
    await this.drive.put(conflictPath, remoteData);

    // Update state to reflect that we've seen this manifest version
    await this.localState.set(path, {
      lastSyncedHash: createHash("sha256").update(localData).digest("hex"),
      lastSyncedMtime: localMtime,
      lastManifestHash: remote.hash,
      lastManifestWriterKey: remote.writerKey,
    });
  }

  this.emit("sync", {
    direction: "remote-to-local",
    type: "conflict",
    path,
    conflictPath,
  } satisfies SyncEvent);
}
```

##### handleRemoteDeletion

```typescript
private async handleRemoteDeletion(path: string, tombstone: TombstoneMetadata): Promise<void> {
  const myWriterKey = this.fileStore.core.key.toString("hex");

  // Don't process our own tombstones
  if (tombstone.writerKey === myWriterKey) return;

  const tracked = this.localState.get(path);

  // If we have no record of this file, it's either already gone or never existed locally
  if (!tracked) return;

  // Check if local file was modified since last sync
  const localData = await this.drive.get(path);
  if (localData) {
    const localHash = createHash("sha256").update(localData).digest("hex");
    if (localHash !== tracked.lastSyncedHash) {
      // Local was modified — edit wins over delete (per PLAN.md)
      // Re-upload the local version
      // (The local change handler will pick this up, or we can trigger it explicitly)
      return;
    }
  }

  // Safe to delete: local file is unmodified since last sync
  if (localData) {
    this.suppressedPaths.add(path);
    await this.drive.del(path);
  }
  await this.localState.remove(path);

  this.emit("sync", {
    direction: "remote-to-local",
    type: "delete",
    path,
  } satisfies SyncEvent);
}
```

#### Helper: downloadFile

Extract the block-fetching + disk-writing logic into a reusable method:

```typescript
private async downloadFile(path: string, metadata: FileMetadata): Promise<void> {
  const data = await this.fetchRemoteFile(metadata);

  this.suppressedPaths.add(path);
  await this.drive.put(path, data);

  const hash = createHash("sha256").update(data).digest("hex");
  await this.localState.set(path, {
    lastSyncedHash: hash,
    lastSyncedMtime: metadata.mtime,
    lastManifestHash: metadata.hash,
    lastManifestWriterKey: metadata.writerKey,
  });
}

private async fetchRemoteFile(metadata: FileMetadata): Promise<Buffer> {
  const remoteCore = this.store.get({ key: Buffer.from(metadata.writerKey, "hex") });
  await remoteCore.ready();

  const blocks: Buffer[] = [];
  for (let i = 0; i < metadata.blocks.length; i++) {
    const block = await remoteCore.get(metadata.blocks.offset + i);
    if (!block) throw new Error(`Missing block ${metadata.blocks.offset + i}`);
    blocks.push(block);
  }
  return Buffer.concat(blocks);
}
```

#### Helper: buildConflictPath

```typescript
export function buildConflictPath(originalPath: string, peerName: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const lastDot = originalPath.lastIndexOf(".");
  const lastSlash = originalPath.lastIndexOf("/");

  // Dot must be after the last slash to be a real extension
  if (lastDot > lastSlash + 1) {
    const stem = originalPath.slice(0, lastDot);
    const ext = originalPath.slice(lastDot);
    return `${stem}.conflict-${date}-${peerName}${ext}`;
  }
  return `${originalPath}.conflict-${date}-${peerName}`;
}
```

Examples:
- `/readme.txt` → `/readme.conflict-2026-02-26-a1b2c3d4.txt`
- `/photos/cat.jpg` → `/photos/cat.conflict-2026-02-26-a1b2c3d4.jpg`
- `/Makefile` → `/Makefile.conflict-2026-02-26-a1b2c3d4`

#### Update SyncEvent

Add the `conflict` type and optional `conflictPath`:

```typescript
export interface SyncEvent {
  direction: "local-to-remote" | "remote-to-local";
  type: "update" | "delete" | "conflict";
  path: string;
  conflictPath?: string;
}
```

#### Update initialSync

The initial sync should also use local state tracking and conflict detection logic. After listing local files and uploading new/changed ones, call `handleRemoteChanges()` (which now handles tombstones and conflicts).

The initial sync should also record local state for each file it uploads.

### 5. Tests (`src/lib/sync-engine.test.ts`)

Add new test groups to the existing test file. Keep all existing tests passing — they should still work because the changes are additive (existing behavior is preserved, we're adding conflict/tombstone/deletion on top).

#### Test group: LocalStateStore

##### Test: state persists across load cycles

```
1. Create a LocalStateStore with a temp sync folder
2. Load it (creates empty state)
3. Set state for "/foo.txt"
4. Create a new LocalStateStore instance for the same folder
5. Load it
6. Assert: get("/foo.txt") returns the same state
```

##### Test: remove deletes state

```
1. Create and load a LocalStateStore
2. Set state for "/bar.txt"
3. Remove "/bar.txt"
4. Assert: get("/bar.txt") returns undefined
5. Reload from disk, still undefined
```

##### Test: ignores .pearsync/ paths in watcher

```
1. Create a SyncEngine, start it
2. Write a file to <syncFolder>/.pearsync/something
3. Wait briefly
4. Assert: no sync event fired, no manifest entry created
```

#### Test group: Tombstones

##### Test: local delete writes tombstone to manifest

```
1. Create a SyncEngine, write a file, wait for upload sync
2. Delete the file from disk
3. Wait for delete sync event
4. Read the manifest entry for that path
5. Assert: entry exists and is a tombstone ({ deleted: true, mtime, writerKey })
```

##### Test: tombstone replicates and deletes file on remote peer

```
1. Create two paired SyncEngines (A and B) via testnet
2. A writes a file → wait for B to download it
3. A deletes the file → tombstone written to manifest
4. Wait for B to receive the tombstone
5. Assert: file is deleted from B's folder
6. Assert: B emits a delete sync event
```

##### Test: edit wins over delete

```
1. Create two paired SyncEngines
2. A writes "original" → wait for B to download it
3. Simultaneously: A deletes the file, B modifies it to "edited"
   (To simulate: stop both engines, make the changes, restart both)
4. After sync settles:
   Assert: the file exists (edit wins)
   Assert: content is "edited"
```

#### Test group: Conflict detection

##### Test: simultaneous edits create conflict copy

```
1. Create two paired SyncEngines
2. A writes "/doc.txt" with "version A" → wait for B to download
3. Stop both engines (to simulate offline edits)
4. Write "A's edit" to A's /doc.txt
5. Write "B's edit" to B's /doc.txt
6. Start both engines
7. Wait for conflict event on at least one side
8. Assert: one of the files is the winner (highest mtime)
9. Assert: a .conflict-YYYY-MM-DD-<peerName>.txt file exists with the loser's content
```

##### Test: same content edits do not conflict

```
1. Create two paired SyncEngines
2. A writes "/same.txt" → wait for B to download
3. Stop both engines
4. Write IDENTICAL content to both A's and B's /same.txt (different mtime, same bytes)
5. Start both engines, wait for sync
6. Assert: no conflict event
7. Assert: no .conflict file
```

##### Test: conflict filename format

```
Unit test for buildConflictPath():
- "/readme.txt" with peer "a1b2c3d4" → "/readme.conflict-YYYY-MM-DD-a1b2c3d4.txt"
- "/photos/cat.jpg" with peer "deadbeef" → "/photos/cat.conflict-YYYY-MM-DD-deadbeef.jpg"
- "/Makefile" with peer "abc12345" → "/Makefile.conflict-YYYY-MM-DD-abc12345"
```

#### Test group: Peer names

##### Test: peer name is registered on startup

```
1. Create a SyncEngine, ready() + start()
2. Read __peer:<writerKey> from the manifest
3. Assert: entry exists and contains a name matching the first 8 chars of writerKey
```

##### Test: peer names are visible to remote peer

```
1. Create two paired SyncEngines
2. After sync settles, engine B reads __peer:<A's writerKey> from the manifest
3. Assert: entry exists
```

#### Test group: Deletion propagation

##### Test: remote deletion of unmodified file removes it locally

```
1. Single SyncEngine: upload a file, record its hash in local state
2. Write a tombstone to the manifest for that path (simulating remote delete)
3. Trigger remote change handler
4. Assert: file is deleted from disk
5. Assert: local state entry is removed
```

##### Test: remote deletion of locally-modified file does NOT delete

```
1. Single SyncEngine: upload a file, record state
2. Modify the file locally (different content)
3. Write a tombstone to the manifest (simulating remote delete)
4. Trigger remote change handler
5. Assert: file still exists on disk (edit wins over delete)
```

##### Test: new local file not in manifest is uploaded, not deleted

```
1. Create a SyncEngine with an empty manifest
2. Write a new file to the sync folder
3. Wait for sync
4. Assert: file is uploaded to manifest (not treated as "remotely deleted")
```

### 6. Keeping existing tests passing

The changes to `ManifestStore` (adding `ManifestValue` union type, `putTombstone()`) and `SyncEngine` (adding `LocalStateStore`, conflict logic) must not break existing tests.

Key compatibility notes:

- `ManifestStore.get()` now returns `ManifestValue | null`. Existing code that expects `FileMetadata` needs type narrowing (use `!isTombstone(value)`). The existing Layer 4 tests should still pass because they never write tombstones — all manifest values will be `FileMetadata`.
- `SyncEvent.type` now includes `"conflict"`. Existing tests that check for `"update"` or `"delete"` are unaffected.
- The LocalStateStore's `.pearsync/` directory will be created inside sync folders during tests. The watcher skip logic prevents it from interfering with existing test assertions.

## Important Technical Notes

### Conflict detection window

There is no time-based "window" for conflicts. A conflict is defined structurally:
- Local file hash differs from last synced hash (local changed)
- Manifest hash differs from last recorded manifest hash (remote changed)
- The two hashes are different (they didn't converge to the same content)

This works whether the edits were 1ms apart or 1 hour apart.

### Conflict copies are regular files

Conflict copies (`.conflict-*`) are just regular files in the sync folder. They will be detected by the watcher and uploaded to the manifest like any other file. This is intentional — the conflict copy will sync to all peers so everyone sees both versions.

### Tombstone garbage collection

Tombstones accumulate in the manifest over time. For now, don't implement GC — just leave them. This is a future optimization. The number of tombstones in normal usage is small.

### Atomic state writes

The LocalStateStore must write atomically (write to temp file, rename). If the process crashes mid-write, a corrupted state file could cause incorrect conflict detection. Atomic rename prevents this.

### Race conditions in handleRemoteChanges

`handleRemoteChanges()` iterates all manifest entries. If a local change happens concurrently (the watcher fires while we're processing), we could read stale data. This is acceptable — the next `handleRemoteChanges()` call will correct it. Don't add locking; keep it simple.

### The `.pearsync/` directory

- Created inside the sync folder: `<syncFolder>/.pearsync/`
- Contains `state.json`
- Must be ignored by the watcher (skip paths starting with `/.pearsync/`)
- Should NOT be uploaded to the manifest
- Future layers may add more files here (e.g., config)

### Peer name collisions

Two peers could have writer keys that start with the same 8 hex chars. This is astronomically unlikely (1 in 4 billion). If it happens, the conflict filenames would be ambiguous but still functional. Not worth over-engineering.

## Development Workflow

1. Read `CLAUDE.md` for project conventions
2. Read `src/lib/sync-engine.ts` and `src/lib/manifest-store.ts` — you'll be modifying both
3. Read `src/lib/sync-engine.test.ts` — understand existing tests before adding new ones
4. Build `LocalStateStore` first — it's self-contained and testable in isolation
5. Update `ManifestStore` with tombstone support
6. Update `SyncEngine` with conflict detection, tombstone handling, deletion propagation, and peer names
7. Write tests incrementally — test each piece as you build it
8. Run `npx tsc --noEmit && npx biome check --write . && npx vitest run` — everything must pass
9. Commit the work

## Success Criteria

- `LocalStateStore` persists per-file sync state to `<syncFolder>/.pearsync/state.json`
- Tombstone entries replace `manifest.remove()` for file deletions
- Peer names are registered as `__peer:<writerKey>` manifest entries
- Conflict detection: when both peers modify the same file, a `.conflict-YYYY-MM-DD-peerName.ext` copy is created
- Winner selection: highest mtime wins, tie goes to remote
- Delete vs edit: edit wins — if one peer deleted and another edited, the file is kept
- Remote deletion: tombstone propagates and deletes unmodified local files
- New local files (not in manifest, not in local state) are uploaded, not deleted
- `.pearsync/` paths are ignored by the watcher
- `__` manifest keys are filtered from file sync logic
- All new tests pass
- All existing tests still pass
- `npx tsc --noEmit && npx biome check --write . && npx vitest run` is green
