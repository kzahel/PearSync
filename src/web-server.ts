import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Corestore from "corestore";
import express from "express";
import { type WebSocket, WebSocketServer } from "ws";
import type { StartupConflictPolicy } from "./api-types.js";
import { EngineBridge } from "./engine-bridge.js";
import {
  type PreparedJoinSession,
  prepareJoinPreview,
  resolveFolder,
  startEngine,
  startEngineFromPreparedJoin,
  startupConflictPolicies,
} from "./engine-manager.js";
import { loadLastFolder, saveLastFolder } from "./last-folder-config.js";
import type { SyncEngine } from "./lib/sync-engine.js";

export interface ServerOptions {
  folder?: string;
  port?: number;
  bootstrap?: { host: string; port: number }[];
  /** If false, skip auto-starting from saved config when no folder is provided. Default: true. */
  autoStart?: boolean;
}

export interface PearSyncServer {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  url: string;
  httpServer: http.Server;
}

export async function createServer(opts: ServerOptions): Promise<PearSyncServer> {
  const app = express();
  app.use(express.json());

  let engine: SyncEngine | null = null;
  let bridge: EngineBridge | null = null;
  let store: InstanceType<typeof Corestore> | null = null;
  let resolvedFolder: string | null = null;
  let currentStartupConflictPolicy: StartupConflictPolicy | null = null;
  let pendingJoinPreview: PreparedJoinSession | null = null;

  async function clearPendingJoinPreview(): Promise<void> {
    if (!pendingJoinPreview) return;
    await pendingJoinPreview.manifest.close();
    await pendingJoinPreview.store.close();
    pendingJoinPreview = null;
  }

  // If folder provided, start engine immediately; otherwise try saved config
  const folderToStart = opts.folder ?? (opts.autoStart !== false ? loadLastFolder() : null);
  if (folderToStart) {
    try {
      resolvedFolder = resolveFolder(folderToStart);
      const result = await startEngine(resolvedFolder, "create", undefined, opts.bootstrap);
      engine = result.engine;
      store = result.store;
      currentStartupConflictPolicy = result.startupConflictPolicy;
      bridge = new EngineBridge(engine, resolvedFolder, currentStartupConflictPolicy);
      bridge.attach();
    } catch (err) {
      console.error("[auto-start] Failed to restore previous session:", err);
      engine = null;
      bridge = null;
      store = null;
      resolvedFolder = null;
    }
  }

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    bridge?.addWsClient(ws);
    ws.on("close", () => bridge?.removeWsClient(ws));
  });

  // --- REST API routes ---

  app.get("/api/status", (_req, res) => {
    if (bridge) {
      res.json(bridge.getStatus());
    } else {
      res.json({ state: "setup", folder: null, startupConflictPolicy: null });
    }
  });

  app.post("/api/setup", async (req, res) => {
    if (engine) {
      res.status(409).json({ error: "Already configured" });
      return;
    }
    const { folder, mode, inviteCode, startupConflictPolicy } = req.body as {
      folder?: string;
      mode?: "create" | "join";
      inviteCode?: string;
      startupConflictPolicy?: StartupConflictPolicy;
    };
    if (!folder || !mode) {
      res.status(400).json({ error: "folder and mode are required" });
      return;
    }
    if (startupConflictPolicy && !startupConflictPolicies.includes(startupConflictPolicy)) {
      res.status(400).json({ error: "invalid startupConflictPolicy" });
      return;
    }
    try {
      resolvedFolder = resolveFolder(folder);
      let result:
        | Awaited<ReturnType<typeof startEngine>>
        | Awaited<ReturnType<typeof startEngineFromPreparedJoin>>;
      if (
        mode === "join" &&
        inviteCode &&
        pendingJoinPreview &&
        pendingJoinPreview.folder === resolvedFolder &&
        pendingJoinPreview.inviteCode === inviteCode
      ) {
        const prepared = pendingJoinPreview;
        pendingJoinPreview = null;
        result = await startEngineFromPreparedJoin(prepared, startupConflictPolicy);
      } else {
        await clearPendingJoinPreview();
        result = await startEngine(
          resolvedFolder,
          mode,
          inviteCode,
          opts.bootstrap,
          startupConflictPolicy,
        );
      }
      engine = result.engine;
      store = result.store;
      currentStartupConflictPolicy = result.startupConflictPolicy;
      bridge = new EngineBridge(engine, resolvedFolder, currentStartupConflictPolicy);
      bridge.attach();
      // Register existing WS clients with the new bridge
      for (const ws of wss.clients) {
        bridge.addWsClient(ws as WebSocket);
      }
      saveLastFolder(resolvedFolder);
      res.json({ ok: true, writerKey: engine.getManifest().writerKey });
    } catch (err) {
      await clearPendingJoinPreview();
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/setup/preview", async (req, res) => {
    if (engine) {
      res.status(409).json({ error: "Already configured" });
      return;
    }
    const { folder, mode, inviteCode } = req.body as {
      folder?: string;
      mode?: "create" | "join";
      inviteCode?: string;
    };

    if (!folder || mode !== "join" || !inviteCode) {
      res.status(400).json({ error: "folder, mode=join, and inviteCode are required" });
      return;
    }

    try {
      resolvedFolder = resolveFolder(folder);
      await clearPendingJoinPreview();
      pendingJoinPreview = await prepareJoinPreview(resolvedFolder, inviteCode, opts.bootstrap);
      res.json(pendingJoinPreview.preview);
    } catch (err) {
      await clearPendingJoinPreview();
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/invite", async (_req, res) => {
    if (!engine) {
      res.status(400).json({ error: "Not configured" });
      return;
    }
    try {
      const inviteCode = await engine.getManifest().createInvite();
      res.json({ inviteCode });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/files", async (_req, res) => {
    if (!bridge) {
      res.json([]);
      return;
    }
    try {
      res.json(await bridge.getFiles());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/peers", async (_req, res) => {
    if (!bridge) {
      res.json([]);
      return;
    }
    try {
      res.json(await bridge.getPeers());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/events", (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const offset = Number.parseInt(String(req.query.offset ?? "0"), 10);
    res.json(bridge ? bridge.getEvents(offset, limit) : []);
  });

  app.post("/api/shutdown", (_req, res) => {
    res.json({ ok: true });
    setImmediate(async () => {
      await shutdown();
    });
  });

  // Serve built React app from web/dist/ in production
  const thisDir = fileURLToPath(new URL(".", import.meta.url));
  const distPath = join(thisDir, "..", "web", "dist");
  if (existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get("{*path}", (_req, res) => {
      res.sendFile(join(distPath, "index.html"));
    });
  }

  // --- Shutdown ---

  let shutdownCalled = false;

  async function shutdown(): Promise<void> {
    if (shutdownCalled) return;
    shutdownCalled = true;

    if (bridge) bridge.detach();
    for (const client of wss.clients) client.close();
    wss.close();
    await clearPendingJoinPreview();
    let activeManifest: ReturnType<SyncEngine["getManifest"]> | null = null;
    if (engine) {
      activeManifest = engine.getManifest();
      await engine.stop();
      await engine.close();
    }
    if (activeManifest) await activeManifest.close();
    if (store) await store.close();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  let actualPort = 0;

  return {
    listen: (port: number) =>
      new Promise<number>((resolve) => {
        httpServer.listen(port, () => {
          actualPort = (httpServer.address() as AddressInfo).port;
          resolve(actualPort);
        });
      }),
    close: shutdown,
    get url() {
      return `http://localhost:${actualPort}`;
    },
    httpServer,
  };
}
