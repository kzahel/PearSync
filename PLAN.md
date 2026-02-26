# PearSync — P2P Folder Sync

## What

A peer-to-peer folder sync tool built on the Holepunch stack. Like Syncthing or Dropbox, but fully decentralized — no servers, no accounts, no cloud.

You pick a folder. You pair with another device. The folders stay in sync.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        PearSync UI                           │
│  File browser, sync status, peer list, conflict resolution   │
├──────────────────────────────────────────────────────────────┤
│                      Sync Engine                             │
│  Folder watcher → diff → chunk → replicate → materialize    │
├─────────────────────┬────────────────────────────────────────┤
│  Autopass           │  Per-Peer Hypercores                   │
│  (manifest + ACL)   │  (file content)                        │
│                     │                                        │
│  Multi-writer via   │  Single-writer each,                   │
│  Autobase.          │  read-only replicas                    │
│  Stores file        │  on other peers.                       │
│  metadata entries.  │  Chunked file bytes.                   │
│  Handles pairing    │                                        │
│  and invites.       │  All replicate through                 │
│                     │  the shared Corestore.                 │
├─────────────────────┴────────────────────────────────────────┤
│  Corestore (shared storage, RocksDB)                         │
│  Hyperswarm (P2P discovery, NAT holepunching, encryption)    │
└──────────────────────────────────────────────────────────────┘
```

## Data Model

### Manifest (Autopass entries)

Each synced file is an Autopass entry:

```
key:   "/path/relative/to/sync-root.txt"
value: JSON({
  size:      Number,       // bytes
  mtime:     Number,       // ms since epoch, from source filesystem
  hash:      String,       // sha256 hex of file contents
  writerKey: String,       // hex of the Hypercore key that holds the bytes
  blocks: {
    offset:  Number,       // starting block index in the writer's core
    length:  Number        // number of blocks
  }
})
```

Special entries:
- `__config` — sync folder path, peer name, settings
- `__peer:<writerKeyHex>` — peer metadata (name, last seen, etc.)

### File Content (per-peer Hypercores)

Each peer creates a named Hypercore in the shared Corestore:
```js
const core = store.get({ name: 'file-data' })
```

Files are chunked (e.g. 64KB blocks) and appended sequentially. The manifest entry's `blocks.offset` and `blocks.length` tell you where in the core to find the file's chunks.

When a file is updated, the new version is appended (old blocks are not overwritten — append-only). GC can reclaim old blocks once all peers have the latest version.

### Conflict Resolution

- **No conflict**: Only one peer modified the file since last sync → fast-forward.
- **Conflict**: Multiple peers modified the same file → keep the newest mtime as the winner, save the loser as `filename.conflict-YYYY-MM-DD-peerName.ext`.
- **Delete vs edit**: If one peer deleted and another edited, the edit wins (re-creates the file). The delete is recorded as a tombstone.
- **Same content**: If both peers wrote the same hash, no conflict regardless of mtime.

## Replication

All Hypercores live in the same Corestore. Autopass manages its own Hyperswarm and calls `store.replicate(connection)` on each peer connection. This replicates ALL cores in the store — including our per-peer file data cores — for free.

No separate swarm needed. We piggyback on Autopass's networking.

Flow:
1. Peer A modifies a file locally
2. Sync engine chunks the file, appends to A's Hypercore
3. Sync engine calls `autopass.add(path, metadata)` to update the manifest
4. Autopass replicates the manifest entry to Peer B
5. Peer B receives `autopass.on('update')` → sees new/changed file in manifest
6. Peer B reads the blocks from Peer A's core (replicated via Corestore)
7. Peer B writes the file to its local sync folder
8. Peer B suppresses its own watcher to avoid a feedback loop

## Testing Phases

### Phase 1: Hypercore File Storage

Validate that we can chunk a file into a Hypercore and reconstruct it.

- Create a Corestore, get a named Hypercore
- Chunk a file (64KB blocks), append each chunk
- Read blocks back, reassemble, verify bytes match original
- Test with small files (< one block) and large files (multi-block)

### Phase 2: Autopass Manifest

Validate Autopass CRUD for file metadata.

- Create an Autopass instance
- `add(path, jsonMetadata)` for several files
- `list()` and verify all entries come back
- `get(path)` and verify specific entry
- `remove(path)` and verify it's gone
- Verify `on('update')` fires for each mutation

### Phase 3: Local Replication

Validate two Autopass instances can pair and sync on the same machine.

- Instance A: create vault, create invite
- Instance B: pair with invite
- A adds a manifest entry → B receives it via `on('update')`
- Verify B can read A's Hypercore blocks through the shared replication
- Test bidirectional: B adds an entry → A sees it

### Phase 4: Folder Watching

Validate watch-drive detects filesystem changes.

- Create a Localdrive pointed at a temp folder
- Watch it with watch-drive
- Create a file → watcher emits `{ type: 'update', key: '/file.txt' }`
- Modify the file → watcher emits update
- Delete the file → watcher emits `{ type: 'delete', key: '/file.txt' }`
- Verify debounce behavior (rapid writes don't flood events)

### Phase 5: Full Round-Trip

End-to-end test on one machine with two instances.

- Instance A watches folder `/tmp/sync-a/`
- Instance B watches folder `/tmp/sync-b/`
- Drop a file in `/tmp/sync-a/test.txt`
- Verify `/tmp/sync-b/test.txt` appears with identical contents
- Modify on B → verify A gets the update
- Delete on A → verify B removes it
- Simultaneous edit → verify conflict copy created

### Phase 6: Pear UI

Wrap the sync engine in a Pear desktop app.

- Setup screen: create vault / join via invite
- Folder picker: select sync directory
- File browser: list synced files with status icons
- Status bar: sync state, peer count
- Activity log: recent sync events, conflicts
- Pairing modal: generate/enter invite codes

## Key Dependencies

| Package | What it does | Layer |
|---------|-------------|-------|
| `autopass` | Multi-writer manifest, pairing, ACL | Manifest |
| `corestore` | Manages all Hypercores, RocksDB storage | Storage |
| `hypercore` | Append-only signed log (transitive dep) | Storage |
| `hyperswarm` | P2P discovery + NAT holepunching (transitive dep) | Network |
| `localdrive` | Maps local folder to Hyperdrive-compatible API | Watching |
| `watch-drive` | Detects changes in a drive | Watching |
| `mirror-drive` | Syncs between two drives (may use for initial sync) | Sync |
| `hyperdrive` | High-level file system on Hypercore (may use for convenience) | Sync |
| `bare-fs` | Filesystem ops in Pear runtime | Util |
| `bare-path` | Path ops in Pear runtime | Util |
| `pear-bridge` | Main↔renderer IPC | UI |
| `pear-electron` | Desktop runtime shell | UI |

## Open Questions

- **Block size**: 64KB? 256KB? Tradeoff between overhead and granularity.
- **Hashing**: Do we hash file contents ourselves (sha256) or rely on Hypercore's Merkle tree?
- **Watcher debounce**: How long to wait after mtime settles before syncing? 500ms? 1s?
- **Max file count**: Any practical limits on number of Autopass entries?
- **Ignore patterns**: `.gitignore`-style exclusions? Or sync everything?
