/**
 * Starts a local PearSync testnet: a private DHT + N peer nodes.
 *
 * Usage:
 *   npx tsx scripts/testnet.ts                     # 2 peers in tmp dirs
 *   npx tsx scripts/testnet.ts 3                   # 3 peers in tmp dirs
 *   npx tsx scripts/testnet.ts ~/a ~/b ~/c         # 3 peers in specified dirs
 *   npx tsx scripts/testnet.ts --base-port 4000 3  # start ports at 4000
 *
 * Each peer gets:
 *   - Its own sync folder (tmp or specified)
 *   - Its own HTTP port (base-port + index, default 3001, 3002, ...)
 *   - A shared local DHT (no internet needed)
 *
 * The first peer creates the sync, the rest join via invite.
 * Press Ctrl+C to shut down all nodes.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
// @ts-expect-error — no types for hyperdht/testnet
import createTestnet from "hyperdht/testnet";
import { createServer, type PearSyncServer } from "../src/web-server.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "base-port": { type: "string", default: "3001" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: false,
});

if (values.help) {
  console.log(`Usage: npx tsx scripts/testnet.ts [--base-port PORT] [COUNT | FOLDER...]`);
  console.log(`  COUNT        Number of peers to create (default: 2)`);
  console.log(`  FOLDER...    Explicit folder paths (one per peer)`);
  console.log(`  --base-port  Starting HTTP port (default: 3001)`);
  process.exit(0);
}

const basePort = Number.parseInt(
  typeof values["base-port"] === "string" ? values["base-port"] : "3001",
  10,
);

// Determine folders: either explicit paths or N temp dirs
let folders: string[];
const tmpFolders: string[] = [];
const args = positionals.filter((a) => !a.startsWith("-"));

if (args.length === 1 && /^\d+$/.test(args[0])) {
  // Single numeric arg = count
  const count = Number.parseInt(args[0], 10);
  folders = [];
  for (let i = 0; i < count; i++) {
    const dir = await mkdtemp(join(tmpdir(), `pearsync-test-${i}-`));
    folders.push(dir);
    tmpFolders.push(dir);
  }
} else if (args.length > 0) {
  // Explicit folder paths
  folders = args.map((f) => resolve(f));
} else {
  // Default: 2 peers
  for (let i = 0; i < 2; i++) {
    const dir = await mkdtemp(join(tmpdir(), `pearsync-test-${i}-`));
    tmpFolders.push(dir);
  }
  folders = tmpFolders;
}

const peerCount = folders.length;
if (peerCount < 2) {
  console.error("Need at least 2 peers");
  process.exit(1);
}

// Start local DHT
console.log("Starting local DHT...");
const testnet = await createTestnet(3);
const bootstrap = testnet.bootstrap as { host: string; port: number }[];
console.log(
  `DHT bootstrap: ${bootstrap.map((b: { host: string; port: number }) => `${b.host}:${b.port}`).join(", ")}`,
);

const servers: PearSyncServer[] = [];

// Seed each folder with a marker file so there's something to sync
for (let i = 0; i < peerCount; i++) {
  await writeFile(
    join(folders[i], `from-peer-${i}.txt`),
    `Hello from peer ${i} at ${new Date().toISOString()}\n`,
  );
}

try {
  // Start peer 0 (creator)
  console.log(`\nStarting peer 0 (creator)...`);
  const server0 = await createServer({ folder: folders[0], bootstrap });
  const port0 = await server0.listen(basePort);
  servers.push(server0);
  console.log(`  Peer 0: http://localhost:${port0}  folder=${folders[0]}`);

  // Generate invite
  const inviteRes = await fetch(`http://localhost:${port0}/api/invite`, { method: "POST" });
  const { inviteCode } = (await inviteRes.json()) as { inviteCode: string };
  console.log(`  Invite: ${inviteCode.slice(0, 20)}...`);

  // Start remaining peers (joiners) — no folder so engine isn't auto-started
  for (let i = 1; i < peerCount; i++) {
    console.log(`Starting peer ${i} (joining)...`);
    const serverI = await createServer({ bootstrap, autoStart: false });
    const portI = await serverI.listen(basePort + i);
    servers.push(serverI);

    // Join via setup API (this creates the engine in join mode)
    const setupRes = await fetch(`http://localhost:${portI}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: folders[i], mode: "join", inviteCode }),
    });
    if (!setupRes.ok) {
      console.error(`  Peer ${i} setup failed: ${await setupRes.text()}`);
    } else {
      console.log(`  Peer ${i}: http://localhost:${portI}  folder=${folders[i]}`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testnet running: ${peerCount} peers on local DHT`);
  console.log(`${"=".repeat(60)}`);
  for (let i = 0; i < peerCount; i++) {
    console.log(`  Peer ${i}: http://localhost:${basePort + i}`);
  }
  console.log(`\nDrop files into any peer's folder and watch them sync.`);
  console.log(`Press Ctrl+C to shut down.\n`);

  // Wait for Ctrl+C
  await new Promise<void>((resolve) => {
    let force = false;
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        if (force) {
          console.log("\nForce exit.");
          process.exit(1);
        }
        force = true;
        resolve();
      });
    }
  });
} finally {
  console.log("\nShutting down...");

  // Force exit if cleanup takes too long
  const forceTimer = setTimeout(() => {
    console.error("Shutdown timed out, forcing exit.");
    process.exit(1);
  }, 5000);
  forceTimer.unref();

  for (const s of servers) {
    try {
      await s.close();
    } catch {}
  }
  try {
    await testnet.destroy();
  } catch {}

  // Clean up temp dirs
  for (const dir of tmpFolders) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  console.log("Done.");
  process.exit(0);
}
