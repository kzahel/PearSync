import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type PearSyncServer } from "../../src/web-server.js";

export interface TestContext {
  server: PearSyncServer;
  folder: string;
}

export async function startTestServer(withFolder = true): Promise<TestContext> {
  const folder = await mkdtemp(join(tmpdir(), "pearsync-e2e-"));
  const server = await createServer(withFolder ? { folder } : {});
  await server.listen(0);
  return { server, folder };
}

export async function cleanupTestServer(ctx: TestContext): Promise<void> {
  await ctx.server.close();
  await rm(ctx.folder, { recursive: true, force: true });
}
