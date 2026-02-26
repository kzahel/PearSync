# PearSync

Peer-to-peer folder sync built on the [Holepunch](https://holepunch.to/) stack. Two or more peers share a folder over encrypted, append-only Hypercores — no central server required.

## Architecture

PearSync is built in layers, each adding a capability on top of the last:

| Layer | Module | Responsibility |
|-------|--------|----------------|
| 1 | `FileStore` | Chunks files into 64 KB blocks stored in Hypercores |
| 2 | `ManifestStore` | Multi-writer file metadata via Autopass; pairing and ACL |
| 3 | Replication | Two instances sync Hypercores over Hyperswarm |
| 4 | `SyncEngine` | Watches a local folder, detects deltas, syncs bidirectionally |
| 5 | Conflict resolution | Detects concurrent edits, tombstones deletions, names peers |
| 6 | Web UI | React dashboard served on localhost (file browser, peers, events, conflicts) |

The **SyncEngine** is the central orchestrator. It watches the local folder for changes, computes SHA-256 hashes to detect deltas, writes file content into a peer-specific Hypercore via FileStore, and publishes metadata to the shared Autopass manifest. Remote changes discovered in the manifest are materialized back to disk.

## Tech Stack

- **Runtime** — [Pear](https://docs.pear.holepunch.to/) (desktop) or plain Node.js (CLI server)
- **Storage** — [Corestore](https://github.com/holepunch-org/corestore) + [Hypercore](https://github.com/holepunch-org/hypercore) append-only logs
- **Networking** — [Hyperswarm](https://github.com/holepunch-org/hyperswarm) DHT for peer discovery and hole-punching
- **Manifest** — [Autopass](https://github.com/holepunch-org/autopass) for multi-writer metadata, pairing, and consensus
- **Language** — TypeScript (strict), compiled with esbuild
- **Web UI** — React + Vite, dark/light themes, WebSocket live updates
- **Testing** — vitest
- **Linting** — Biome

## Getting Started

```sh
npm install
cd web && npm install && cd ..   # install web UI deps
```

### Build

```sh
node esbuild.config.js           # compile TS → JS (lib/ and ui/)
cd web && npx vite build && cd .. # build React UI
```

Or to run the Pear desktop app:

```sh
pear run --dev .
```

## Running the CLI Server

The standalone server starts a SyncEngine and exposes a REST + WebSocket API on localhost.

```sh
npx tsx src/server.ts --folder ~/my-sync-folder --port 3000
```

| Flag | Description | Default |
|------|-------------|---------|
| `--folder <path>` | Folder to sync | _(none — configure via web UI)_ |
| `--port <number>` | HTTP server port | `3000` |
| `--bootstrap <host:port,...>` | Custom DHT bootstrap nodes (comma-separated) | _(public DHT)_ |

Once running, open `http://localhost:3000` in a browser. The setup screen lets you either **create** a new sync vault or **join** an existing one with an invite code.

### Startup Conflict Policies

When joining a vault that already has files, you can choose how to handle conflicts between local and remote versions:

- **`remote-wins`** — remote versions overwrite local files
- **`local-wins`** — local files take precedence
- **`keep-both`** — both versions are kept; the local copy is renamed with a `.conflict-<date>-<peer>` suffix

## Running the Local Testnet

The testnet script spins up a private DHT and multiple peer instances on one machine — useful for development and testing.

```sh
npx tsx scripts/testnet.ts            # 2 peers in temp dirs
npx tsx scripts/testnet.ts 5          # 5 peers in temp dirs
npx tsx scripts/testnet.ts ~/a ~/b    # 2 peers in specified dirs
npx tsx scripts/testnet.ts --base-port 4000 3  # 3 peers starting at port 4000
```

Peer 0 creates the vault; the remaining peers auto-join via generated invite codes. Each peer gets a seed file (`from-peer-N.txt`) so you can immediately see sync in action. Press Ctrl+C to tear down all peers and clean up temp directories.

## Testing

```sh
npm test              # run all tests
npm run typecheck     # tsc --noEmit
npm run lint          # biome check
npm run check         # all three: typecheck + lint + test
```

## Project Structure

```
src/
  lib/
    file-store.ts         # Hypercore chunking and retrieval
    manifest-store.ts     # Autopass manifest CRUD, pairing, invites
    sync-engine.ts        # Folder watcher, delta detection, bidirectional sync
    local-state-store.ts  # Persistent local file state for reconciliation
    file-utils.ts         # Hashing and file metadata helpers
    *.test.ts             # Tests for each module
  server.ts               # CLI entry point
  web-server.ts           # Express REST API + WebSocket
  engine-bridge.ts        # Connects SyncEngine events to the web layer
  api-types.ts            # Shared TypeScript interfaces
web/                      # React web UI (Vite)
scripts/
  testnet.ts              # Local multi-peer testnet launcher
docs/                     # Design docs (authentication, reconciliation)
prompts/                  # Layer specifications
```

## Syncthing Comparison

PearSync and [Syncthing](https://github.com/syncthing/syncthing) solve the same core problem — decentralized, encrypted folder sync with no central server. A detailed architecture and algorithm comparison lives in [`docs/syncthing-comparison.md`](docs/syncthing-comparison.md). Key takeaways:

**Where the architectures fundamentally differ:**
- Syncthing uses **vector clocks** per-file for causal ordering across all peers. PearSync offloads this to **Autobase linearization** and uses a simpler local state tracker to catch conflicts the linearization hides. Both are deterministic — just different mechanisms.
- Syncthing has a sophisticated **copier → puller → finisher pipeline** with block-level dedup (only transfer changed 128K–16M blocks). PearSync does **whole-file transfers** — the single biggest efficiency gap.

**Conflict resolution is very similar:**
- Both detect same-content edits and skip conflict creation
- Both have "edit beats delete" semantics
- Both use a `previousBlocksHash`/`baseHash` concept for fast-forward detection
- Both create renamed conflict copies with date + device ID in the filename
- Winner selection differs in mechanism (ModTime + DeviceID tiebreak vs Autobase linearization) but both are deterministic across all peers

**Features Syncthing has that PearSync doesn't (roughly by impact):**
1. **Ignore patterns** (`.stignore`) — essential for real use (`.git/`, `node_modules/`)
2. **Folder modes** — receive-only, send-only, encrypted relay (4 modes vs 1)
3. **Rename detection** — block hash matching avoids re-transferring renamed files
4. **Block-level sync** — 1-byte change to 1GB file transfers ~1 block, not the whole file
5. **Multi-folder with per-folder device sets**
6. **Case conflict handling** — explicit detection on macOS/Windows
7. **Permission/xattr tracking** — per-platform metadata
8. **Conflict copy limits** — configurable cap to prevent accumulation
9. **Untrusted encryption** — AES-SIV + XChaCha20-Poly1305 for relay peers

**Where PearSync has advantages:**
- Simpler conflict model (easier to reason about)
- Fully decentralized discovery (no global discovery server dependency)
- Cryptographic identity baked in from the start (Autopass pairing)
- Integration tests exercise the full stack (vs Syncthing's mock-heavy approach)

## License

Apache-2.0
