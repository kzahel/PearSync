# Syncthing vs PearSync — Architecture & Algorithm Comparison

## 1. High-Level Architecture

### Syncthing
```
┌────────────────────────────────────────────────────────────────┐
│  Model (per-folder orchestrator)                               │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐ │
│  │ Scanner      │ │ Puller       │ │ Index (per-device       │ │
│  │ (hash+watch) │ │ (copier →    │ │  version vectors,       │ │
│  │              │ │  puller →    │ │  global state computed  │ │
│  │              │ │  finisher)   │ │  from all device views) │ │
│  └──────────────┘ └──────────────┘ └────────────────────────┘ │
│                         ↓ ↑                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ BEP Protocol (protobuf over TLS 1.3)                    │   │
│  │ Index/IndexUpdate messages carry FileInfo + Vectors      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         ↓ ↑                                    │
│  ┌─────────────┐ ┌──────────────┐ ┌────────────────────────┐  │
│  │ Relay       │ │ Global       │ │ Local Discovery        │  │
│  │ (NAT trav.) │ │ Discovery    │ │ (LAN broadcast)        │  │
│  └─────────────┘ └──────────────┘ └────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### PearSync
```
┌────────────────────────────────────────────────────────────────┐
│  SyncEngine (single-folder orchestrator)                       │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐ │
│  │ watch-drive  │ │ FileStore    │ │ ManifestStore          │ │
│  │ (fs.watch)   │ │ (Hypercore   │ │ (Autopass/HyperDB      │ │
│  │              │ │  chunks)     │ │  linearized view)      │ │
│  └──────────────┘ └──────────────┘ └────────────────────────┘ │
│                         ↓ ↑              ↓ ↑                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ LocalStateStore (.pearsync/state.json)                    │  │
│  │ Tracks lastSyncedHash, lastManifestHash per file          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                         ↓ ↑                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Corestore replication via Autopass Hyperswarm            │   │
│  │ (Noise protocol encryption, DHT-based peer discovery)    │   │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

**Key structural difference**: Syncthing maintains per-device index views and computes
a "global state" by merging all device vectors. PearSync delegates this to Autobase —
a multi-writer log linearizer that deterministically selects one value per key. PearSync
then uses a local state tracker to detect conflicts that Autobase's linearization hides.

---

## 2. Conflict Detection

### Syncthing — Version Vectors

Every file carries a **version vector** (list of `{DeviceID, Counter}` pairs):

```go
type Vector struct {
    Counters []Counter  // sorted by ShortID
}
type Counter struct {
    ID    ShortID  // first 64 bits of device certificate
    Value uint64   // monotonically increasing
}
```

**Detection**: `f.InConflictWith(previous)` returns true when:
1. Neither version vector dominates the other (concurrent changes), AND
2. `f.PreviousBlocksHash != previous.BlocksHash` (the new version wasn't based on the old content)

The `PreviousBlocksHash` check is subtle — it means if peer A edits a file, and peer B
independently edits the file but starts from the same base content as A's result, it's
still treated as a fast-forward, not a conflict. This reduces false-positive conflicts.

### PearSync — Local State Tracking

No vector clocks. Conflict detection is structural:

```typescript
const remoteChanged = remote.hash !== tracked.lastManifestHash;
const localChanged  = localHash !== tracked.lastSyncedHash;

if (remoteChanged && localChanged && localHash !== remote.hash) {
    // CONFLICT
}
```

**Why this works**: Autobase linearizes all writes deterministically, so the manifest
always shows exactly one version per key. The `LocalStateStore` remembers what we last
synced, so we can detect when both sides diverged from that checkpoint.

**Trade-off**: Simpler, but loses causal ordering information. If peer A edits, peer B
edits based on A's version, and peer C hasn't seen either — C can't tell whether B's
edit causally follows A's. Syncthing's vectors can.

**In practice**: This rarely matters for PearSync because Autobase's linearization
already picks a deterministic winner. The local state check is primarily about
preserving the user's local edits as conflict copies.

### Same-Content Optimization

Both systems detect when two peers make identical edits (same hash) and skip conflict
creation. Syncthing checks `BlocksHash` equality; PearSync checks `localHash === remote.hash`.

---

## 3. Conflict Resolution (Winner Selection)

### Syncthing — Deterministic Heuristic

```go
func (f *FileInfo) WinsConflict(other FileInfo) bool {
    // 1. Invalid files always lose
    if f.IsInvalid() != other.IsInvalid() {
        return !f.IsInvalid()
    }
    // 2. Newer modification time wins
    if f.ModTime().After(other.ModTime()) { return true }
    if f.ModTime().Before(other.ModTime()) { return false }
    // 3. Tie-break: deterministic device ID ordering
    return f.FileVersion().Compare(other.FileVersion()) == ConcurrentGreater
}
```

The winner occupies the canonical path. The loser is saved as:
`{name}.sync-conflict-{YYYYMMDD-HHMMSS}-{DeviceShortID}{ext}`

`MaxConflicts` config controls how many conflict copies to keep (-1=unlimited, 0=none, N=cap).

### PearSync — Manifest Wins

The manifest (Autobase-linearized view) is always authoritative. When a conflict is
detected, the remote/manifest version wins the canonical path, and the local version
is saved as:
`{name}.conflict-{YYYY-MM-DD}-{peerName}{ext}`

No configurable max conflicts. Conflict copies are uploaded to the manifest like regular
files, so all peers receive them.

### Comparison

| Aspect | Syncthing | PearSync |
|--------|-----------|----------|
| Winner selection | ModTime > DeviceID tiebreak | Manifest (Autobase linearization) |
| Deterministic? | Yes (all peers agree) | Yes (Autobase is deterministic) |
| Conflict naming | `.sync-conflict-DATE-DEVICEID` | `.conflict-DATE-PEERNAME` |
| Conflict copies capped? | Yes (configurable) | No |
| Copies replicated? | Yes (as regular files) | Yes (uploaded to manifest) |

---

## 4. Delete vs Edit Conflicts

### Syncthing

Edit wins. If a file is deleted on one device and modified on another concurrently,
the modification survives and propagates back to the deleting device. The deletion
becomes a conflict copy (if versioner is configured). Implementation in
`folder_sendrecv.go:918-930`.

### PearSync

Edit wins. `handleRemoteDeletion()` checks if the local file was modified since last sync:
- If `localHash !== tracked.lastSyncedHash` → local was edited → skip the delete
- If local is unchanged → safe to delete

The `keep-both` startup policy can also save local edits as `.conflict-` copies while
still honoring the tombstone on the canonical path.

### Both systems agree: edits beat deletes.

---

## 5. Tombstones and Deletion Tracking

### Syncthing

Deletions set `Deleted = true` on the FileInfo, increment the version vector, clear
blocks, and propagate via index updates. Tombstones live in the database indefinitely —
there's no garbage collection. A deleted file's entry persists with its version vector
so new peers can see it was intentionally deleted (not just missing).

### PearSync

Tombstones are explicit manifest entries:
```typescript
interface TombstoneMetadata {
    kind: "tombstone";
    deleted: true;
    hash: string;       // hash at time of deletion
    baseHash: string | null;
    seq: number;        // incremented from previous entry
    deletedBy: string;  // writerKey of deleting peer
}
```

Tombstones also persist indefinitely in the Autobase-backed manifest. They carry `seq`
and `baseHash` for the same fast-forward detection used by file entries.

---

## 6. Version Tracking

### Syncthing — Vector Clocks + Sequence Numbers

Two separate tracking mechanisms:

**Version Vector** (causal ordering):
- Per-file, replicated to all peers
- `Update(deviceID)` increments counter, uses `max(counter+1, unix_timestamp)` to
  incorporate wall-clock time (prevents time-skew issues)
- `Merge(other)` takes max of each counter (used when receiving remote index)
- Enables three-way comparison: Greater, Lesser, Equal, ConcurrentGreater, ConcurrentLesser

**Sequence Number** (per-device monotonic counter):
- NOT replicated as part of version vector
- Used for efficient delta sync: "give me all files with seq > N on your device"
- Each device tracks its own sequence independently

### PearSync — seq + baseHash

Single per-file counter (`seq`) incremented on every write. Plus `baseHash` — the SHA256
of the previous version's content — enabling fast-forward detection:

```typescript
if (remote.baseHash !== null && remote.baseHash === localHash) {
    // Remote was based on what we have → fast-forward, no conflict
}
```

No causal ordering across peers. The `seq` is not a global ordering — it's per-key,
per-writer, and Autobase linearization determines which writer's seq survives.

### Key difference

Syncthing's vectors let any peer determine the causal relationship between two versions
without any central authority. PearSync offloads this to Autobase's deterministic
linearization and uses local state tracking to catch what linearization hides.

---

## 7. Folder Modes

### Syncthing — Four Modes

| Mode | Pull? | Push? | Local edits propagate? | Use case |
|------|-------|-------|----------------------|----------|
| **SendReceive** | Yes | Yes | Yes | Default bidirectional |
| **SendOnly** | No | Yes | Yes | "Master" copy |
| **ReceiveOnly** | Yes | No | No (marked invalid) | Mirror/backup |
| **ReceiveEncrypted** | Yes | No | No | Untrusted relay |

**ReceiveOnly** details:
- Local changes get `FlagLocalReceiveOnly` → sent as `Invalid` to peers
- `Revert()` operation resets version vectors to zero, triggering re-pull of global state
- Useful for backup destinations where accidental edits shouldn't propagate

**SendOnly** details:
- Only sends index updates, never pulls file data
- Metadata-only pull to keep local DB in sync
- Local version always wins

### PearSync — Single Mode (+ Startup Policies)

Currently only one mode: full bidirectional sync. But has three **startup policies**
that affect initial reconciliation:

| Policy | Remote files | Local-only files | Divergent files |
|--------|-------------|-----------------|-----------------|
| **remote-wins** | Download | Upload | Remote wins canonical |
| **local-wins** | Download if no local | Upload (overwrites) | Local wins canonical |
| **keep-both** | Download | Upload | Create `.conflict-` copies |

**What PearSync lacks**:
- No persistent send-only or receive-only mode (only startup behavior)
- No revert operation
- No untrusted/encrypted relay mode
- No per-folder mode configuration (it's a constructor option, not runtime-switchable)

---

## 8. Multi-Folder Support

### Syncthing

- Each folder has a unique `FolderID` string
- Configured with its own device set — different folders can sync to different peers
- Independent scanner, puller, and index per folder
- Block-level dedup can reach **across folders** (copier checks other folders' DBs for
  matching block hashes before fetching remotely)
- Folders can have different modes (one SendOnly, another ReceiveOnly, etc.)

### PearSync

- One `SyncEngine` instance per folder
- Multi-folder would require multiple engines, each with separate Corestore/ManifestStore
- No cross-folder block dedup
- No built-in folder management (the application layer would need to orchestrate multiple engines)

---

## 9. File Pulling Pipeline

### Syncthing — Copier/Puller/Finisher

A sophisticated three-stage concurrent pipeline:

```
Scanner detects needed files
    ↓
Queue (ordered by PullOrder config: alphabetic, random, etc.)
    ↓
┌─────────────────────────────────────────────────┐
│ Copier (2 goroutines)                           │
│  • Try local block copy (same file, same folder)│
│  • Try cross-folder block copy                  │
│  • Try rename detection (same blocks = rename)  │
│  • Only pass to Puller if local copy fails      │
└────────────┬──────────────────┬─────────────────┘
             ↓                  ↓
┌────────────────────┐  ┌──────────────────┐
│ Puller             │  │ Finisher         │
│ • Fetch from peers │  │ • Close temp     │
│ • Load-balanced    │  │ • Set perms/mtime│
│ • Verify block hash│  │ • Atomic rename  │
│ • Rate-limited     │  │ • Handle conflict│
└────────┬───────────┘  │ • Batch DB update│
         ↓              └──────────────────┘
    Finisher
```

**Block-level dedup**: Files are split into 128KiB–16MiB blocks (power-of-two sizes).
When pulling, the copier first searches the local DB for any file (in any folder) with
a matching block hash before requesting it from a peer. This means:
- Copying a file within the sync folder = zero network transfer
- Editing 1 byte of a 1GB file = transfer ~1 block (128KiB–16MiB)
- Renaming a file = detected via block matching, no transfer needed

**Rename detection**: When a file appears as "new" but its blocks match a recently
deleted file, Syncthing uses `RenameOrCopy()` instead of re-downloading.

### PearSync — Whole-File Transfer

```
Watcher detects change → Read file → SHA256 hash
    ↓
Write entire file to FileStore (64KB Hypercore blocks)
    ↓
Put metadata to Manifest
    ↓
Remote peer sees Manifest update → Download entire file from FileStore
```

**No block-level dedup**: Files are chunked (64KB default) for Hypercore storage, but
the sync logic operates on whole files. Changing one byte re-uploads the entire file.

**No rename detection**: A rename becomes delete (tombstone) + create (new file entry),
transferring the full file content again.

**No prioritization**: Changes are processed in watcher event order. No queue reordering.

---

## 10. Ignore Patterns

### Syncthing

`.stignore` file per folder with glob-based patterns:
- `(?i)` for case-insensitive
- `(?d)` to allow deletions of ignored files
- `!pattern` for negation
- `#include otherfile` for includes
- Applied locally during scan and pull — NOT automatically replicated
- Each peer maintains its own ignore patterns

### PearSync

No ignore patterns. All files in the sync folder are synced. Reserved paths
(`.pearsync/`, `__peer:*`, `__config`) are handled internally but users can't
configure exclusions.

---

## 11. Encryption / Untrusted Mode

### Syncthing — ReceiveEncrypted

Full per-file encryption for untrusted relays:
- Folder key derived via `scrypt(password, "syncthing" + folderID)`
- Per-file key via HKDF from folder key + plaintext filename
- **Filenames**: AES-SIV encrypted, base32-encoded
- **Block data**: XChaCha20-Poly1305 with random nonces
- **Metadata**: Full FileInfo encrypted and attached to fake metadata
- Untrusted device sees only encrypted blob filenames and opaque block tokens

### PearSync

No untrusted mode. All peers are trusted writers or readers via Autopass ACL.
Hypercore provides transport encryption (Noise protocol) and at-rest encryption
can be enabled at the Corestore level, but there's no concept of a peer that
stores data it can't read.

---

## 12. Testing Approaches

### Syncthing

- **Real filesystem** + in-memory SQLite DB
- **Mock connections**: `protocol.mocks.Connection` for simulating peers
- **Index-based state**: Push `FileInfo` via `m.Index()` rather than writing real files
- **State verification**: Check `GlobalSize()`, `LocalSize()`, `ReceiveOnlySize()` counters
- **Per-mode test files**: `folder_recvonly_test.go`, `folder_sendonly_test.go`, etc.
- **Large test suite**: Thousands of tests across the `lib/` packages

### PearSync

- **Real filesystem** + real Hypercore/Autopass (no mocks)
- **Multi-peer simulation**: Creates real `SyncEngine` instances with real Corestores,
  connected via in-memory replication streams
- **Event-driven assertions**: `waitForSync()`, `waitForCondition()`, `waitForFileContent()`
- **Helpers**: `waitForMembers()` to ensure peer discovery before testing sync
- **Edge case coverage**: Same-content edits, mtime-only changes, rapid modifications,
  startup policies, tombstone propagation, edit-wins-over-delete
- **Multi-peer tests**: 2-peer and 3-peer convergence in `resilience.test.ts`

**Key difference**: Syncthing tests are more unit-oriented (mock connections, push index
state). PearSync tests are more integration-oriented (real replication, real filesystem,
real Autobase consensus). PearSync's approach tests the full stack but is slower and
harder to isolate failures.

---

## 13. Edge Cases — Where They Diverge

### Case Sensitivity

**Syncthing**: Explicit `CaseConflictError` detection on case-insensitive filesystems
(macOS HFS+, Windows NTFS). Uses an LRU cache for performance. A file differing only
in case from an existing file is treated as "doesn't exist" to avoid corruption.

**PearSync**: No case sensitivity handling. On macOS, writing `README.md` and
`readme.md` would silently overwrite each other on disk while being separate manifest entries.

### Symlinks

**Syncthing**: Full symlink support with `FileInfoType_SYMLINK`. Symlinks are synced as
their target path (not followed). Not available on Windows (marked `FlagLocalUnsupported`).

**PearSync**: No symlink handling. Localdrive may follow or skip symlinks depending on
configuration, but the manifest has no symlink type.

### Permissions / Ownership

**Syncthing**: Tracks Unix permissions (mode bits), UID/GID, Windows owner, and extended
attributes (xattrs) per-platform. `isEquivalent()` comparison can optionally ignore
ownership/xattrs. Windows uses a 0o600 mask for permission comparison.

**PearSync**: No permission tracking. All files are regular user files.

### Invalid Filenames

**Syncthing**: Rejects Windows-invalid names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`,
`LPT1-9`, names ending with `.` or space) with explicit error handling.

**PearSync**: No invalid filename handling.

### Empty Files

**Syncthing**: Handled naturally — zero blocks, zero size. Hash is hash of empty input.

**PearSync**: Handled — empty files get a SHA256 hash of empty buffer. Tested implicitly
through the hash comparison logic.

### Directory Conflicts

**Syncthing**: Explicit handling for type changes:
- File → Directory: move file to conflict copy, create directory
- Directory → File: delete directory (must be empty/ignored), create file
- Directory → Symlink: delete directory, create symlink

**PearSync**: No directory tracking in the manifest. Directories are created implicitly
when files are written. No directory deletion propagation. A directory conflict
(file at path where directory expected) would likely cause an error.

---

## 14. Features PearSync Doesn't Have (Potential Roadmap)

Ordered roughly by likely impact/usefulness:

| Feature | Syncthing | Complexity | Notes |
|---------|-----------|------------|-------|
| **Ignore patterns** | `.stignore` with globs | Medium | High user value — `.git/`, `node_modules/`, etc. |
| **Receive-only mode** | `FlagLocalReceiveOnly` + Revert | Medium | Useful for backup peers |
| **Rename detection** | Block hash matching | Medium | Major bandwidth savings |
| **Block-level sync** | Copier/puller pipeline | High | Only transfer changed blocks, not whole files |
| **Multi-folder** | Per-folder config + device sets | Medium | Different folders to different peers |
| **Case conflict handling** | CaseConflictError + LRU cache | Low | Important on macOS/Windows |
| **Permission tracking** | Per-platform metadata | Low | Unix mode bits, xattrs |
| **Conflict copy limits** | `MaxConflicts` config | Low | Prevent conflict copy accumulation |
| **Untrusted encryption** | AES-SIV + XChaCha20-Poly1305 | High | Encrypted relay peers |
| **Send-only mode** | Metadata-only pull | Low | "Master" copy pattern |
| **Symlink support** | `FileInfoType_SYMLINK` | Low | Platform-dependent |

---

## 15. Architectural Lessons from Syncthing

### What Syncthing does well that PearSync could learn from:

1. **PreviousBlocksHash for fast-forward detection**: Syncthing's check that a new
   version was "based on" the old version (via block hash comparison) reduces false
   conflicts. PearSync has `baseHash` which serves the same purpose — good design choice.

2. **Deterministic conflict winner selection**: Syncthing's `WinsConflict()` is
   deterministic across all peers (ModTime → DeviceID tiebreak). PearSync's Autobase
   linearization is also deterministic. Both avoid the "two peers disagree on the winner"
   problem.

3. **Block-level dedup is transformative**: For large files, Syncthing's approach of
   only transferring changed blocks is orders of magnitude more efficient. This is the
   single biggest feature gap for real-world usage.

4. **Folder modes as a first-class concept**: Having receive-only and send-only as
   built-in modes (not just startup policies) enables important use cases like backups
   and "golden copy" workflows.

5. **Ignore patterns are essential**: Real-world sync folders always contain files that
   shouldn't be synced (build artifacts, caches, `.git/`, `node_modules/`). This is
   likely the highest-impact missing feature for user experience.

### Where PearSync's approach has advantages:

1. **Simpler conflict model**: Local state tracking is easier to reason about than
   vector clocks. The trade-off (less causal information) is acceptable because
   Autobase provides the deterministic ordering.

2. **No global discovery dependency**: Syncthing relies on global discovery servers
   for initial peer finding (data doesn't flow through them, but availability depends
   on them). PearSync uses Hyperswarm's DHT which is fully decentralized.

3. **Cryptographic identity from the start**: PearSync's Autopass pairing model is
   simpler than Syncthing's device certificate exchange. No QR codes or device ID
   strings to share.

4. **Integration testing over mocks**: PearSync's test suite exercises the full
   replication stack, catching integration issues that Syncthing's mock-heavy tests
   might miss.
