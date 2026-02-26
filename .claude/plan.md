# Layer 6: Web UI — Implementation Plan

## Overview
Localhost web UI (React + Vite) with Node.js HTTP/WebSocket server wrapping SyncEngine. Torrent-client dashboard with full visibility into sync state, peers, files, and events.

## Steps (in dependency order)

### Step 0: Install dependencies + config updates
- `npm install express ws && npm install -D @types/express @types/ws tsx`
- Add `web/node_modules/` and `web/dist/` to `.gitignore`
- Add `web/src/**` to `biome.json` includes
- Add scripts to package.json: `dev:server`, `dev:ui`, `build:ui`, `start`

### Step 1: Ring buffer (`src/ring-buffer.ts` + test)
- Fixed-capacity circular buffer for event history
- `push()`, `toArray()` (newest first), `slice(offset, limit)`, `size`
- Unit test in `src/ring-buffer.test.ts`

### Step 2: Shared API types (`src/api-types.ts`)
- `AppEvent`, `FileInfo`, `PeerInfo`, `StatusInfo`, `WsMessage`
- Response types: `SetupResponse`, `InviteResponse`, `ShutdownResponse`

### Step 3: Engine bridge (`src/engine-bridge.ts`)
- Listens to SyncEngine events, converts to AppEvent, pushes to ring buffer
- Manages WS client set, broadcasts messages
- Query methods: `getFiles()`, `getPeers()`, `getStatus()`, `getEvents()`
- Periodic stats broadcast every 2s
- `attach()` / `detach()` lifecycle

### Step 4: Web server + routes (`src/web-server.ts`)
- `createServer(opts) → PearSyncServer` with `listen()`, `close()`, `url`
- Express + ws (noServer mode) on same port
- `startEngine()`: creates Corestore at `<folder>/.pearsync/corestore/`, ManifestStore, SyncEngine
- Routes: GET /api/status, POST /api/setup, POST /api/invite, GET /api/files, GET /api/peers, GET /api/events, POST /api/shutdown
- Serves `web/dist/` static files in production
- Graceful close: bridge.detach → WS close → engine.stop → engine.close → store.close → http.close

### Step 5: Server tests (`src/web-server.test.ts`)
- Real SyncEngine with temp folders, port 0, server.close() in afterEach
- Tests: status/setup/files/events REST + WebSocket sync events

### Step 6: CLI entry point (`src/server.ts`)
- Parse `--folder` and `--port` via `node:util` parseArgs
- SIGINT/SIGTERM → graceful shutdown

### Step 7: Scaffold React app
- `npm create vite@latest web -- --template react-ts`
- Configure `web/vite.config.ts` with proxy for `/api` → :3000 and `/ws` → ws://:3000
- Set up `web/playwright.config.ts` and `web/e2e/tsconfig.json`
- `cd web && npm install && npm install -D @playwright/test`

### Step 8: Theme system + global CSS
- `web/src/styles/global.css` — CSS custom properties for dark/light
- `web/src/hooks/useTheme.ts` — toggle, localStorage persistence

### Step 9: API client + hooks
- `web/src/api.ts` — fetch wrappers for all endpoints
- `web/src/hooks/useWebSocket.ts` — auto-reconnect with backoff
- `web/src/hooks/useApi.ts` — polling data fetcher
- `web/src/hooks/useEvents.ts` — event log from WS + REST

### Step 10: App + Setup screen
- `App.tsx` checks `/api/status` → routes to Setup or Dashboard
- `Setup.tsx` — folder input, Create/Join, invite code, POST /api/setup

### Step 11: Dashboard + Status bar + Files tab
- `Dashboard.tsx` — tab layout
- `StatusBar.tsx` — state badge, peers, files, theme toggle
- `FileTable.tsx` — sortable table, search, status icons, WS refresh

### Step 12: Remaining tabs + Invite modal
- `PeerList.tsx`, `EventLog.tsx`, `ConflictList.tsx`, `InviteModal.tsx`

### Step 13: Playwright E2E tests (`web/e2e/`)
- Helper: `startTestServer()` on random port
- Tests: setup flow, file list, activity log, theme toggle, shutdown API

### Step 14: Final verification
```sh
npx tsc --noEmit && npx biome check --write . && npx vitest run
cd web && npx tsc --noEmit && npx vite build && npx playwright test
```

## Key decisions
- Corestore at `<folder>/.pearsync/corestore/` (watcher ignores `.pearsync/`)
- ESM `.js` extensions in src/ imports (tsx handles .ts resolution)
- Real engine in server tests (no mocking)
- Routes inline in web-server.ts (no separate api.ts)
- Port 0 in tests for no conflicts
- `~/` resolved server-side via `os.homedir()`
