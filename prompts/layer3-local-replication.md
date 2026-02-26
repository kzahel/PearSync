# Layer 3: Local Replication (Integration Tests)

## Context

You are working on PearSync, a P2P folder sync tool built on the Holepunch stack. Read `PLAN.md` for the full architecture. Read `CLAUDE.md` for development guidelines.

This is Layer 3. Layer 1 (FileStore — chunked file storage on Hypercores) and Layer 2 (ManifestStore — Autopass-backed file metadata CRUD + pairing) are both complete. Now we need to prove the critical integration: when two peers pair via ManifestStore and one writes a file, the other peer can read the actual file bytes from the writer's Hypercore — not just the manifest metadata, but the raw file content.

This layer has **no new production code**. It is purely integration tests that exercise FileStore + ManifestStore + Autopass networking together.

## What Already Exists

### FileStore (`src/lib/file-store.ts`)

Chunks files into a named Hypercore and reads them back.

```typescript
import { FileStore, StoredFile } from "./file-store";

interface StoredFile {
  offset: number;   // starting block index in the Hypercore
  length: number;   // number of blocks
  size: number;     // total bytes
  hash: string;     // sha256 hex of content
}

// Create — takes a Corestore, opens a named Hypercore internally
const fileStore = new FileStore(store, { name: "file-data", blockSize: 65536 });
await fileStore.ready();

// Write — chunks data into 64KB blocks, appends to core
const stored: StoredFile = await fileStore.writeFile(Buffer.from("hello"));
// stored = { offset: 0, length: 1, size: 5, hash: "2cf24d..." }

// Read — reconstructs file from blocks
const data: Buffer = await fileStore.readFile(stored.offset, stored.length);

// Key — the underlying Hypercore's public key (needed for remote access)
fileStore.core.key  // Buffer, 32 bytes

await fileStore.close();
```

### ManifestStore (`src/lib/manifest-store.ts`)

Wraps Autopass as a typed key-value store for file metadata. Handles pairing and P2P replication.

```typescript
import { ManifestStore, FileMetadata, ManifestEntry } from "./manifest-store";

interface FileMetadata {
  size: number;        // total bytes
  mtime: number;       // ms since epoch
  hash: string;        // sha256 hex of content
  writerKey: string;   // hex of the Hypercore key holding the file bytes
  blocks: {
    offset: number;    // starting block index
    length: number;    // number of blocks
  };
}

interface ManifestEntry {
  path: string;
  metadata: FileMetadata;
}

// Create — uses static factory (NOT `new`), takes Corestore + options
const manifest = ManifestStore.create(store, {
  replicate: true,           // default; set false for non-networked tests
  bootstrap: tn.bootstrap,   // testnet bootstrap nodes
});
await manifest.ready();

// CRUD
await manifest.put("/path/to/file.txt", metadata);
const meta: FileMetadata | null = await manifest.get("/path/to/file.txt");
const all: ManifestEntry[] = await manifest.list();
await manifest.remove("/path/to/file.txt");

// Pairing
const invite: string = await manifest.createInvite();
const paired = await ManifestStore.pair(otherStore, invite, { bootstrap });

// Properties
manifest.writerKey   // string, hex-encoded — this peer's Autopass writer key
manifest.writable    // boolean
manifest.autopass    // underlying Autopass instance (for test assertions)

// Events
manifest.on('update', () => { /* manifest changed (local or remote) */ });

await manifest.close();
```

### Type declarations (`src/types/holepunch.d.ts`)

Already contains declarations for `corestore`, `autopass`, and `hyperdht/testnet`. No additions needed for this layer.

## The Key Mechanism: Why File Blocks Replicate for Free

This is the most important thing to understand for these tests.

When Autopass creates its Hyperswarm and a peer connects, it runs:

```javascript
// reference/autopass/index.js, line 326
this.swarm.on('connection', (connection, peerInfo) => {
  this.base.replicate(connection)
})
```

`this.base.replicate(connection)` replicates the Autobase multi-writer ledger, but the Autobase shares the same **Corestore** that our FileStore uses. When a Corestore replication session is active, **ALL Hypercores in the store** get replicated — including our FileStore's named `"file-data"` core.

This means:
1. Peer A creates a FileStore on `storeA`, writes a file to it
2. Peer A creates a ManifestStore on the same `storeA` (with `replicate: true` + testnet bootstrap)
3. Peer B pairs with A — Autopass opens a Hyperswarm connection and calls `base.replicate(connection)`
4. That connection now replicates ALL of storeA's cores to storeB — including A's file data Hypercore
5. On Peer B, `storeB.get({ key: fileStoreA.core.key })` opens a read-only replica of A's file core
6. B can read blocks from that core — the bytes are there because they replicated via step 4

**Critical detail**: On the remote side, you open the core by **key** (not by name). Names are local — derived from `store.primaryKey + name`. Different stores have different primary keys, so the same name gives different cores. You must use:

```typescript
// On peer B, open A's core by its public key:
const remoteCore = storeB.get({ key: Buffer.from(metadata.writerKey, 'hex') });
await remoteCore.ready();
const block = await remoteCore.get(metadata.blocks.offset);  // fetched via replication
```

## What to Build

Write integration tests in `src/lib/replication.test.ts`. These tests pair two ManifestStore instances via testnet, write files through FileStore, publish metadata through ManifestStore, and verify the remote peer can read the actual file bytes.

No new production classes. Just tests.

## What to Test

All tests use `hyperdht/testnet` for local networking. Follow the patterns established in `src/lib/manifest-store.test.ts`.

### Test setup pattern

Every replication test needs:

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Corestore from "corestore";
import testnet from "hyperdht/testnet";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "./file-store";
import { ManifestStore } from "./manifest-store";
import type { FileMetadata } from "./manifest-store";

// Temp directory management (same pattern as other test files)
let tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pearsync-repl-test-"));
  tmpDirs.push(dir);
  return dir;
}

// Wait for a condition on update events (proven pattern from manifest-store.test.ts)
function waitUntil(manifest: ManifestStore, condition: () => Promise<boolean>): Promise<void> {
  return new Promise((resolve) => {
    const check = async () => {
      if (await condition()) {
        manifest.removeListener("update", check);
        resolve();
      }
    };
    manifest.on("update", check);
    check();
  });
}
```

### Pairing + setup helper

Each test needs to pair two instances and wait for stability. Extract a helper:

```typescript
async function createPairedStores(bootstrap: { host: string; port: number }[]) {
  const storeA = new Corestore(await makeTmpDir());
  const manifestA = ManifestStore.create(storeA, { bootstrap });
  await manifestA.ready();

  const invite = await manifestA.createInvite();

  const storeB = new Corestore(await makeTmpDir());
  const manifestB = await ManifestStore.pair(storeB, invite, { bootstrap });

  // Wait for pairing to stabilize (both sides see 2 members)
  await Promise.all([
    new Promise<void>((resolve) => {
      const check = () => {
        if (manifestA.autopass.base.system.members === 2) {
          manifestA.removeListener("update", check);
          resolve();
        }
      };
      if (manifestA.autopass.base.system.members === 2) return resolve();
      manifestA.on("update", check);
    }),
    new Promise<void>((resolve) => {
      const check = () => {
        if (manifestB.autopass.base.system.members === 2) {
          manifestB.removeListener("update", check);
          resolve();
        }
      };
      if (manifestB.autopass.base.system.members === 2) return resolve();
      manifestB.on("update", check);
    }),
  ]);

  const fileStoreA = new FileStore(storeA);
  await fileStoreA.ready();

  const fileStoreB = new FileStore(storeB);
  await fileStoreB.ready();

  return { storeA, storeB, manifestA, manifestB, fileStoreA, fileStoreB };
}
```

### Cleanup

```typescript
let tn: Awaited<ReturnType<typeof testnet>>;

afterEach(async () => {
  if (tn) {
    for (const node of tn.nodes) await node.destroy();
  }
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});
```

**IMPORTANT cleanup order**: Destroy testnet nodes FIRST, then remove temp dirs. If you remove temp dirs while Hyperswarm is still running, you may get ENOENT errors.

### Test 1: A writes file → B reads file bytes via manifest metadata

The core integration test. This is the whole point of Layer 3.

1. Pair A and B
2. A writes a file to its FileStore → gets `StoredFile` back
3. A puts a manifest entry with the file metadata (including `fileStoreA.core.key` as `writerKey`)
4. B receives the manifest update (use `waitUntil`)
5. B reads the manifest entry, extracts `writerKey` and `blocks`
6. B opens A's Hypercore by key: `storeB.get({ key: Buffer.from(writerKey, 'hex') })`
7. B reads blocks from that core
8. **Assert**: bytes match the original file content

### Test 2: Bidirectional — B writes file → A reads bytes

Same as Test 1 but B writes and A reads. Proves both peers are full writers.

1. Pair A and B (wait for `b.writable === true`)
2. B writes a file to its FileStore
3. B puts a manifest entry
4. A receives the update
5. A opens B's core by key on storeA
6. A reads the blocks
7. **Assert**: bytes match

### Test 3: Multiple files replicate

1. Pair A and B
2. A writes 3 files to FileStore, puts 3 manifest entries
3. B receives all 3 entries (wait for `list().length === 3`)
4. B reads each file's blocks from A's core
5. **Assert**: all 3 files' bytes match originals

### Test 4: Large file replication

1. Pair A and B
2. A writes a large file (e.g. 1MB — many blocks) to FileStore
3. A puts the manifest entry
4. B receives the update
5. B reads all blocks from A's core
6. **Assert**: reassembled bytes match original, hash matches

Use 1MB not 10MB to keep test runtime reasonable (Autopass swarm replication is slower than direct pipe replication in Layer 1 tests).

### Test 5: Both peers write files, both can read each other's

Full bidirectional multi-file test.

1. Pair A and B
2. A writes fileX to its FileStore → puts manifest entry `/x.txt`
3. B writes fileY to its FileStore → puts manifest entry `/y.txt`
4. Wait for both sides to see both entries
5. B reads A's fileX bytes by opening A's core by key
6. A reads B's fileY bytes by opening B's core by key
7. **Assert**: both files' bytes match originals

### Test 6: File blocks persist after manifest entry removal

Proves that removing a manifest entry doesn't delete the underlying Hypercore blocks (they're append-only).

1. Pair A and B
2. A writes a file, puts manifest entry
3. B receives the entry, reads the file bytes (save them)
4. A removes the manifest entry
5. B sees the removal
6. B can still read the file blocks from A's core (the blocks are still there)
7. **Assert**: bytes still match

## Important Technical Notes

### FileStore core key as writerKey

When building the `FileMetadata` for a manifest entry, the `writerKey` should be the hex encoding of the FileStore's Hypercore key:

```typescript
const stored = await fileStoreA.writeFile(data);
const metadata: FileMetadata = {
  size: stored.size,
  mtime: Date.now(),
  hash: stored.hash,
  writerKey: fileStoreA.core.key.toString("hex"),
  blocks: {
    offset: stored.offset,
    length: stored.length,
  },
};
await manifestA.put("/file.txt", metadata);
```

### Reading remote blocks

On the remote side, open the core by key and read blocks:

```typescript
const entry = await manifestB.get("/file.txt");
const remoteCore = storeB.get({ key: Buffer.from(entry.writerKey, 'hex') });
await remoteCore.ready();

const blocks: Buffer[] = [];
for (let i = 0; i < entry.blocks.length; i++) {
  const block = await remoteCore.get(entry.blocks.offset + i);
  blocks.push(block!);
}
const fileData = Buffer.concat(blocks);
```

The `remoteCore.get(index)` call will **block** until the block is replicated from the remote peer. Since Autopass's Hyperswarm is already connected and replicating, this should resolve quickly. The default Hypercore `get` timeout is 0 (wait forever), which is fine under the 30s vitest test timeout.

### waitUntil pattern is mandatory for replication tests

Never assume a single `update` event means data is available. Autobase fires multiple intermediate update events during linearization. Always use the `waitUntil` helper that re-checks the condition on each update:

```typescript
await waitUntil(manifestB, async () => (await manifestB.get("/file.txt")) !== null);
```

### Shared Corestore — both FileStore and ManifestStore use the same one

In each peer, create ONE Corestore and pass it to both FileStore and ManifestStore:

```typescript
const store = new Corestore(await makeTmpDir());
const fileStore = new FileStore(store);       // opens core named "file-data"
const manifest = ManifestStore.create(store); // creates Autopass on same store
```

This is essential — the replication only works because they share the same Corestore. If you create separate Corestores, the FileStore's core won't replicate through Autopass's swarm.

### FileStore default name collision

Both peers create a FileStore with the default name `"file-data"`. This is fine — the name is combined with each store's unique `primaryKey` to derive the Hypercore key. Each peer's `"file-data"` core has a different key. On the remote side, you always open by key, not by name.

### Test timeout

Replication tests with testnet take a few seconds each. The 30s vitest timeout (`vitest.config.ts`) should be sufficient. If any test approaches 30s, it's likely a bug (hung replication, missing cleanup).

### Autobase update event latency

From Layer 2 experience: Autobase `remove` operations can trigger slow linearization (~17s) in local-only mode. In replication mode with testnet this is usually faster, but be aware that `waitUntil` may take several seconds for some operations.

### Cleanup matters

If you don't destroy testnet nodes, the test process will hang. If you don't close ManifestStores (which closes their Hyperswarm), you'll get dangling connections. Close order:

```typescript
await fileStoreA.close();
await fileStoreB.close();
await manifestA.close();
await manifestB.close();
await storeA.close();
await storeB.close();
// testnet nodes destroyed in afterEach
```

## Development Workflow

1. Read `CLAUDE.md` for project conventions
2. Read `src/lib/file-store.ts` and `src/lib/manifest-store.ts` to understand the APIs
3. Read `src/lib/manifest-store.test.ts` for testnet pairing patterns (especially the `waitUntil` helper and pairing stabilization)
4. Write the integration tests in `src/lib/replication.test.ts`
5. Run `npm run check` (tsc + biome + vitest) — everything must pass
6. Commit the work

## Success Criteria

- All integration tests pass (`npm run check` is green)
- Test 1 proves: A writes file bytes → puts manifest entry → B reads manifest → B opens A's core by key → B reads file bytes → bytes match
- Test 2 proves bidirectional (B writes → A reads bytes)
- Tests are not flaky — use `waitUntil` patterns, not single `waitForUpdate`
- No new production code — just tests in `src/lib/replication.test.ts`
- Existing tests still pass (file-store, manifest-store)
- Code follows project conventions (see `src/lib/manifest-store.test.ts` for style reference)
