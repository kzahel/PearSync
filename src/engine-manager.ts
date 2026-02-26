import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import type { StartupConflictPolicy } from "./api-types.js";
import { isConfigMetadata, ManifestStore } from "./lib/manifest-store.js";
import { SyncEngine } from "./lib/sync-engine.js";

export const startupConflictPolicies: StartupConflictPolicy[] = [
  "remote-wins",
  "local-wins",
  "keep-both",
];

export function resolveFolder(folder: string): string {
  if (folder.startsWith("~/") || folder === "~") {
    return join(homedir(), folder.slice(2));
  }
  return folder;
}

export async function startEngine(
  folder: string,
  mode: "create" | "join",
  inviteCode: string | undefined,
  bootstrap?: { host: string; port: number }[],
  startupConflictPolicy?: StartupConflictPolicy,
): Promise<{
  engine: SyncEngine;
  store: InstanceType<typeof Corestore>;
  startupConflictPolicy: StartupConflictPolicy | null;
}> {
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

  await manifest.ready();
  const existingConfig = await manifest.get("__config");
  const existingSettings =
    existingConfig && isConfigMetadata(existingConfig) ? (existingConfig.settings ?? {}) : {};

  let resolvedPolicy: StartupConflictPolicy | null = null;
  const persistedPolicy = existingSettings.startupConflictPolicy;
  if (
    typeof persistedPolicy === "string" &&
    startupConflictPolicies.includes(persistedPolicy as StartupConflictPolicy)
  ) {
    resolvedPolicy = persistedPolicy as StartupConflictPolicy;
  }
  if (startupConflictPolicy) {
    resolvedPolicy = startupConflictPolicy;
  }

  await manifest.putConfig({
    ...(existingConfig && isConfigMetadata(existingConfig)
      ? { peerName: existingConfig.peerName }
      : {}),
    syncFolder: folder,
    settings:
      resolvedPolicy === null
        ? existingSettings
        : { ...existingSettings, startupConflictPolicy: resolvedPolicy },
  });

  const engine = new SyncEngine(store, folder, {
    manifest,
    startupConflictPolicy: resolvedPolicy ?? undefined,
  });
  await engine.ready();
  await engine.start();
  return { engine, store, startupConflictPolicy: resolvedPolicy };
}
