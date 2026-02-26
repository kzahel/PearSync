import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import { isConfigMetadata, ManifestStore } from "./lib/manifest-store.js";
import { SyncEngine } from "./lib/sync-engine.js";
const startupConflictPolicies = [
  "remote-wins",
  "local-wins",
  "keep-both"
];
function resolveFolder(folder) {
  if (folder.startsWith("~/") || folder === "~") {
    return join(homedir(), folder.slice(2));
  }
  return folder;
}
async function startEngine(folder, mode, inviteCode, bootstrap, startupConflictPolicy) {
  await mkdir(folder, { recursive: true });
  const storePath = join(folder, ".pearsync", "corestore");
  await mkdir(storePath, { recursive: true });
  const store = new Corestore(storePath);
  let manifest;
  if (mode === "join" && inviteCode) {
    manifest = await ManifestStore.pair(store, inviteCode, { bootstrap });
  } else {
    manifest = ManifestStore.create(store, { bootstrap });
  }
  await manifest.ready();
  const existingConfig = await manifest.get("__config");
  const existingSettings = existingConfig && isConfigMetadata(existingConfig) ? existingConfig.settings ?? {} : {};
  let resolvedPolicy = null;
  const persistedPolicy = existingSettings.startupConflictPolicy;
  if (typeof persistedPolicy === "string" && startupConflictPolicies.includes(persistedPolicy)) {
    resolvedPolicy = persistedPolicy;
  }
  if (startupConflictPolicy) {
    resolvedPolicy = startupConflictPolicy;
  }
  await manifest.putConfig({
    ...existingConfig && isConfigMetadata(existingConfig) ? { peerName: existingConfig.peerName } : {},
    syncFolder: folder,
    settings: resolvedPolicy === null ? existingSettings : { ...existingSettings, startupConflictPolicy: resolvedPolicy }
  });
  const engine = new SyncEngine(store, folder, {
    manifest,
    startupConflictPolicy: resolvedPolicy ?? void 0
  });
  await engine.ready();
  await engine.start();
  return { engine, store, startupConflictPolicy: resolvedPolicy };
}
export {
  resolveFolder,
  startEngine,
  startupConflictPolicies
};
//# sourceMappingURL=engine-manager.js.map
