# Layer 6: Web UI — P2P Sync Dashboard

## Context

You are working on PearSync, a P2P folder sync tool built on the Holepunch stack. Read `PLAN.md` for the full architecture. Read `CLAUDE.md` for development guidelines.

This is Layer 6. Previous layers are complete:

- **Layer 1** — FileStore: chunked file storage on Hypercores
- **Layer 2** — ManifestStore: Autopass-backed file metadata CRUD + pairing
- **Layer 3** — Integration tests proving file bytes replicate through Autopass networking
- **Layer 4** — SyncEngine: folder watching, local↔remote file sync, watcher suppression
- **Layer 5** — Conflict resolution, tombstones, deletion propagation, peer names

The Pear desktop app scaffolding exists but is being left in place unused. This layer builds a **standalone localhost web UI** — a Node.js server that runs the sync engine and serves a React dashboard in the browser. Think torrent client: full visibility into network state, peers, file transfers, and events.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Browser (localhost:3000)                            │
│  React app — dashboard, file list, peers, events    │
│  ↕ WebSocket (real-time events)                     │
│  ↕ REST API (queries + actions)                     │
├─────────────────────────────────────────────────────┤
│  Node.js server (src/server.ts)                     │
│  Express/Fastify + ws                               │
│  ↕                                                  │
│  SyncEngine (layers 1-5)                            │
│  Autopass, Hypercore, Corestore, Hyperswarm          │
└─────────────────────────────────────────────────────┘
```

Two processes during development:
- `npx tsx src/server.ts ~/SyncFolder` — backend server on port 3000
- `cd web && npx vite dev` — React dev server with HMR, proxies API to :3000

Production: Vite builds static assets, the Node server serves them directly.

## What to Build

### 1. Server entry point (`src/server.ts`)

A foreground Node.js process that:

1. Parses CLI args for folder path (required) and port (optional, default 3000)
2. Creates the SyncEngine (or defers creation until setup completes via UI)
3. Starts an HTTP server with REST API routes
4. Starts a WebSocket server for real-time event streaming
5. Serves the built React app from `web/dist/` (production) or proxies to Vite (dev)
6. Opens the browser automatically on start (use `open` package or `child_process`)

```
Usage: npx tsx src/server.ts [options]

Options:
  --folder <path>    Sync folder path (can also be set via UI)
  --port <number>    HTTP port (default: 3000)
```

**Two launch modes:**

- **With `--folder`**: Engine starts immediately, UI shows dashboard
- **Without `--folder`**: Engine is not started, UI shows setup screen

#### Server structure

```typescript
// src/server.ts
import { createServer } from "./web-server";

const opts = parseArgs(process.argv.slice(2));
const server = await createServer(opts);
const port = await server.listen(opts.port ?? 3000);

console.log(`PearSync running at http://localhost:${port}`);

// Graceful shutdown on Ctrl+C or kill
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`\n${sig} received, shutting down...`);
    await server.close();
    process.exit(0);
  });
}
```

```typescript
// src/web-server.ts — HTTP + WS server, API routes, engine lifecycle
export interface ServerOptions {
  folder?: string;
  port?: number;
}

export interface PearSyncServer {
  /** Start listening on the given port. Returns the actual port (useful if 0 was passed). */
  listen(port: number): Promise<number>;

  /** Graceful shutdown: stop engine, close WebSockets, close HTTP server. */
  close(): Promise<void>;

  /** The base URL (e.g. "http://localhost:3000"), available after listen(). */
  url: string;

  /** The underlying HTTP server, for test plumbing. */
  httpServer: import("http").Server;
}

export async function createServer(opts: ServerOptions): Promise<PearSyncServer>;
```

Keep the server logic in `src/web-server.ts` so it can be tested without launching a process.

The `close()` method is critical — it must:
1. Stop the SyncEngine (stop watcher, close Autopass/Corestore)
2. Close all WebSocket connections
3. Close the HTTP server
4. Resolve once everything is torn down

This makes tests trivial: `createServer()` → do stuff → `server.close()` in `afterEach`.

### 2. REST API (`src/api.ts`)

#### Setup & lifecycle

```
POST /api/setup
  Body: { folder: string, mode: "create" | "join", inviteCode?: string }
  → Creates SyncEngine, starts sync
  → Returns: { ok: true, writerKey: string }

POST /api/invite
  → Generates a new invite code from Autopass
  → Returns: { inviteCode: string }

GET /api/status
  → Returns overall sync state
  → { state: "idle" | "syncing" | "watching" | "setup", folder: string | null }

POST /api/shutdown
  → Graceful shutdown: stops engine, closes server, exits process
  → Returns: { ok: true } (response sent before shutdown completes)
  → Useful for Playwright tests and remote control
```

#### Files

```
GET /api/files
  → List all synced files with metadata
  → Returns: Array<{
      path: string,
      size: number,
      hash: string,
      mtime: number,
      writerKey: string,
      peerName: string,
      syncState: "synced" | "syncing" | "conflict" | "local-only",
    }>

GET /api/files/:path
  → Get metadata for a specific file
```

#### Peers

```
GET /api/peers
  → List all known peers
  → Returns: Array<{
      writerKey: string,
      name: string,
      isLocal: boolean,
      isConnected: boolean,
    }>
```

#### Events

```
GET /api/events?limit=100&offset=0
  → Recent sync events (persisted in memory, ring buffer)
  → Returns: Array<{
      id: number,
      timestamp: number,
      type: "upload" | "download" | "delete" | "conflict" | "peer-join" | "peer-leave" | "error",
      path?: string,
      detail: string,
    }>
```

### 3. WebSocket protocol

Single WebSocket endpoint at `ws://localhost:3000/ws`.

Server pushes JSON messages to all connected clients:

```typescript
interface WsMessage {
  type: "sync" | "status" | "peer" | "error" | "stats";
  payload: unknown;
  timestamp: number;
}
```

**Message types:**

```typescript
// File synced
{ type: "sync", payload: { direction: "up" | "down", action: "update" | "delete" | "conflict", path: string, size?: number, conflictPath?: string } }

// Overall status changed
{ type: "status", payload: { state: "watching" | "syncing" | "idle", fileCount: number, peerCount: number } }

// Peer connected/disconnected
{ type: "peer", payload: { event: "join" | "leave", writerKey: string, name: string } }

// Error
{ type: "error", payload: { message: string, path?: string } }

// Periodic stats (every 2s)
{ type: "stats", payload: { filesTotal: number, filesInSync: number, peersConnected: number, uptime: number } }
```

The client connects on mount and reconnects automatically on disconnect (exponential backoff).

### 4. React app (`web/`)

Initialize with Vite + React + TypeScript:

```
web/
├── index.html
├── vite.config.ts          # proxy /api and /ws to backend
├── src/
│   ├── main.tsx            # React root
│   ├── App.tsx             # Router: Setup or Dashboard
│   ├── api.ts              # fetch wrappers for REST endpoints
│   ├── hooks/
│   │   ├── useWebSocket.ts # WS connection, auto-reconnect, message dispatch
│   │   ├── useApi.ts       # data fetching hook (SWR-style)
│   │   └── useEvents.ts    # event log state from WS
│   ├── components/
│   │   ├── Setup.tsx        # Initial setup wizard
│   │   ├── Dashboard.tsx    # Main dashboard layout
│   │   ├── StatusBar.tsx    # Top bar: sync state, peers, uptime
│   │   ├── FileTable.tsx    # File list with sort/filter
│   │   ├── PeerList.tsx     # Connected peers panel
│   │   ├── EventLog.tsx     # Scrolling activity log
│   │   ├── ConflictList.tsx # Conflict files with details
│   │   └── InviteModal.tsx  # Generate/show invite code
│   └── styles/
│       ├── global.module.css
│       ├── dashboard.module.css
│       └── ... (per-component modules)
```

#### Vite config

```typescript
// web/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
```

### 5. UI Screens

#### Setup screen

Shown when no folder is configured (server started without `--folder`).

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│                    🍐 PearSync                       │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  Start syncing a folder                        │  │
│  │                                                │  │
│  │  Folder path: [~/PearSync_______________]      │  │
│  │                                                │  │
│  │  ○ Create new sync group                       │  │
│  │  ○ Join with invite code                       │  │
│  │                                                │  │
│  │  Invite code: [_________________________]      │  │
│  │  (shown when "Join" is selected)               │  │
│  │                                                │  │
│  │              [ Start Syncing ]                  │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- Folder path defaults to `~/PearSync` but is editable
- "Create" mode: starts engine, then shows invite code to share
- "Join" mode: shows invite code input field, pairs on submit
- Validation: folder must be an absolute path or start with `~/`
- Server creates the folder if it doesn't exist

#### Dashboard — main layout

Torrent-client style with a persistent status bar and tabbed content area.

```
┌──────────────────────────────────────────────────────┐
│  PearSync    ~/Documents/sync    ● Watching          │
│  2 peers connected    47 files synced    ↑0 ↓0       │
├────────┬────────┬────────┬────────┬──────────────────┤
│ Files  │ Peers  │Activity│Conflicts│   [ + Invite ]  │
├────────┴────────┴────────┴────────┴──────────────────┤
│                                                      │
│  (tab content area)                                  │
│                                                      │
│                                                      │
│                                                      │
│                                                      │
│                                                      │
│                                                      │
│                                                      │
│                                                      │
│                                                      │
└──────────────────────────────────────────────────────┘
```

#### Status bar (always visible)

- Sync folder path
- Overall state: Watching (green) / Syncing (blue pulse) / Offline (gray)
- Peer count: "2 peers connected"
- File count: "47 files synced"
- Transfer indicators: ↑ uploading count, ↓ downloading count
- Uptime since start

#### Files tab

Table with columns, sortable by clicking headers:

| Name | Size | Modified | Status | Peer |
|------|------|----------|--------|------|
| /readme.txt | 2.4 KB | 2 min ago | ● Synced | local |
| /photos/cat.jpg | 1.2 MB | 5 min ago | ● Synced | a1b2c3d4 |
| /doc.txt | 890 B | just now | ◐ Syncing | local |
| /notes.md | 340 B | 1 hr ago | ⚠ Conflict | deadbeef |

- Status icons: green dot (synced), blue spinner (syncing), yellow warning (conflict), gray dash (local only)
- Click a row to see full metadata (hash, blocks, writerKey)
- Filter/search box at the top
- Show file count and total size in footer

#### Peers tab

| Peer | Writer Key | Status | Files |
|------|-----------|--------|-------|
| local (you) | a1b2c3d4e5f6... | ● Online | 47 |
| desktop-2 | deadbeef1234... | ● Online | 47 |

- Green dot for connected, gray for disconnected
- Show the writer key (truncated, click to copy full)
- "local (you)" label for the local peer
- Could show last seen time for disconnected peers

#### Activity tab

Scrolling event log, newest first. Like a torrent client's log panel.

```
12:34:56  ↑ Uploaded /readme.txt (2.4 KB)
12:34:55  ↓ Downloaded /photos/cat.jpg (1.2 MB) from deadbeef
12:34:50  ⚠ Conflict: /doc.txt — kept local version, saved remote as .conflict copy
12:34:45  ● Peer deadbeef connected
12:30:00  ▶ Started watching ~/Documents/sync
```

- Color-coded by type (uploads green, downloads blue, conflicts yellow, errors red)
- Filter by type (checkboxes: uploads, downloads, conflicts, errors, peers)
- Auto-scroll to latest, with a "pause" toggle to read history
- Keep last 1000 events in memory

#### Conflicts tab

List of active conflict files with resolution info:

```
┌──────────────────────────────────────────────────────┐
│ /doc.txt                                             │
│ Winner: local version (mtime: 12:34:56)              │
│ Conflict copy: /doc.conflict-2026-02-26-deadbeef.txt │
│ Remote peer: desktop-2 (deadbeef)                    │
│                                                      │
│ Both files are synced. Delete the conflict copy when  │
│ you've reviewed it.                                  │
└──────────────────────────────────────────────────────┘
```

- Lists all `.conflict-*` files detected in the manifest
- Shows which version won and why (mtime comparison)
- In the future: could add "resolve" buttons (keep mine / keep theirs / keep both)

#### Invite modal

Triggered by the "+ Invite" button in the tab bar.

```
┌────────────────────────────────────┐
│  Invite a peer                     │
│                                    │
│  Share this code with your other   │
│  device. They have 10 minutes to   │
│  enter it.                         │
│                                    │
│  ┌──────────────────────────────┐  │
│  │  a1b2-c3d4-e5f6-g7h8        │  │
│  └──────────────────────────────┘  │
│                                    │
│  [ Copy to clipboard ]             │
│                                    │
│           [ Close ]                │
└────────────────────────────────────┘
```

- Generates a fresh invite code via `POST /api/invite`
- Large, monospace display of the code
- Copy button
- Note about expiration

### 6. Theme: dark and light mode

Default to dark theme (torrent-client aesthetic), with a toggle in the status bar to switch to light mode. Use CSS custom properties (variables) so the entire palette swaps with a single `data-theme` attribute on `<html>`.

Persist the user's choice in `localStorage`.

#### Dark palette (default)
- `--bg`: `#0f1117` (near-black)
- `--surface`: `#1a1d24` (panels, cards)
- `--border`: `#2a2d34`
- `--text`: `#e0e0e0`
- `--text-secondary`: `#888`

#### Light palette
- `--bg`: `#f5f5f5`
- `--surface`: `#ffffff`
- `--border`: `#ddd`
- `--text`: `#1a1a1a`
- `--text-secondary`: `#666`

#### Shared accent colors (both themes)
- `--green`: `#4ade80` (synced, online, uploads)
- `--blue`: `#60a5fa` (syncing, downloads)
- `--yellow`: `#facc15` (conflicts, warnings)
- `--red`: `#f87171` (errors)
- `--gray`: `#555` (offline, inactive)

Monospace font for hashes, writer keys, invite codes. System sans-serif for everything else.

#### Implementation

```css
/* global.module.css */
:root, [data-theme="dark"] {
  --bg: #0f1117;
  --surface: #1a1d24;
  --border: #2a2d34;
  --text: #e0e0e0;
  --text-secondary: #888;
}

[data-theme="light"] {
  --bg: #f5f5f5;
  --surface: #ffffff;
  --border: #ddd;
  --text: #1a1a1a;
  --text-secondary: #666;
}
```

The theme toggle is a simple sun/moon icon button in the status bar.

### 7. Engine-to-server bridge

The SyncEngine emits events. The server needs to bridge these to the WebSocket and event log. Create a thin adapter:

```typescript
// src/engine-bridge.ts

export class EngineBridge {
  private engine: SyncEngine;
  private events: RingBuffer<AppEvent>;
  private wsClients: Set<WebSocket>;

  constructor(engine: SyncEngine);

  /** Start listening to engine events and broadcasting */
  attach(): void;

  /** Get recent events for REST API */
  getEvents(limit: number, offset: number): AppEvent[];

  /** Get file list with sync status */
  async getFiles(): Promise<FileInfo[]>;

  /** Get peer list */
  async getPeers(): Promise<PeerInfo[]>;

  /** Get overall status */
  getStatus(): StatusInfo;

  /** Broadcast a message to all connected WebSocket clients */
  broadcast(msg: WsMessage): void;
}
```

This keeps the server routes thin — they just call the bridge.

### 8. Event ring buffer

Keep the last 1000 events in memory for the REST API and for new WebSocket clients to get recent history on connect.

```typescript
// src/ring-buffer.ts

export class RingBuffer<T> {
  private items: T[];
  private head: number;
  private count: number;
  private capacity: number;

  constructor(capacity: number);
  push(item: T): void;
  toArray(): T[];  // newest first
  slice(offset: number, limit: number): T[];
}
```

### 9. Dependencies to add

```
# Server
npm install ws express
npm install -D @types/ws @types/express

# React app (in web/)
npm create vite@latest web -- --template react-ts
cd web && npm install
```

Minimal dependency footprint. Express for HTTP routing (could swap for Hono/Fastify, but Express is fine for this). `ws` for WebSocket.

### 10. esbuild / build integration

Don't touch the existing esbuild.config.js. The web UI has its own Vite build.

Add scripts to package.json:

```json
{
  "scripts": {
    "dev:server": "tsx src/server.ts",
    "dev:ui": "cd web && npx vite dev",
    "build:ui": "cd web && npx vite build",
    "start": "node dist/server.js"
  }
}
```

During development, run both `dev:server` and `dev:ui`. Vite proxies API calls to the server.

### 11. Tests

#### Server API tests (`src/web-server.test.ts`)

Test the REST API and WebSocket without a real SyncEngine — mock the engine or use a real one with a temp folder.

##### Test: GET /api/status returns setup state when no engine
```
1. Create server without --folder
2. GET /api/status
3. Assert: { state: "setup", folder: null }
```

##### Test: POST /api/setup creates engine and starts sync
```
1. Create server without --folder
2. POST /api/setup { folder: "/tmp/test-sync", mode: "create" }
3. Assert: 200, { ok: true, writerKey: "..." }
4. GET /api/status
5. Assert: { state: "watching", folder: "/tmp/test-sync" }
```

##### Test: GET /api/files returns file list
```
1. Create server with a temp folder containing files
2. Wait for engine to index
3. GET /api/files
4. Assert: array of file entries with expected fields
```

##### Test: WebSocket receives sync events
```
1. Create server with engine running
2. Connect WebSocket client
3. Write a file to the sync folder
4. Assert: WS receives { type: "sync", payload: { direction: "up", ... } }
```

##### Test: GET /api/events returns recent events
```
1. Create server, trigger some sync events
2. GET /api/events?limit=10
3. Assert: array of events, newest first
```

#### Playwright E2E tests (`web/e2e/`)

Playwright tests spin up a real server, open a real browser, and verify the UI end-to-end. The `PearSyncServer` interface makes this easy — tests create a server on a random port and tear it down after each test.

```typescript
// web/e2e/helpers.ts
import { createServer, type PearSyncServer } from "../../src/web-server";
import { mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export async function startTestServer(): Promise<{ server: PearSyncServer; folder: string }> {
  const folder = await mkdtemp(join(tmpdir(), "pearsync-e2e-"));
  const server = await createServer({ folder });
  await server.listen(0); // random available port
  return { server, folder };
}
```

##### Test: setup flow — create new sync group
```
1. Start server without --folder, listen on random port
2. Navigate to server.url
3. Assert: setup screen is visible
4. Fill in folder path, select "Create", click "Start Syncing"
5. Assert: dashboard appears with status "Watching"
6. Assert: invite modal can be opened
7. server.close()
```

##### Test: dashboard shows files after sync
```
1. Start server with a temp folder
2. Write a file to the temp folder
3. Navigate to server.url
4. Wait for file table to update
5. Assert: file appears in the Files tab with correct name and size
6. server.close()
```

##### Test: activity log receives real-time events
```
1. Start server with a temp folder
2. Navigate to server.url, click Activity tab
3. Write a file to the temp folder
4. Assert: upload event appears in the activity log within 5 seconds
5. server.close()
```

##### Test: theme toggle switches between dark and light
```
1. Navigate to server.url
2. Assert: html[data-theme="dark"] (default)
3. Click theme toggle
4. Assert: html[data-theme="light"]
5. Reload page
6. Assert: html[data-theme="light"] (persisted)
7. server.close()
```

##### Test: POST /api/shutdown stops the server
```
1. Start server on random port
2. POST /api/shutdown
3. Assert: response is { ok: true }
4. Assert: subsequent fetch to server.url rejects (connection refused)
```

#### Playwright config

```typescript
// web/playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3000", // overridden per test via server.url
  },
});
```

Add to dependencies:
```
cd web && npm install -D @playwright/test
```

#### React component tests are optional for this layer — focus on server API tests and Playwright E2E tests.

### 12. Development workflow

1. Read `CLAUDE.md` for project conventions
2. Read `src/lib/sync-engine.ts` — understand the engine API you're wrapping
3. Build the server (`src/server.ts`, `src/web-server.ts`, `src/api.ts`, `src/engine-bridge.ts`)
4. Build the React app scaffold (`web/`)
5. Implement Setup screen first — get the create/join flow working
6. Implement Dashboard with status bar and file table
7. Add WebSocket streaming and activity log
8. Add peers tab and conflicts tab
9. Polish: sorting, filtering, dark theme
10. Run `npx tsc --noEmit && npx biome check --write . && npx vitest run`

### 13. What NOT to build (yet)

- File content preview
- Diff viewer for conflicts
- Settings page (peer name editing, ignore patterns)
- Multiple sync folders
- System tray / notifications
- Authentication for the web UI (it's localhost-only)
- Mobile responsive layout

## Success Criteria

- `npx tsx src/server.ts --folder ~/test` starts the engine and serves the UI
- `npx tsx src/server.ts` (no folder) shows setup screen in browser
- Setup flow: user can create a new sync group or join with invite code
- Dashboard shows real-time sync status, file list, peer list, activity log
- WebSocket pushes events to the browser as they happen
- Conflict files are visible in the conflicts tab
- Invite modal generates and displays invite codes
- Dark/light theme toggle, persisted to localStorage
- `POST /api/shutdown` gracefully stops everything
- `server.close()` tears down engine, WebSockets, and HTTP cleanly
- SIGINT/SIGTERM in the CLI trigger graceful shutdown
- All existing tests still pass
- New server API tests pass
- Playwright E2E tests pass (setup flow, file list, activity log, theme toggle)
