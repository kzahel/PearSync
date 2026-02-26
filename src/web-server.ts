import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Corestore from "corestore";
import express from "express";
import { type WebSocket, WebSocketServer } from "ws";
import { EngineBridge } from "./engine-bridge.js";
import { ManifestStore } from "./lib/manifest-store.js";
import { SyncEngine } from "./lib/sync-engine.js";

export interface ServerOptions {
  folder?: string;
  port?: number;
  bootstrap?: { host: string; port: number }[];
}

export interface PearSyncServer {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  url: string;
  httpServer: http.Server;
}

async function startEngine(
  folder: string,
  mode: "create" | "join",
  inviteCode: string | undefined,
  bootstrap?: { host: string; port: number }[],
): Promise<{ engine: SyncEngine; store: InstanceType<typeof Corestore> }> {
  await mkdir(folder, { recursive: true });
  const storePath = join(folder, ".pearsync", "corestore");
  await mkdir(storePath, { recursive: true });
  const store = new Corestore(storePath);

  let manifest: ManifestStore;
  if (mode === "join" && inviteCode) {
    manifest = await ManifestStore.pair(store, inviteCode, { bootstrap });
  } else {
    manifest = ManifestStore.create(store, { bootstrap });
  }

  const engine = new SyncEngine(store, folder, { manifest });
  await engine.ready();
  await engine.start();
  return { engine, store };
}

function resolveFolder(folder: string): string {
  if (folder.startsWith("~/") || folder === "~") {
    return join(homedir(), folder.slice(2));
  }
  return folder;
}

export async function createServer(opts: ServerOptions): Promise<PearSyncServer> {
  const app = express();
  app.use(express.json());

  let engine: SyncEngine | null = null;
  let bridge: EngineBridge | null = null;
  let store: InstanceType<typeof Corestore> | null = null;
  let resolvedFolder: string | null = null;

  // If folder provided, start engine immediately
  if (opts.folder) {
    resolvedFolder = resolveFolder(opts.folder);
    const result = await startEngine(resolvedFolder, "create", undefined, opts.bootstrap);
    engine = result.engine;
    store = result.store;
    bridge = new EngineBridge(engine, resolvedFolder);
    bridge.attach();
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
      res.json({ state: "setup", folder: null });
    }
  });

  app.post("/api/setup", async (req, res) => {
    if (engine) {
      res.status(409).json({ error: "Already configured" });
      return;
    }
    const { folder, mode, inviteCode } = req.body as {
      folder?: string;
      mode?: "create" | "join";
      inviteCode?: string;
    };
    if (!folder || !mode) {
      res.status(400).json({ error: "folder and mode are required" });
      return;
    }
    try {
      resolvedFolder = resolveFolder(folder);
      const result = await startEngine(resolvedFolder, mode, inviteCode, opts.bootstrap);
      engine = result.engine;
      store = result.store;
      bridge = new EngineBridge(engine, resolvedFolder);
      bridge.attach();
      // Register existing WS clients with the new bridge
      for (const ws of wss.clients) {
        bridge.addWsClient(ws as WebSocket);
      }
      res.json({ ok: true, writerKey: engine.getManifest().writerKey });
    } catch (err) {
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
    if (engine) {
      await engine.stop();
      await engine.close();
    }
    if (store) await store.close();
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
