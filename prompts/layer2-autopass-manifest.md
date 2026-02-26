# Layer 2: Autopass Manifest

## Context

You are working on PearSync, a P2P folder sync tool built on the Holepunch stack. Read `PLAN.md` for the full architecture. Read `CLAUDE.md` for development guidelines.

This is Layer 2. Layer 1 (Hypercore File Storage) is complete — see `src/lib/file-store.ts` and its tests. Now we need to validate that we can use Autopass as a multi-writer manifest to store file metadata entries, and that two paired Autopass instances can sync entries between each other.

## Background: What is Autopass?

Autopass is a distributed key-value store built on Autobase (multi-writer) + HyperDB (indexed views) + Hyperswarm (P2P networking). It was originally designed as a password manager, but we're repurposing it as our file metadata manifest.

Key properties:
- **Multi-writer**: Multiple peers can write to the same database
- **Automatic replication**: Creates its own Hyperswarm, replicates on peer connections
- **Pairing**: Invite-based — one instance creates an invite code, another pairs with it
- **CRUD**: `add(key, value)`, `get(key)`, `remove(key)`, `list()` for records
- **Events**: Emits `'update'` when the database changes (local or remote)

## Reference Code

- `reference/autopass/index.js` — Full Autopass source (~411 lines). Read this carefully.
- `reference/autopass/test.js` — Official tests showing create, pair, add, get patterns
- `reference/autopass/example.mjs` — Simple usage example
- `reference/autopass/README.md` — API documentation
- `reference/autopass/schema.js` — HyperDB schema definitions (records have `key: string, value: string, file?: Buffer`)
- `node_modules/autopass/` — Installed version (same as reference)

## Autopass API Reference

This is the exact API from reading the source. Do NOT guess — use these signatures.

### Constructor & Lifecycle

```javascript
// Create new vault
const pass = new Autopass(corestore, opts?)
// opts: { replicate?: boolean, bootstrap?: Array, swarm?: Hyperswarm, ... }

await pass.ready()   // MUST call before any operations
await pass.close()   // Cleanup all resources
```

### CRUD Operations

```javascript
// Add/update an entry (key and value are both strings)
await pass.add(key: string, value: string, file?: Buffer)
// file is optional, must be < 6MB

// Get a single entry
const entry = await pass.get(key: string)
// Returns: { value: string, file: Buffer | null } or null if not found
// NOTE: does NOT include `key` in the return value

// List all entries — returns a STREAM, not an array
const stream = pass.list()
// Each entry: { key: string, value: string, file: Buffer | null }
// Use: for await (const entry of pass.list()) { ... }
// Or:  pass.list().on('data', (entry) => { ... })
// Or:  const entries = await pass.list().toArray()

// Remove an entry
await pass.remove(key: string)
```

### Events

```javascript
pass.on('update', () => {
  // Fired when database changes (local add/remove OR remote replication)
  // No arguments passed to callback
})
```

### Pairing

```javascript
// On instance A: create invite
const inviteCode = await pass.createInvite()  // z32-encoded string, ~106 chars
// Optional: await pass.createInvite({ readOnly: true })

// On instance B: pair with invite
const pairer = Autopass.pair(corestore, inviteCode, opts?)
// opts: same as constructor (bootstrap, etc.)
const pairedPass = await pairer.finished()  // resolves when pairing complete
await pairedPass.ready()
```

### Properties

```javascript
pass.writerKey   // Buffer — local peer's signing key
pass.writable    // boolean — can this peer write?
pass.key         // Buffer — vault's shared key
pass.store       // Corestore — underlying storage
pass.base        // Autobase — underlying multi-writer base
```

### Critical Detail: Networking

Autopass creates its own Hyperswarm internally (unless `replicate: false`). When two instances pair, they discover each other via the swarm and replicate automatically. For tests that need two instances to actually communicate, you MUST use `hyperdht/testnet` to create a local test network:

```javascript
const testnet = require('hyperdht/testnet')  // or import
const tn = await testnet(10, t)  // 10 bootstrap nodes
// Pass tn.bootstrap to both Autopass instances
const a = new Autopass(storeA, { bootstrap: tn.bootstrap })
const b_pairer = Autopass.pair(storeB, invite, { bootstrap: tn.bootstrap })
```

Without `testnet`, the two instances will try to find each other on the real DHT and fail in tests.

For tests that only test local CRUD (no replication), use `{ replicate: false }` to skip swarm creation entirely — these tests will be faster.

## What to Build

Build a `ManifestStore` class in `src/lib/manifest-store.ts` that wraps Autopass with our file metadata schema.

1. Takes a Corestore instance and options
2. Creates/opens an Autopass vault
3. Can store file metadata entries (path → FileMetadata JSON)
4. Can retrieve, list, and remove entries
5. Emits `'update'` events when the manifest changes
6. Provides a pairing workflow (create invite, pair with invite)

### API Sketch

```typescript
import { EventEmitter } from "node:events";

interface FileMetadata {
  size: number;        // total bytes
  mtime: number;       // ms since epoch
  hash: string;        // sha256 hex of content
  writerKey: string;   // hex of the Hypercore key holding the bytes
  blocks: {
    offset: number;    // starting block index
    length: number;    // number of blocks
  };
}

interface ManifestEntry {
  path: string;        // normalized path e.g. "/docs/readme.txt"
  metadata: FileMetadata;
}

interface ManifestStoreOptions {
  replicate?: boolean;    // default true; set false for unit tests
  bootstrap?: unknown[];  // DHT bootstrap nodes (for testnet)
}

class ManifestStore extends EventEmitter {
  constructor(store: Corestore, options?: ManifestStoreOptions)

  async ready(): Promise<void>
  async close(): Promise<void>

  // CRUD
  async put(path: string, metadata: FileMetadata): Promise<void>
  async get(path: string): Promise<FileMetadata | null>
  async list(): Promise<ManifestEntry[]>
  async remove(path: string): Promise<void>

  // Pairing
  async createInvite(): Promise<string>
  static async pair(store: Corestore, invite: string, options?: ManifestStoreOptions): Promise<ManifestStore>

  // Properties
  get writerKey(): string   // hex-encoded
  get writable(): boolean
}
```

The `put` method calls `autopass.add(path, JSON.stringify(metadata))`. The `get` method calls `autopass.get(path)` and parses the JSON. The `list` method collects all entries from `autopass.list()` stream, parsing each value. The `static pair` method wraps `Autopass.pair()`.

## What to Test

Write comprehensive tests in `src/lib/manifest-store.test.ts`. Tests should use temp directories for Corestore storage, cleaned up in afterEach.

### CRUD tests (use `replicate: false` — fast, no networking):

- `put` a file entry, `get` it back, metadata matches
- `put` multiple entries, `list` returns all of them
- `get` a non-existent path returns null
- `remove` an entry, `get` returns null after removal
- `list` after removal excludes the removed entry
- `put` the same path twice (update), `get` returns the latest metadata
- Paths are stored as-is (no normalization in ManifestStore — caller normalizes)

### Event tests (use `replicate: false`):

- `'update'` event fires after `put`
- `'update'` event fires after `remove`

### Pairing & replication tests (use testnet — these are the critical ones):

**IMPORTANT**: These tests require `hyperdht/testnet` for local DHT bootstrap. The pattern is:

```typescript
import testnet from "hyperdht/testnet";

const tn = await testnet(10);  // returns { bootstrap, nodes }
// Pass tn.bootstrap to ManifestStore options
// In afterEach: destroy all tn.nodes and close the testnet
```

You will need to add a type declaration for `hyperdht/testnet` in `src/types/holepunch.d.ts`. The signature is:
```typescript
declare module "hyperdht/testnet" {
  interface TestnetResult {
    bootstrap: { host: string; port: number }[];
    nodes: { destroy(): Promise<void> }[];
  }
  function testnet(size: number): Promise<TestnetResult>;
  export = testnet;
}
```

Tests:
- Instance A creates vault, creates invite. Instance B pairs with invite. Both see `writable === true` and `base.system.members === 2`.
- Instance A puts an entry → Instance B receives `'update'` event and can `get` the same entry
- Instance B puts an entry → Instance A can `get` it (bidirectional)
- Instance A puts multiple entries → Instance B can `list` all of them
- Instance A removes an entry → Instance B sees it removed after update

### Waiting for replication

Replication is async. After A puts an entry, you need to wait for B's `'update'` event before reading from B. Use a helper like:

```typescript
function waitForUpdate(manifest: ManifestStore): Promise<void> {
  return new Promise((resolve) => manifest.once('update', resolve));
}

// Usage:
const updatePromise = waitForUpdate(storeB);
await storeA.put('/file.txt', metadata);
await updatePromise;
const entry = await storeB.get('/file.txt');
```

### Edge cases:

- Large JSON metadata value (many fields, long strings)
- Special characters in path (`/foo bar/baz.txt`, `/émoji/🎉.txt`)
- Empty list on fresh instance

## Important Technical Notes

- **Autopass values are strings**: `add(key, value)` takes `(string, string)`. We JSON.stringify the FileMetadata for storage and JSON.parse it on retrieval.
- **`list()` returns a stream**: Use `await pass.list().toArray()` or `for await` to collect entries. Do NOT treat it as an array.
- **`get()` return shape**: Returns `{ value, file }` (no `key` field) or `null`. The `value` is a string that you JSON.parse.
- **Testnet cleanup**: You MUST destroy all testnet nodes in afterEach/afterAll, or the test process will hang. Pattern: `for (const node of tn.nodes) await node.destroy()`.
- **Pairing takes time**: `pair.finished()` is a promise that resolves when the handshake completes. This can take a few seconds in tests. The 30-second vitest timeout should be sufficient.
- **Type declarations**: Autopass has no TypeScript types. Add a declaration for `"autopass"` in `src/types/holepunch.d.ts` alongside the existing `"corestore"` declaration. Declare the class, static `pair` method, and key properties/methods.
- **ES modules**: The project uses `"type": "module"`. Autopass is CJS but can be default-imported in ESM: `import Autopass from "autopass"`.
- **The `store` property**: `pass.store` gives you the Corestore. This is how the sync engine will access the same Corestore for FileStore operations — both ManifestStore and FileStore share the same Corestore.
- **`base.system.members`**: To check member count after pairing, access `pass.base.system.members`. This is useful in assertions but requires Autobase internals — only use it in tests, not in production code.
- **Autopass creates its own Hyperswarm** when `replicate !== false`. Calling `store.replicate(connection)` happens inside Autopass automatically on every swarm connection. This means ALL Hypercores in the Corestore (including our FileStore cores) get replicated for free when Autopass connects to a peer.

## Development Workflow

1. Read `CLAUDE.md` for project conventions
2. Read `reference/autopass/index.js` to understand the full implementation
3. Read `reference/autopass/test.js` to see test patterns (especially pairing with testnet)
4. Add type declarations for `autopass` and `hyperdht/testnet` to `src/types/holepunch.d.ts`
5. Write the `ManifestStore` class
6. Write comprehensive tests
7. Run `npm run check` (tsc + biome + vitest) — everything must pass
8. Commit the work

## Success Criteria

- `ManifestStore` class with clean TypeScript types
- All tests pass (`npm run check` is green)
- CRUD tests work with `replicate: false` (fast, no networking)
- Pairing + replication tests prove that entries written on one instance appear on the paired instance
- Events fire correctly for both local and remote mutations
- Code follows existing project conventions (see `src/lib/file-store.ts` for style reference)
- No test flakiness — use proper `waitForUpdate` patterns for replication tests
