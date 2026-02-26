import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createServer, type PearSyncServer } from "./web-server.js";

const servers: PearSyncServer[] = [];
const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pearsync-web-test-"));
  tmpDirs.push(dir);
  return dir;
}

async function makeServer(folder?: string): Promise<PearSyncServer> {
  const server = await createServer({ folder });
  await server.listen(0);
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const s of servers) {
    try {
      await s.close();
    } catch {}
  }
  servers.length = 0;
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("Web Server API", () => {
  it("GET /api/status returns setup state when no engine", async () => {
    const server = await makeServer();
    const res = await fetch(`${server.url}/api/status`);
    const data = await res.json();
    expect(data).toEqual({ state: "setup", folder: null });
  });

  it("POST /api/setup creates engine and starts sync", async () => {
    const folder = await makeTmpDir();
    const server = await makeServer();

    const setupRes = await fetch(`${server.url}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder, mode: "create" }),
    });
    const setupData = await setupRes.json();
    expect(setupRes.status).toBe(200);
    expect(setupData.ok).toBe(true);
    expect(typeof setupData.writerKey).toBe("string");

    const statusRes = await fetch(`${server.url}/api/status`);
    const statusData = await statusRes.json();
    expect(statusData.state).toBe("watching");
    expect(statusData.folder).toBe(folder);
  });

  it("POST /api/setup rejects duplicate setup", async () => {
    const folder = await makeTmpDir();
    const server = await makeServer(folder);

    const res = await fetch(`${server.url}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder, mode: "create" }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/setup rejects invalid startup conflict policy", async () => {
    const folder = await makeTmpDir();
    const server = await makeServer();

    const res = await fetch(`${server.url}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder,
        mode: "join",
        inviteCode: "dummy",
        startupConflictPolicy: "invalid",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/files returns file list after sync", async () => {
    const folder = await makeTmpDir();
    await writeFile(join(folder, "hello.txt"), "hello world");

    const server = await makeServer(folder);

    // Wait for the engine to index the file
    await waitFor(async () => {
      const res = await fetch(`${server.url}/api/files`);
      const files = await res.json();
      return files.length > 0;
    }, 10_000);

    const res = await fetch(`${server.url}/api/files`);
    const files = await res.json();
    expect(files.length).toBeGreaterThanOrEqual(1);
    const file = files.find((f: { path: string }) => f.path === "/hello.txt");
    expect(file).toBeDefined();
    expect(file.size).toBe(11);
    expect(file.syncState).toBe("synced");
  });

  it("GET /api/events returns events after sync activity", async () => {
    const folder = await makeTmpDir();
    const server = await makeServer(folder);

    // Write file after server is running so the watcher picks it up
    await writeFile(join(folder, "test.txt"), "data");

    await waitFor(async () => {
      const res = await fetch(`${server.url}/api/events`);
      const events = await res.json();
      return events.length > 0;
    }, 10_000);

    const res = await fetch(`${server.url}/api/events?limit=10`);
    const events = await res.json();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("upload");
  });

  it("GET /api/peers returns peer list", async () => {
    const folder = await makeTmpDir();
    const server = await makeServer(folder);

    // Give the manifest a moment to register the peer
    await waitFor(async () => {
      const res = await fetch(`${server.url}/api/peers`);
      const peers = await res.json();
      return peers.length > 0;
    }, 5_000);

    const res = await fetch(`${server.url}/api/peers`);
    const peers = await res.json();
    expect(peers.length).toBeGreaterThanOrEqual(1);
    expect(peers[0].isLocal).toBe(true);
    expect(typeof peers[0].name).toBe("string");
  });

  it("WebSocket receives sync events", async () => {
    const folder = await makeTmpDir();
    const server = await makeServer(folder);

    const wsUrl = `${server.url.replace("http", "ws")}/ws`;
    const ws = new WebSocket(wsUrl);

    interface WsMsg {
      type: string;
      payload: { direction: string; path: string };
    }
    const messages: WsMsg[] = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as WsMsg);
    });

    await new Promise<void>((resolve) => ws.on("open", resolve));

    // Write a file to trigger a sync event
    await writeFile(join(folder, "ws-test.txt"), "websocket test");

    await waitFor(() => messages.some((m) => m.type === "sync"), 10_000);

    const syncMsg = messages.find((m) => m.type === "sync");
    expect(syncMsg).toBeDefined();
    expect(syncMsg?.payload.direction).toBe("up");
    expect(syncMsg?.payload.path).toBe("/ws-test.txt");

    ws.close();
  });
});

/** Poll until fn returns true, or timeout. */
async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
